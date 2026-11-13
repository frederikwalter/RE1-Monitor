// Darstellung der Auswertung. Die Rechenlogik liegt in report.js.
// Die Versionsnummer zwingt den Browser, nach einer Änderung an report.js die neue Fassung zu laden.
import {
	parseCsv, buildReport, buildSummary, LATE_FROM, messageLabel, TRANSFER_RESULTS,
	CATEGORIES, CATEGORY_GROUPS, MAIN_CATEGORIES,
} from './report.js?v=7';

const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...children) => {
	const n = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) k === 'class' ? n.className = v : n.setAttribute(k, v);
	n.append(...children.filter(c => c !== null && c !== undefined && c !== false));
	return n;
};
const svgEl = (tag, attrs) => {
	const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
	for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
	return n;
};

// Datenquelle: ?src=<Ordner> oder, auf GitHub Pages, der Branch "data" desselben Repos
const repo = (() => {
	if (!location.hostname.endsWith('.github.io')) return null;
	return {owner: location.hostname.split('.')[0], name: location.pathname.split('/').filter(Boolean)[0]};
})();
const base = (() => {
	const src = new URLSearchParams(location.search).get('src');
	if (src) return src.replace(/\/?$/, '/');
	return repo ? `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/data/` : '../data/';
})();
const load = async (name, required = false) => {
	const res = await fetch(base + name, {cache: 'no-store'});
	if (!res.ok) {
		if (required) throw Object.assign(new Error(`${name} konnte nicht geladen werden (HTTP ${res.status}).`), {noData: true});
		return [];
	}
	return parseCsv(await res.text());
};

// ---------- Formatierung ----------

const fmtTime = (s) => s ? `${s.slice(8, 10)}.${s.slice(5, 7)}. ${s.slice(11, 16)}` : '–';
const fmtDay = (s) => `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)}`;
const WD = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const wd = (date) => WD[new Date(`${date}T12:00:00Z`).getUTCDay()];
const fmtLead = (h) => {
	if (h === null || Number.isNaN(h)) return '–';
	const abs = Math.abs(h);
	const txt = abs >= 48 ? `${(abs / 24).toFixed(1).replace('.', ',')} Tage`
		: abs >= 1 ? `${Math.floor(abs)} h ${String(Math.round(abs % 1 * 60)).padStart(2, '0')} min`
		: `${Math.round(abs * 60)} min`;
	return h < 0 ? `${txt} danach` : `${txt} vorher`;
};
const pct = (a, b) => b ? `${Math.round(a / b * 100)} %` : '–';
const dirLabel = {N: '→ Nürnberg', S: '→ München'};
// Kategorien je Zug und Tag: Farbe (Klasse c-<schlüssel>) und Zeichen, damit nichts allein an der Farbe hängt
const CAT_KEYS = Object.keys(CATEGORIES);
const swatch = (k, tag = 'i', cls = 'sw') => el(tag, {class: `${cls} c-${k}`}, CATEGORIES[k].mark);
const catText = (k) => CATEGORIES[k].long;
const countsText = (counts) => CAT_KEYS.filter(k => counts[k]).map(k => `${counts[k]} × ${catText(k)}`).join('; ');

const table = (node, head, rows, emptyText) => {
	node.replaceChildren();
	if (!rows.length) { node.append(el('caption', {class: 'empty'}, emptyText)); return; }
	node.append(el('thead', {}, el('tr', {}, ...head.map(([h, cls]) => el('th', cls ? {class: cls} : {}, h)))));
	node.append(el('tbody', {}, ...rows.map(r => el('tr', {}, ...r.map((c, i) => el('td', head[i][1] ? {class: head[i][1]} : {}, c ?? ''))))));
};
// Legende in Gruppen. Die fünf Hauptkategorien stehen immer drin, die übrigen nur, wenn sie vorkommen.
const categoryLegend = (counts, {dot = false} = {}) => {
	const shown = CAT_KEYS.filter(k => MAIN_CATEGORIES.includes(k) || counts[k]);
	return el('div', {class: 'catlegend'}, ...Object.entries(CATEGORY_GROUPS).map(([g, title]) => {
		const keys = shown.filter(k => CATEGORIES[k].group === g);
		const items = keys.map(k => el('span', {}, swatch(k), CATEGORIES[k].label));
		if (g === 'sonst' && dot) items.push(el('span', {}, el('i', {class: 'sw none'}, '·'), 'nicht beobachtet'));
		return items.length ? el('div', {class: 'group'}, el('span', {class: 'gtitle'}, title), ...items) : null;
	}));
};
const barList = (node, items, total, unit) => {
	const max = Math.max(1, ...items.map(b => b.count));
	node.replaceChildren(...items.map(b =>
		el('div', {class: 'row', title: `${b.label}: ${b.count} ${unit} (${pct(b.count, total)})`},
			el('div', {class: 'name'}, b.label),
			el('div', {class: 'track'}, el('div', {class: 'fill', style: `width:${b.count / max * 100}%`})),
			el('div', {class: 'num'}, `${b.count}`))));
};

// ---------- Abschnitte ----------

const renderStatus = (runs, events) => {
	const last = runs.at(-1);
	const node = $('status');
	node.replaceChildren();
	if (last) {
		const ageH = (Date.now() - new Date(last.run_at)) / 36e5;
		const errors = Number(last.errors);
		const state = ageH > 3 ? ['var(--critical)', 'Sammler steht seit'] : errors ? ['var(--warning)', 'Letzter Lauf mit Fehlern:'] : ['var(--good)', 'Letzter Lauf:'];
		node.append(el('span', {}, el('span', {class: 'dot', style: `background:${state[0]}`}), `${state[1]} ${fmtTime(last.run_at)} Uhr`));
		node.append(el('span', {}, `${last.halts} anstehende Halte geprüft, ${errors} Fehler`));
		node.append(el('span', {}, `${runs.length} Läufe seit ${fmtTime(runs[0].run_at)}`));
	} else if (events.length) {
		node.append(el('span', {}, `Stand: ${fmtTime(events.at(-1).detected_at)} Uhr`));
	}
};

const renderSummary = (rep) => {
	const paras = buildSummary(rep);
	$('summary').replaceChildren(...paras.map(p => el('p', {}, p)));
	$('copy').onclick = async () => {
		await navigator.clipboard.writeText(paras.join('\n\n'));
		$('copy').textContent = 'Kopiert';
		setTimeout(() => { $('copy').textContent = 'Text kopieren'; }, 1500);
	};
	const f = rep.filter;
	$('print-meta').textContent = `Stand ${fmtTime(rep.now)} Uhr · Zeitraum ${f.from ? fmtDay(f.from) : 'Beginn'} bis ${f.to ? fmtDay(f.to) : 'heute'}`
		+ `${f.days ? ` · ${f.days === 'werktags' ? 'Mo–Fr' : 'Sa–So'}` : ''}${f.hours ? ' · Abfahrt 6–9 und 16–19 Uhr' : ''}`;
};

const renderTiles = (rep) => {
	const o = rep.outcomes, n = rep.cancelledHalts;
	const tile = (label, value, sub) => el('div', {class: 'tile'},
		el('div', {class: 'label'}, label), el('div', {class: 'value'}, String(value)), el('div', {class: 'sub'}, sub));
	$('tiles').replaceChildren(
		tile('Durchgehende Züge', rep.run, rep.upcoming ? `gefahren; dazu ${rep.upcoming} anstehend` : 'gefahren'),
		tile('davon planmäßig', o.planned, `${pct(o.planned, rep.run)} mit allen Halten`),
		tile('endeten in Treuchtlingen', o.treuchtlingen, `${pct(o.treuchtlingen, rep.run)}, auch Beginn dort`),
		tile('nicht in Treuchtlingen', o.gone, `${pct(o.gone, rep.run)}; Halte gestrichen, auch dort kein Halt`),
		tile('Mittlerer Vorlauf', n ? `${Math.abs(rep.medianLeadH) >= 48 ? `${(rep.medianLeadH / 24).toFixed(1)} Tage` : `${rep.medianLeadH.toFixed(1)} h`}`.replace('.', ',') : '–',
			n ? `Median; ${pct(rep.sameDay, n)} erst am Fahrtag angelegt` : 'noch keine Streichung'),
	);
};

const throughCount = (counts) => counts.ontime + counts.late;
const total = (counts) => CAT_KEYS.reduce((s, k) => s + counts[k], 0);

const renderDays = (rep) => {
	$('days-legend').replaceChildren(categoryLegend(rep.categories));
	const dayMax = Math.max(1, ...rep.days.map(d => total(d.counts)));
	$('days').replaceChildren(...(rep.days.length ? rep.days.map(d => {
		const n = total(d.counts);
		return el('div', {class: 'row', title: `${wd(d.date)} ${fmtDay(d.date)}: ${countsText(d.counts)}`},
			el('div', {class: 'name'}, `${wd(d.date)} ${fmtDay(d.date)}`),
			el('div', {class: 'stack', style: `width:${n / dayMax * 100}%`},
				...CAT_KEYS.filter(k => d.counts[k]).map(k => el('div', {class: `c-${k}`, style: `flex:${d.counts[k]}`}))),
			el('div', {class: 'num'}, `${throughCount(d.counts)} von ${n} durchgehend`));
	}) : [el('div', {class: 'empty', style: 'grid-column:1/-1'}, 'Noch ist kein beobachteter Zug gefahren.')]));
};

// Kalender: eine Zeile je Zug, eine Spalte je Tag
const renderCalendar = (rep) => {
	const node = $('calendar');
	node.replaceChildren();
	$('calendar-legend').replaceChildren(categoryLegend(rep.categories, {dot: true}));
	if (!rep.dates.length) { node.append(el('caption', {class: 'empty'}, 'Noch ist kein beobachteter Zug gefahren.')); return; }
	node.append(el('thead', {}, el('tr', {}, el('th', {title: 'planmäßige Abfahrt am Startbahnhof'}, 'Abfahrt'), el('th', {}, 'Zug'),
		...rep.dates.map(d => el('th', {class: 'c', title: fmtDay(d)}, el('span', {}, wd(d)), el('br'), `${d.slice(8, 10)}.${d.slice(5, 7)}.`)))));
	const body = el('tbody');
	for (const dir of ['N', 'S']) {
		const list = rep.byTrain[dir] || [];
		if (!list.length) continue;
		body.append(el('tr', {class: 'group'}, el('th', {colspan: String(rep.dates.length + 2)}, `Richtung ${dirLabel[dir].slice(2)}`)));
		for (const t of list) {
			body.append(el('tr', {}, el('td', {class: 'num', title: `ab ${t.origin}`}, t.time), el('td', {}, t.train),
				...rep.dates.map(d => {
					const c = t.byDate[d];
					return el('td', {class: 'c'}, c
						? el('span', {class: `cell c-${c.category}`, title: `${t.train}, ${wd(d)} ${fmtDay(d)}: ${catText(c.category)} – ${c.note}`}, CATEGORIES[c.category].mark)
						: el('span', {class: 'cell none', title: `${t.train}, ${wd(d)} ${fmtDay(d)}: nicht beobachtet`}, '·'));
				})));
		}
	}
	node.append(body);
};

// Kreis aus Segmenten in Kategorie-Reihenfolge, beginnend oben im Uhrzeigersinn
const pie = (counts) => {
	const R = 20, C = 22, svg = svgEl('svg', {width: 44, height: 44, viewBox: '0 0 44 44', 'aria-hidden': 'true'});
	const keys = CAT_KEYS.filter(k => counts[k]), n = total(counts);
	if (keys.length === 1) { svg.append(svgEl('circle', {cx: C, cy: C, r: R, class: `c-${keys[0]}`})); return svg; }
	const pt = (f) => `${C + R * Math.sin(2 * Math.PI * f)},${C - R * Math.cos(2 * Math.PI * f)}`;
	let from = 0;
	for (const k of keys) {
		const to = from + counts[k] / n;
		svg.append(svgEl('path', {class: `c-${k}`, d: `M${C},${C} L${pt(from)} A${R},${R} 0 ${to - from > 0.5 ? 1 : 0} 1 ${pt(to)} Z`}));
		from = to;
	}
	return svg;
};
const renderPies = (rep) => {
	$('pies-legend').replaceChildren(categoryLegend(rep.categories));
	const pieRow = (dir) => {
		const list = rep.byTrain[dir] || [];
		return [el('div', {class: 'dir'}, dirLabel[dir]),
			el('div', {class: 'line'}, ...(list.length ? list.map(t => {
				const days = total(t.counts);
				return el('div', {class: 'pie', title: `${t.train}, Abfahrt ${t.time} Uhr ab ${t.origin}, ${days} ${days === 1 ? 'Tag' : 'Tage'}: ${countsText(t.counts)}`},
					pie(t.counts), el('div', {class: 't'}, t.time), el('div', {}, t.train), el('div', {class: 'c'}, `${throughCount(t.counts)} von ${days}`));
			}) : [el('span', {class: 'empty'}, 'Noch ist kein beobachteter Zug gefahren.')]))];
	};
	$('pies').replaceChildren(...pieRow('N'), ...pieRow('S'));
};

// Umstieg in Treuchtlingen; Farben und Zeichen wie bei den Kategorien
const T_CLASS = {reached: 'c-reached', missed: 'c-missed', feederCancelled: 'c-gone', connectionCancelled: 'c-missed', open: 'c-open'};
const T_MARK = {reached: 'U', missed: '✕', feederCancelled: '–', connectionCancelled: '✕', open: '?'};
const signed = (m) => m === null ? '–' : `${m > 0 ? '+' : m < 0 ? '−' : '±'}${Math.abs(m)} min`;
const hm = (s) => s ? s.slice(11, 16) : '–';
const transferCsv = (pairs) => {
	const cell = (v) => /[",\n;]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
	const head = ['betriebstag', 'richtung', 'durchgehender_zug', 'pendelzug', 'zubringer', 'ankunft_soll', 'ankunft_ist', 'gleis_ankunft',
		'anschluss', 'abfahrt_soll', 'abfahrt_ist', 'gleis_abfahrt', 'umstieg_soll_min', 'umstieg_ist_min', 'ergebnis', 'pendelzug_erstmals_gesehen'];
	const lines = pairs.map(p => [p.serviceDate, p.direction, p.through.train, p.shuttle.train, p.from.train, p.arrPlanned, p.arrActual, p.platformArr,
		p.to.train, p.depPlanned, p.depActual, p.platformDep, p.plannedMin ?? '', p.actualMin ?? '', TRANSFER_RESULTS[p.result], p.shuttleSeen].map(cell).join(','));
	return [head.join(','), ...lines].join('\n') + '\n';
};

const renderTransfers = (rep) => {
	const tr = rep.transfers, n = tr.counts;
	const tile = (label, value, sub) => el('div', {class: 'tile'},
		el('div', {class: 'label'}, label), el('div', {class: 'value'}, String(value)), el('div', {class: 'sub'}, sub));
	const cancelled = n.feederCancelled + n.connectionCancelled;
	const none = 'noch keine gefahrene Verbindung';
	$('transfer-tiles').replaceChildren(
		tile('mit Pendelzug', tr.withShuttle, tr.through ? `von ${tr.through} in Treuchtlingen endenden oder beginnenden Zügen` : 'noch kein solcher Zug gefahren'),
		tile('Umstieg erreicht', n.reached, tr.decided ? `${pct(n.reached, tr.decided)} der ${tr.decided} gefahrenen Verbindungen` : none),
		tile('Umstieg verpasst', n.missed, tr.decided ? `${pct(n.missed, tr.decided)}; Anschluss fuhr vor der Ankunft ab` : none),
		tile('Zug ausgefallen', cancelled, n.open ? `dazu ${n.open} noch offen` : 'Zubringer oder Anschluss'),
		tile('ohne Pendelzug', tr.withoutShuttle, 'durchgehende Züge, die in Treuchtlingen enden oder beginnen'),
	);

	const items = [['reached', n.reached, 'erreicht'], ['missed', n.missed, 'verpasst'],
		['feederCancelled', cancelled, 'Zubringer oder Anschluss ausgefallen'], ['open', n.open, 'noch offen']];
	const shown = items.filter(([, c]) => c).length ? items.filter(([, c]) => c) : items.slice(0, 2);
	$('transfer-legend').replaceChildren(el('div', {class: 'legend'}, ...shown.map(([k, , label]) =>
		el('span', {}, el('i', {class: `sw ${T_CLASS[k]}`}, T_MARK[k]), label))));

	// je Verbindung: eine Zeile, eine Spalte je Tag
	const slotsNode = $('transfer-slots');
	slotsNode.replaceChildren();
	const dates = [...new Set(tr.pairs.map(p => p.serviceDate))].sort();
	if (!tr.slots.length) {
		slotsNode.append(el('caption', {class: 'empty'}, 'Noch kein Pendelzug in Treuchtlingen erfasst.'));
	} else {
		slotsNode.append(el('thead', {}, el('tr', {}, el('th', {}, 'Zubringer → Anschluss'), el('th', {}, 'an → ab'), el('th', {}, 'Gleis'),
			el('th', {class: 'num'}, 'Soll'), el('th', {class: 'num'}, 'erreicht'),
			...dates.map(d => el('th', {class: 'c', title: fmtDay(d)}, el('span', {}, wd(d)), el('br'), `${d.slice(8, 10)}.${d.slice(5, 7)}.`)))));
		const body = el('tbody');
		for (const dir of ['N', 'S']) {
			const list = tr.slots.filter(s => s.direction === dir);
			if (!list.length) continue;
			body.append(el('tr', {class: 'group'}, el('th', {colspan: String(dates.length + 5)}, `Richtung ${dirLabel[dir].slice(2)}`)));
			for (const s of list) {
				const done = s.counts.reached + s.counts.missed + s.counts.feederCancelled + s.counts.connectionCancelled;
				const shuttle = s.shuttles.join(', ');
				body.append(el('tr', {},
					el('td', {}, dir === 'N' ? `${s.through} → ${shuttle}` : `${shuttle} → ${s.through}`),
					el('td', {class: 'num'}, `${s.arr} → ${s.dep}`), el('td', {}, s.platforms || '–'),
					el('td', {class: 'num'}, signed(s.plannedMin)),
					el('td', {class: 'num'}, `${s.counts.reached} von ${done}`),
					...dates.map(d => {
						const r = s.byDate[d];
						return el('td', {class: 'c'}, r
							? el('span', {class: `cell ${T_CLASS[r]}`, title: `${s.through}, ${fmtDay(d)}: ${TRANSFER_RESULTS[r]}`}, T_MARK[r])
							: el('span', {class: 'cell none', title: `${fmtDay(d)}: kein Pendelzug`}, '·'));
					})));
			}
		}
		slotsNode.append(body);
	}

	table($('transfers'),
		[['Tag'], ['Zubringer'], ['an Soll', 'num'], ['an Ist', 'num'], ['Gleis'], ['Anschluss'], ['ab Soll', 'num'], ['ab Ist', 'num'], ['Gleis'],
			['Umstieg Soll', 'num'], ['Umstieg Ist', 'num'], ['Ergebnis'], ['Pendelzug erstmals gesehen']],
		tr.pairs.map(p => [
			`${wd(p.serviceDate)} ${fmtDay(p.serviceDate)}`, p.from.train, hm(p.arrPlanned), hm(p.arrActual), p.platformArr || '–',
			p.to.train, hm(p.depPlanned), hm(p.depActual), p.platformDep || '–',
			signed(p.plannedMin), signed(p.actualMin),
			el('span', {}, el('i', {class: `sw ${T_CLASS[p.result]}`}, T_MARK[p.result]), TRANSFER_RESULTS[p.result]),
			`${fmtTime(p.shuttleSeen)} (${fmtLead(p.shuttleLeadH)})`,
		]),
		'Noch kein Umstieg auf einen Pendelzug erfasst.');
	$('transfer-download').onclick = () => {
		const a = el('a', {href: URL.createObjectURL(new Blob([transferCsv(tr.pairs)], {type: 'text/csv'})), download: 're1-umstiege-treuchtlingen.csv'});
		a.click();
		URL.revokeObjectURL(a.href);
	};
};

const renderLead = (rep) => barList($('histogram'), rep.leadHistogram, rep.cancelledHalts, 'Streichungen');

const renderReasons = (rep) => {
	const node = $('reasons');
	if (!rep.reasons.length) { node.replaceChildren(el('div', {class: 'empty', style: 'grid-column:1/-1'}, 'Zu den gestrichenen Halten liegen noch keine Meldungen vor.')); return; }
	barList(node, rep.reasons, rep.cancelledHalts, 'gestrichene Halte');
};

const renderDelays = (rep) => {
	const block = (title, d, emptyText) => el('div', {},
		el('h3', {}, title),
		d.n ? el('p', {class: 'note'}, `${d.late} von ${d.n} (${pct(d.late, d.n)}) ab ${LATE_FROM} min verspätet · Median ${String(d.median).replace('.', ',')} min · höchster Wert ${d.max} min`)
			: el('p', {class: 'empty'}, emptyText),
		d.n ? (() => { const b = el('div', {class: 'bars'}); barList(b, d.histogram, d.n, 'Halte'); return b; })() : null);
	$('delays').replaceChildren(
		block(`Bediente Halte in ${rep.stations.join(' und ')}`, rep.delays.halts, 'Noch keine Messung.'),
		block('Ankunft bzw. Abfahrt in Treuchtlingen (dort endende oder beginnende Züge)', rep.delays.treuchtlingen, 'Noch keine Messung.'));
};

let currentRows = [];
const renderTrains = (rep) => {
	const days = [...new Set(rep.trains.map(t => t.serviceDate))].sort().reverse();
	const keep = {status: $('f-status').value, day: $('f-day').value};
	const fill = (sel, all, opts, value) => {
		sel.replaceChildren(el('option', {value: ''}, all), ...opts.map(([v, t]) => el('option', {value: v}, t)));
		if (opts.some(([v]) => v === value)) sel.value = value;
	};
	fill($('f-status'), 'alle', [...CAT_KEYS.map(k => [k, catText(k)]), ['pendel', 'Pendelzüge']], keep.status);
	fill($('f-day'), 'alle', days.map(d => [d, `${wd(d)} ${fmtDay(d)}`]), keep.day);
	const haltCell = (h) => !h ? el('span', {class: 'muted'}, '–')
		: h.cancelled ? `✕ ${h.status}`
		: el('span', {class: 'muted'}, `✓ ${h.plannedTime.slice(11, 16)}${h.delay ? ` (+${h.delay})` : ''}`);
	const ctxCell = (t) => !t.context ? el('span', {class: 'muted'}, '–')
		: t.context.cancelled ? '✕ gestrichen'
		: `${t.context.terminus || 'Halt'}${t.contextDelay ? ` (+${t.contextDelay})` : ''}`;
	const renderRows = () => {
		const status = $('f-status').value, day = $('f-day').value;
		const rows = rep.trains.filter(t =>
			(!status || (status === 'pendel' ? t.type === 'pendel' : t.category === status))
			&& (!day || t.serviceDate === day));
		currentRows = rows;
		table($('trains'),
			[['Zug'], ['Richtung'], ['Abfahrt'], ['Kategorie'], ...rep.stations.map(s => [s]), ['Treuchtlingen'],
				['Streichung angelegt'], ['Vorlauf', 'num'], ['Meldung'], ['']],
			rows.map(t => [
				t.train, dirLabel[t.direction] || '', `${wd(t.serviceDate)} ${fmtTime(t.departure)} ${t.origin}`,
				t.type === 'pendel'
					? el('span', {}, el('i', {class: 'sw none'}, 'P'), `Pendelzug${t.replaces ? ` für ${t.replaces}` : ''}${t.cancelled ? ', Halte gestrichen' : ''}`)
					: el('span', {title: t.categoryNote}, swatch(t.category), catText(t.category)),
				...rep.stations.map(s => haltCell(t.halts[s])), ctxCell(t),
				t.cancelled ? fmtTime(t.createdAt) + (t.exact ? '' : ' *') : '', t.cancelled ? fmtLead(t.leadH) : '',
				t.messages.map(messageLabel).join(', '),
				el('span', {}, ...[t.sameDay && 'am Fahrtag gestrichen', !t.past && 'anstehend']
					.filter(Boolean).map(x => el('span', {class: 'tag'}, x))),
			]),
			'Kein Zug für diese Auswahl.');
		$('footnote').hidden = !rows.some(t => t.cancelled && !t.exact);
	};
	$('f-status').onchange = $('f-day').onchange = renderRows;
	renderRows();

	$('download').onclick = () => {
		const cell = (v) => /[",\n;]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
		const head = ['zug', 'richtung', 'betriebstag', 'abfahrt', 'typ', 'pendelzug_fuer', 'kategorie', 'kategorie_detail', ...rep.stations.map(s => `status_${s}`),
			'treuchtlingen', 'streichung_angelegt', 'vorlauf_h', 'verspaetung_min', 'verspaetung_treuchtlingen_min', 'meldungen'];
		const lines = currentRows.map(t => [t.train, t.direction, t.serviceDate, t.plannedTime, t.type, t.replaces, t.category ? catText(t.category) : '', t.categoryNote,
			...rep.stations.map(s => t.halts[s]?.status ?? ''), t.context ? (t.context.terminus || t.context.status) : '',
			t.createdAt, t.leadH ?? '', t.delay ?? '', t.contextDelay ?? '', t.messages.join(' ')].map(cell).join(','));
		const a = el('a', {href: URL.createObjectURL(new Blob([[head.join(','), ...lines].join('\n') + '\n'], {type: 'text/csv'})), download: 're1-zuege.csv'});
		a.click();
		URL.revokeObjectURL(a.href);
	};
};

const renderCoverage = (rep) => {
	const c = rep.coverage;
	const items = [];
	if (!c.start) items.push('Es liegt noch kein Protokoll der Läufe vor.');
	else {
		items.push(`Beobachtet seit ${fmtTime(c.start)} Uhr, letzter erfolgreicher Lauf ${fmtTime(c.end)} Uhr, ${c.runs} Läufe, davon ${c.errorRuns} mit Fehlern.`);
		items.push(c.gaps.length
			? `${c.gaps.length} ${c.gaps.length === 1 ? 'Lücke' : 'Lücken'} von mehr als 90 Minuten zwischen zwei Läufen. ${c.lossy.length ? `${c.lossy.length} davon länger als 18 Stunden: Dort können Züge fehlen.` : 'Keine ist länger als 18 Stunden, es fehlt also kein Zug; die Verspätungen sind in diesen Stunden ungenauer.'}`
			: 'Keine Lücke von mehr als 90 Minuten zwischen zwei Läufen.');
	}
	$('coverage').replaceChildren(...items.map(t => el('li', {}, t)));
	table($('gaps'), [['Von'], ['Bis'], ['Dauer', 'num'], ['']],
		c.gaps.map(g => [fmtTime(g.from), g.open ? 'jetzt' : fmtTime(g.to), `${String(g.hours).replace('.', ',')} h`,
			g.hours > 18 ? el('span', {class: 'tag'}, 'Züge können fehlen') : '']), '');
	$('gaps').hidden = !c.gaps.length;
};

// ---------- Start ----------

const filterFromForm = () => ({
	from: $('f-from').value || '', to: $('f-to').value || '',
	days: $('f-days').value || '', hours: $('f-hours').value || '',
});

try {
	const [events, runs] = await Promise.all([load('events.csv', true), load('runs.csv')]);
	renderStatus(runs, events);
	const render = () => {
		const rep = buildReport(events, runs, {filter: filterFromForm()});
		if (rep.allDates.length) { $('f-from').min = $('f-to').min = rep.allDates[0]; $('f-from').max = $('f-to').max = rep.allDates.at(-1); }
		for (const fn of [renderSummary, renderTiles, renderDays, renderCalendar, renderPies, renderTransfers, renderLead, renderReasons, renderDelays, renderTrains, renderCoverage]) fn(rep);
	};
	for (const id of ['f-from', 'f-to', 'f-days', 'f-hours']) $(id).onchange = render;
	$('f-reset').onclick = () => { for (const id of ['f-from', 'f-to', 'f-days', 'f-hours']) $(id).value = ''; render(); };
	$('print').onclick = () => window.print();
	if (repo) {
		const tree = `https://github.com/${repo.owner}/${repo.name}/tree/data`;
		$('raw-links').replaceChildren('Rohdaten: ', el('a', {href: `${base}events.csv`}, 'events.csv'), ', ',
			el('a', {href: `${base}runs.csv`}, 'runs.csv'), ', ', el('a', {href: `${tree}/snapshots`}, 'Schnappschüsse im Wortlaut der API'), '.');
	}
	render();
	$('content').hidden = false;
} catch (err) {
	$('status').textContent = '';
	const box = $('error');
	box.hidden = false;
	box.append(el('h2', {}, err.noData ? 'Noch keine Daten' : 'Fehler bei der Auswertung'), el('p', {}, err.message),
		el('p', {class: 'note'}, err.noData
			? `Quelle: ${base} – die Datei entsteht mit dem ersten erfolgreichen Lauf des Sammlers.`
			: 'Bitte die Seite ohne Cache neu laden (Cmd+Shift+R).'));
}
