// Offline-Test mit simulierten API-Antworten (kein Netz nötig).
// Simuliert: RE 4041 hält planmäßig in Roth, die DB legt um 05:47 am Fahrtag die Streichung an.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 're1-'));
process.env.RE1_DATA_DIR = tmp;
const {runCollect, irisTime, haltStatus} = await import('../collect.mjs');
const {buildReport, parseCsv} = await import('../docs/report.js');
const {loadConfig} = await import('../lib.mjs');

const cfg = {...loadConfig(), stations: ['Roth'], planHoursAhead: 12};
const readCsv = (name) => parseCsv(fs.readFileSync(path.join(tmp, name), 'utf8'));
const names = (r) => r.events.map(e => e.event);

assert.equal(irisTime('2611141525'), '2026-11-14T14:25:00.000Z', 'Winterzeit');
assert.equal(irisTime('2607141525'), '2026-07-14T13:25:00.000Z', 'Sommerzeit');
assert.equal(haltStatus({ar: {}, dp: {}}, {dp: {cs: 'c', clt: '2611140547'}}).status, 'teilweise gestrichen');

// Sollfahrplan Roth, Stunde 15: RE1 nach Nürnberg (4041), RE1 nach München (4042),
// eine andere Linie (RE 16) und eine Linie 1, die nicht über die Strecke fährt
const planXml = `<timetable station="Roth">
<s id="111-2611141328-4"><tl c="RE" n="4041"/><ar pt="2611141525" l="RE1" ppth="München Hbf|Ingolstadt Hbf|Treuchtlingen"/><dp pt="2611141526" l="RE1" ppth="Schwabach|Nürnberg Hbf"/></s>
<s id="333-2611141515-3"><tl c="RE" n="4042"/><ar pt="2611141535" l="RE1" ppth="Nürnberg Hbf|Schwabach"/><dp pt="2611141536" l="RE1" ppth="Treuchtlingen|Ingolstadt Hbf|München Hbf"/></s>
<s id="222-2611141530-3"><tl c="RE" n="59127"/><dp pt="2611141530" l="RE16" ppth="Nürnberg Hbf"/></s>
<s id="444-2611141540-2"><tl c="RE" n="777"/><dp pt="2611141540" l="RE1" ppth="Anderswo|Ganz woanders"/></s>
</timetable>`;
let fchg = '<timetable station="Roth"></timetable>';
let planCalls = 0;
const fetchXml = async (p) => {
	if (p.startsWith('/station/')) return '<stations><station name="Roth" eva="8000317"/></stations>';
	if (p.startsWith('/plan/')) { planCalls++; return p === '/plan/8000317/261114/15' ? planXml : '<timetable/>'; }
	return fchg;
};
const run = (now) => runCollect(fetchXml, cfg, {now: new Date(now)});

// Lauf 1, 05:00: beide RE1-Halte erstmals gesehen, planmäßig
let r = await run('2026-11-14T05:00+01:00');
assert.deepEqual(names(r), ['ERSTMALS_GESEHEN', 'ERSTMALS_GESEHEN'], 'RE 16 und fremde Linie 1 ausgefiltert');
assert.deepEqual(r.events.map(e => e.direction), ['N', 'S']);
assert.equal(r.events[0].new_status, 'planmäßig');
assert.equal(planCalls, 13);

// Lauf 2, 06:00: Streichung von RE 4041, angelegt um 05:47
fchg = `<timetable station="Roth"><s id="111-2611141328-4"><ar cs="c" clt="2611140547"/><dp cs="c" clt="2611140547"/></s></timetable>`;
r = await run('2026-11-14T06:00+01:00');
assert.equal(planCalls, 13 + 12, 'nur die gefüllte Stundenscheibe gilt als geladen, leere werden erneut versucht');
assert.deepEqual(names(r), ['HALT_GESTRICHEN']);
assert.equal(r.events[0].cancellation_created_at, '2026-11-14T05:47:00');
assert.equal(r.events[0].lead_time_h, 9.65, 'Vorlauf ab Anlagezeitpunkt, nicht ab Abruf');

// Lauf 3, 07:00: nichts Neues → kein Ereignis
r = await run('2026-11-14T07:00+01:00');
assert.equal(r.events.length, 0);

// Lauf 4, 16:00: Halt liegt in der Vergangenheit, IRIS hat die Änderung entfernt → Stand bleibt
fchg = '<timetable station="Roth"></timetable>';
r = await run('2026-11-14T16:00+01:00');
assert.equal(r.events.length, 0, 'keine scheinbare Wiederherstellung nach der Abfahrt');

const plan = JSON.parse(fs.readFileSync(path.join(tmp, 'state', 'plan_8000317.json'), 'utf8'));
assert.deepEqual(Object.keys(plan.stops).sort(), ['111-2611141328-4', '333-2611141515-3'], 'nur RE1-Halte gespeichert');
assert.equal(readCsv('runs.csv').length, 4);
const snaps = fs.readFileSync(path.join(tmp, 'snapshots', '2026-11-14.jsonl'), 'utf8').trim().split('\n');
assert.equal(snaps.length, 3, 'ein Schnappschuss je Ereignis');

// Auswertung (dieselbe Funktion wie auf der HTML-Seite)
const events = readCsv('events.csv');
console.log('events.csv:');
for (const e of events) console.log(' ', e.detected_at, e.train, e.station, e.planned_time, e.event, e.new_status, e.cancellation_created_at, `(${e.lead_time_h} h)`);
const rep = buildReport(events, '2026-11-14T15:30:00'); // RE 4041 ist gefahren, RE 4042 (15:36) steht noch aus
assert.equal(rep.halts, 2);
assert.equal(rep.trains.length, 2);
assert.deepEqual([rep.run, rep.runPlanned, rep.runCancelled, rep.upcoming], [1, 0, 1, 1]);
assert.deepEqual(rep.days, [{date: '2026-11-14', planned: 0, cancelled: 1}]);
const all = buildReport(events, '2026-11-15T00:00:00');
assert.deepEqual([all.run, all.runPlanned, all.runCancelled], [2, 1, 1], 'RE 4042 fuhr planmäßig');
assert.deepEqual(all.trains.find(t => t.cancelled).cancelledStations, ['Roth']);
assert.deepEqual(all.byTrain.N, [{train: 'RE 4041', time: '15:26', planned: 0, cancelled: 1}]);
assert.deepEqual(all.byTrain.S, [{train: 'RE 4042', time: '15:36', planned: 1, cancelled: 0}]);
assert.equal(rep.cancelled.length, 1);
assert.equal(rep.sameDay, 1);
assert.equal(rep.medianLeadH, 9.65);
assert.equal(rep.histogram.find(b => b.label === '6–24 h').count, 1);
assert.equal(rep.cancelled[0].createdAt, '2026-11-14T05:47:00');
assert.equal(rep.cancelled[0].exact, true);
console.log('\nAuswertung:', {halte: rep.halts, gestrichen: rep.cancelled.length, amFahrtag: rep.sameDay, medianVorlaufH: rep.medianLeadH});
console.log('✓ Alle Offline-Tests bestanden');
