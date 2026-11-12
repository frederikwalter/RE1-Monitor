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

const norm = (s) => (s || '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();

// "Roth:Halt; Nürnberg Hbf:entfällt" → Map(Name → Status)
const parseSummary = (s) => new Map((s || '').split('; ')
	.map(p => p.match(/^(.*):(Halt|entfällt)$/))
	.filter(Boolean)
	.map(m => [m[1], m[2]]));

const CANCEL_EVENTS = ['HALT_GESTRICHEN', 'HALT_AUS_LAUFWEG_ENTFERNT'];

export const buildReport = (events, irisEvents = []) => {
	const byTrip = new Map();
	for (const e of events) {
		if (!byTrip.has(e.trip_key)) byTrip.set(e.trip_key, []);
		byTrip.get(e.trip_key).push(e);
	}

	// eine Zeile pro Fahrt und beobachtetem Halt
	const rows = [];
	for (const [key, evs] of byTrip) {
		const first = evs.find(e => e.event === 'FAHRT_ERSTMALS_GESEHEN');
		if (!first) continue;
		for (const [halt, statusAtFirst] of parseSummary(first.new_value)) {
			const stopEvs = evs.filter(e => norm(e.stop) === norm(halt));
			const cancel = stopEvs.find(e => CANCEL_EVENTS.includes(e.event));
			const restored = cancel && stopEvs.find(e =>
				['HALT_WIEDERHERGESTELLT', 'HALT_HINZUGEFUEGT'].includes(e.event) && e.detected_at > cancel.detected_at);
			const planned = (cancel || stopEvs.find(e => e.stop_planned_time))?.stop_planned_time || '';
			rows.push({
				tripKey: key, train: first.train, serviceDate: first.service_date, direction: first.direction,
				halt, statusAtFirst, firstSeen: first.detected_at, firstSeenLeadH: Number(first.lead_time_h),
				plannedTime: planned,
				cancelDetected: cancel?.detected_at || '', cancelKind: cancel?.event || '',
				cancelLeadH: cancel ? Number(cancel.lead_time_h) : null,
				sameDay: cancel && planned ? cancel.detected_at.slice(0, 10) === planned.slice(0, 10) : null,
				restored: restored?.detected_at || '',
			});
		}
	}

	const planned = rows.filter(r => r.statusAtFirst === 'Halt');
	const cancelledLater = planned.filter(r => r.cancelDetected);
	const histogram = BUCKETS.map(([label]) => ({label, count: 0}));
	for (const r of cancelledLater) histogram[bucketOf(r.cancelLeadH)].count++;

	// IRIS: Ankunft und Abfahrt eines Halts zu einer Zeile zusammenfassen, frühester Anlagezeitpunkt zählt
	const iris = new Map();
	for (const e of irisEvents) {
		if (e.new_status !== 'gestrichen' || !e.cancellation_created_at) continue;
		const k = `${e.station}|${e.stop_id}`;
		const old = iris.get(k);
		if (!old || e.cancellation_created_at < old.createdAt) {
			iris.set(k, {
				train: e.train, station: e.station, plannedTime: e.planned_time,
				createdAt: e.cancellation_created_at, leadH: Number(e.lead_time_from_clt_h),
				sameDay: e.cancellation_created_at.slice(0, 10) === e.planned_time.slice(0, 10),
			});
		}
	}

	return {
		trips: byTrip.size,
		halts: [...new Set(rows.map(r => r.halt))].sort(),
		rows,
		planned: planned.length,
		cancelledLater,
		sameDay: cancelledLater.filter(r => r.sameDay).length,
		alreadyCancelled: rows.filter(r => r.statusAtFirst === 'entfällt').length,
		histogram,
		iris: [...iris.values()].sort((a, b) => b.plannedTime.localeCompare(a.plannedTime)),
	};
};
