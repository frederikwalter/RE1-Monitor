#!/usr/bin/env node
// RE1-Monitor – Sammler über die offizielle "Timetables"-API (IRIS) aus dem DB API Marketplace
// (kostenloser Zugang, Client-ID + API-Key nötig).
//
// Die API kennt nur Bahnhöfe. Ein Lauf lädt deshalb für jeden beobachteten Bahnhof
//   1. den Sollfahrplan der nächsten Stunden (/plan, jede Stundenscheibe nur einmal) und
//   2. alle bekannten Änderungen (/fchg),
// filtert die Halte der Linie RE1 heraus und vergleicht ihren Status mit dem letzten Lauf.
// Für jede Streichung liefert IRIS das Feld "clt" = Zeitpunkt, zu dem die DB sie angelegt hat.
//
// Aufruf:  DB_CLIENT_ID=... DB_API_KEY=... node collect.mjs
import fs from 'node:fs';
import path from 'node:path';
import {XMLParser} from 'fast-xml-parser';
import {
	ROOT, DATA, loadConfig, readJson, writeJson, appendCsv, appendJsonl, sleep, withRetry,
	berlin, berlinDate, hoursBetween, isMain,
} from './lib.mjs';

export const EVENT_HEADER = [
	'detected_at', 'station', 'role', 'train', 'train_type', 'stop_id', 'direction', 'planned_time', 'event',
	'old_status', 'new_status', 'cancellation_created_at', 'lead_time_h', 'lead_time_detected_h',
	'delay_min', 'messages', 'terminus', 'planned_path', 'changed_path_before', 'changed_path_after',
	'arrival_planned', 'arrival_actual', 'departure_planned', 'departure_actual', 'platform_arrival', 'platform_departure',
];
export const RUN_HEADER = ['run_at', 'halts', 'events', 'errors', 'requests'];

const HOUR = 36e5;
const KEEP_MS = 3 * 24 * HOUR; // Soll-Daten und Zustand 3 Tage aufbewahren
const FOLLOW_MS = 6 * HOUR;     // so lange nach der Sollzeit wird ein Halt weiterverfolgt
// ab dieser Änderung (min) wird eine Verspätung neu protokolliert. In Treuchtlingen minutengenau,
// weil dort über den Umstieg auf den Pendelzug jede Minute entscheidet.
const DELAY_STEP = {halt: 5, kontext: 1};

const xml = new XMLParser({
	ignoreAttributes: false, attributeNamePrefix: '', parseAttributeValue: false,
	isArray: (name) => ['s', 'm', 'station'].includes(name),
});

// IRIS-Zeitformat YYMMddHHmm (Ortszeit Berlin) → ISO mit korrektem Offset
export const irisTime = (s) => {
	if (!s || s.length < 10) return null;
	const local = `20${s.slice(0, 2)}-${s.slice(2, 4)}-${s.slice(4, 6)}T${s.slice(6, 8)}:${s.slice(8, 10)}:00`;
	for (const off of ['+01:00', '+02:00']) {
		const d = new Date(local + off);
		if (berlin(d).slice(0, 16) === local.slice(0, 16)) return d.toISOString();
	}
	return new Date(local + '+01:00').toISOString();
};

const slim = (e) => e && {pt: e.pt, pp: e.pp, l: e.l, ppth: e.ppth, ps: e.ps};
const KINDS = ['ar', 'dp'];

// Richtung Nürnberg, wenn der Zug nach dem Halt nach Nürnberg fährt oder (ohne Abfahrt) nicht von dort kommt
export const directionOf = (p) => p.dp
	? (/Nürnberg/.test(p.dp.ppth || '') ? 'N' : 'S')
	: (/Nürnberg/.test(p.ar?.ppth || '') ? 'S' : 'N');

// Stand eines Halts aus Soll (p) und Änderung (c).
//   status   – gestrichen, wenn Ankunft und Abfahrt (soweit vorhanden) beide gestrichen sind
//   delay    – geänderte minus geplante Zeit in Minuten (Abfahrt, sonst Ankunft); 0, wenn nichts gemeldet ist
//   messages – Typ und Code der Meldungen der DB, z. B. "d34;f2000"
//   terminus – "endet hier"/"beginnt hier", wenn der geänderte Laufweg nach bzw. vor dem Halt leer ist
export const haltStatus = (p, c) => {
	const kinds = KINDS.filter(k => p[k] || c[k]);
	const cs = (k) => c[k]?.cs || p[k]?.ps;
	const cancelled = kinds.filter(k => cs(k) === 'c');
	const status = cancelled.length === kinds.length ? 'gestrichen'
		: cancelled.length ? 'teilweise gestrichen'
		: kinds.some(k => cs(k) === 'a') ? 'zusätzlich' : 'planmäßig';
	const clt = cancelled.map(k => c[k]?.clt).filter(Boolean).sort()[0] || '';

	// Abfahrt, sonst Ankunft (ein hier endender Zug hat nur für die Ankunft eine geänderte Zeit)
	const k = ['dp', 'ar'].find(kind => c[kind]?.ct && p[kind]?.pt);
	const delay = k ? Math.round((new Date(irisTime(c[k].ct)) - new Date(irisTime(p[k].pt))) / 60000) : 0;

	const codes = new Set();
	for (const kind of KINDS) for (const m of c[kind]?.m || []) if (m.t && m.c) codes.add(`${m.t}${m.c}`);
	const messages = [...codes].sort().join(';');

	// cpth="" heißt: der Zug fährt nach (dp) bzw. vor (ar) diesem Halt nicht mehr
	const before = c.ar?.cpth, after = c.dp?.cpth;
	let terminus = '';
	if (status !== 'gestrichen') {
		if (p.dp?.ppth && after === '') terminus = 'endet hier';
		else if (p.ar?.ppth && before === '') terminus = 'beginnt hier';
	}
	// Ankunft und Abfahrt einzeln (Ortszeit Berlin): Soll, Ist (geänderte Zeit, sonst Soll) und Gleis.
	// Ist und Gleis bleiben leer, wenn die Ankunft bzw. Abfahrt gestrichen ist oder der Zug hier endet bzw. beginnt.
	const times = {};
	for (const [kind, name] of [['ar', 'arrival'], ['dp', 'departure']]) {
		const pt = p[kind]?.pt || c[kind]?.pt;
		const gone = !pt || cs(kind) === 'c' || (kind === 'dp' ? after === '' : before === '');
		times[`${name}_planned`] = pt ? berlin(irisTime(pt)) : '';
		times[`${name}_actual`] = gone ? '' : berlin(irisTime(c[kind]?.ct || pt));
		times[`platform_${name}`] = gone ? '' : (c[kind]?.cp || p[kind]?.pp || c[kind]?.pp || '');
	}
	return {status, clt, delay, messages, terminus, before: before ?? '', after: after ?? '', times};
};

const EVENT_FOR = {
	'gestrichen': 'HALT_GESTRICHEN',
	'teilweise gestrichen': 'HALT_TEILWEISE_GESTRICHEN',
	'planmäßig': 'HALT_WIEDERHERGESTELLT',
};

export const runCollect = async (fetchXml, cfg, {now = new Date()} = {}) => {
	const stateDir = path.join(DATA, 'state');
	const stationsFile = path.join(stateDir, 'stations.json');
	const evas = {...readJson(stationsFile, {}), ...(cfg.stationIds || {})};
	const pathRe = new RegExp(cfg.pathRegex, 'i');
	const cutoff = new Date(now.getTime() - KEEP_MS);
	const roles = [...cfg.stations.map(n => [n, 'halt']), ...(cfg.contextStations || []).map(n => [n, 'kontext'])];
	const events = [];
	let errors = 0, requests = 0, halts = 0;
	const get = async (p) => { requests++; return xml.parse(await fetchXml(p)); };

	// gehört der Halt zur beobachteten Linie? Der Laufweg muss zusätzlich über die Strecke führen,
	// damit eine gleichnamige Linie anderswo nicht mitgezählt wird.
	const isLine = (tl, ar, dp) => cfg.categories.includes(tl?.c) && (ar?.l || dp?.l) === cfg.line
		&& pathRe.test(`${ar?.ppth || ''}|${dp?.ppth || ''}`);

	for (const [name, role] of roles) {
		if (!evas[name]) {
			try {
				const list = (await get(`/station/${encodeURIComponent(name)}`)).stations?.station || [];
				const hit = list.find(s => s.name === name) || list[0];
				if (!hit) throw new Error('nicht gefunden');
				evas[name] = hit.eva;
				console.log(`  Station ${name} → ${hit.name} (EVA ${hit.eva})`);
				writeJson(stationsFile, evas);
			} catch (err) { errors++; console.error(`  ✗ Station ${name}: ${err.message}`); continue; }
		}
		const eva = evas[name];

		// Soll-Daten: eine Stundenscheibe ändert sich nach Veröffentlichung nicht, sie wird nur einmal
		// geladen. Leere Scheiben gelten als noch nicht veröffentlicht und werden erneut versucht.
		const planFile = path.join(stateDir, `plan_${eva}.json`);
		const plan = readJson(planFile, {slices: {}, stops: {}});
		const seenLines = {};
		let farthest = 0;
		for (let h = 0; h <= cfg.planHoursAhead; h++) {
			const b = berlin(new Date(now.getTime() + h * HOUR));
			const ymd = b.slice(2, 4) + b.slice(5, 7) + b.slice(8, 10);
			const hh = b.slice(11, 13);
			if (plan.slices[ymd + hh]) { farthest = h; continue; }
			try {
				const stops = (await get(`/plan/${eva}/${ymd}/${hh}`)).timetable?.s || [];
				for (const s of stops) {
					const combo = `${s.tl?.c || '?'} ${s.ar?.l || s.dp?.l || ''}`;
					seenLines[combo] = (seenLines[combo] || 0) + 1;
					if (isLine(s.tl, s.ar, s.dp)) plan.stops[s.id] = {tl: {c: s.tl.c, n: s.tl.n, t: s.tl.t}, ar: slim(s.ar), dp: slim(s.dp)};
				}
				if (stops.length) { plan.slices[ymd + hh] = true; farthest = h; }
			} catch (err) { errors++; console.error(`  ✗ plan ${name} ${ymd} ${hh}: ${err.message}`); }
		}
		for (const k of Object.keys(plan.slices)) if (new Date(irisTime(k + '00')) < cutoff) delete plan.slices[k];
		for (const [id, s] of Object.entries(plan.stops)) {
			if (new Date(irisTime(s.dp?.pt || s.ar?.pt)) < cutoff) delete plan.stops[id];
		}

		// Ist-Daten: alle bekannten Änderungen des Bahnhofs
		let changes;
		try {
			changes = new Map(((await get(`/fchg/${eva}`)).timetable?.s || []).map(s => [s.id, s]));
		} catch (err) { errors++; console.error(`  ✗ fchg ${name}: ${err.message}`); writeJson(planFile, plan); continue; }

		// Zusätzliche Halte und Sonderzüge stehen nur in den Änderungen, nicht im Sollfahrplan
		// (z. B. der Halt eines umgeleiteten Zuges in Treuchtlingen). Sie bringen Zugnummer und Sollzeit mit.
		for (const [id, s] of changes) {
			if (plan.stops[id] || !s.tl?.n || !(s.ar?.pt || s.dp?.pt) || !isLine(s.tl, s.ar, s.dp)) continue;
			plan.stops[id] = {tl: {c: s.tl.c, n: s.tl.n, t: s.tl.t}, ar: slim(s.ar), dp: slim(s.dp), added: true};
		}
		writeJson(planFile, plan);
		const lineHalts = Object.keys(plan.stops).length;
		console.log(`  ${name}: Sollfahrplan bis +${farthest} h, ${lineHalts} Halte der Linie`);
		if (Object.keys(seenLines).length && !lineHalts && role === 'halt') {
			console.error(`  ! ${name}: kein Halt mit Gattung ${cfg.categories.join("/")} und Linie "${cfg.line}". Gesehen: ${Object.keys(seenLines).sort().join(', ')}`);
		}

		const stateFile = path.join(stateDir, `halts_${eva}.json`);
		const state = readJson(stateFile, {});

		for (const [id, p] of Object.entries(plan.stops)) {
			const plannedTime = irisTime(p.dp?.pt || p.ar?.pt);
			const upcoming = new Date(plannedTime) >= now;
			// Nach der Sollzeit wird ein Halt nur weiterverfolgt, solange die API ihn noch liefert
			// (für Endverspätung und späte Streichungen). Fehlt er, bleibt der letzte Stand stehen.
			const prev = state[id];
			// Ein beobachteter Halt, der erst nach seiner Abfahrt auftaucht, wird nicht mehr aufgenommen: Die DB
			// aktualisiert den Anlagezeitpunkt einer Streichung manchmal nachträglich, der Vorlauf wäre dann falsch.
			// Für Treuchtlingen (nur Verbleib des Zuges) gilt das nicht.
			if (!upcoming && ((!prev && role === 'halt') || !changes.has(id) || now - new Date(plannedTime) > FOLLOW_MS)) continue;
			if (upcoming) halts++;
			const c = changes.get(id) || {};
			const cur = haltStatus(p, c);
			const pathChanged = prev && (prev.before !== cur.before || prev.after !== cur.after || prev.terminus !== cur.terminus);
			const event = !prev ? 'ERSTMALS_GESEHEN'
				: prev.status !== cur.status ? (EVENT_FOR[cur.status] || 'STATUS_GEAENDERT')
				: pathChanged ? 'LAUFWEG_GEAENDERT'
				: Math.abs(cur.delay - (prev.loggedDelay ?? 0)) >= DELAY_STEP[role] ? 'VERSPAETUNG' : null;
			if (event) {
				const created = irisTime(cur.clt);
				events.push({
					detected_at: berlin(now), station: name, role, train: `${p.tl.c} ${p.tl.n}`, train_type: p.tl.t || '',
					stop_id: id,
					direction: directionOf(p),
					planned_time: berlin(plannedTime), event,
					old_status: prev?.status || '', new_status: cur.status,
					cancellation_created_at: berlin(created),
					lead_time_h: created ? hoursBetween(created, plannedTime) : '',
					lead_time_detected_h: hoursBetween(now, plannedTime),
					delay_min: cur.delay, messages: cur.messages, terminus: cur.terminus,
					planned_path: [p.ar?.ppth, p.dp?.ppth].filter(Boolean).join(' → '),
					changed_path_before: cur.before, changed_path_after: cur.after,
					...cur.times,
				});
				// Beweissicherung: Soll und Änderung im Wortlaut der API
				appendJsonl(path.join(DATA, 'snapshots', `${berlinDate(now)}.jsonl`),
					{run_at: berlin(now), station: name, stop_id: id, event, plan: p, change: changes.get(id) || null});
			}
			const {times, ...keep} = cur;
			state[id] = {...keep, plannedTime, loggedDelay: event ? cur.delay : (prev?.loggedDelay ?? 0)};
		}
		for (const [k, v] of Object.entries(state)) if (new Date(v.plannedTime) < cutoff) delete state[k];
		writeJson(stateFile, state);
	}

	appendCsv(path.join(DATA, 'events.csv'), EVENT_HEADER, events);
	appendCsv(path.join(DATA, 'runs.csv'), RUN_HEADER,
		[{run_at: berlin(now), halts, events: events.length, errors, requests}]);
	return {events, errors, halts, requests};
};

if (isMain(import.meta.url)) {
	const cfg = loadConfig();
	// lokale Zugangsdaten aus .env (nicht im Repo); auf GitHub kommen sie aus den Secrets
	const envFile = path.join(ROOT, '.env');
	if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
	const {DB_CLIENT_ID, DB_API_KEY} = process.env;
	if (!DB_CLIENT_ID || !DB_API_KEY) {
		console.error('DB_CLIENT_ID und DB_API_KEY fehlen (lokal in .env eintragen, auf GitHub als Secrets). Zugang kostenlos über https://developers.deutschebahn.com (API „Timetables“), siehe README.');
		process.exit(1);
	}
	const fetchXml = async (p) => {
		const res = await withRetry(async () => {
			const r = await fetch(cfg.baseUrl + p, {
				headers: {'DB-Client-Id': DB_CLIENT_ID, 'DB-Api-Key': DB_API_KEY, accept: 'application/xml'},
				signal: AbortSignal.timeout(20000), // hängende Verbindung nicht abwarten
			});
			if (r.status === 404) return '<timetable/>'; // leere oder noch nicht veröffentlichte Stundenscheibe
			if (r.status === 401 || r.status === 403) {
				throw Object.assign(new Error(`HTTP ${r.status}: Zugangsdaten abgelehnt oder API „Timetables“ nicht abonniert`), {fatal: true});
			}
			if (!r.ok) throw new Error(`HTTP ${r.status}`);
			return r.text();
		}, {retries: cfg.maxRetries ?? 3, label: p});
		await sleep(cfg.requestDelayMs ?? 1100); // erlaubt sind 60 Anfragen pro Minute
		return res;
	};
	console.log(`[${berlin(new Date())}] RE1-Monitor`);
	const {events, errors, halts, requests} = await runCollect(fetchXml, cfg);
	const hits = events.filter(e => e.event !== 'ERSTMALS_GESEHEN');
	console.log(`  ${halts} Halte beobachtet, ${events.length} Ereignisse (${hits.length} Änderungen), ${errors} Fehler, ${requests} Anfragen`);
	for (const e of hits) {
		console.log(`  → ${e.event} ${e.train} ${e.station} ${e.planned_time}${e.cancellation_created_at ? ` (angelegt ${e.cancellation_created_at})` : ''}`);
	}
	if (errors && !halts) process.exit(1);
}
