#!/usr/bin/env node
// RE1-Monitor – Auswertung: Wann wurden die Halte in Roth / Nürnberg gestrichen?
// Liest data/events.csv (und, falls vorhanden, data/iris_events.csv) und schreibt
// data/report.md sowie data/report_halte.csv.
//
// Aufruf:  node report.mjs
import path from 'node:path';
import fs from 'node:fs';
import {DATA, loadConfig, readCsv, appendCsv, berlin} from './lib.mjs';

const BUCKETS = [
	['≥ 7 Tage vorher', 168], ['1–7 Tage vorher', 24], ['6–24 h vorher', 6],
	['2–6 h vorher', 2], ['0–2 h vorher', 0], ['erst nach Sollzeit', -Infinity],
];
const bucketOf = (h) => BUCKETS.find(([, min]) => h >= min)[0];

export const buildReport = (events, irisEvents, cfg, now = new Date()) => {
	const byTrip = new Map();
	for (const e of events) {
		if (!byTrip.has(e.trip_key)) byTrip.set(e.trip_key, []);
		byTrip.get(e.trip_key).push(e);
	}

	const rows = [];
	for (const [key, evs] of byTrip) {
		const first = evs.find(e => e.event === 'FAHRT_ERSTMALS_GESEHEN');
		if (!first) continue;
		for (const w of cfg.watchStations) {
			const re = new RegExp(`${w}:(Halt|entfällt)`);
			const m = first.new_value.match(re);
			const atFirst = m ? m[1] : 'nicht im Laufweg';
			const stopEvs = evs.filter(e => e.stop && e.stop.toLowerCase().startsWith(w.toLowerCase()));
			const cancel = stopEvs.find(e => ['HALT_GESTRICHEN', 'HALT_AUS_LAUFWEG_ENTFERNT'].includes(e.event));
			const restored = stopEvs.find(e => e.event === 'HALT_WIEDERHERGESTELLT');
			const planned = (cancel || stopEvs[0])?.stop_planned_time || '';
			rows.push({
				trip_key: key, train: first.train, service_date: first.service_date, direction: first.direction,
				halt: w, status_beim_ersten_sehen: atFirst, erstmals_gesehen: first.detected_at,
				vorlauf_erstes_sehen_h: first.lead_time_h,
				soll_zeit_halt: planned,
				streichung_erkannt: cancel?.detected_at || '', streichung_art: cancel?.event || '',
				vorlauf_streichung_h: cancel?.lead_time_h ?? '',
				gleicher_tag: cancel && planned ? String(cancel.detected_at.slice(0, 10) === planned.slice(0, 10)) : '',
				wiederhergestellt: restored?.detected_at || '',
			});
		}
	}

	const relevant = rows.filter(r => r.status_beim_ersten_sehen === 'Halt');
	const cancelledLater = relevant.filter(r => r.streichung_erkannt);
	const alreadyCancelled = rows.filter(r => r.status_beim_ersten_sehen === 'entfällt');
	const sameDay = cancelledLater.filter(r => r.gleicher_tag === 'true');
	const pct = (a, b) => b ? `${Math.round(a / b * 100)} %` : '–';

	const hist = Object.fromEntries(BUCKETS.map(([b]) => [b, 0]));
	for (const r of cancelledLater) hist[bucketOf(Number(r.vorlauf_streichung_h))]++;

	const irisCancels = irisEvents.filter(e => e.new_status === 'gestrichen');

	let md = `# RE1-Monitor – Auswertung\n\nStand: ${berlin(now)}  \n`;
	md += `Beobachtete Halte: ${cfg.watchStations.join(', ')}  \n`;
	md += `Beobachtete Fahrten: ${byTrip.size}\n\n`;
	md += `## Kernaussage\n\n`;
	md += `- Planmäßige Halte (Fahrt × Bahnhof), die beim ersten Abruf **im Fahrplan standen**: ${relevant.length}\n`;
	md += `- davon später **gestrichen**: ${cancelledLater.length} (${pct(cancelledLater.length, relevant.length)})\n`;
	md += `- davon Streichung **am Tag der Fahrt** erkannt: ${sameDay.length} (${pct(sameDay.length, cancelledLater.length)})\n`;
	md += `- Halte, die schon beim ersten Abruf als „entfällt“ markiert waren: ${alreadyCancelled.length}\n\n`;
	md += `## Wie lange vor der Sollzeit wurde gestrichen?\n\n| Vorlauf | Anzahl |\n|---|---|\n`;
	for (const [b, n] of Object.entries(hist)) md += `| ${b} | ${n} |\n`;
	md += `\nHinweis: Der Zeitpunkt ist der erste Abruf, bei dem die Streichung sichtbar war. Die Genauigkeit entspricht also dem Abfrageintervall.\n\n`;

	if (irisCancels.length) {
		md += `## Offizieller Streichungszeitpunkt (IRIS, Feld „clt“)\n\n| Zug | Bahnhof | Art | Sollzeit | Streichung angelegt | Vorlauf (h) |\n|---|---|---|---|---|---|\n`;
		for (const e of irisCancels) {
			md += `| ${e.train} | ${e.station} | ${e.kind} | ${e.planned_time} | ${e.cancellation_created_at} | ${e.lead_time_from_clt_h} |\n`;
		}
		md += '\n';
	}

	md += `## Einzelne Streichungen\n\n| Fahrt | Halt | Sollzeit | erstmals gesehen (Status) | Streichung erkannt | Vorlauf (h) |\n|---|---|---|---|---|---|\n`;
	for (const r of cancelledLater) {
		md += `| ${r.trip_key} ${r.train} | ${r.halt} | ${r.soll_zeit_halt} | ${r.erstmals_gesehen} (${r.status_beim_ersten_sehen}) | ${r.streichung_erkannt} | ${r.vorlauf_streichung_h} |\n`;
	}
	return {md, rows};
};

const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (isMain) {
	const cfg = loadConfig();
	const events = readCsv(path.join(DATA, 'events.csv'));
	const iris = readCsv(path.join(DATA, 'iris_events.csv'));
	if (!events.length) { console.error('Noch keine Daten in data/events.csv'); process.exit(1); }
	const {md, rows} = buildReport(events, iris, cfg);
	fs.writeFileSync(path.join(DATA, 'report.md'), md);
	const out = path.join(DATA, 'report_halte.csv');
	fs.rmSync(out, {force: true});
	appendCsv(out, Object.keys(rows[0] || {trip_key: ''}), rows);
	console.log(md);
	console.log(`→ ${path.join(DATA, 'report.md')}\n→ ${out}`);
}
