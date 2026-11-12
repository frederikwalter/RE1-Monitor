#!/usr/bin/env node
// RE1-Monitor – optionaler zweiter Sammler über die offizielle "Timetables"-API (IRIS)
// aus dem DB API Marketplace (kostenloser Zugang, Client-ID + API-Key nötig).
//
// Vorteil: Für jede Streichung eines Halts liefert IRIS das Feld "clt"
// (cancellation time) = Zeitpunkt, zu dem die Streichung im System angelegt wurde.
// Nachteil: Sollfahrplan nur ca. 12 h im Voraus abrufbar.
//
// Aufruf:  DB_CLIENT_ID=... DB_API_KEY=... node iris.mjs
import path from 'node:path';
import fs from 'node:fs';
import {XMLParser} from 'fast-xml-parser';
import {
	DATA, loadConfig, readJson, writeJson, appendCsv, withLock, sleep, withRetry, berlin, hoursBetween, ensureDir,
} from './lib.mjs';

export const IRIS_HEADER = [
	'detected_at', 'station', 'train', 'stop_id', 'kind', 'planned_time', 'event',
	'old_status', 'new_status', 'cancellation_created_at', 'lead_time_from_clt_h', 'lead_time_detected_h',
	'planned_path', 'changed_path',
];

const xml = new XMLParser({
	ignoreAttributes: false, attributeNamePrefix: '', parseAttributeValue: false,
	isArray: (name) => ['s', 'm', 'station'].includes(name),
});

// IRIS-Zeitformat YYMMddHHmm (Ortszeit Berlin) → ISO mit korrektem Offset
export const irisTime = (s) => {
	if (!s || s.length < 10) return null;
	const local = `20${s.slice(0, 2)}-${s.slice(2, 4)}-${s.slice(4, 6)}T${s.slice(6, 8)}:${s.slice(8, 10)}:00`;
	// Offset von Europe/Berlin für diesen Zeitpunkt bestimmen
	for (const off of ['+01:00', '+02:00']) {
		const d = new Date(local + off);
		if (berlin(d).slice(0, 16) === local.slice(0, 16)) return d.toISOString();
	}
	return new Date(local + '+01:00').toISOString();
};

const statusOf = (ev) => {
	if (!ev) return '';
	if (ev.cs === 'c') return 'gestrichen';
	if (ev.cs === 'a') return 'zusätzlich';
	return 'planmäßig';
};

export const runIris = async (fetchXml, cfg, {now = new Date()} = {}) => {
	const ic = cfg.iris;
	const dir = path.join(DATA, 'iris');
	ensureDir(path.join(dir, 'plan'));
	const stationsFile = path.join(dir, 'stations.json');
	const evas = readJson(stationsFile, {});
	const events = [];

	for (const name of ic.stations) {
		if (!evas[name]) {
			const doc = xml.parse(await fetchXml(`/station/${encodeURIComponent(name)}`));
			const list = doc.stations?.station || [];
			const hit = list.find(s => s.name === name) || list[0];
			if (!hit) { console.error(`  ✗ Station ${name} nicht gefunden`); continue; }
			evas[name] = hit.eva;
			console.log(`  Station ${name} → ${hit.name} (EVA ${hit.eva})`);
			writeJson(stationsFile, evas);
		}
		const eva = evas[name];

		// Soll-Daten: Stundenscheiben einmalig cachen (ändern sich nach Veröffentlichung nicht)
		const planned = new Map(); // id -> {train, ar, dp}
		for (let h = -6; h <= ic.planHoursAhead; h++) {
			const t = new Date(now.getTime() + h * 36e5);
			const b = berlin(t);
			const ymd = b.slice(2, 4) + b.slice(5, 7) + b.slice(8, 10);
			const hh = b.slice(11, 13);
			const file = path.join(dir, 'plan', `${eva}_${ymd}_${hh}.xml`);
			if (!fs.existsSync(file) && h >= 0) {
				try {
					fs.writeFileSync(file, await fetchXml(`/plan/${eva}/${ymd}/${hh}`));
				} catch (err) { console.error(`  ✗ plan ${name} ${ymd} ${hh}: ${err.message}`); }
			}
			if (!fs.existsSync(file)) continue;
			for (const s of xml.parse(fs.readFileSync(file, 'utf8')).timetable?.s || []) {
				planned.set(s.id, s);
			}
		}

		// Ist-Daten: alle bekannten Änderungen
		let changes = new Map();
		try {
			const raw = await fetchXml(`/fchg/${eva}`);
			changes = new Map((xml.parse(raw).timetable?.s || []).map(s => [s.id, s]));
		} catch (err) { console.error(`  ✗ fchg ${name}: ${err.message}`); continue; }

		const stateFile = path.join(dir, 'state', `${eva}.json`);
		const state = readJson(stateFile, {});
		const debugCombos = {};

		const ids = new Set([...planned.keys(), ...changes.keys()]);
		for (const id of ids) {
			const p = planned.get(id) || {};
			const c = changes.get(id) || {};
			const tl = p.tl || c.tl || {};
			const line = p.ar?.l || p.dp?.l || c.ar?.l || c.dp?.l || '';
			debugCombos[`${tl.c || '?'} ${line}`] = (debugCombos[`${tl.c || '?'} ${line}`] || 0) + 1;
			if (tl.c !== ic.category || line !== ic.line) continue;

			const train = `${tl.c} ${tl.n}`;
			for (const kind of ['ar', 'dp']) {
				const pe = p[kind];
				const ce = c[kind];
				if (!pe && !ce) continue;
				const plannedTime = irisTime(pe?.pt || ce?.pt);
				const cur = {
					status: statusOf({cs: ce?.cs || pe?.ps}),
					clt: ce?.clt || '',
					path: ce?.cpth || '',
				};
				const sk = `${id}|${kind}`;
				const prev = state[sk];
				const row = (event, extra = {}) => ({
					detected_at: berlin(now), station: name, train, stop_id: id,
					kind: kind === 'ar' ? 'Ankunft' : 'Abfahrt', planned_time: berlin(plannedTime), event,
					lead_time_detected_h: hoursBetween(now, plannedTime),
					planned_path: pe?.ppth || '', changed_path: cur.path, ...extra,
				});
				if (!prev) {
					events.push(row('ERSTMALS_GESEHEN', {new_status: cur.status,
						cancellation_created_at: berlin(irisTime(cur.clt)),
						lead_time_from_clt_h: cur.clt ? hoursBetween(irisTime(cur.clt), plannedTime) : ''}));
				} else if (prev.status !== cur.status) {
					events.push(row(cur.status === 'gestrichen' ? 'HALT_GESTRICHEN' : 'STATUS_GEAENDERT', {
						old_status: prev.status, new_status: cur.status,
						cancellation_created_at: berlin(irisTime(cur.clt)),
						lead_time_from_clt_h: cur.clt ? hoursBetween(irisTime(cur.clt), plannedTime) : '',
					}));
				} else if (prev.path !== cur.path && cur.path) {
					events.push(row('LAUFWEG_GEAENDERT', {old_status: prev.status, new_status: cur.status}));
				}
				state[sk] = {...cur, plannedTime};
			}
		}
		// alte Einträge (> 3 Tage) aufräumen
		for (const [k, v] of Object.entries(state)) {
			if (v.plannedTime && new Date(v.plannedTime) < new Date(now.getTime() - 3 * 864e5)) delete state[k];
		}
		writeJson(stateFile, state);
		writeJson(path.join(dir, 'debug', `categories_${eva}.json`), debugCombos);
	}

	appendCsv(path.join(DATA, 'iris_events.csv'), IRIS_HEADER, events);
	return {events};
};

const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (isMain) {
	const cfg = loadConfig();
	const {DB_CLIENT_ID, DB_API_KEY} = process.env;
	if (!DB_CLIENT_ID || !DB_API_KEY) {
		console.error('DB_CLIENT_ID und DB_API_KEY setzen (kostenlos über developers.deutschebahn.com, API "Timetables").');
		process.exit(1);
	}
	const fetchXml = async (p) => {
		const res = await withRetry(async () => {
			const r = await fetch(cfg.iris.baseUrl + p, {
				headers: {'DB-Client-Id': DB_CLIENT_ID, 'DB-Api-Key': DB_API_KEY, accept: 'application/xml'},
			});
			if (r.status === 404) return ''; // leere Stundenscheibe
			if (!r.ok) throw new Error(`HTTP ${r.status}`);
			return r.text();
		}, {label: p});
		await sleep(1100); // max. 60 Anfragen/Minute
		return res;
	};
	await withLock('iris', async () => {
		console.log(`[${berlin(new Date())}] RE1-Sammler IRIS`);
		const {events} = await runIris(fetchXml, cfg);
		const hits = events.filter(e => e.event !== 'ERSTMALS_GESEHEN');
		console.log(`  ${events.length} Ereignisse (${hits.length} Änderungen)`);
		for (const e of hits) console.log(`  → ${e.event} ${e.train} ${e.station} ${e.kind} ${e.planned_time} (angelegt ${e.cancellation_created_at})`);
	});
}
