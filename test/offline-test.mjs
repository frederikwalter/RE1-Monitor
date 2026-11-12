// Offline-Test mit simulierten API-Antworten (kein Netz nötig).
// Simuliert: Fahrt zwei Tage vorher mit Halt Roth/Nürnberg → am Fahrtag gestrichen.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 're1-'));
process.env.RE1_DATA_DIR = tmp;
const {runCollect} = await import('../collect.mjs');
const {runIris} = await import('../iris.mjs');
const {buildReport} = await import('../report.mjs');
const {loadConfig, readCsv} = await import('../lib.mjs');

const cfg = {...loadConfig(), requestDelayMs: 0, maxRetries: 0, lookbackHours: 0};
const iso = (s) => new Date(s).toISOString();

const mkStop = (name, time, cancelled = false) => ({
	stop: {name, id: name}, plannedArrival: iso(time), plannedDeparture: iso(time), ...(cancelled ? {cancelled: true} : {}),
});
// RE1 nordwärts, Treuchtlingen 14:58 am 14.11.2026
const tripA = (variant) => {
	const roth = variant >= 1, nbg = variant >= 1;
	const stopovers = [
		mkStop('München Hbf', '2026-11-14T13:28+01:00'),
		mkStop('Ingolstadt Hbf', '2026-11-14T14:05+01:00'),
		mkStop('Treuchtlingen', '2026-11-14T14:58+01:00'),
		mkStop('Roth', '2026-11-14T15:25+01:00', roth),
		mkStop('Nürnberg Hbf', '2026-11-14T15:45+01:00', nbg),
	];
	if (variant === 2) stopovers.splice(3, 2); // Halte ganz aus dem Laufweg entfernt
	return {
		id: 'A', line: {name: 'RE 1', fahrtNr: '4041'}, cancelled: false, stopovers,
		remarks: variant >= 1 ? [{type: 'warning', text: 'Halt entfällt'}] : [],
	};
};
// RE1 südwärts, Treuchtlingen 15:02 — bleibt unverändert
const tripB = {
	id: 'B', line: {name: 'RE 1'}, cancelled: false, remarks: [],
	stopovers: [
		mkStop('Nürnberg Hbf', '2026-11-14T14:15+01:00'), mkStop('Roth', '2026-11-14T14:35+01:00'),
		mkStop('Treuchtlingen', '2026-11-14T15:02+01:00'), mkStop('München Hbf', '2026-11-14T16:30+01:00'),
	],
};

const mkClient = (variant) => ({
	locations: async () => [{type: 'station', id: '8000122', name: 'Treuchtlingen'}],
	departures: async (id, {when}) => ({
		departures: new Date(when).toISOString().startsWith('2026-11-14T13') // 14:xx Berlin
			? [{tripId: 'A', line: {name: 'RE 1'}}, {tripId: 'B', line: {name: 'RE 1'}}, {tripId: 'X', line: {name: 'RE 16'}}]
			: [],
	}),
	arrivals: async () => ({arrivals: []}),
	trip: async (id) => ({trip: id === 'A' ? tripA(variant) : tripB}),
});

// Lauf 1: zwei Tage vorher → alles planmäßig
let r = await runCollect(mkClient(0), cfg, {horizonHours: 60, now: new Date('2026-11-12T12:00+01:00')});
assert.equal(r.trips, 2, 'zwei RE1-Fahrten (RE 16 ausgefiltert)');
// Lauf 2: am Fahrtag 06:00 → Roth + Nürnberg gestrichen
r = await runCollect(mkClient(1), cfg, {horizonHours: 12, now: new Date('2026-11-14T06:00+01:00')});
assert.deepEqual(r.events.map(e => e.event).sort(), ['HALT_GESTRICHEN', 'HALT_GESTRICHEN', 'HINWEIS_NEU']);
// Lauf 3: Halte ganz entfernt, Ziel Treuchtlingen
r = await runCollect(mkClient(2), cfg, {horizonHours: 12, now: new Date('2026-11-14T08:00+01:00')});
assert.ok(r.events.some(e => e.event === 'START_ZIEL_GEAENDERT'));
assert.equal(r.events.filter(e => e.event === 'HALT_AUS_LAUFWEG_ENTFERNT').length, 2);
// Lauf 4: Fahrt verschwindet von der Tafel
const empty = {...mkClient(2), departures: async () => ({departures: []})};
r = await runCollect(empty, cfg, {horizonHours: 12, now: new Date('2026-11-14T09:00+01:00')});
assert.equal(r.events.filter(e => e.event === 'FAHRT_NICHT_MEHR_GEFUNDEN').length, 2);

const events = readCsv(path.join(tmp, 'events.csv'));
console.log('events.csv:');
for (const e of events) console.log(' ', e.detected_at, e.trip_key, e.event, e.stop, e.old_value, '→', e.new_value, `(${e.lead_time_h} h)`);

// IRIS: Roth, RE 4041, Streichung am Fahrtag 05:47 angelegt
const planXml = `<timetable station="Roth"><s id="111-2611141525-4"><tl f="N" t="p" o="800734" c="RE" n="4041"/>
<ar pt="2611141525" pp="2" l="1" ppth="München Hbf|Ingolstadt Hbf|Treuchtlingen"/><dp pt="2611141526" pp="2" l="1" ppth="Nürnberg Hbf"/></s>
<s id="222-2611141530-3"><tl f="N" t="p" o="800734" c="RE" n="59127"/><dp pt="2611141530" l="16" ppth="Nürnberg Hbf"/></s></timetable>`;
let fchg = '<timetable station="Roth"></timetable>';
const fetchXml = async (p) => {
	if (p.startsWith('/station/')) return '<stations><station name="Roth" eva="8000317"/></stations>';
	if (p.startsWith('/plan/8000317/261114/15')) return planXml;
	if (p.startsWith('/plan/')) return '<timetable/>';
	return fchg;
};
const icfg = {...cfg, iris: {...cfg.iris, stations: ['Roth']}};
let ir = await runIris(fetchXml, icfg, {now: new Date('2026-11-14T05:00+01:00')});
assert.equal(ir.events.length, 2, 'RE1 an/ab gesehen, RE16 ausgefiltert');
fchg = `<timetable station="Roth"><s id="111-2611141525-4"><ar cs="c" clt="2611140547"/><dp cs="c" clt="2611140547"/></s></timetable>`;
ir = await runIris(fetchXml, icfg, {now: new Date('2026-11-14T06:00+01:00')});
assert.equal(ir.events.length, 2);
assert.equal(ir.events[0].event, 'HALT_GESTRICHEN');
assert.equal(ir.events[0].cancellation_created_at, '2026-11-14T05:47:00');
console.log('\niris_events (Änderungen):');
for (const e of ir.events) console.log(' ', e.train, e.kind, e.planned_time, e.event, 'angelegt', e.cancellation_created_at, `Vorlauf ${e.lead_time_from_clt_h} h`);

const {md} = buildReport(events, readCsv(path.join(tmp, 'iris_events.csv')), cfg, new Date('2026-11-14T10:00+01:00'));
console.log('\n' + md);
assert.ok(md.includes('davon später **gestrichen**: 2 (50 %)'));
assert.ok(md.includes('am Tag der Fahrt** erkannt: 2'));
console.log('✓ Alle Offline-Tests bestanden');
