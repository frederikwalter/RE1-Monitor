// Offline-Test mit simulierten API-Antworten (kein Netz nötig).
// Szenario am 14.11.2026:
//   RE 4041 (München → Nürnberg) hält planmäßig in Roth. Um 05:47 legt die DB die Streichung an,
//   der Zug endet stattdessen in Treuchtlingen (zusätzlicher Halt, 12 min verspätet).
//   RE 4042 (Nürnberg → München) fährt mit Halt in Roth, zuletzt 15 min verspätet.
//   RE 39540 ist ein Pendelzug Treuchtlingen – Nürnberg.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 're1-'));
process.env.RE1_DATA_DIR = tmp;
const {runCollect, irisTime, haltStatus, EVENT_HEADER} = await import('../collect.mjs');
const {buildReport, buildSummary, parseCsv, messageLabel} = await import('../docs/report.js');
const {loadConfig} = await import('../lib.mjs');

const cfg = {...loadConfig(), stations: ['Roth'], contextStations: ['Treuchtlingen'], planHoursAhead: 12};
const readCsv = (name) => parseCsv(fs.readFileSync(path.join(tmp, name), 'utf8'));
const names = (r) => r.events.map(e => e.event).sort();

// ---------- Einzelfunktionen ----------
assert.equal(irisTime('2611141525'), '2026-11-14T14:25:00.000Z', 'Winterzeit');
assert.equal(irisTime('2607141525'), '2026-07-14T13:25:00.000Z', 'Sommerzeit');
assert.equal(haltStatus({ar: {}, dp: {}}, {dp: {cs: 'c', clt: '2611140547'}}).status, 'teilweise gestrichen');
const hs = haltStatus(
	{ar: {pt: '2611141458', ppth: 'München Hbf'}, dp: {pt: '2611141459', ppth: 'Roth|Nürnberg Hbf'}},
	{ar: {ct: '2611141510', m: [{t: 'd', c: '34'}, {t: 'f', c: '2000'}]}, dp: {cpth: ''}});
assert.equal(hs.delay, 12, 'Verspätung aus der Ankunft, wenn der Zug hier endet');
assert.equal(hs.terminus, 'endet hier');
assert.equal(hs.messages, 'd34;f2000');
assert.equal(messageLabel('d34'), 'Reparatur/Defekt an einem Signal (d34)');
assert.equal(messageLabel('x99'), 'Code x99');

// ---------- Simulierte API ----------
const rothPlan = `<timetable station="Roth">
<s id="111-2611141328-4"><tl c="RE" n="4041" t="p"/><ar pt="2611141525" l="RE1" ppth="München Hbf|Ingolstadt Hbf|Treuchtlingen"/><dp pt="2611141526" l="RE1" ppth="Schwabach|Nürnberg Hbf"/></s>
<s id="333-2611141515-3"><tl c="RE" n="4042" t="p"/><ar pt="2611141535" l="RE1" ppth="Nürnberg Hbf|Schwabach"/><dp pt="2611141536" l="RE1" ppth="Treuchtlingen|Ingolstadt Hbf|München Hbf"/></s>
<s id="555-2611141500-2"><tl c="RE" n="39540" t="s"/><ar pt="2611141509" l="RE1" ppth="Treuchtlingen|Pleinfeld"/><dp pt="2611141510" l="RE1" ppth="Schwabach|Nürnberg Hbf"/></s>
<s id="222-2611141530-3"><tl c="RE" n="59127"/><dp pt="2611141530" l="RE16" ppth="Nürnberg Hbf"/></s>
<s id="444-2611141540-2"><tl c="RE" n="777"/><dp pt="2611141540" l="RE1" ppth="Anderswo|Ganz woanders"/></s>
</timetable>`;
const empty = '<timetable/>';
let fchg = {Roth: empty, Treuchtlingen: empty};
let rothPlanCalls = 0;
const EVA = {Roth: '8000317', Treuchtlingen: '8000122'};
const fetchXml = async (p) => {
	const st = p.match(/^\/station\/(.+)$/);
	if (st) { const n = decodeURIComponent(st[1]); return `<stations><station name="${n}" eva="${EVA[n]}"/></stations>`; }
	if (p.startsWith('/plan/8000317/')) { rothPlanCalls++; return p === '/plan/8000317/261114/15' ? rothPlan : empty; }
	if (p.startsWith('/plan/')) return empty;
	if (p === '/fchg/8000317') return fchg.Roth;
	if (p === '/fchg/8000122') return fchg.Treuchtlingen;
	throw new Error(`unerwartete Anfrage ${p}`);
};
const run = (now) => runCollect(fetchXml, cfg, {now: new Date(now)});

// Vorhandene events.csv im alten Format (vor diesem Umbau): muss beim ersten Lauf übernommen werden
fs.writeFileSync(path.join(tmp, 'events.csv'),
	'detected_at,station,train,stop_id,direction,planned_time,event,old_status,new_status,cancellation_created_at,lead_time_h,lead_time_detected_h,planned_path,changed_path\n'
	+ '2026-11-13T05:00:00,Roth,RE 9999,999-2611131000-1,N,2026-11-13T10:25:00,ERSTMALS_GESEHEN,,planmäßig,,,5.4,München Hbf|Ingolstadt Hbf → Nürnberg Hbf,\n');

// Lauf 1, 05:00: drei RE1-Halte in Roth erstmals gesehen, alle planmäßig
let r = await run('2026-11-14T05:00+01:00');
assert.deepEqual(names(r), ['ERSTMALS_GESEHEN', 'ERSTMALS_GESEHEN', 'ERSTMALS_GESEHEN'], 'RE 16 und fremde Linie ausgefiltert');
assert.equal(rothPlanCalls, 13);
const migrated = readCsv('events.csv');
assert.equal(Object.keys(migrated[0]).join(','), EVENT_HEADER.join(','), 'alte Datei auf neue Kopfzeile umgeschrieben');
assert.equal(migrated[0].train, 'RE 9999', 'alte Zeile erhalten');
assert.equal(migrated.length, 4);

// Lauf 2, 06:00: RE 4041 in Roth gestrichen (angelegt 05:47), endet als zusätzlicher Halt in Treuchtlingen
fchg.Roth = `<timetable><s id="111-2611141328-4">
	<ar cs="c" clt="2611140547"><m t="d" c="34"/></ar><dp cs="c" clt="2611140547"><m t="d" c="34"/></dp></s></timetable>`;
fchg.Treuchtlingen = `<timetable><s id="111-2611141328-2"><tl c="RE" n="4041" t="p"/>
	<ar pt="2611141458" ps="a" ct="2611141510" l="RE1" ppth="München Hbf|Ingolstadt Hbf"><m t="d" c="34"/></ar>
	<dp pt="2611141459" ps="a" cpth="" l="RE1" ppth="Roth|Nürnberg Hbf"/></s></timetable>`;
r = await run('2026-11-14T06:00+01:00');
assert.equal(rothPlanCalls, 13 + 12, 'nur gefüllte Stundenscheiben gelten als geladen');
assert.deepEqual(names(r), ['ERSTMALS_GESEHEN', 'HALT_GESTRICHEN']);
const cancel = r.events.find(e => e.event === 'HALT_GESTRICHEN');
assert.equal(cancel.cancellation_created_at, '2026-11-14T05:47:00');
assert.equal(cancel.lead_time_h, 9.65, 'Vorlauf ab Anlagezeitpunkt, nicht ab Abruf');
assert.equal(cancel.messages, 'd34');
const ctx = r.events.find(e => e.station === 'Treuchtlingen');
assert.equal(ctx.role, 'kontext');
assert.equal(ctx.new_status, 'zusätzlich', 'Halt nur aus den Änderungen übernommen');
assert.equal(ctx.terminus, 'endet hier');
assert.equal(ctx.delay_min, 12);

// Lauf 3, 07:00: RE 4042 meldet 8 min Verspätung
fchg.Roth = fchg.Roth.replace('</timetable>', '<s id="333-2611141515-3"><dp ct="2611141544"/></s></timetable>');
r = await run('2026-11-14T07:00+01:00');
assert.deepEqual(names(r), ['VERSPAETUNG']);
assert.equal(r.events[0].delay_min, 8);

// Lauf 4, 08:00: Verspätung nur um 1 min geändert → kein Ereignis
fchg.Roth = fchg.Roth.replace('ct="2611141544"', 'ct="2611141545"');
r = await run('2026-11-14T08:00+01:00');
assert.equal(r.events.length, 0, 'kleine Änderungen der Verspätung werden nicht protokolliert');

// Lauf 5, 16:00: Sollzeit vorbei. RE 4042 steht noch in der API (15 min) → wird weiterverfolgt.
// RE 4041 fehlt in der API → keine scheinbare Wiederherstellung.
// Neu und erst nach der Abfahrt gemeldet: ein Halt in Roth (nachträglicher Anlagezeitpunkt, wird ignoriert)
// und ein Halt in Treuchtlingen (Verbleib, wird aufgenommen).
fchg.Roth = '<timetable><s id="333-2611141515-3"><dp ct="2611141551"/></s>'
	+ '<s id="666-2611141400-5"><tl c="RE" n="4099"/><ar pt="2611141530" cs="c" clt="2611141555" l="RE1" ppth="München Hbf"/><dp pt="2611141531" cs="c" clt="2611141555" l="RE1" ppth="Nürnberg Hbf"/></s></timetable>';
fchg.Treuchtlingen = fchg.Treuchtlingen.replace('</timetable>',
	'<s id="777-2611141400-2"><tl c="RE" n="4098"/><ar pt="2611141500" ps="a" l="RE1" ppth="München Hbf"/><dp pt="2611141501" ps="a" cpth="" l="RE1" ppth="Roth|Nürnberg Hbf"/></s></timetable>');
r = await run('2026-11-14T16:00+01:00');
assert.deepEqual(names(r), ['ERSTMALS_GESEHEN', 'VERSPAETUNG']);
assert.equal(r.events.find(e => e.event === 'VERSPAETUNG').delay_min, 15);
assert.equal(r.events.find(e => e.event === 'ERSTMALS_GESEHEN').station, 'Treuchtlingen', 'Roth-Halt nach der Abfahrt nicht aufgenommen');
assert.equal(r.halts, 0, 'vergangene Halte zählen nicht als anstehend');

// Lauf 6, 23:00: mehr als 6 h nach der Sollzeit → nicht mehr verfolgt
fchg.Roth = '<timetable><s id="333-2611141515-3"><dp ct="2611141620"/></s></timetable>';
r = await run('2026-11-14T23:00+01:00');
assert.equal(r.events.length, 0);

const plan = JSON.parse(fs.readFileSync(path.join(tmp, 'state', 'plan_8000317.json'), 'utf8'));
assert.deepEqual(Object.keys(plan.stops).sort(), ['111-2611141328-4', '333-2611141515-3', '555-2611141500-2', '666-2611141400-5'], 'nur RE1-Halte gespeichert');
const runs = readCsv('runs.csv');
assert.equal(runs.length, 6);
const snaps = fs.readFileSync(path.join(tmp, 'snapshots', '2026-11-14.jsonl'), 'utf8').trim().split('\n');
assert.equal(snaps.length, 8, 'ein Schnappschuss je Ereignis (3 + 2 + 1 + 2)');

// ---------- Auswertung (dieselben Funktionen wie auf der Seite) ----------
const events = readCsv('events.csv');
console.log('events.csv:');
for (const e of events) console.log(' ', e.detected_at, e.station.padEnd(13), e.train.padEnd(9), e.planned_time, e.event.padEnd(16), e.new_status, e.delay_min, e.terminus, e.messages);

const now = '2026-11-14T23:30:00';
const rep = buildReport(events, runs, {now, filter: {from: '2026-11-14'}});
assert.equal(rep.trains.length, 3, 'Zeitraumfilter blendet den alten Zug vom 13.11. aus');
const t4041 = rep.trains.find(t => t.number === '4041');
assert.equal(t4041.type, 'durch');
assert.equal(t4041.outcome, 'treuchtlingen');
assert.equal(t4041.contextDelay, 12);
assert.equal(rep.trains.find(t => t.number === '39540').type, 'pendel');
assert.equal(rep.trains.find(t => t.number === '4042').delay, 15);
assert.equal(rep.run, 2);
assert.deepEqual(rep.outcomes, {planned: 1, treuchtlingen: 1, gone: 0, unknown: 0});
assert.deepEqual(rep.shuttle, {run: 1, cancelled: 0});
assert.deepEqual(rep.days, [{date: '2026-11-14', planned: 1, treuchtlingen: 1, gone: 0, unknown: 0}]);
assert.equal(rep.cancelledHalts, 1);
assert.equal(rep.sameDay, 1);
assert.equal(rep.medianLeadH, 9.65);
assert.deepEqual(rep.reasons.map(x => [x.code, x.count]), [['d34', 1]]);
assert.deepEqual([rep.delays.halts.n, rep.delays.halts.late], [2, 1], 'RE 4042 (15 min) und Pendelzug (0 min)');
assert.deepEqual([rep.delays.treuchtlingen.n, rep.delays.treuchtlingen.late], [1, 1]);
assert.deepEqual(rep.byTrain.N.map(t => [t.train, t.byDate['2026-11-14']]), [['RE 4041', 'treuchtlingen']]);
assert.deepEqual(rep.coverage.gaps.map(g => g.hours), [8, 7], 'Lücken 08:00–16:00 und 16:00–23:00');
assert.equal(rep.coverage.lossy.length, 0);

const all = buildReport(events, runs, {now});
assert.equal(all.run, 3, 'ohne Filter zählt der Zug vom 13.11. mit');
assert.equal(all.trains.find(t => t.number === '9999').outcome, 'planned');
assert.equal(buildReport(events, runs, {now, filter: {hours: 'hvz'}}).run, 0, 'Tageszeitfilter');
assert.equal(buildReport(events, runs, {now, filter: {days: 'wochenende'}}).run, 2, '14.11.2026 ist ein Samstag');

const summary = buildSummary(rep).join('\n\n');
console.log('\n' + summary);
assert.match(summary, /Am 14\.11\.2026 wurden 2 durchgehende Züge/);
assert.match(summary, /1 Zug endete oder begann in Treuchtlingen/);
assert.match(summary, /Presseinformation vom 09\.10\.2026/);
assert.match(summary, /keine generellen zusätzlichen Verspätungen/);
assert.match(buildSummary(buildReport(events, runs, {now, filter: {hours: 'hvz'}}))[0], /noch kein beobachteter Zug/);
console.log('\n✓ Alle Offline-Tests bestanden');
