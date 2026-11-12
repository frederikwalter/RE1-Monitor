// Gemeinsame Hilfsfunktionen: Dateien, CSV, Zeit, Retry.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseCsv} from './docs/report.js';

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

// Hängt Zeilen an. Hat eine vorhandene Datei eine andere Kopfzeile (ältere Programmversion), wird sie
// einmalig auf die neue umgeschrieben; die Werte werden über die Spaltennamen zugeordnet.
export const appendCsv = (file, header, rows) => {
	if (!rows.length) return;
	ensureDir(path.dirname(file));
	const line = (r) => header.map(h => csvCell(r[h])).join(',');
	let exists = fs.existsSync(file);
	if (exists) {
		const text = fs.readFileSync(file, 'utf8');
		if (text.slice(0, text.indexOf('\n')).trim() !== header.join(',')) {
			const tmp = `${file}.${process.pid}.tmp`;
			fs.writeFileSync(tmp, [header.join(','), ...parseCsv(text).map(line)].join('\n') + '\n');
			fs.renameSync(tmp, file);
		}
	}
	fs.appendFileSync(file, (exists ? '' : header.join(',') + '\n') + rows.map(line).join('\n') + '\n');
};

export const appendJsonl = (file, obj) => {
	ensureDir(path.dirname(file));
	fs.appendFileSync(file, JSON.stringify(obj) + '\n');
};

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export const withRetry = async (fn, {retries = 3, baseDelay = 2000, label = ''} = {}) => {
	let lastErr;
	for (let i = 0; i <= retries; i++) {
		try { return await fn(); } catch (err) {
			lastErr = err;
			if (err.fatal) break;
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

export const isMain = (metaUrl) =>
	Boolean(process.argv[1]) && fileURLToPath(metaUrl) === path.resolve(process.argv[1]);
