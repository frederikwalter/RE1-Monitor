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
const {buildReport, parseCsv} = await import('../docs/report.js');
const {loadConfig} = await import('../lib.mjs');

const cfg = {...loadConfig(), requestDelayMs: 0, maxRetries: 0, lookbackHours: 0, stationIds: {Treuchtlingen: '8000122'}};
const iso = (s) => new Date(s).toISOString();
const readCsv = (name) => parseCsv(fs.readFileSync(path.join(tmp, name), 'utf8'));
const names = (r) => r.events.map(e => e.event).sort();

const mkStop = (name, time, cancelled = false) => ({
	stop: {name, id: name}, plannedArrival: iso(time), plannedDeparture: iso(time), ...(cancelled ? {cancelled: true} : {}),
});
// RE1 nordwärts (Zug 4041), Treuchtlingen 14:58 am 14.11.2026
const tripA = (variant) => {
	const gone = variant >= 1;
	const stopovers = [
		mkStop('München Hbf', '2026-11-14T13:28+01:00'),
		mkStop('Ingolstadt Hbf', '2026-11-14T14:05+01:00'),
		mkStop('Treuchtlingen', '2026-11-14T14:58+01:00'),
		mkStop('Roth', '2026-11-14T15:25+01:00', gone),
		mkStop('Nürnberg Hbf', '2026-11-14T15:45+01:00', gone),
	];
	if (variant === 2) stopovers.splice(3, 2); // Halte ganz aus dem Laufweg entfernt
	return {
		id: variant === 2 ? 'A2' : 'A', line: {name: 'RE 1', fahrtNr: '4041'}, cancelled: false, stopovers,
		remarks: gone ? [{type: 'warning', text: 'Halt entfällt'}] : [],
	};
};
// RE1 südwärts (Zug 4042), Treuchtlingen 15:02 — bleibt unverändert
const tripB = {
	id: 'B', line: {name: 'RE 1', fahrtNr: '4042'}, cancelled: false, remarks: [],
	stopovers: [
		mkStop('Nürnberg Hbf', '2026-11-14T14:15+01:00'), mkStop('Roth', '2026-11-14T14:35+01:00'),
		mkStop('Treuchtlingen', '2026-11-14T15:02+01:00'), mkStop('München Hbf', '2026-11-14T16:30+01:00'),
	],
};

// trips: Fahrt-ID → Antwort (fehlende ID = Fehler); board: IDs auf der Tafel um 14 Uhr
const mkClient = ({trips, board}) => {
	const calls = {boards: 0, trip: []};
	return {
		calls,
		locations: async () => { throw new Error('Bahnhofssuche sollte nicht nötig sein'); },
		departures: async (id, {when}) => {
			calls.boards++;
			const hit = new Date(when).toISOString().startsWith('2026-11-14T13'); // 14:xx Berlin
			return {departures: hit ? [...board.map(tripId => ({tripId, line: {name: 'RE 1'}})), {tripId: 'X', line: {name: 'RE 16'}}] : []};
		},
		arrivals: async () => { calls.boards++; return {arrivals: []}; },
		trip: async (id) => {
			calls.trip.push(id);
			if (!trips[id]) throw new Error('trip not found');
			return {trip: trips[id]};
		},
	};
};
const run = (client, horizonHours, now) => runCollect(client, cfg, {horizonHours, now: new Date(now)});

// Lauf 1: zwei Tage vorher → Tafel-Suche über alle Fenster, alles planmäßig
let c = mkClient({trips: {A: tripA(0), B: tripB}, board: ['A', 'B']});
let r = await run(c, 60, '2026-11-12T12:00+01:00');
assert.equal(r.trips, 2, 'zwei RE1-Fahrten (RE 16 ausgefiltert)');
assert.equal(c.calls.boards, 120, '60 Fenster × Abfahrt/Ankunft');
assert.deepEqual(names(r), ['FAHRT_ERSTMALS_GESEHEN', 'FAHRT_ERSTMALS_GESEHEN']);
assert.equal(r.events[0].trip_key, '2026-11-14_4041', 'Schlüssel aus Betriebstag und Zugnummer');

// Lauf 2: eine Stunde später, nichts geändert → Direktabruf, nur das eine neue Fenster an der Tafel
c = mkClient({trips: {A: tripA(0), B: tripB}, board: ['A', 'B']});
r = await run(c, 60, '2026-11-12T13:00+01:00');
assert.equal(c.calls.boards, 2, 'nur das neu hinzugekommene Stundenfenster');
assert.deepEqual(c.calls.trip.sort(), ['A', 'B'], 'bekannte Fahrten direkt abgerufen');
assert.equal(r.events.length, 0);
const snapshots = () => fs.readdirSync(path.join(tmp, 'snapshots'))
	.flatMap(f => fs.readFileSync(path.join(tmp, 'snapshots', f), 'utf8').trim().split('\n'));
assert.equal(snapshots().length, 2, 'kein Schnappschuss ohne Änderung');

// Lauf 3: am Fahrtag 06:00 → Roth + Nürnberg gestrichen, erkannt über den Direktabruf
c = mkClient({trips: {A: tripA(1), B: tripB}, board: []});
r = await run(c, 12, '2026-11-14T06:00+01:00');
assert.deepEqual(names(r), ['HALT_GESTRICHEN', 'HALT_GESTRICHEN', 'HINWEIS_NEU']);
assert.equal(snapshots().length, 3, 'Schnappschuss nur für die geänderte Fahrt');

// Lauf 4: Fahrt-ID von A ungültig → Fenster wird neu abgefragt, Fahrt unter neuer ID gefunden
c = mkClient({trips: {A2: tripA(2), B: tripB}, board: ['A2', 'B']});
r = await run(c, 12, '2026-11-14T08:00+01:00');
assert.ok(c.calls.trip.includes('A2'), 'neue Fahrt-ID von der Tafel übernommen');
assert.ok(r.events.some(e => e.event === 'START_ZIEL_GEAENDERT'));
assert.equal(r.events.filter(e => e.event === 'HALT_AUS_LAUFWEG_ENTFERNT').length, 2);
assert.ok(!r.events.some(e => e.event === 'FAHRT_NICHT_MEHR_GEFUNDEN'));

// Lauf 5: beide Fahrten weder direkt noch auf der Tafel auffindbar
c = mkClient({trips: {}, board: []});
r = await run(c, 12, '2026-11-14T09:00+01:00');
assert.deepEqual(names(r), ['FAHRT_NICHT_MEHR_GEFUNDEN', 'FAHRT_NICHT_MEHR_GEFUNDEN']);

// Lauf 6: als fehlend markierte Fahrten werden nicht erneut gemeldet
c = mkClient({trips: {}, board: []});
r = await run(c, 12, '2026-11-14T10:00+01:00');
assert.equal(r.events.length, 0);
assert.equal(c.calls.trip.length, 0);

const events = readCsv('events.csv');
console.log('events.csv:');
for (const e of events) console.log(' ', e.detected_at, e.trip_key, e.event, e.stop, e.old_value, '→', e.new_value, `(${e.lead_time_h} h)`);
assert.equal(readCsv('runs.csv').length, 6);

// IRIS: Roth, RE 4041, Streichung am Fahrtag 05:47 angelegt
const planXml = `<timetable station="Roth"><s id="111-2611141525-4"><tl f="N" t="p" o="800734" c="RE" n="4041"/>
<ar pt="2611141525" pp="2" l="1" ppth="München Hbf|Ingolstadt Hbf|Treuchtlingen"/><dp pt="2611141526" pp="2" l="1" ppth="Nürnberg Hbf"/></s>
<s id="222-2611141530-3"><tl f="N" t="p" o="800734" c="RE" n="59127"/><dp pt="2611141530" l="16" ppth="Nürnberg Hbf"/></s></timetable>`;
let fchg = '<timetable station="Roth"></timetable>';
let planCalls = 0;
const fetchXml = async (p) => {
	if (p.startsWith('/station/')) return '<stations><station name="Roth" eva="8000317"/></stations>';
	if (p.startsWith('/plan/')) { planCalls++; return p.startsWith('/plan/8000317/261114/15') ? planXml : '<timetable/>'; }
	return fchg;
};
const icfg = {...cfg, iris: {...cfg.iris, stations: ['Roth']}};
let ir = await runIris(fetchXml, icfg, {now: new Date('2026-11-14T05:00+01:00')});
assert.equal(ir.events.length, 2, 'RE1 an/ab gesehen, RE16 ausgefiltert');
assert.equal(planCalls, 13);
fchg = `<timetable station="Roth"><s id="111-2611141525-4"><ar cs="c" clt="2611140547"/><dp cs="c" clt="2611140547"/></s></timetable>`;
ir = await runIris(fetchXml, icfg, {now: new Date('2026-11-14T06:00+01:00')});
assert.equal(planCalls, 14, 'bereits geladene Stundenscheiben werden nicht erneut abgerufen');
assert.equal(ir.events.length, 2);
assert.equal(ir.events[0].event, 'HALT_GESTRICHEN');
assert.equal(ir.events[0].cancellation_created_at, '2026-11-14T05:47:00');
const planFile = JSON.parse(fs.readFileSync(path.join(tmp, 'iris', 'plan_8000317.json'), 'utf8'));
assert.deepEqual(Object.keys(planFile.stops), ['111-2611141525-4'], 'nur RE1-Halte gespeichert');

// Auswertung (dieselbe Funktion wie auf der HTML-Seite)
const rep = buildReport(events, readCsv('iris_events.csv'));
assert.equal(rep.trips, 2);
assert.deepEqual(rep.halts, ['Nürnberg Hbf', 'Roth']);
assert.equal(rep.planned, 4, 'zwei Fahrten × zwei Halte standen im Fahrplan');
assert.equal(rep.cancelledLater.length, 2);
assert.equal(rep.sameDay, 2);
assert.equal(rep.histogram.find(b => b.label === '6–24 h').count, 2);
assert.equal(rep.iris.length, 1, 'Ankunft und Abfahrt zu einer Zeile zusammengefasst');
assert.equal(rep.iris[0].createdAt, '2026-11-14T05:47:00');
console.log('\nAuswertung:', {fahrten: rep.trips, imFahrplan: rep.planned, gestrichen: rep.cancelledLater.length, amFahrtag: rep.sameDay});
console.log('✓ Alle Offline-Tests bestanden');
