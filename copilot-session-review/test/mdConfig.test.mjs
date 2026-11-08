import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { code, mdText, quote } from '../src/md.mjs';
import { loadConfig, ROOT } from '../src/config.mjs';

test('mdText escapes Markdown characters and flattens line breaks', () => {
  assert.equal(mdText('a\r\nb\nc'), 'a b c');
  assert.equal(mdText('*bold* _it_ `x` [l] <h> a|b #t \\'), '\\*bold\\* \\_it\\_ \\`x\\` \\[l\\] \\<h\\> a\\|b \\#t \\\\');
  assert.equal(mdText(null), '');
  assert.equal(mdText(undefined), '');
  assert.equal(mdText(42), '42');
});

test('code wraps in backticks, swaps inner backticks and shortens', () => {
  assert.equal(code('  a   b\n c '), '`a b c`');
  assert.equal(code('a`b'), "`a'b`");
  assert.equal(code('x'.repeat(10), 5), `\`${'x'.repeat(4)}…\``);
  assert.equal(code('x'.repeat(5), 5), `\`${'x'.repeat(5)}\``);
  assert.equal(code(undefined), '``');
});

test('quote uses curly quotes and escapes the text', () => {
  assert.equal(quote('a*b\nc'), '“a\\*b c”');
});

test('loadConfig uses defaults under the user profile', () => {
  const home = path.resolve('tester-home');
  const cfg = loadConfig({ USERPROFILE: home });
  assert.equal(cfg.lookbackHours, 24);
  assert.equal(cfg.sessionStateDir, path.join(home, '.copilot', 'session-state'));
  assert.deepEqual(cfg.vscodeUserDirs, [
    path.join(home, 'AppData', 'Roaming', 'Code', 'User'),
    path.join(home, 'AppData', 'Roaming', 'Code - Insiders', 'User'),
  ]);
  assert.equal(cfg.reportsDir, path.join(ROOT, 'reports'));
  assert.equal(cfg.stateDir, path.join(ROOT, 'state'));
  assert.equal(cfg.logsDir, path.join(ROOT, 'logs'));
  assert.equal(cfg.python, '');
  assert.equal(cfg.titleLookup, true);
  assert.equal(cfg.notify, true);
});

test('loadConfig honours overrides and ignores bad numbers', () => {
  const cfg = loadConfig({
    USERPROFILE: 'H',
    APPDATA: 'A',
    SESSION_REVIEW_LOOKBACK_HOURS: '6',
    SESSION_REVIEW_SESSION_STATE: 'S',
    SESSION_REVIEW_VSCODE_DIRS: ['d1', '', 'd2'].join(path.delimiter),
    SESSION_REVIEW_REPORTS_DIR: 'R',
    SESSION_REVIEW_STATE_DIR: 'ST',
    SESSION_REVIEW_LOGS_DIR: 'L',
    SESSION_REVIEW_PYTHON: 'py',
    SESSION_REVIEW_TITLES: '0',
    SESSION_REVIEW_NOTIFY: '0',
  });
  assert.equal(cfg.lookbackHours, 6);
  assert.equal(cfg.sessionStateDir, 'S');
  assert.deepEqual(cfg.vscodeUserDirs, ['d1', 'd2']);
  assert.deepEqual([cfg.reportsDir, cfg.stateDir, cfg.logsDir, cfg.python], ['R', 'ST', 'L', 'py']);
  assert.equal(cfg.titleLookup, false);
  assert.equal(cfg.notify, false);
  for (const bad of ['0', '-3', 'abc', 'Infinity', '']) {
    assert.equal(loadConfig({ USERPROFILE: 'H', SESSION_REVIEW_LOOKBACK_HOURS: bad }).lookbackHours, 24, bad);
  }
  assert.equal(loadConfig({ USERPROFILE: 'H', APPDATA: 'A' }).vscodeUserDirs[0], path.join('A', 'Code', 'User'));
});
