#!/usr/bin/env node
// RE1-Monitor – Sammler (bahn.de / DB Navigator über db-vendo-client, ohne API-Key)
//
// Ein Lauf:
//   1. fragt an den Ankerbahnhöfen (Standard: Treuchtlingen) Abfahrten UND Ankünfte
//      für jede Stunde im Fenster [jetzt - lookback, jetzt + horizon] ab,
//   2. filtert alle Fahrten der Linie RE1,
//   3. lädt für jede Fahrt den kompletten Laufweg (alle Halte inkl. "fällt aus"-Markierung),
//   4. vergleicht mit dem zuletzt gespeicherten Stand und schreibt jede Änderung
//      mit Zeitstempel nach data/events.csv.
//
// Aufruf:  node collect.mjs [--horizon 72] [--dry-run]
import path from 'node:path';
import {
	DATA, loadConfig, readJson, writeJson, appendCsv, appendJsonl, withLock, sleep, withRetry,
	berlin, berlinDate, hoursBetween, normName,
} from './lib.mjs';

export const EVENT_HEADER = [
	'detected_at', 'trip_key', 'train', 'service_date', 'direction', 'event', 'stop', 'watch_stop',
	'old_value', 'new_value', 'stop_planned_time', 'lead_time_h', 'detail',
];

// ---------- Normalisierung ----------

const stopTime = (s) => s.plannedDeparture || s.plannedArrival || null;

export const isWatch = (name, cfg) => {
	const n = normName(name);
	return cfg.watchStations.some(w => {
		const ww = normName(w);
		return n === ww || n.startsWith(ww + '(') || n.startsWith(ww + ' (');
	});
};

const remarkTexts = (list, prefix = '') => (list || [])
	.map(r => (r.text || r.summary || '').trim())
	.filter(Boolean)
	.map(t => prefix + t);

export const normalizeTrip = (trip, cfg, anchorNames) => {
	const stops = (trip.stopovers || []).map(s => ({
		name: s.stop?.name || '?',
		id: s.stop?.id || null,
		plannedArrival: s.plannedArrival || null,
		plannedDeparture: s.plannedDeparture || null,
		cancelled: Boolean(s.cancelled),
	}));
	const anchorIdx = stops.findIndex(s => anchorNames.some(a => normName(a) === normName(s.name)));
	if (anchorIdx < 0) return null;
	const anchor = stops[anchorIdx];

	const south = new RegExp(cfg.southRegex, 'i');
	const north = new RegExp(cfg.northRegex, 'i');
	const before = stops.slice(0, anchorIdx).map(s => s.name).join('|');
	const after = stops.slice(anchorIdx + 1).map(s => s.name).join('|');
	const direction = (south.test(before) || north.test(after)) ? 'N' : 'S';

	const anchorTime = anchor.plannedDeparture || anchor.plannedArrival;
	const remarks = [
		...remarkTexts(trip.remarks),
		...(trip.stopovers || []).flatMap(s => remarkTexts(s.remarks, `[${s.stop?.name}] `)),
	];

	return {
		key: `${berlin(anchorTime).slice(0, 16).replace(':', '')}_${direction}`,
		tripId: trip.id,
		train: trip.line?.name || '',
		fahrtNr: trip.line?.fahrtNr || '',
		direction,
		serviceDate: berlinDate(stopTime(stops[0]) || anchorTime),
		anchor: {name: anchor.name, planned: anchorTime},
		origin: stops[0]?.name,
		destination: stops[stops.length - 1]?.name,
		cancelled: Boolean(trip.cancelled),
		stops,
		remarks: [...new Set(remarks)].sort(),
	};
};

// ---------- Vergleich zweier Stände ----------

const stopSummary = (st, cfg) => st.stops
	.filter(s => isWatch(s.name, cfg))
	.map(s => `${s.name}:${s.cancelled ? 'entfällt' : 'Halt'}`)
	.join('; ') || 'kein Beobachtungshalt im Laufweg';

export const diffStates = (prev, cur, cfg, now) => {
	const ev = [];
	const base = (event, extra = {}) => ({
		detected_at: berlin(now), trip_key: cur.key, train: cur.train, service_date: cur.serviceDate,
		direction: cur.direction, event, ...extra,
	});
	const withStop = (event, s, old_value, new_value, detail = '') => base(event, {
		stop: s.name, watch_stop: isWatch(s.name, cfg) ? 'ja' : '', old_value, new_value,
		stop_planned_time: berlin(stopTime(s)), lead_time_h: hoursBetween(now, stopTime(s)), detail,
	});

	if (!prev) {
		ev.push(base('FAHRT_ERSTMALS_GESEHEN', {
			old_value: '', new_value: stopSummary(cur, cfg),
			stop_planned_time: berlin(cur.anchor.planned), lead_time_h: hoursBetween(now, cur.anchor.planned),
			detail: `${cur.origin} → ${cur.destination}; ${cur.stops.length} Halte`,
		}));
		// Halte, die schon beim ersten Sehen als "entfällt" markiert sind
		for (const s of cur.stops) if (s.cancelled) ev.push(withStop('HALT_BEREITS_GESTRICHEN', s, '', 'entfällt'));
		return ev;
	}

	if (prev.missing) {
		ev.push(base('FAHRT_WIEDER_AUFGETAUCHT', {
			stop_planned_time: berlin(cur.anchor.planned), lead_time_h: hoursBetween(now, cur.anchor.planned),
		}));
	}

	const pMap = new Map(prev.stops.map(s => [normName(s.name), s]));
	const cMap = new Map(cur.stops.map(s => [normName(s.name), s]));

	for (const [k, s] of cMap) {
		const p = pMap.get(k);
		if (!p) { ev.push(withStop('HALT_HINZUGEFUEGT', s, '', s.cancelled ? 'entfällt' : 'Halt')); continue; }
		if (!p.cancelled && s.cancelled) ev.push(withStop('HALT_GESTRICHEN', s, 'Halt', 'entfällt'));
		if (p.cancelled && !s.cancelled) ev.push(withStop('HALT_WIEDERHERGESTELLT', s, 'entfällt', 'Halt'));
		if (p.plannedArrival !== s.plannedArrival || p.plannedDeparture !== s.plannedDeparture) {
			ev.push(withStop('SOLLZEIT_GEAENDERT', s,
				`${berlin(p.plannedArrival).slice(11, 16)}/${berlin(p.plannedDeparture).slice(11, 16)}`,
				`${berlin(s.plannedArrival).slice(11, 16)}/${berlin(s.plannedDeparture).slice(11, 16)}`));
		}
	}
	for (const [k, p] of pMap) {
		if (!cMap.has(k)) ev.push(withStop('HALT_AUS_LAUFWEG_ENTFERNT', p, p.cancelled ? 'entfällt' : 'Halt', ''));
	}

	if (!prev.cancelled && cur.cancelled) ev.push(base('FAHRT_GESTRICHEN', {old_value: 'fährt', new_value: 'fällt aus'}));
	if (prev.cancelled && !cur.cancelled) ev.push(base('FAHRT_WIEDER_AKTIV', {old_value: 'fällt aus', new_value: 'fährt'}));
	if (prev.destination !== cur.destination || prev.origin !== cur.origin) {
		ev.push(base('START_ZIEL_GEAENDERT', {
			old_value: `${prev.origin} → ${prev.destination}`, new_value: `${cur.origin} → ${cur.destination}`,
		}));
	}

	const pr = new Set(prev.remarks || []);
	const cr = new Set(cur.remarks || []);
	for (const r of cr) if (!pr.has(r)) ev.push(base('HINWEIS_NEU', {new_value: r}));
	for (const r of pr) if (!cr.has(r)) ev.push(base('HINWEIS_ENTFERNT', {old_value: r}));

	return ev;
};

// ---------- API-Zugriff ----------

const resolveStations = async (client, cfg, names, delay) => {
	const cacheFile = path.join(DATA, 'stations.json');
	const cache = {...readJson(cacheFile, {}), ...(cfg.stationIds || {})};
	for (const name of names) {
		if (cache[name]) continue;
		const res = await withRetry(() => client.locations(name, {results: 3, addresses: false, poi: false}),
			{label: `Bahnhofssuche ${name}`});
		const hit = res.find(l => l.type === 'stop' || l.type === 'station');
		if (!hit) throw new Error(`Bahnhof nicht gefunden: ${name}`);
		cache[name] = hit.id;
		console.log(`  Bahnhof ${name} → ${hit.name} (${hit.id})`);
		await sleep(delay);
	}
	writeJson(cacheFile, cache);
	return cache;
};

export const runCollect = async (client, cfg, {horizonHours, now = new Date(), dryRun = false} = {}) => {
	const delay = cfg.requestDelayMs ?? 1200;
	const retry = (fn, label) => withRetry(fn, {retries: cfg.maxRetries ?? 3, label});
	const lineRe = new RegExp(cfg.lineRegex, 'i');
	const ids = await resolveStations(client, cfg, cfg.anchorStations, delay);

	const start = new Date(now.getTime() - (cfg.lookbackHours ?? 1) * 36e5);
	start.setMinutes(0, 0, 0);
	const end = new Date(now.getTime() + horizonHours * 36e5);

	// 1. Fahrten über die Tafeln finden
	const found = new Map(); // tripId -> line name
	const okWindows = [];
	const linesSeen = {};
	let errors = 0;
	for (let t = start; t < end; t = new Date(t.getTime() + 36e5)) {
		let windowOk = true;
		for (const anchor of cfg.anchorStations) {
			for (const kind of ['departures', 'arrivals']) {
				try {
					const res = await retry(() => client[kind](ids[anchor], {
						when: t, duration: 60, remarks: false, stopovers: false,
					}), `${kind} ${anchor} ${berlin(t)}`);
					for (const d of res[kind] || []) {
						const name = d.line?.name || '';
						linesSeen[name] = (linesSeen[name] || 0) + 1;
						if (lineRe.test(name) && d.tripId) found.set(d.tripId, name);
					}
				} catch (err) {
					windowOk = false; errors++;
					console.error(`  ✗ ${kind} ${anchor} ${berlin(t)}: ${err.message}`);
				}
				await sleep(delay);
			}
		}
		if (windowOk) okWindows.push([t, new Date(t.getTime() + 36e5)]);
	}
	console.log(`  ${found.size} RE1-Fahrten auf den Tafeln gefunden`);

	// 2. Laufwege laden und normalisieren
	const current = new Map();
	for (const [tripId] of found) {
		try {
			const {trip} = await retry(() => client.trip(tripId, {stopovers: true, remarks: true, polyline: false}),
				`Fahrt ${tripId.slice(0, 30)}`);
			const st = normalizeTrip(trip, cfg, cfg.anchorStations);
			if (st) current.set(st.key, st);
		} catch (err) {
			errors++;
			console.error(`  ✗ Fahrt ${tripId.slice(0, 40)}…: ${err.message}`);
		}
		await sleep(delay);
	}

	// 3. Mit gespeichertem Stand vergleichen
	const stateDir = path.join(DATA, 'state');
	const indexFile = path.join(DATA, 'index.json');
	const index = readJson(indexFile, {}); // key -> {anchorPlanned, missing}
	const events = [];
	for (const [key, st] of current) {
		const prevFile = path.join(stateDir, `${key}.json`);
		const prev = readJson(prevFile);
		if (prev && index[key]?.missing) prev.missing = true;
		events.push(...diffStates(prev, st, cfg, now));
		if (!dryRun) {
			writeJson(prevFile, {...st, firstSeen: prev?.firstSeen || berlin(now), lastSeen: berlin(now)});
			appendJsonl(path.join(DATA, 'snapshots', `${berlinDate(now)}.jsonl`), {run_at: berlin(now), ...st});
		}
		index[key] = {anchorPlanned: st.anchor.planned, train: st.train, serviceDate: st.serviceDate, missing: false};
	}
	// bekannte Fahrten, die in einem erfolgreich abgefragten Fenster nicht mehr auftauchen
	const inOkWindow = (iso) => okWindows.some(([a, b]) => new Date(iso) >= a && new Date(iso) < b);
	for (const [key, meta] of Object.entries(index)) {
		if (current.has(key) || meta.missing || !inOkWindow(meta.anchorPlanned)) continue;
		if (new Date(meta.anchorPlanned) < now) continue; // schon vorbei, Tafel zeigt sie evtl. nicht mehr
		events.push({
			detected_at: berlin(now), trip_key: key, train: meta.train, service_date: meta.serviceDate,
			direction: key.slice(-1), event: 'FAHRT_NICHT_MEHR_GEFUNDEN',
			stop_planned_time: berlin(meta.anchorPlanned), lead_time_h: hoursBetween(now, meta.anchorPlanned),
		});
		meta.missing = true;
	}

	if (!dryRun) {
		writeJson(indexFile, index);
		appendCsv(path.join(DATA, 'events.csv'), EVENT_HEADER, events);
		appendCsv(path.join(DATA, 'runs.csv'),
			['run_at', 'horizon_h', 'trips', 'events', 'errors'],
			[{run_at: berlin(now), horizon_h: horizonHours, trips: current.size, events: events.length, errors}]);
		writeJson(path.join(DATA, 'debug', 'lines_seen_at_anchor.json'), linesSeen);
	}
	return {trips: current.size, events, errors, linesSeen};
};

// ---------- CLI ----------

const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (isMain) {
	const cfg = loadConfig();
	const args = process.argv.slice(2);
	const hIdx = args.indexOf('--horizon');
	const horizonHours = hIdx >= 0 ? Number(args[hIdx + 1]) : cfg.defaultHorizonHours;
	const dryRun = args.includes('--dry-run');

	if (/BITTE-EMAIL-EINTRAGEN/.test(cfg.userAgent)) {
		console.error('Bitte in config.json bei "userAgent" eine Kontaktadresse eintragen.');
		process.exit(1);
	}

	const {createClient} = await import('db-vendo-client');
	const {profile} = await import(`db-vendo-client/p/${cfg.profile}/index.js`);
	const client = createClient(profile, cfg.userAgent, {enrichStations: false});

	await withLock('collect', async () => {
		const t0 = Date.now();
		console.log(`[${berlin(new Date())}] RE1-Sammler, Horizont ${horizonHours} h`);
		const res = await runCollect(client, cfg, {horizonHours, dryRun});
		console.log(`  ${res.trips} Fahrten, ${res.events.length} Ereignisse, ${res.errors} Fehler, ${Math.round((Date.now() - t0) / 1000)} s`);
		for (const e of res.events.filter(e => e.watch_stop || /FAHRT_(GESTRICHEN|NICHT)/.test(e.event))) {
			console.log(`  → ${e.event} ${e.trip_key} ${e.stop || ''} (${e.lead_time_h} h vor Soll)`);
		}
	});
}
