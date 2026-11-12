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
	'detected_at', 'station', 'train', 'stop_id', 'direction', 'planned_time', 'event',
	'old_status', 'new_status', 'cancellation_created_at', 'lead_time_h', 'lead_time_detected_h',
	'planned_path', 'changed_path',
];
export const RUN_HEADER = ['run_at', 'halts', 'events', 'errors', 'requests'];

const HOUR = 36e5;
const KEEP_MS = 3 * 24 * HOUR; // Soll-Daten und Zustand 3 Tage aufbewahren

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

const slim = (e) => e && {pt: e.pt, l: e.l, ppth: e.ppth, ps: e.ps};
const KINDS = ['ar', 'dp'];

// Status eines Halts aus Soll (p) und Änderung (c). Ein Halt gilt als gestrichen,
// wenn Ankunft und Abfahrt (soweit vorhanden) beide gestrichen sind.
export const haltStatus = (p, c) => {
	const kinds = KINDS.filter(k => p[k] || c[k]);
	const cs = (k) => c[k]?.cs || p[k]?.ps;
	const cancelled = kinds.filter(k => cs(k) === 'c');
	const status = cancelled.length === kinds.length ? 'gestrichen'
		: cancelled.length ? 'teilweise gestrichen'
		: kinds.some(k => cs(k) === 'a') ? 'zusätzlich' : 'planmäßig';
	const clt = cancelled.map(k => c[k]?.clt).filter(Boolean).sort()[0] || '';
	return {status, clt, path: c.dp?.cpth || c.ar?.cpth || ''};
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
	const events = [];
	let errors = 0, requests = 0, halts = 0;
	const get = async (p) => { requests++; return xml.parse(await fetchXml(p)); };

	// gehört der Halt zur beobachteten Linie? Der Laufweg muss zusätzlich über die Strecke führen,
	// damit eine gleichnamige Linie anderswo nicht mitgezählt wird.
	const isLine = (tl, ar, dp) => cfg.categories.includes(tl?.c) && (ar?.l || dp?.l) === cfg.line
		&& pathRe.test(`${ar?.ppth || ''}|${dp?.ppth || ''}`);

	for (const name of cfg.stations) {
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
					if (isLine(s.tl, s.ar, s.dp)) plan.stops[s.id] = {tl: {c: s.tl.c, n: s.tl.n}, ar: slim(s.ar), dp: slim(s.dp)};
				}
				if (stops.length) { plan.slices[ymd + hh] = true; farthest = h; }
			} catch (err) { errors++; console.error(`  ✗ plan ${name} ${ymd} ${hh}: ${err.message}`); }
		}
		for (const k of Object.keys(plan.slices)) if (new Date(irisTime(k + '00')) < cutoff) delete plan.slices[k];
		for (const [id, s] of Object.entries(plan.stops)) {
			if (new Date(irisTime(s.dp?.pt || s.ar?.pt)) < cutoff) delete plan.stops[id];
		}
		writeJson(planFile, plan);
		const lineHalts = Object.keys(plan.stops).length;
		console.log(`  ${name}: Sollfahrplan bis +${farthest} h, ${lineHalts} Halte der Linie`);
		if (Object.keys(seenLines).length && !lineHalts) {
			console.error(`  ! ${name}: kein Halt mit Gattung ${cfg.categories.join("/")} und Linie "${cfg.line}". Gesehen: ${Object.keys(seenLines).sort().join(', ')}`);
		}

		// Ist-Daten: alle bekannten Änderungen des Bahnhofs
		let changes;
		try {
			changes = new Map(((await get(`/fchg/${eva}`)).timetable?.s || []).map(s => [s.id, s]));
		} catch (err) { errors++; console.error(`  ✗ fchg ${name}: ${err.message}`); continue; }

		const stateFile = path.join(stateDir, `halts_${eva}.json`);
		const state = readJson(stateFile, {});

		for (const [id, p] of Object.entries(plan.stops)) {
			const plannedTime = irisTime(p.dp?.pt || p.ar?.pt);
			// vergangene Halte bleiben auf ihrem letzten Stand: IRIS entfernt alte Änderungen wieder
			if (new Date(plannedTime) < now) continue;
			halts++;
			const c = changes.get(id) || {};
			const cur = haltStatus(p, c);
			const prev = state[id];
			const event = !prev ? 'ERSTMALS_GESEHEN'
				: prev.status !== cur.status ? (EVENT_FOR[cur.status] || 'STATUS_GEAENDERT')
				: prev.path !== cur.path && cur.path ? 'LAUFWEG_GEAENDERT' : null;
			if (event) {
				const created = irisTime(cur.clt);
				events.push({
					detected_at: berlin(now), station: name, train: `${p.tl.c} ${p.tl.n}`, stop_id: id,
					// Halte in Richtung München haben die Strecke im Laufweg nach dem Halt
					direction: pathRe.test(p.dp?.ppth || '') ? 'S' : 'N',
					planned_time: berlin(plannedTime), event,
					old_status: prev?.status || '', new_status: cur.status,
					cancellation_created_at: berlin(created),
					lead_time_h: created ? hoursBetween(created, plannedTime) : '',
					lead_time_detected_h: hoursBetween(now, plannedTime),
					planned_path: [p.ar?.ppth, p.dp?.ppth].filter(Boolean).join(' → '), changed_path: cur.path,
				});
				// Beweissicherung: Soll und Änderung im Wortlaut der API
				appendJsonl(path.join(DATA, 'snapshots', `${berlinDate(now)}.jsonl`),
					{run_at: berlin(now), station: name, stop_id: id, event, plan: p, change: changes.get(id) || null});
			}
			state[id] = {...cur, plannedTime};
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
