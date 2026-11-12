// Auswertung der gesammelten Ereignisse. Läuft im Browser (docs/app.js) und in Node (Test, lib.mjs).

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

// Ortszeit Berlin im Format der CSV ("2026-11-14T15:26:00"), damit sich Zeiten als Text vergleichen lassen
export const berlinNow = (d = new Date()) => new Intl.DateTimeFormat('sv-SE', {
	timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit',
	hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
}).format(d).replace(' ', 'T');

// Vorlauf einer Streichung: [Bezeichnung, Untergrenze in Stunden]
export const LEAD_BUCKETS = [
	['≥ 7 Tage', 168], ['1–7 Tage', 24], ['6–24 h', 6], ['2–6 h', 2], ['0–2 h', 0], ['nach Sollzeit', -Infinity],
];
// Verspätung: [Bezeichnung, Untergrenze in Minuten]. Ab 6 min gilt ein Halt hier als verspätet.
export const DELAY_BUCKETS = [['über 60 min', 61], ['31–60 min', 31], ['16–30 min', 16], ['6–15 min', 6], ['bis 5 min', -Infinity]];
export const LATE_FROM = 6;

// Ausgang eines durchgehenden Zuges (München/Ingolstadt ↔ Nürnberg)
export const OUTCOMES = {
	planned: 'planmäßig',
	treuchtlingen: 'endet/beginnt in Treuchtlingen',
	gone: 'Halte gestrichen, nicht in Treuchtlingen gesehen',
	unknown: 'Halte gestrichen, Verbleib nicht erfasst',
};

// Bedeutung der Meldungscodes. Die DB veröffentlicht keine Liste; die Texte stammen aus dem
// Open-Source-Projekt Travel::Status::DE::IRIS und sind nicht amtlich.
export const MESSAGE_CODES = {
	d21: 'Warten auf Anschlussreisende', d31: 'Bauarbeiten', d34: 'Reparatur/Defekt an einem Signal',
	d35: 'Streckensperrung', d38: 'Reparatur/Defekt an der Strecke', d45: 'Vorfahrt eines anderen Zuges',
	d48: 'Verspätung aus vorheriger Fahrt', d55: 'Technischer Defekt an einem anderen Zug',
};
export const messageLabel = (code) => MESSAGE_CODES[code] ? `${MESSAGE_CODES[code]} (${code})` : `Code ${code}`;

const HOUR = 36e5;
const THROUGH = /München|Ingolstadt/;
const bucketOf = (buckets, v) => buckets.findIndex(([, min]) => v >= min);
const median = (xs) => {
	if (!xs.length) return null;
	const s = [...xs].sort((a, b) => a - b);
	return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
// Die Halt-ID hat die Form <Fahrt>-<Startzeit>-<Nummer des Halts>; ohne die Nummer bezeichnet sie die Fahrt.
const tripOf = (stopId) => stopId.replace(/-\d+$/, '');
const weekday = (date) => new Date(`${date}T12:00:00Z`).getUTCDay(); // 0 = Sonntag
const ts = (s) => new Date(`${s}Z`).getTime(); // nur für Abstände zwischen zwei Ortszeiten

const matches = (t, f) => {
	if (f.from && t.serviceDate < f.from) return false;
	if (f.to && t.serviceDate > f.to) return false;
	const wd = weekday(t.serviceDate);
	if (f.days === 'werktags' && (wd === 0 || wd === 6)) return false;
	if (f.days === 'wochenende' && wd >= 1 && wd <= 5) return false;
	if (f.hours === 'hvz') {
		const h = Number(t.plannedTime.slice(11, 13));
		if (!((h >= 6 && h < 9) || (h >= 16 && h < 19))) return false;
	}
	return true;
};

// Erfassungslücken aus dem Protokoll der Läufe
export const findGaps = (runs, now) => {
	const ok = runs.filter(r => Number(r.halts) > 0 || Number(r.errors) === 0).map(r => r.run_at).sort();
	const gaps = [];
	const points = ok.length ? [...ok, now] : [];
	for (let i = 1; i < points.length; i++) {
		const hours = (ts(points[i]) - ts(points[i - 1])) / HOUR;
		if (hours > 1.5) gaps.push({from: points[i - 1], to: points[i], hours: Math.round(hours * 10) / 10, open: i === points.length - 1});
	}
	return {
		start: ok[0] || '', end: ok.at(-1) || '', runs: runs.length,
		errorRuns: runs.filter(r => Number(r.errors) > 0).length,
		gaps,
		// Die API reicht rund 18 h voraus. Dauert eine Lücke länger, fehlen Züge.
		lossy: gaps.filter(g => g.hours > 18),
	};
};

// Auswertung auf drei Ebenen:
//   Halt  – Bahnhof × Fahrt, maßgeblich ist der letzte gemeldete Stand
//   Zug   – alle Halte einer Fahrt; "planmäßig", wenn kein Halt in Roth/Nürnberg gestrichen ist
//   Summe – Kennzahlen über die gefilterten, bereits gefahrenen Züge
// opts.now (Ortszeit Berlin) trennt gefahrene von anstehenden Zügen, opts.filter grenzt die Züge ein.
export const buildReport = (events, runs = [], {now = berlinNow(), filter = {}} = {}) => {
	const byHalt = new Map();
	for (const e of events) {
		const k = `${e.station}|${e.stop_id}`;
		if (!byHalt.has(k)) byHalt.set(k, []);
		byHalt.get(k).push(e);
	}

	const halts = [];
	for (const evs of byHalt.values()) {
		const first = evs[0], last = evs.at(-1);
		const cancelled = last.new_status === 'gestrichen' || last.new_status === 'teilweise gestrichen';
		// Zeile mit dem frühesten gemeldeten Anlagezeitpunkt; die DB aktualisiert ihn manchmal nachträglich
		const cancel = cancelled ? evs.filter(e => e.new_status === last.new_status && e.cancellation_created_at)
			.sort((a, b) => a.cancellation_created_at.localeCompare(b.cancellation_created_at))[0]
			|| evs.find(e => e.new_status === last.new_status) : null;
		const createdAt = cancel ? (cancel.cancellation_created_at || cancel.detected_at) : '';
		const lead = cancel ? (cancel.lead_time_h !== '' ? cancel.lead_time_h : cancel.lead_time_detected_h) : '';
		const measured = evs.filter(e => e.delay_min !== undefined && e.delay_min !== '');
		halts.push({
			trip: tripOf(first.stop_id), train: first.train, station: first.station, role: first.role || 'halt',
			direction: first.direction, plannedTime: first.planned_time, serviceDate: first.planned_time.slice(0, 10),
			status: last.new_status, cancelled,
			createdAt, exact: Boolean(cancel?.cancellation_created_at),
			leadH: cancel ? Number(lead) : null,
			sameDay: cancel ? createdAt.slice(0, 10) === first.planned_time.slice(0, 10) : null,
			delay: measured.length ? Number(measured.at(-1).delay_min) : null,
			messages: [...new Set(evs.flatMap(e => (e.messages || '').split(';').filter(Boolean)))].sort(),
			terminus: evs.findLast(e => e.terminus)?.terminus || '',
			through: evs.some(e => THROUGH.test(`${e.planned_path}|${e.changed_path_before || ''}|${e.changed_path_after || ''}`)),
		});
	}

	// ab wann Treuchtlingen mitbeobachtet wird: davor ist der Verbleib eines Zuges nicht erfasst
	const contextSince = events.find(e => e.role === 'kontext')?.detected_at || '';

	const byTrip = new Map();
	for (const h of halts) {
		if (!byTrip.has(h.trip)) byTrip.set(h.trip, []);
		byTrip.get(h.trip).push(h);
	}
	const allTrains = [];
	for (const list of byTrip.values()) {
		const watch = list.filter(h => h.role === 'halt').sort((a, b) => a.plannedTime.localeCompare(b.plannedTime));
		if (!watch.length) continue; // nur in Treuchtlingen gesehen: kein Halt, über den sich etwas sagen lässt
		const context = list.find(h => h.role === 'kontext') || null;
		const cancelledHalts = watch.filter(h => h.cancelled);
		const earliest = [...cancelledHalts].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
		const through = list.some(h => h.through);
		let outcome = 'planned';
		if (cancelledHalts.length) {
			outcome = context && !context.cancelled ? 'treuchtlingen'
				: contextSince && watch[0].plannedTime >= contextSince ? 'gone' : 'unknown';
		}
		const served = watch.filter(h => !h.cancelled && h.delay !== null);
		allTrains.push({
			train: watch[0].train, number: watch[0].train.replace(/\D/g, ''), direction: watch[0].direction,
			plannedTime: watch[0].plannedTime, serviceDate: watch[0].serviceDate,
			past: watch.at(-1).plannedTime < now,
			type: through ? 'durch' : 'pendel',
			halts: Object.fromEntries(watch.map(h => [h.station, h])), context,
			cancelled: cancelledHalts.length > 0, outcome,
			createdAt: earliest?.createdAt || '', exact: earliest?.exact ?? true,
			leadH: earliest?.leadH ?? null, sameDay: earliest?.sameDay ?? null,
			delay: served.length ? Math.max(...served.map(h => h.delay)) : null,
			contextDelay: context && !context.cancelled ? context.delay : null,
			messages: [...new Set(cancelledHalts.flatMap(h => h.messages))].sort(),
		});
	}
	allTrains.sort((a, b) => b.plannedTime.localeCompare(a.plannedTime));

	const trains = allTrains.filter(t => matches(t, filter));
	const through = trains.filter(t => t.type === 'durch');
	const shuttle = trains.filter(t => t.type === 'pendel');
	const run = through.filter(t => t.past);
	const shuttleRun = shuttle.filter(t => t.past);

	const outcomes = Object.fromEntries(Object.keys(OUTCOMES).map(k => [k, run.filter(t => t.outcome === k).length]));

	const dayMap = new Map();
	for (const t of run) {
		if (!dayMap.has(t.serviceDate)) dayMap.set(t.serviceDate, {date: t.serviceDate, ...Object.fromEntries(Object.keys(OUTCOMES).map(k => [k, 0]))});
		dayMap.get(t.serviceDate)[t.outcome]++;
	}
	const days = [...dayMap.values()].sort((a, b) => b.date.localeCompare(a.date));

	// je Zugnummer und Richtung: Ausgang an jedem Tag (Kalender) und Summe (Kreisdiagramm)
	const numMap = new Map();
	for (const t of run) {
		const k = `${t.direction}|${t.number}`;
		if (!numMap.has(k)) numMap.set(k, {train: t.train, direction: t.direction, times: {}, planned: 0, cancelled: 0, byDate: {}});
		const g = numMap.get(k);
		g[t.cancelled ? 'cancelled' : 'planned']++;
		g.byDate[t.serviceDate] = t.outcome;
		const hm = t.plannedTime.slice(11, 16);
		g.times[hm] = (g.times[hm] || 0) + 1;
	}
	const byTrain = {N: [], S: []};
	for (const g of numMap.values()) {
		// übliche Abfahrtszeit = die häufigste
		const time = Object.entries(g.times).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
		(byTrain[g.direction] ||= []).push({train: g.train, time, planned: g.planned, cancelled: g.cancelled, byDate: g.byDate});
	}
	for (const list of Object.values(byTrain)) list.sort((a, b) => a.time.localeCompare(b.time));

	// Zeitpunkt der Streichungen: jeder gestrichene Halt der durchgehenden Züge, auch anstehende
	const cancelledHalts = through.flatMap(t => Object.values(t.halts).filter(h => h.cancelled));
	const leadHistogram = LEAD_BUCKETS.map(([label]) => ({label, count: 0}));
	for (const h of cancelledHalts) leadHistogram[bucketOf(LEAD_BUCKETS, h.leadH)].count++;

	const reasonMap = new Map();
	for (const h of cancelledHalts) for (const c of h.messages) reasonMap.set(c, (reasonMap.get(c) || 0) + 1);
	const reasons = [...reasonMap].map(([code, count]) => ({code, label: messageLabel(code), count}))
		.sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));

	// Verspätung: bediente Halte in Roth/Nürnberg (alle Züge) und Ankunft der in Treuchtlingen endenden Züge
	const delayStats = (values) => {
		const histogram = DELAY_BUCKETS.map(([label]) => ({label, count: 0}));
		for (const v of values) histogram[bucketOf(DELAY_BUCKETS, v)].count++;
		return {n: values.length, late: values.filter(v => v >= LATE_FROM).length, median: median(values), max: values.length ? Math.max(...values) : null, histogram: histogram.reverse()};
	};
	const pastTrains = trains.filter(t => t.past);
	const delays = {
		halts: delayStats(pastTrains.flatMap(t => Object.values(t.halts).filter(h => !h.cancelled && h.delay !== null).map(h => h.delay))),
		treuchtlingen: delayStats(run.filter(t => t.outcome === 'treuchtlingen' && t.contextDelay !== null).map(t => t.contextDelay)),
	};

	return {
		filter, now,
		stations: [...new Set(halts.filter(h => h.role === 'halt').map(h => h.station))].sort(),
		dates: [...new Set(run.map(t => t.serviceDate))].sort(),
		allDates: [...new Set(allTrains.map(t => t.serviceDate))].sort(),
		trains,
		run: run.length, outcomes, upcoming: through.length - run.length,
		shuttle: {run: shuttleRun.length, cancelled: shuttleRun.filter(t => t.cancelled).length},
		days, byTrain,
		cancelledHalts: cancelledHalts.length,
		sameDay: cancelledHalts.filter(h => h.sameDay).length,
		medianLeadH: median(cancelledHalts.map(h => h.leadH)),
		leadHistogram, reasons, delays,
		contextSince,
		coverage: findGaps(runs, now),
	};
};

// ---------- Zusammenfassung als Fließtext ----------

const day = (s) => `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)}`;
const pct = (a, b) => b ? `${Math.round(a / b * 100)} %` : '–';
const num = (v) => String(Math.round(v * 10) / 10).replace('.', ',');
const hours = (h) => Math.abs(h) >= 48 ? `${num(Math.abs(h) / 24)} Tage` : `${num(Math.abs(h))} Stunden`;
const count = (n, one, many) => n === 1 ? `1 ${one}` : `${n} ${many}`;

// Gibt Absätze zurück. Jeder Satz entsteht nur, wenn die Daten ihn tragen.
export const buildSummary = (rep) => {
	if (!rep.run) return ['Im gewählten Zeitraum ist noch kein beobachteter Zug gefahren.'];
	const o = rep.outcomes;
	const notPlanned = rep.run - o.planned;
	const both = rep.stations.join(' und ');
	const filterNote = [
		rep.filter.days === 'werktags' && 'nur Montag bis Freitag',
		rep.filter.days === 'wochenende' && 'nur Samstag und Sonntag',
		rep.filter.hours === 'hvz' && 'nur Abfahrten von 6 bis 9 Uhr und von 16 bis 19 Uhr',
	].filter(Boolean).join(', ');
	const span = rep.dates.length > 1 ? `Vom ${day(rep.dates[0])} bis ${day(rep.dates.at(-1))}` : `Am ${day(rep.dates[0])}`;
	const paras = [];

	paras.push(`${span} ${rep.run === 1 ? 'wurde' : 'wurden'} ${count(rep.run, 'durchgehender Zug', 'durchgehende Züge')} der Linie RE1 mit planmäßigem Halt in ${both} beobachtet${filterNote ? ` (${filterNote})` : ''}. `
		+ `${o.planned} davon (${pct(o.planned, rep.run)}) ${o.planned === 1 ? 'fuhr' : 'fuhren'} mit allen diesen Halten. `
		+ `Bei ${notPlanned} (${pct(notPlanned, rep.run)}) wurden Halte in ${rep.stations.join(' oder ')} gestrichen.`);

	const parts = [];
	if (o.treuchtlingen) parts.push(`${count(o.treuchtlingen, 'Zug endete oder begann', 'Züge endeten oder begannen')} in Treuchtlingen, statt Nürnberg zu erreichen`);
	if (o.gone) parts.push(`${count(o.gone, 'Zug wurde', 'Züge wurden')} auch in Treuchtlingen nicht gesehen (ausgefallen oder anders umgeleitet)`);
	if (o.unknown) parts.push(`bei ${count(o.unknown, 'Zug', 'Zügen')} ist der Verbleib nicht erfasst`);
	let p = parts.length ? `Von den Zügen mit gestrichenen Halten gilt: ${parts.join('; ')}.` : '';
	if (rep.shuttle.run) {
		p += `${p ? ' ' : ''}Zusätzlich ${rep.shuttle.run === 1 ? 'verkehrte' : 'verkehrten'} ${count(rep.shuttle.run, 'Pendelzug', 'Pendelzüge')} zwischen Treuchtlingen und Nürnberg`
			+ `${rep.shuttle.cancelled ? `, davon ${rep.shuttle.cancelled} mit gestrichenen Halten` : ''}.`;
	}
	if (p) paras.push(p);

	if (rep.cancelledHalts) {
		paras.push(`Die DB legte die Streichungen im Mittel ${hours(rep.medianLeadH)} ${rep.medianLeadH < 0 ? 'nach' : 'vor'} der planmäßigen Abfahrt in ihrem System an (Median über ${count(rep.cancelledHalts, 'gestrichenen Halt', 'gestrichene Halte')}). `
			+ `${rep.sameDay} davon (${pct(rep.sameDay, rep.cancelledHalts)}) ${rep.sameDay === 1 ? 'wurde' : 'wurden'} erst am Tag der Fahrt angelegt.`);
	}

	const d = rep.delays;
	const delayParts = [];
	if (d.halts.n) delayParts.push(`An den bedienten Halten in ${both} ${d.halts.late === 1 ? 'war' : 'waren'} ${d.halts.late} von ${d.halts.n} Abfahrten (${pct(d.halts.late, d.halts.n)}) mindestens ${LATE_FROM} Minuten verspätet (Median ${num(d.halts.median)} Minuten)`);
	if (d.treuchtlingen.n) delayParts.push(`${delayParts.length ? 'die' : 'Die'} in Treuchtlingen endenden oder beginnenden Züge waren dort zu ${pct(d.treuchtlingen.late, d.treuchtlingen.n)} mindestens ${LATE_FROM} Minuten verspätet (Median ${num(d.treuchtlingen.median)} Minuten, höchster Wert ${d.treuchtlingen.max} Minuten)`);
	if (delayParts.length) paras.push(delayParts.join('; ') + '.');

	// Gegenüberstellung mit der Ankündigung: nur Aussagen, die die Presseinformation und die Daten tragen
	if (notPlanned) {
		p = 'Angekündigt hatte die DB in ihrer Presseinformation vom 09.10.2026, die Züge des RE1 würden „über Treuchtlingen (via Ingolstadt) bzw. Augsburg umgeleitet“. '
			+ `Dass Züge in Treuchtlingen enden und die Halte in ${both} entfallen, steht dort nicht. `;
		p += o.treuchtlingen
			? `Beobachtet wurde, dass ${pct(o.treuchtlingen, rep.run)} der durchgehenden Züge in Treuchtlingen endeten oder begannen; wer nach oder von Nürnberg fuhr, musste dort umsteigen.`
			: `Beobachtet wurde, dass bei ${pct(notPlanned, rep.run)} der durchgehenden Züge die Halte in ${both} entfielen.`;
		if (d.treuchtlingen.late) p += ' Laut Presseberichten erwartete die Bahn „keine generellen zusätzlichen Verspätungen aufgrund der Umleitung“; die gemessenen Werte stehen im Absatz davor.';
		paras.push(p);
	}

	const c = rep.coverage;
	p = 'Quelle ist die offizielle Timetables-API der Deutschen Bahn, stündlich abgefragt';
	if (c.start) p += ` seit dem ${day(c.start)}, ${c.start.slice(11, 16)} Uhr`;
	p += '. Der Zeitpunkt jeder Streichung stammt aus dem System der DB.';
	if (c.start) {
		p += c.lossy.length
			? ` In ${count(c.lossy.length, 'Erfassungslücke', 'Erfassungslücken')} von mehr als 18 Stunden können Züge fehlen.`
			: ' Es gibt keine Erfassungslücke, in der Züge fehlen können.';
	}
	paras.push(p);
	return paras;
};
