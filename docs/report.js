// Auswertung der gesammelten Ereignisse. Läuft im Browser (docs/index.html) und in Node (Test).

export const parseCsv = (text) => {
	const rows = [];
	let row = [], cell = '', q = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (q) {
			if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
			else if (c === '"') q = false;
			else cell += c;
		} else if (c === '"') q = true;
		else if (c === ',') { row.push(cell); cell = ''; }
		else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
		else if (c !== '\r') cell += c;
	}
	if (cell || row.length) { row.push(cell); rows.push(row); }
	const [header, ...body] = rows;
	if (!header) return [];
	return body.filter(r => r.length > 1).map(r => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
};

// Vorlauf-Klassen: [Bezeichnung, Untergrenze in Stunden]
export const BUCKETS = [
	['≥ 7 Tage', 168], ['1–7 Tage', 24], ['6–24 h', 6], ['2–6 h', 2], ['0–2 h', 0], ['nach Sollzeit', -Infinity],
];
const bucketOf = (h) => BUCKETS.findIndex(([, min]) => h >= min);

const median = (xs) => {
	if (!xs.length) return null;
	const s = [...xs].sort((a, b) => a - b);
	return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

// Ortszeit Berlin im Format der CSV ("2026-11-14T15:26:00"), damit sich Zeiten als Text vergleichen lassen
export const berlinNow = (d = new Date()) => new Intl.DateTimeFormat('sv-SE', {
	timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit',
	hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
}).format(d).replace(' ', 'T');

// Die Halt-ID hat die Form <Fahrt>-<Startzeit>-<Nummer des Halts>; ohne die Nummer bezeichnet sie die Fahrt.
const tripOf = (stopId) => stopId.replace(/-\d+$/, '');

// Auswertung auf zwei Ebenen:
//   rows   – eine Zeile pro Halt (Bahnhof × Fahrt). Eine Streichung zählt mit dem Zeitpunkt, zu dem die DB
//            sie angelegt hat (cancellation_created_at); fehlt er, mit dem Zeitpunkt des Abrufs.
//   trains – eine Zeile pro Zug. Er gilt als "planmäßig", wenn keiner seiner beobachteten Halte gestrichen ist.
// "now" (Ortszeit Berlin) trennt gefahrene von noch anstehenden Zügen.
export const buildReport = (events, now = berlinNow()) => {
	const byHalt = new Map();
	for (const e of events) {
		const k = `${e.station}|${e.stop_id}`;
		if (!byHalt.has(k)) byHalt.set(k, []);
		byHalt.get(k).push(e);
	}

	const rows = [];
	for (const evs of byHalt.values()) {
		const first = evs[0], last = evs.at(-1);
		// maßgeblich ist der letzte Stand; eine zurückgenommene Streichung zählt nicht
		const isCancelled = last.new_status === 'gestrichen' || last.new_status === 'teilweise gestrichen';
		const cancel = isCancelled ? evs.findLast(e => e.new_status === last.new_status && e.event !== 'LAUFWEG_GEAENDERT') || last : null;
		const createdAt = cancel ? (cancel.cancellation_created_at || cancel.detected_at) : '';
		const lead = cancel ? (cancel.lead_time_h !== '' ? cancel.lead_time_h : cancel.lead_time_detected_h) : '';
		rows.push({
			trip: tripOf(first.stop_id), train: first.train, station: first.station, direction: first.direction,
			plannedTime: first.planned_time, serviceDate: first.planned_time.slice(0, 10),
			status: last.new_status, cancelled: isCancelled,
			createdAt, exact: Boolean(cancel?.cancellation_created_at),
			leadH: cancel ? Number(lead) : null,
			sameDay: cancel ? createdAt.slice(0, 10) === first.planned_time.slice(0, 10) : null,
		});
	}

	const byTrip = new Map();
	for (const r of rows) {
		if (!byTrip.has(r.trip)) byTrip.set(r.trip, []);
		byTrip.get(r.trip).push(r);
	}
	const trains = [...byTrip.values()].map(halts => {
		halts.sort((a, b) => a.plannedTime.localeCompare(b.plannedTime));
		const cancelledHalts = halts.filter(h => h.cancelled);
		const earliest = [...cancelledHalts].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
		return {
			train: halts[0].train, direction: halts[0].direction,
			plannedTime: halts[0].plannedTime, serviceDate: halts[0].serviceDate,
			// gefahren = letzter beobachteter Halt liegt in der Vergangenheit
			past: halts.at(-1).plannedTime < now,
			halts: Object.fromEntries(halts.map(h => [h.station, h])),
			cancelled: cancelledHalts.length > 0,
			cancelledStations: cancelledHalts.map(h => h.station),
			createdAt: earliest?.createdAt || '', exact: earliest?.exact ?? true,
			leadH: earliest?.leadH ?? null, sameDay: earliest?.sameDay ?? null,
		};
	}).sort((a, b) => b.plannedTime.localeCompare(a.plannedTime));

	const run = trains.filter(t => t.past);
	const dayMap = new Map();
	for (const t of run) {
		if (!dayMap.has(t.serviceDate)) dayMap.set(t.serviceDate, {date: t.serviceDate, planned: 0, cancelled: 0});
		dayMap.get(t.serviceDate)[t.cancelled ? 'cancelled' : 'planned']++;
	}

	// je Zugnummer und Richtung: an wie vielen Tagen planmäßig bzw. mit gestrichenen Halten gefahren
	const numMap = new Map();
	for (const t of run) {
		const k = `${t.direction}|${t.train.replace(/\D/g, '')}`;
		if (!numMap.has(k)) numMap.set(k, {train: t.train, direction: t.direction, times: {}, planned: 0, cancelled: 0});
		const g = numMap.get(k);
		g[t.cancelled ? 'cancelled' : 'planned']++;
		const hm = t.plannedTime.slice(11, 16);
		g.times[hm] = (g.times[hm] || 0) + 1;
	}
	const byTrain = {N: [], S: []};
	for (const g of numMap.values()) {
		// übliche Abfahrtszeit = die häufigste
		const time = Object.entries(g.times).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
		(byTrain[g.direction] ||= []).push({train: g.train, time, planned: g.planned, cancelled: g.cancelled});
	}
	for (const list of Object.values(byTrain)) list.sort((a, b) => a.time.localeCompare(b.time));

	const cancelled = rows.filter(r => r.cancelled);
	const histogram = BUCKETS.map(([label]) => ({label, count: 0}));
	for (const r of cancelled) histogram[bucketOf(r.leadH)].count++;

	return {
		stations: [...new Set(rows.map(r => r.station))].sort(),
		rows, trains,
		// gefahrene Züge
		run: run.length,
		runPlanned: run.filter(t => !t.cancelled).length,
		runCancelled: run.filter(t => t.cancelled).length,
		upcoming: trains.length - run.length,
		days: [...dayMap.values()].sort((a, b) => b.date.localeCompare(a.date)),
		byTrain,
		// Zeitpunkt der Streichungen (alle Halte, auch anstehende)
		halts: rows.length,
		cancelled,
		sameDay: cancelled.filter(r => r.sameDay).length,
		medianLeadH: median(cancelled.map(r => r.leadH)),
		histogram,
	};
};
