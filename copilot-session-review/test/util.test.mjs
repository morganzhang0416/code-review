import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  activeMinutes,
  createLogger,
  fmtDateTime,
  fmtDuration,
  fmtTime,
  localDateKey,
  MINUTE,
  plural,
  readJson,
  writeFileAtomic,
} from '../src/util.mjs';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-session-review-util-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('local date and time formatting uses the local calendar and pads values', () => {
  const local = new Date(2026, 0, 5, 7, 3);
  assert.equal(localDateKey(local), '2026-01-05');
  assert.equal(fmtTime(local.getTime()), '07:03');
  assert.equal(fmtDateTime(local.getTime()), 'Mon 5 Jan 07:03');
  assert.equal(localDateKey(new Date(2026, 11, 31, 23, 59)), '2026-12-31');
});

test('fmtDuration and plural give short readable text', () => {
  assert.equal(fmtDuration(0), '0 min');
  assert.equal(fmtDuration(59.4), '59 min');
  assert.equal(fmtDuration(60), '1 h');
  assert.equal(fmtDuration(125), '2 h 5 min');
  assert.equal(plural(1, 'session'), '1 session');
  assert.equal(plural(2, 'session'), '2 sessions');
  assert.equal(plural(0, 'entry', 'entries'), '0 entries');
  assert.equal(plural(3, 'entry', 'entries'), '3 entries');
});

test('activeMinutes ignores idle gaps, zero gaps and unsorted drops', () => {
  const t0 = 1_000_000;
  const stamps = [t0, t0 + 5 * MINUTE, t0 + 5 * MINUTE, t0 + 40 * MINUTE, t0 + 42 * MINUTE];
  assert.equal(activeMinutes(stamps), 7);
  assert.equal(activeMinutes([t0 + 10 * MINUTE, t0 + 10 * MINUTE - 1000]), 0);
  assert.equal(activeMinutes([t0, t0 + 10 * MINUTE]), 10);
  assert.equal(activeMinutes([t0, t0 + 10 * MINUTE + 1]), 0);
  assert.equal(activeMinutes([t0, t0 + 30 * MINUTE], 30 * MINUTE), 30);
  assert.equal(activeMinutes([]), 0);
  assert.equal(activeMinutes([t0]), 0);
});

test('readJson returns the fallback for missing or invalid files', (t) => {
  const dir = tempDir(t);
  assert.deepEqual(readJson(path.join(dir, 'missing.json'), { ok: false }), { ok: false });
  fs.writeFileSync(path.join(dir, 'bad.json'), '{not json');
  assert.equal(readJson(path.join(dir, 'bad.json'), null), null);
  fs.writeFileSync(path.join(dir, 'good.json'), '{"a":1}');
  assert.deepEqual(readJson(path.join(dir, 'good.json'), null), { a: 1 });
});

test('writeFileAtomic creates parent folders, replaces content and leaves no temp file', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'nested', 'deep', 'state.json');
  writeFileAtomic(file, 'one');
  writeFileAtomic(file, 'two');
  assert.equal(fs.readFileSync(file, 'utf8'), 'two');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['state.json']);
});

test('createLogger appends levelled lines, rotates large logs and echoes warnings only when asked', (t) => {
  const dir = tempDir(t);
  const logsDir = path.join(dir, 'logs');
  const echoed = [];
  t.mock.method(console, 'error', (message) => echoed.push(message));

  const quiet = createLogger(logsDir);
  quiet.info('hello');
  quiet.warn('careful');
  quiet.error('broken');
  const lines = fs.readFileSync(quiet.file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^\d{4}-\d\d-\d\dT[\d:.]+Z INFO  hello$/);
  assert.match(lines[1], / WARN  careful$/);
  assert.match(lines[2], / ERROR broken$/);
  assert.deepEqual(echoed, []);

  const loud = createLogger(logsDir, { echoWarnings: true });
  loud.warn('shown');
  loud.info('not shown');
  assert.deepEqual(echoed, ['warning: shown']);

  fs.writeFileSync(quiet.file, 'x'.repeat(1_000_001));
  quiet.info('after rotate');
  assert.equal(fs.statSync(`${quiet.file}.old`).size, 1_000_001);
  assert.match(fs.readFileSync(quiet.file, 'utf8'), /INFO {2}after rotate\n$/);
});

test('createLogger never throws when the log folder cannot be created', (t) => {
  const dir = tempDir(t);
  const blocker = path.join(dir, 'file-not-folder');
  fs.writeFileSync(blocker, 'x');
  const logger = createLogger(path.join(blocker, 'logs'));
  assert.doesNotThrow(() => logger.error('still fine'));
});
