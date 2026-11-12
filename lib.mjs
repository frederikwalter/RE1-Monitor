// Gemeinsame Hilfsfunktionen: Dateien, CSV, Lock, Zeit, Retry.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const DATA = process.env.RE1_DATA_DIR || path.join(ROOT, 'data');

export const loadConfig = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

export const ensureDir = (d) => fs.mkdirSync(d, {recursive: true});

export const readJson = (file, fallback = null) => {
	try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};

// atomar schreiben, damit ein abgebrochener Lauf keine kaputten Zustandsdateien hinterlässt
export const writeJson = (file, obj) => {
	ensureDir(path.dirname(file));
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
	fs.renameSync(tmp, file);
};

const csvCell = (v) => {
	if (v === null || v === undefined) return '';
	const s = String(v);
	return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const appendCsv = (file, header, rows) => {
	if (!rows.length) return;
	ensureDir(path.dirname(file));
	const exists = fs.existsSync(file);
	const lines = rows.map(r => header.map(h => csvCell(r[h])).join(','));
	fs.appendFileSync(file, (exists ? '' : header.join(',') + '\n') + lines.join('\n') + '\n');
};

export const readCsv = (file) => {
	if (!fs.existsSync(file)) return [];
	const text = fs.readFileSync(file, 'utf8');
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
		else cell += c;
	}
	if (cell || row.length) { row.push(cell); rows.push(row); }
	const [header, ...body] = rows;
	return body.filter(r => r.length > 1).map(r => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
};

export const appendJsonl = (file, obj) => {
	ensureDir(path.dirname(file));
	fs.appendFileSync(file, JSON.stringify(obj) + '\n');
};

// einfacher Lock, damit sich Cron-Läufe nicht überlappen
export const withLock = async (name, fn) => {
	ensureDir(DATA);
	const lock = path.join(DATA, `.${name}.lock`);
	if (fs.existsSync(lock)) {
		const age = Date.now() - fs.statSync(lock).mtimeMs;
		if (age < 30 * 60 * 1000) {
			console.error(`[${name}] läuft bereits (Lock ${Math.round(age / 1000)} s alt) – Abbruch.`);
			return;
		}
		console.error(`[${name}] verwaister Lock wird entfernt.`);
	}
	fs.writeFileSync(lock, String(process.pid));
	try { return await fn(); } finally { fs.rmSync(lock, {force: true}); }
};

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export const withRetry = async (fn, {retries = 3, baseDelay = 2000, label = ''} = {}) => {
	let lastErr;
	for (let i = 0; i <= retries; i++) {
		try { return await fn(); } catch (err) {
			lastErr = err;
			if (i < retries) {
				const wait = baseDelay * 2 ** i;
				console.error(`  ! ${label} fehlgeschlagen (${err.code || err.message}), neuer Versuch in ${wait / 1000} s`);
				await sleep(wait);
			}
		}
	}
	throw lastErr;
};

// Zeit in Europe/Berlin formatieren (unabhängig von der Zeitzone des Servers)
const berlinFmt = new Intl.DateTimeFormat('sv-SE', {
	timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit',
	hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});
export const berlin = (d) => d ? berlinFmt.format(new Date(d)).replace(' ', 'T') : '';
export const berlinDate = (d) => berlin(d).slice(0, 10);

export const hoursBetween = (from, to) =>
	(from && to) ? Math.round((new Date(to) - new Date(from)) / 36e5 * 100) / 100 : '';

export const normName = (s) => (s || '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
