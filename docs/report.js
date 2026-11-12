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

// Eine Zeile pro Halt (Bahnhof × Fahrt). Eine Streichung zählt mit dem Zeitpunkt, zu dem die DB
// sie angelegt hat (cancellation_created_at); fehlt er, mit dem Zeitpunkt des Abrufs.
export const buildReport = (events) => {
	const byHalt = new Map();
	for (const e of events) {
		const k = `${e.station}|${e.stop_id}`;
		if (!byHalt.has(k)) byHalt.set(k, []);
		byHalt.get(k).push(e);
	}

	const rows = [];
	for (const evs of byHalt.values()) {
		const first = evs[0], last = evs.at(-1);
		const cancel = evs.find(e => e.new_status === 'gestrichen');
		const createdAt = cancel ? (cancel.cancellation_created_at || cancel.detected_at) : '';
		const lead = cancel ? (cancel.lead_time_h !== '' ? cancel.lead_time_h : cancel.lead_time_detected_h) : '';
		rows.push({
			train: first.train, station: first.station, direction: first.direction,
			plannedTime: first.planned_time, serviceDate: first.planned_time.slice(0, 10),
			firstSeen: first.detected_at,
			cancelled: Boolean(cancel),
			createdAt, exact: Boolean(cancel?.cancellation_created_at),
			leadH: cancel ? Number(lead) : null,
			sameDay: cancel ? createdAt.slice(0, 10) === first.planned_time.slice(0, 10) : null,
			restored: Boolean(cancel) && last.new_status === 'planmäßig',
		});
	}

	const cancelled = rows.filter(r => r.cancelled);
	const histogram = BUCKETS.map(([label]) => ({label, count: 0}));
	for (const r of cancelled) histogram[bucketOf(r.leadH)].count++;

	return {
		halts: rows.length,
		stations: [...new Set(rows.map(r => r.station))].sort(),
		rows,
		cancelled,
		sameDay: cancelled.filter(r => r.sameDay).length,
		medianLeadH: median(cancelled.map(r => r.leadH)),
		histogram,
	};
};
