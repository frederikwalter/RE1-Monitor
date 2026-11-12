#!/usr/bin/env node
// RE1-Monitor – zweiter Sammler über die offizielle "Timetables"-API (IRIS)
// aus dem DB API Marketplace (kostenloser Zugang, Client-ID + API-Key nötig).
//
// Vorteil: Für jede Streichung eines Halts liefert IRIS das Feld "clt"
// (cancellation time) = Zeitpunkt, zu dem die Streichung im System angelegt wurde.
// Nachteil: Die API kennt nur Bahnhöfe, und der Sollfahrplan ist nur ca. 12 h im Voraus abrufbar.
//
// Aufruf:  DB_CLIENT_ID=... DB_API_KEY=... node iris.mjs
import path from 'node:path';
import {XMLParser} from 'fast-xml-parser';
import {
	DATA, loadConfig, readJson, writeJson, appendCsv, sleep, withRetry, berlin, hoursBetween, isMain,
} from './lib.mjs';

export const IRIS_HEADER = [
	'detected_at', 'station', 'train', 'stop_id', 'kind', 'planned_time', 'event',
	'old_status', 'new_status', 'cancellation_created_at', 'lead_time_from_clt_h', 'lead_time_detected_h',
	'planned_path', 'changed_path',
];

const KEEP_MS = 3 * 864e5; // Soll-Daten und Zustand 3 Tage aufbewahren

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

const statusOf = (cs) => cs === 'c' ? 'gestrichen' : cs === 'a' ? 'zusätzlich' : 'planmäßig';
const lineOf = (s) => s?.ar?.l || s?.dp?.l || '';
const slim = (e) => e && {pt: e.pt, l: e.l, ppth: e.ppth, ps: e.ps};

export const runIris = async (fetchXml, cfg, {now = new Date()} = {}) => {
	const ic = cfg.iris;
	const dir = path.join(DATA, 'iris');
	const stationsFile = path.join(dir, 'stations.json');
	const evas = {...readJson(stationsFile, {}), ...(ic.stationIds || {})};
	const isLine = (tl, line) => tl?.c === ic.category && line === ic.line;
	const events = [];
	let errors = 0;

	for (const name of ic.stations) {
		if (!evas[name]) {
			try {
				const list = xml.parse(await fetchXml(`/station/${encodeURIComponent(name)}`)).stations?.station || [];
				const hit = list.find(s => s.name === name) || list[0];
				if (!hit) throw new Error('nicht gefunden');
				evas[name] = hit.eva;
				console.log(`  Station ${name} → ${hit.name} (EVA ${hit.eva})`);
				writeJson(stationsFile, evas);
			} catch (err) { errors++; console.error(`  ✗ Station ${name}: ${err.message}`); continue; }
		}
		const eva = evas[name];

		// Soll-Daten: jede Stundenscheibe nur einmal laden (sie ändert sich nach Veröffentlichung nicht)
		// und davon nur die Halte der beobachteten Linie behalten.
		const planFile = path.join(dir, `plan_${eva}.json`);
		const plan = readJson(planFile, {slices: {}, stops: {}});
		const seenLines = {};
		for (let h = 0; h <= ic.planHoursAhead; h++) {
			const t = new Date(now.getTime() + h * 36e5);
			const b = berlin(t);
			const ymd = b.slice(2, 4) + b.slice(5, 7) + b.slice(8, 10);
			const hh = b.slice(11, 13);
			if (plan.slices[`${ymd}${hh}`]) continue;
			try {
				for (const s of xml.parse(await fetchXml(`/plan/${eva}/${ymd}/${hh}`)).timetable?.s || []) {
					const combo = `${s.tl?.c || '?'} ${lineOf(s)}`;
					seenLines[combo] = (seenLines[combo] || 0) + 1;
					if (isLine(s.tl, lineOf(s))) plan.stops[s.id] = {tl: {c: s.tl.c, n: s.tl.n}, ar: slim(s.ar), dp: slim(s.dp)};
				}
				plan.slices[`${ymd}${hh}`] = true;
			} catch (err) { errors++; console.error(`  ✗ plan ${name} ${ymd} ${hh}: ${err.message}`); }
		}
		const cutoff = new Date(now.getTime() - KEEP_MS);
		for (const k of Object.keys(plan.slices)) if (new Date(irisTime(k + '00')) < cutoff) delete plan.slices[k];
		for (const [id, s] of Object.entries(plan.stops)) {
			if (new Date(irisTime(s.dp?.pt || s.ar?.pt)) < cutoff) delete plan.stops[id];
		}
		writeJson(planFile, plan);
		if (Object.keys(seenLines).length && !Object.keys(plan.stops).length) {
			console.error(`  ! ${name}: kein Halt mit Gattung "${ic.category}" und Linie "${ic.line}". Gesehen: ${Object.keys(seenLines).join(', ')}`);
		}

		// Ist-Daten: alle bekannten Änderungen
		let changes;
		try {
			changes = new Map((xml.parse(await fetchXml(`/fchg/${eva}`)).timetable?.s || []).map(s => [s.id, s]));
		} catch (err) { errors++; console.error(`  ✗ fchg ${name}: ${err.message}`); continue; }

		const stateFile = path.join(dir, `state_${eva}.json`);
		const state = readJson(stateFile, {});

		for (const id of new Set([...Object.keys(plan.stops), ...changes.keys()])) {
			const p = plan.stops[id] || {};
			const c = changes.get(id) || {};
			const tl = p.tl || c.tl || {};
			if (!isLine(tl, lineOf(p) || lineOf(c))) continue;

			const train = `${tl.c} ${tl.n}`;
			for (const kind of ['ar', 'dp']) {
				const pe = p[kind];
				const ce = c[kind];
				if (!pe && !ce) continue;
				const plannedTime = irisTime(pe?.pt || ce?.pt);
				const cur = {status: statusOf(ce?.cs || pe?.ps), clt: ce?.clt || '', path: ce?.cpth || ''};
				const sk = `${id}|${kind}`;
				const prev = state[sk];
				const row = (event, extra = {}) => ({
					detected_at: berlin(now), station: name, train, stop_id: id,
					kind: kind === 'ar' ? 'Ankunft' : 'Abfahrt', planned_time: berlin(plannedTime), event,
					new_status: cur.status,
					cancellation_created_at: berlin(irisTime(cur.clt)),
					lead_time_from_clt_h: cur.clt ? hoursBetween(irisTime(cur.clt), plannedTime) : '',
					lead_time_detected_h: hoursBetween(now, plannedTime),
					planned_path: pe?.ppth || '', changed_path: cur.path, ...extra,
				});
				if (!prev) events.push(row('ERSTMALS_GESEHEN'));
				else if (prev.status !== cur.status) {
					events.push(row(cur.status === 'gestrichen' ? 'HALT_GESTRICHEN' : 'STATUS_GEAENDERT', {old_status: prev.status}));
				} else if (prev.path !== cur.path && cur.path) {
					events.push(row('LAUFWEG_GEAENDERT', {old_status: prev.status}));
				}
				state[sk] = {...cur, plannedTime};
			}
		}
		for (const [k, v] of Object.entries(state)) {
			if (v.plannedTime && new Date(v.plannedTime) < cutoff) delete state[k];
		}
		writeJson(stateFile, state);
	}

	appendCsv(path.join(DATA, 'iris_events.csv'), IRIS_HEADER, events);
	return {events, errors};
};

if (isMain(import.meta.url)) {
	const cfg = loadConfig();
	const {DB_CLIENT_ID, DB_API_KEY} = process.env;
	if (!DB_CLIENT_ID || !DB_API_KEY) {
		// kein Fehler: der Workflow soll auch ohne Zugangsdaten durchlaufen
		console.log('IRIS übersprungen: DB_CLIENT_ID und DB_API_KEY sind nicht gesetzt (kostenlos über developers.deutschebahn.com, API "Timetables").');
		process.exit(0);
	}
	const fetchXml = async (p) => {
		const res = await withRetry(async () => {
			const r = await fetch(cfg.iris.baseUrl + p, {
				headers: {'DB-Client-Id': DB_CLIENT_ID, 'DB-Api-Key': DB_API_KEY, accept: 'application/xml'},
			});
			if (r.status === 404) return '<timetable/>'; // leere Stundenscheibe
			if (!r.ok) throw new Error(`HTTP ${r.status}`);
			return r.text();
		}, {label: p});
		await sleep(1100); // max. 60 Anfragen/Minute
		return res;
	};
	console.log(`[${berlin(new Date())}] RE1-Sammler IRIS`);
	const {events, errors} = await runIris(fetchXml, cfg);
	const hits = events.filter(e => e.event !== 'ERSTMALS_GESEHEN');
	console.log(`  ${events.length} Ereignisse (${hits.length} Änderungen), ${errors} Fehler`);
	for (const e of hits) console.log(`  → ${e.event} ${e.train} ${e.station} ${e.kind} ${e.planned_time} (angelegt ${e.cancellation_created_at})`);
	if (errors && !events.length) process.exit(1);
}
