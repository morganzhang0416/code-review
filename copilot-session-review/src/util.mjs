import fs from 'node:fs';
import path from 'node:path';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad = (n) => String(n).padStart(2, '0');

/** Local calendar date as YYYY-MM-DD. */
export function localDateKey(date = new Date()) {
  const d = new Date(date);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local HH:MM. */
export function fmtTime(ms) {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** e.g. "Fri 23 Oct 20:51". */
export function fmtDateTime(ms) {
  const d = new Date(ms);
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${fmtTime(ms)}`;
}

/** e.g. "Friday 23 October 2026". */
export function fmtLongDate(ms) {
  return new Intl.DateTimeFormat('en-NZ', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    .format(new Date(ms))
    .replace(/,/g, '');
}

/** Short local time-zone name, e.g. "NZDT". */
export function fmtZone(ms) {
  try {
    const parts = new Intl.DateTimeFormat('en-NZ', { timeZoneName: 'short' }).formatToParts(new Date(ms));
    return parts.find((p) => p.type === 'timeZoneName')?.value || '';
  } catch {
    return '';
  }
}

export function fmtDuration(minutes) {
  const m = Math.round(minutes);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}

export function fmtNumber(n) {
  return Math.round(n).toLocaleString('en-NZ');
}

export function plural(n, singular, pluralForm = `${singular}s`) {
  return `${fmtNumber(n)} ${n === 1 ? singular : pluralForm}`;
}

/** Sum of gaps between consecutive timestamps that are no longer than `maxGap` (idle time is ignored). */
export function activeMinutes(sortedTimestamps, maxGap = 10 * MINUTE) {
  let total = 0;
  for (let i = 1; i < sortedTimestamps.length; i++) {
    const gap = sortedTimestamps[i] - sortedTimestamps[i - 1];
    if (gap > 0 && gap <= maxGap) total += gap;
  }
  return total / MINUTE;
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** Write via a temporary file and rename so a reader never sees a half-written file. */
export function writeFileAtomic(file, content) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * Append-only log file (rotated at ~1 MB). `echoWarnings` also prints warnings to stderr.
 * @param {string} logsDir
 * @param {{ echoWarnings?: boolean }} [options]
 */
export function createLogger(logsDir, { echoWarnings = false } = {}) {
  const file = path.join(logsDir, 'copilot-session-review.log');
  const write = (level, message) => {
    const line = `${new Date().toISOString()} ${level.padEnd(5)} ${message}`;
    if (echoWarnings && level === 'WARN') console.error(`warning: ${message}`);
    try {
      ensureDir(logsDir);
      try {
        if (fs.statSync(file).size > 1_000_000) fs.renameSync(file, `${file}.old`);
      } catch {
        // no log yet
      }
      fs.appendFileSync(file, `${line}\n`);
    } catch {
      // logging must never break a run
    }
  };
  return {
    file,
    info: (m) => write('INFO', m),
    warn: (m) => write('WARN', m),
    error: (m) => write('ERROR', m),
  };
}

export const silentLogger = { file: '', info() {}, warn() {}, error() {} };
