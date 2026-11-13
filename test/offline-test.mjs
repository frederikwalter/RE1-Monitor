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

// Lauf 1, 05:00: drei RE1-Halte in Roth erstmals gesehen, alle planmäßig
let r = await run('2026-11-14T05:00+01:00');
assert.deepEqual(names(r), ['ERSTMALS_GESEHEN', 'ERSTMALS_GESEHEN', 'ERSTMALS_GESEHEN'], 'RE 16 und fremde Linie ausgefiltert');
assert.equal(rothPlanCalls, 13);
const first = readCsv('events.csv');
assert.equal(Object.keys(first[0]).join(','), EVENT_HEADER.join(','), 'neue Datei mit Kopfzeile');
assert.equal(first.length, 3);

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
assert.equal(rep.trains.length, 3);
const t4041 = rep.trains.find(t => t.number === '4041');
assert.equal(t4041.type, 'durch');
assert.equal(t4041.outcome, 'treuchtlingen');
assert.equal(t4041.contextDelay, 12);
assert.equal(rep.trains.find(t => t.number === '39540').type, 'pendel');
assert.equal(rep.trains.find(t => t.number === '4042').delay, 15);
assert.equal(rep.run, 2);
assert.deepEqual(rep.outcomes, {planned: 1, treuchtlingen: 1, gone: 0});
assert.deepEqual(rep.shuttle, {run: 1, cancelled: 0});
const cats = (o) => ({ontime: 0, late: 0, reached: 0, noShuttle: 0, missed: 0, gone: 0, open: 0, ...o});
assert.deepEqual(rep.days, [{date: '2026-11-14', counts: cats({late: 1, noShuttle: 1})}]);
assert.deepEqual(rep.categories, cats({late: 1, noShuttle: 1}), 'RE 4042 durchgehend mit 15 min, RE 4041 endet ohne Pendelzug');
assert.equal(rep.trains.find(t => t.number === '4042').categoryNote, '+15 min in Roth');
assert.equal(rep.cancelledHalts, 1);
assert.equal(rep.sameDay, 1);
assert.equal(rep.medianLeadH, 9.65);
assert.deepEqual(rep.reasons.map(x => [x.code, x.count]), [['d34', 1]]);
assert.deepEqual([rep.delays.halts.n, rep.delays.halts.late], [2, 1], 'RE 4042 (15 min) und Pendelzug (0 min)');
assert.deepEqual([rep.delays.treuchtlingen.n, rep.delays.treuchtlingen.late], [1, 1]);
assert.deepEqual(rep.byTrain.N.map(t => [t.train, t.byDate['2026-11-14'].category, t.counts.noShuttle]), [['RE 4041', 'noShuttle', 1]]);
assert.deepEqual(rep.byTrain.S.map(t => [t.train, t.byDate['2026-11-14'].category]), [['RE 4042', 'late']]);
assert.deepEqual(rep.coverage.gaps.map(g => g.hours), [8, 7], 'Lücken 08:00–16:00 und 16:00–23:00');
assert.equal(rep.coverage.lossy.length, 0);

assert.equal(buildReport(events, runs, {now, filter: {to: '2026-11-13'}}).run, 0, 'Zeitraumfilter');
assert.equal(buildReport(events, runs, {now, filter: {hours: 'hvz'}}).run, 0, 'Tageszeitfilter');
assert.equal(buildReport(events, runs, {now, filter: {days: 'wochenende'}}).run, 2, '14.11.2026 ist ein Samstag');

const summary = buildSummary(rep).join('\n\n');
console.log('\n' + summary);
assert.match(summary, /Am 14\.11\.2026 wurden 2 durchgehende Züge/);
assert.match(summary, /1 Zug endete oder begann in Treuchtlingen/);
assert.match(summary, /Presseinformation vom 09\.10\.2026/);
assert.match(summary, /keine generellen zusätzlichen Verspätungen/);
assert.match(buildSummary(buildReport(events, runs, {now, filter: {hours: 'hvz'}}))[0], /noch kein beobachteter Zug/);
assert.equal(rep.transfers.pairs.length, 0, 'ohne Pendelzug in Treuchtlingen kein Umstieg');

// ---------- Umstieg auf Pendelzüge in Treuchtlingen, 15.11.2026 ----------
// Die Pendelzüge stehen in Treuchtlingen nur in den Änderungen, Laufweg nur Roth/Nürnberg.
//   A  RE 4010 endet 10:22 (+10)  → Pendel 39540 ab 10:21 pünktlich        → verpasst
//   B  RE 4040 endet 20:22         → Pendel 39550 ab 20:22                  → erreicht (0 min)
//   C  RE 4044 endet 22:22 (+8)    → Pendel 39544 ab 22:21, wartet (+10/+11) → erreicht
//   D  RE 4020 endet 14:21         → kein Pendelzug
//   E  Pendel 39561 aus Nürnberg an 18:38 (+7) → RE 4037 beginnt 18:40 pünktlich → verpasst
const thru = (id, n, ar, arCt, pp) => `<s id="${id}"><tl c="RE" n="${n}" t="p"/>`
	+ `<ar pt="${ar}" ps="a"${arCt ? ` ct="${arCt}"` : ''} pp="${pp}" l="RE1" ppth="München Hbf|Ingolstadt Hbf"><m t="d" c="34"/></ar>`
	+ `<dp pt="${ar}" ps="a" cpth="" l="RE1" ppth="Roth|Nürnberg Hbf"/></s>`;
const shuttleN = (id, n, dp, dpCt, pp) => `<s id="${id}"><tl c="RE" n="${n}" t="s"/>`
	+ `<dp pt="${dp}"${dpCt ? ` ct="${dpCt}"` : ''} pp="${pp}" l="RE1" ppth="Roth|Nürnberg Hbf"/></s>`;
const treuchtlingen15 = (c39544) => '<timetable>'
	+ thru('A-2611150904-9', '4010', '2611151022', '2611151032', '3') + shuttleN('S1-2611151021-1', '39540', '2611151021', '', '2')
	+ thru('B-2611151904-9', '4040', '2611152022', '', '3') + shuttleN('S2-2611152022-1', '39550', '2611152022', '', '2')
	+ thru('C-2611152104-9', '4044', '2611152222', '2611152230', '3') + shuttleN('S3-2611152221-1', '39544', '2611152221', c39544, '2')
	+ thru('D-2611151304-9', '4020', '2611151421', '', '3')
	+ '<s id="S4-2611151810-3"><tl c="RE" n="39561" t="s"/><ar pt="2611151838" ct="2611151845" pp="2" l="RE1" ppth="Nürnberg Hbf|Roth"/></s>'
	+ '<s id="E-2611151840-1"><tl c="RE" n="4037" t="p"/><ar pt="2611151840" ps="a" cpth="" pp="3" l="RE1" ppth="Nürnberg Hbf|Roth"/>'
	+ '<dp pt="2611151840" ps="a" pp="3" l="RE1" ppth="Ingolstadt Hbf|München Hbf"/></s>'
	+ '</timetable>';
// In Roth: RE 4040 gestrichen, an seiner Stelle der Pendelzug 39550
fchg.Roth = '<timetable><s id="S2-2611152022-2"><tl c="RE" n="39550" t="s"/><ar pt="2611152040" l="RE1" ppth="Treuchtlingen"/><dp pt="2611152040" l="RE1" ppth="Nürnberg Hbf"/></s>'
	+ '<s id="A-2611150904-10"><tl c="RE" n="4010" t="p"/><ar pt="2611151040" cs="c" clt="2611150300" l="RE1" ppth="München Hbf|Ingolstadt Hbf"/><dp pt="2611151040" cs="c" clt="2611150300" l="RE1" ppth="Nürnberg Hbf"/></s>'
	+ '<s id="B-2611151904-10"><tl c="RE" n="4040" t="p"/><ar pt="2611152040" cs="c" clt="2611150300" l="RE1" ppth="München Hbf|Ingolstadt Hbf"/><dp pt="2611152040" cs="c" clt="2611150300" l="RE1" ppth="Nürnberg Hbf"/></s></timetable>';
fchg.Treuchtlingen = treuchtlingen15('2611152231');
r = await run('2026-11-15T09:00+01:00');
const tEvents = r.events.filter(e => e.station === 'Treuchtlingen');
assert.equal(tEvents.length, 9, 'alle Durchläufer und Pendelzüge in Treuchtlingen erfasst');
const s39550 = tEvents.find(e => e.train === 'RE 39550');
assert.equal(s39550.direction, 'N');
assert.equal(s39550.departure_planned, '2026-11-15T20:22:00');
assert.equal(s39550.platform_departure, '2');
assert.equal(s39550.arrival_planned, '');
const t4010 = tEvents.find(e => e.train === 'RE 4010');
assert.deepEqual([t4010.arrival_actual, t4010.platform_arrival, t4010.departure_actual], ['2026-11-15T10:32:00', '3', ''], 'endet hier: keine Abfahrt');
assert.equal(tEvents.find(e => e.train === 'RE 39561').direction, 'S', 'Pendelzug aus Nürnberg');
assert.equal(tEvents.find(e => e.train === 'RE 4037').direction, 'S');

// 1 min mehr Verspätung: in Treuchtlingen protokolliert (in Roth erst ab 5 min)
fchg.Treuchtlingen = treuchtlingen15('2611152232');
r = await run('2026-11-15T10:00+01:00');
assert.deepEqual(r.events.map(e => [e.event, e.train, e.departure_actual]), [['VERSPAETUNG', 'RE 39544', '2026-11-15T22:32:00']]);

const events15 = readCsv('events.csv');
const rep15 = buildReport(events15, readCsv('runs.csv'), {now: '2026-11-16T00:00:00', filter: {from: '2026-11-15'}});
const tr = rep15.transfers;
const pairOf = (n) => tr.pairs.find(p => p.through.train === `RE ${n}`);
assert.deepEqual(tr.pairs.map(p => [p.through.train, p.shuttle.train, p.plannedMin, p.actualMin, p.result]).sort(), [
	['RE 4010', 'RE 39540', -1, -11, 'missed'],
	['RE 4037', 'RE 39561', 2, -5, 'missed'],
	['RE 4040', 'RE 39550', 0, 0, 'reached'],
	['RE 4044', 'RE 39544', -1, 2, 'reached'],
]);
assert.deepEqual([pairOf(4040).platformArr, pairOf(4040).platformDep], ['3', '2']);
assert.deepEqual(tr.counts, {reached: 2, missed: 2, feederCancelled: 0, connectionCancelled: 0, open: 0});
assert.deepEqual([tr.through, tr.withShuttle, tr.withoutShuttle, tr.decided, tr.platformChange], [5, 4, 1, 4, 4]);
assert.deepEqual(tr.plannedRange, [-1, 2]);
assert.deepEqual(tr.slots.map(s => [s.direction, s.through, s.arr, s.dep, s.counts.reached]),
	[['N', 'RE 4010', '10:22', '10:21', 0], ['N', 'RE 4040', '20:22', '20:22', 1], ['N', 'RE 4044', '22:22', '22:21', 1], ['S', 'RE 4037', '18:38', '18:40', 0]]);
assert.equal(rep15.trains.find(t => t.number === '39550').replaces, 'RE 4040', 'Pendelzug in Roth seinem Durchläufer zugeordnet');
assert.deepEqual(rep15.trains.filter(t => t.type === 'durch').map(t => [t.train, t.category, t.categoryNote]).sort(), [
	['RE 4010', 'missed', 'RE 39540 fuhr 11 min vor Ankunft des Zubringers ab'],
	['RE 4040', 'reached', 'RE 39550, Umstiegszeit 0 min'],
]);
assert.deepEqual(rep15.categories, cats({reached: 1, missed: 1}));
assert.equal(buildReport(events15, [], {now: '2026-11-15T21:00:00', filter: {from: '2026-11-15'}}).transfers.counts.open, 1, 'RE 4044 noch nicht angekommen');
assert.deepEqual(buildReport(events15, [], {now: '2026-11-16T00:00:00', filter: {from: '2026-11-15', hours: 'hvz'}}).transfers.pairs.map(p => p.through.train), ['RE 4037'], 'Filter wirkt: nur 18:40 liegt in der Hauptverkehrszeit');

const summary15 = buildSummary(rep15).join('\n\n');
console.log('\n' + summary15);
assert.match(summary15, /Für 4 von 5 in Treuchtlingen endenden oder beginnenden durchgehenden Zügen gab es dort einen Pendelzug/);
assert.match(summary15, /für einen weiteren nicht/);
assert.match(summary15, /Die geplante Umstiegszeit betrug −1 bis 2 Minuten, in 4 von 4 Fällen mit Wechsel des Gleises/);
assert.match(summary15, /Von 4 Umstiegen waren 2 \(50 %\) erreichbar, 2 nicht/);
console.log('\n✓ Alle Offline-Tests bestanden');
