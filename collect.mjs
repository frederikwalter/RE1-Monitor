#!/usr/bin/env node
// RE1-Monitor – Sammler (bahn.de / DB Navigator über db-vendo-client, ohne API-Key)
//
// Die Schnittstelle kennt keine Suche nach Zugnummer. Ein Lauf hat deshalb zwei Phasen:
//   1. Entdecken: Abfahrts- und Ankunftstafel am Ankerbahnhof (Treuchtlingen), aber nur für
//      Stundenfenster, die noch nie oder vor mehr als `rescanHours` abgefragt wurden.
//   2. Direktabruf: Jede bereits bekannte Fahrt wird über ihre Fahrt-ID geladen, ohne Tafel.
//      Ist die ID ungültig geworden, wird das Stundenfenster der Fahrt neu abgefragt.
// Der Laufweg jeder Fahrt wird mit dem letzten gespeicherten Stand verglichen; jede Änderung
// landet mit Zeitstempel in data/events.csv.
//
// Aufruf:  node collect.mjs [--horizon 72] [--dry-run]
import path from 'node:path';
import {
	DATA, loadConfig, readJson, writeJson, appendCsv, appendJsonl, sleep, withRetry,
	berlin, berlinDate, hoursBetween, normName, isMain,
} from './lib.mjs';

export const EVENT_HEADER = [
	'detected_at', 'trip_key', 'train', 'service_date', 'direction', 'event', 'stop', 'watch_stop',
	'old_value', 'new_value', 'stop_planned_time', 'lead_time_h', 'detail',
];
export const RUN_HEADER = ['run_at', 'horizon_h', 'trips', 'events', 'errors', 'board_requests', 'trip_requests'];

const HOUR = 36e5;

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

export const normalizeTrip = (trip, cfg) => {
	const stops = (trip.stopovers || []).map(s => ({
		name: s.stop?.name || '?',
		id: s.stop?.id || null,
		plannedArrival: s.plannedArrival || null,
		plannedDeparture: s.plannedDeparture || null,
		cancelled: Boolean(s.cancelled),
	}));
	if (!stops.length) return null;

	// Richtung: liegt ein südlicher Halt vor einem nördlichen, fährt der Zug nach Norden.
	const firstIdx = (re) => stops.findIndex(s => new RegExp(re, 'i').test(s.name));
	const south = firstIdx(cfg.southRegex);
	const north = firstIdx(cfg.northRegex);
	const anchorIdx = stops.findIndex(s => cfg.anchorStations.some(a => normName(a) === normName(s.name)));
	let direction = '?';
	if (south >= 0 && north >= 0) direction = south < north ? 'N' : 'S';
	else if (anchorIdx >= 0 && south >= 0) direction = south < anchorIdx ? 'N' : 'S';
	else if (anchorIdx >= 0 && north >= 0) direction = north > anchorIdx ? 'N' : 'S';

	// Bezugszeit: Sollzeit am Ankerbahnhof, sonst am ersten Halt
	const ref = stops[anchorIdx >= 0 ? anchorIdx : 0];
	const refPlanned = stopTime(ref);
	const serviceDate = berlinDate(stopTime(stops[0]) || refPlanned);

	// Schlüssel: Betriebstag + Zugnummer. Manche Antworten liefern statt der Zugnummer nur
	// die Ziffern der Linie ("1"); dann greift Sollzeit am Anker + Richtung.
	const train = trip.line?.name || '';
	const fahrtNr = String(trip.line?.fahrtNr || '');
	const hasNr = fahrtNr && fahrtNr !== train.replace(/\D/g, '');
	const key = hasNr
		? `${serviceDate}_${fahrtNr}`
		: `${berlin(refPlanned).slice(0, 16).replace(':', '')}_${direction}`;

	const remarks = [
		...remarkTexts(trip.remarks),
		...(trip.stopovers || []).flatMap(s => remarkTexts(s.remarks, `[${s.stop?.name}] `)),
	];

	return {
		key,
		tripId: trip.id,
		train: hasNr ? `${train} (${fahrtNr})` : train,
		fahrtNr: hasNr ? fahrtNr : '',
		direction,
		serviceDate,
		anchor: {name: ref.name, planned: refPlanned},
		origin: stops[0].name,
		destination: stops[stops.length - 1].name,
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

const resolveStations = async (client, cfg, delay) => {
	const cacheFile = path.join(DATA, 'state', 'stations.json');
	const cache = {...readJson(cacheFile, {}), ...(cfg.stationIds || {})};
	for (const name of cfg.anchorStations) {
		if (cache[name]) continue;
		const res = await withRetry(() => client.locations(name, {results: 3, addresses: false, poi: false}),
			{label: `Bahnhofssuche ${name}`});
		const hit = res.find(l => l.type === 'stop' || l.type === 'station');
		if (!hit) throw new Error(`Bahnhof nicht gefunden: ${name}`);
		cache[name] = hit.id;
		console.log(`  Bahnhof ${name} → ${hit.name} (${hit.id})`);
		writeJson(cacheFile, cache);
		await sleep(delay);
	}
	return cache;
};

const hourStart = (d) => { const t = new Date(d); t.setMinutes(0, 0, 0); return t; };

export const runCollect = async (client, cfg, {horizonHours, now = new Date(), dryRun = false} = {}) => {
	const delay = cfg.requestDelayMs ?? 1200;
	const retries = cfg.maxRetries ?? 3;
	const lineRe = new RegExp(cfg.lineRegex, 'i');
	const ids = await resolveStations(client, cfg, delay);

	const start = hourStart(now.getTime() - (cfg.lookbackHours ?? 1) * HOUR);
	const end = new Date(now.getTime() + horizonHours * HOUR);

	const stateDir = path.join(DATA, 'state');
	const indexFile = path.join(DATA, 'index.json');
	const windowsFile = path.join(stateDir, 'windows.json');
	const index = readJson(indexFile, {});     // key -> {tripId, anchorPlanned, train, serviceDate, direction, missing}
	const windows = readJson(windowsFile, {}); // ISO-Stundenbeginn -> Zeitpunkt der letzten erfolgreichen Abfrage

	const found = new Map();       // tripId -> Linienname (von den Tafeln)
	const scannedOk = new Set();   // in diesem Lauf erfolgreich abgefragte Fenster
	const scannedFail = new Set();
	const linesSeen = {};
	let errors = 0, boardRequests = 0, boardOk = 0, tripRequests = 0;
	// Schlagen die ersten Anfragen alle fehl, sperrt die DB vermutlich die IP-Adresse: Lauf abbrechen
	const blocked = () => !boardOk && errors >= 4;

	const scanWindow = async (t) => {
		const iso = t.toISOString();
		if (scannedOk.has(iso) || scannedFail.has(iso)) return;
		let ok = true;
		for (const anchor of cfg.anchorStations) {
			for (const kind of ['departures', 'arrivals']) {
				boardRequests++;
				try {
					const res = await withRetry(() => client[kind](ids[anchor], {
						when: t, duration: 60, remarks: false, stopovers: false,
					}), {retries, label: `${kind} ${anchor} ${berlin(t)}`});
					boardOk++;
					for (const d of res[kind] || []) {
						const name = d.line?.name || '';
						linesSeen[name] = (linesSeen[name] || 0) + 1;
						if (lineRe.test(name) && d.tripId) found.set(d.tripId, name);
					}
				} catch (err) {
					ok = false; errors++;
					console.error(`  ✗ ${kind} ${anchor} ${berlin(t)}: ${err.message}`);
				}
				await sleep(delay);
			}
		}
		if (ok) { scannedOk.add(iso); windows[iso] = now.toISOString(); } else scannedFail.add(iso);
	};

	// 1. Entdecken: nur neue oder länger nicht abgefragte Stundenfenster
	const rescanMs = (cfg.rescanHours ?? 6) * HOUR;
	for (let t = start; t < end; t = new Date(t.getTime() + HOUR)) {
		const last = windows[t.toISOString()];
		if (blocked()) break;
		if (!last || now - new Date(last) >= rescanMs) await scanWindow(t);
	}
	for (const iso of Object.keys(windows)) if (new Date(iso) < start) delete windows[iso];

	const current = new Map(); // key -> normalisierter Stand
	const fetched = new Set(); // bereits geladene Fahrt-IDs
	const loadTrip = async (tripId, tries) => {
		fetched.add(tripId);
		tripRequests++;
		try {
			const {trip} = await withRetry(() => client.trip(tripId, {stopovers: true, remarks: true, polyline: false}),
				{retries: tries, label: `Fahrt ${tripId.slice(0, 30)}`});
			return normalizeTrip(trip, cfg);
		} finally { await sleep(delay); }
	};

	// 2. Direktabruf aller bekannten, noch anstehenden Fahrten
	const stale = []; // Schlüssel, deren Fahrt-ID nicht mehr funktioniert
	for (const [key, meta] of Object.entries(index)) {
		const planned = new Date(meta.anchorPlanned);
		if (blocked() || planned < start || planned >= end || meta.missing || !meta.tripId) continue;
		try {
			const st = await loadTrip(meta.tripId, Math.min(retries, 1));
			if (st) current.set(st.key, st); else stale.push(key);
		} catch (err) {
			stale.push(key);
			console.error(`  ! Direktabruf ${key} fehlgeschlagen (${err.message}), Tafel wird neu abgefragt`);
		}
	}
	for (const key of stale) await scanWindow(hourStart(index[key].anchorPlanned));

	// 3. Laufwege der auf den Tafeln neu gefundenen Fahrten
	for (const tripId of found.keys()) {
		if (fetched.has(tripId)) continue;
		try {
			const st = await loadTrip(tripId, retries);
			if (st) current.set(st.key, st);
		} catch (err) {
			errors++;
			console.error(`  ✗ Fahrt ${tripId.slice(0, 40)}…: ${err.message}`);
		}
	}
	console.log(`  ${boardRequests} Tafel-Anfragen, ${tripRequests} Fahrt-Anfragen, ${current.size} RE1-Fahrten`);

	// 4. Mit gespeichertem Stand vergleichen
	const events = [];
	for (const [key, st] of current) {
		const prevFile = path.join(stateDir, 'trips', `${key}.json`);
		const prev = readJson(prevFile);
		if (prev && index[key]?.missing) prev.missing = true;
		const evs = diffStates(prev, st, cfg, now);
		events.push(...evs);
		// Stand und Schnappschuss nur schreiben, wenn sich etwas geändert hat
		if (!dryRun && (evs.length || prev?.tripId !== st.tripId)) {
			writeJson(prevFile, {...st, firstSeen: prev?.firstSeen || berlin(now), lastChange: berlin(now)});
			if (evs.length) appendJsonl(path.join(DATA, 'snapshots', `${berlinDate(now)}.jsonl`), {run_at: berlin(now), ...st});
		}
		index[key] = {
			tripId: st.tripId, anchorPlanned: st.anchor.planned, train: st.train,
			serviceDate: st.serviceDate, direction: st.direction, missing: false,
		};
	}

	// bekannte Fahrten, deren ID ungültig ist und die auch auf der Tafel fehlen
	for (const key of stale) {
		const meta = index[key];
		if (current.has(key) || !scannedOk.has(hourStart(meta.anchorPlanned).toISOString())) continue;
		if (new Date(meta.anchorPlanned) < now) continue; // schon vorbei, Tafel zeigt sie evtl. nicht mehr
		events.push({
			detected_at: berlin(now), trip_key: key, train: meta.train, service_date: meta.serviceDate,
			direction: meta.direction, event: 'FAHRT_NICHT_MEHR_GEFUNDEN',
			stop_planned_time: berlin(meta.anchorPlanned), lead_time_h: hoursBetween(now, meta.anchorPlanned),
		});
		meta.missing = true;
	}
	// alte Einträge (> 7 Tage) aus dem Index entfernen; die Stände in state/trips bleiben erhalten
	for (const [key, meta] of Object.entries(index)) {
		if (new Date(meta.anchorPlanned) < now.getTime() - 7 * 24 * HOUR) delete index[key];
	}

	if (!dryRun) {
		writeJson(indexFile, index);
		writeJson(windowsFile, windows);
		appendCsv(path.join(DATA, 'events.csv'), EVENT_HEADER, events);
		appendCsv(path.join(DATA, 'runs.csv'), RUN_HEADER, [{
			run_at: berlin(now), horizon_h: horizonHours, trips: current.size, events: events.length, errors,
			board_requests: boardRequests, trip_requests: tripRequests,
		}]);
		writeJson(path.join(stateDir, 'lines_seen_at_anchor.json'), linesSeen);
	}
	return {trips: current.size, events, errors, boardRequests, tripRequests, linesSeen, blocked: blocked()};
};

// ---------- CLI ----------

if (isMain(import.meta.url)) {
	const cfg = loadConfig();
	const args = process.argv.slice(2);
	const hIdx = args.indexOf('--horizon');
	const horizonHours = hIdx >= 0 ? Number(args[hIdx + 1]) : cfg.defaultHorizonHours;
	const dryRun = args.includes('--dry-run');
	if (!Number.isFinite(horizonHours) || horizonHours <= 0) {
		console.error('--horizon erwartet eine Stundenzahl > 0');
		process.exit(2);
	}

	const {createClient} = await import('db-vendo-client');
	const {profile} = await import(`db-vendo-client/p/${cfg.profile}/index.js`);
	const client = createClient(profile, process.env.RE1_USER_AGENT || cfg.userAgent, {enrichStations: false});

	const t0 = Date.now();
	console.log(`[${berlin(new Date())}] RE1-Sammler, Horizont ${horizonHours} h${dryRun ? ' (Probelauf, nichts wird gespeichert)' : ''}`);
	const res = await runCollect(client, cfg, {horizonHours, dryRun});
	console.log(`  ${res.events.length} Ereignisse, ${res.errors} Fehler, ${Math.round((Date.now() - t0) / 1000)} s`);
	for (const e of res.events.filter(e => e.watch_stop || /FAHRT_(GESTRICHEN|NICHT)/.test(e.event))) {
		console.log(`  → ${e.event} ${e.trip_key} ${e.stop || ''} (${e.lead_time_h} h vor Soll)`);
	}
	if (res.blocked) {
		console.error('Abbruch: Alle Anfragen wurden abgelehnt. Vermutlich sperrt die DB diese IP-Adresse (siehe README, Abschnitt „Grenzen“).');
		process.exit(1);
	}
}
