import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyze } from '../src/analyze.mjs';
import { addFile, newChat } from '../src/collect/common.mjs';
import { mdInline } from '../src/md.mjs';
import { buildDigest, renderMarkdown } from '../src/report.mjs';

const BASE = Date.parse('2026-10-23T00:00:00Z');
const at = (min) => BASE + min * 60_000;
const WINDOW = { start: BASE, end: BASE + 24 * 3_600_000 };

function chat(id, { cwd = 'C:\\Work\\proj', title = '', group = null } = {}) {
  const c = newChat({ id, source: 'agents', title, cwd });
  c.group = group;
  return c;
}

function prompt(c, min, text, extra = {}) {
  c.prompts.push({ ts: at(min), text, chars: text.length, steering: false, attachments: 0, ...extra });
  c.timestamps.push(at(min));
}

function tool(c, min, fields) {
  const t = { id: `${c.id}-${c.toolCalls.length}`, name: 'powershell', category: 'shell', ts: at(min), endTs: at(min), ok: true, ...fields };
  c.toolCalls.push(t);
  c.timestamps.push(at(min));
  return t;
}

function edit(c, min, file) {
  addFile(c, `${c.cwd}\\${file}`, 'edit', at(min));
  tool(c, min, { name: 'edit', category: 'edit' });
}

function scenario() {
  const checkedLate = chat('a', { title: 'Checked after edit' });
  prompt(checkedLate, 0, 'Implement feature X');
  edit(checkedLate, 10, 'src\\x.ts');
  tool(checkedLate, 20, { command: 'npm test', exitCode: 0 });
  checkedLate.completions.push({ ts: at(21), summary: 'Done. See `x.ts`', success: true });
  checkedLate.assistantMessages = 2;
  checkedLate.lastAssistantTs = at(21);

  const checkedEarly = chat('b', { title: 'Checked before edit', cwd: 'C:\\Other' });
  prompt(checkedEarly, 30, 'Refactor Y');
  tool(checkedEarly, 31, { command: 'npm test', exitCode: 0 });
  edit(checkedEarly, 40, 'src\\y.ts');

  const long = chat('c', { title: 'Marathon', cwd: 'C:\\Long' });
  for (let i = 0; i < 16; i++) prompt(long, 60 + i, i === 3 ? 'still not working after your change' : i === 5 ? "that's not what I asked for" : `step ${i}`);
  prompt(long, 80, 'x'.repeat(25_000));
  for (let i = 0; i < 5; i++) tool(long, 81 + i, { command: 'node probe.cjs', ok: false });
  long.approvals.human = 5;
  long.maxInputTokens = 400_000;

  const parallelA = chat('d', { title: 'Parallel A', cwd: 'C:\\Shared' });
  prompt(parallelA, 200, 'change a');
  edit(parallelA, 205, 'src\\a.ts');
  const parallelB = chat('e', { title: 'Parallel B', cwd: 'C:\\Shared' });
  prompt(parallelB, 201, 'change b');
  edit(parallelB, 207, 'src\\b.ts');
  tool(parallelA, 210, { command: 'npx tsc --noEmit', exitCode: 2 });
  tool(parallelB, 211, { command: 'npm run lint', exitCode: 0 });

  const quick = chat('f', { title: 'Quick question' });
  prompt(quick, 300, 'what does this flag mean? email me at someone@example.com');
  quick.premium = 15;
  quick.credits = 2;
  quick.inputTokens = 1200;
  quick.outputTokens = 300;
  quick.modelUse['claude-opus-5.5'] = { prompts: 1, premium: 15 };
  quick.modelNames['claude-opus-5.5'] = 'Claude Opus 5.5';
  quick.errors.push({ ts: at(301), type: 'query', message: 'Failed to get response from the AI model' });

  const grouped1 = chat('g1', { title: 'chat one', group: { id: 'S', title: 'Grouped session', order: 0 }, cwd: 'C:\\Docs' });
  prompt(grouped1, 400, 'write docs');
  addFile(grouped1, 'C:\\Docs\\README.md', 'edit', at(401));
  const grouped2 = chat('g2', { title: 'chat two', group: { id: 'S', title: 'Grouped session', order: 1 }, cwd: 'C:\\Docs' });
  prompt(grouped2, 402, 'more docs');
  grouped2.skills.push('repo-search');
  grouped2.subagents.push({ name: 'code-review', display: 'review', ts: at(403), toolCalls: 3, durationMs: 1000 });

  return [checkedLate, checkedEarly, long, parallelA, parallelB, quick, grouped1, grouped2];
}

test('analyze groups chats, totals activity and raises evidence-based findings', () => {
  const a = analyze(scenario(), { window: WINDOW, now: WINDOW.end });
  assert.equal(a.totals.chats, 8);
  assert.equal(a.totals.entries, 7, 'two chats of one Agents session form one entry');
  const grouped = a.entries.find((e) => e.title === 'Grouped session');
  assert.equal(grouped.chatCount, 2);
  assert.equal(grouped.codeFiles.length, 0, 'README is documentation');

  const improve = Object.fromEntries(a.improve.map((f) => [f.id, f]));
  assert.ok(improve.unchecked, 'edit after the last check');
  assert.match(improve.unchecked.detail, /Checked before edit/);
  assert.doesNotMatch(improve.unchecked.detail, /Checked after edit/);
  assert.match(improve['failing-check'].detail, /npx tsc --noEmit/);
  assert.match(improve.long.detail, /Marathon.*17 prompts.*400k tokens/);
  assert.ok(improve['large-prompts']);
  assert.match(improve.corrections.detail, /2 prompts/);
  assert.match(improve.failures.detail, /node probe\.cjs.*×5/);
  assert.match(improve['parallel-edits'].detail, /Parallel A.*Parallel B/);
  assert.match(improve.approvals.detail, /5 tool calls/);
  assert.match(improve['model-choice'].detail, /Quick question.*Claude Opus 5\.5/);
  assert.match(improve['ended-on-error'].detail, /Quick question/);
  assert.deepEqual(
    a.improve.map((f) => f.severity),
    a.improve.map((f) => f.severity).slice().sort((x, y) => y - x),
    'sorted by severity',
  );
  assert.equal(a.focus.length, 3);

  const good = Object.fromEntries(a.good.map((g) => [g.id, g]));
  assert.match(good.checked.detail, /^3 of 4 sessions/, 'a failing check still counts as checked; it is reported separately');
  assert.ok(good.completed);
  assert.ok(good.skills);
  assert.ok(good.delegation);
  assert.match(a.summary, /7 sessions\*\* \(8 chats\)/);
});

test('renderMarkdown and buildDigest produce complete, redacted output', () => {
  const a = analyze(scenario(), { window: WINDOW, now: WINDOW.end });
  const meta = { version: '0.0.0-test', scheduled: true, sources: { agents: { dir: 'C:\\x', scanned: 8 }, vscode: { scanned: 0 }, titles: '' } };
  const md = renderMarkdown(a, meta);
  for (const heading of ['# Copilot daily review', '## Summary', '## Things you did', '## What went well', '## What to improve', '## Focus for tomorrow', '## About this report']) {
    assert.ok(md.includes(heading), heading);
  }
  assert.match(md, /\(scheduled run\)/);
  assert.match(md, /\| Agents \/ CLI premium units \(estimate\) \| 15 \|/);
  assert.match(md, /\| VS Code chat credits \| 2 \|/);
  assert.match(md, /\| Recorded input tokens \| 1,200 \|/);
  assert.match(md, /\| Recorded output tokens \| 300 \|/);
  assert.match(md, /\| Recorded total tokens \| 1,500 \|/);
  assert.match(md, /classic VS Code chats do not expose token totals/);
  assert.match(md, /### \d+\. Grouped session/);
  assert.match(md, /\*\*Outcome:\*\* ✅ Done\. See `x\.ts`/);
  assert.doesNotMatch(md, /someone@example\.com/);
  const digest = buildDigest(a, meta);
  assert.equal(digest.sessions.length, 7);
  assert.equal(digest.totals.prompts, 24);
  assert.equal(digest.totals.premiumUnitsEstimate, 15);
  assert.equal(digest.totals.vscodeChatCredits, 2);
  assert.equal(digest.totals.inputTokens, 1200);
  assert.equal(digest.totals.outputTokens, 300);
  assert.equal(digest.totals.totalTokens, 1500);
  assert.ok(digest.toImprove.length >= 5);
  assert.doesNotMatch(JSON.stringify(digest), /someone@example\.com/);
});

test('analyze handles an empty window', () => {
  const a = analyze([], { window: WINDOW, now: WINDOW.end });
  assert.equal(a.summary, 'No Copilot activity was found in this window.');
  const md = renderMarkdown(a, { version: 't', scheduled: false, sources: {} });
  assert.match(md, /Nothing recorded in this window/);
});

test('unfinished validation does not count as a final check', () => {
  const c = chat('pending', { title: 'Unfinished validation' });
  prompt(c, 0, 'Check the latest change');
  edit(c, 1, 'src\\api.ts');
  tool(c, 2, { command: 'npm test', ok: null, endTs: null });

  const a = analyze([c], { window: WINDOW, now: WINDOW.end });
  assert.equal(a.totals.checks, 1);
  assert.equal(a.totals.checksFailed, 0);
  assert.equal(a.totals.checksPending, 1);
  assert.equal(a.entries[0].checkedAfterEdit, false);
  assert.equal(a.entries[0].lastCompletedCheck, null);
  assert.equal(a.good.some((g) => g.id === 'checked'), false);
  assert.match(a.improve.find((f) => f.id === 'unchecked').detail, /no completed test, build or lint run/);
  assert.match(a.improve.find((f) => f.id === 'pending-checks').detail, /Unfinished validation/);
});

test('a pending retry does not erase the last completed failure', () => {
  const c = chat('retry', { title: 'Pending retry' });
  edit(c, 1, 'src\\api.ts');
  tool(c, 2, { command: 'npm run lint', exitCode: 2 });
  tool(c, 3, { command: 'npm test', ok: null, endTs: null });

  const a = analyze([c], { window: WINDOW, now: WINDOW.end });
  assert.equal(a.entries[0].lastCheck.command, 'npm test');
  assert.equal(a.entries[0].lastCompletedCheck.command, 'npm run lint');
  assert.equal(a.entries[0].checkedAfterEdit, true, 'a completed failing check still counts as checked');
  assert.match(a.improve.find((f) => f.id === 'failing-check').detail, /npm run lint.*exited 2/);
  assert.ok(a.improve.some((f) => f.id === 'pending-checks'));
});

test('validation outcomes distinguish missing results from explicit success and failure', () => {
  const cases = [
    ['unfinished tool', { ok: null, endTs: null }, null],
    ['unfinished tool in a completed request', { ok: null }, null],
    ['unknown outcome', { ok: undefined }, null],
    ['explicit successful exit', { ok: null, exitCode: 0 }, true],
    ['explicit failing exit', { ok: null, exitCode: 2 }, false],
    ['completed tool', { ok: true }, true],
    ['completed successful exit', { ok: true, exitCode: 0 }, true],
    ['failing exit despite tool success', { ok: true, exitCode: 1 }, false],
    ['tool failure', { ok: false }, false],
    ['tool failure despite zero exit', { ok: false, exitCode: 0 }, false],
  ];
  for (const [name, fields, passed] of cases) {
    const c = chat(name);
    edit(c, 1, 'src\\api.ts');
    tool(c, 2, { command: 'npm test', ...fields });
    const a = analyze([c], { window: WINDOW, now: WINDOW.end });
    const digest = buildDigest(a, { version: 'test', sources: {} });
    assert.equal(a.totals.checksPending, passed === null ? 1 : 0, name);
    assert.equal(a.totals.checksFailed, passed === false ? 1 : 0, name);
    assert.equal(a.entries[0].checkedAfterEdit, passed !== null, name);
    assert.equal(digest.sessions[0].checks[0].passed, passed, name);
  }
});

test('Markdown and JSON distinguish pending checks from completed outcomes', () => {
  const c = chat('mixed', { title: 'Mixed validation outcomes' });
  edit(c, 1, 'src\\api.ts');
  tool(c, 2, { command: 'npm test', exitCode: 0 });
  tool(c, 3, { command: 'npm test', exitCode: 1 });
  tool(c, 4, { command: 'npm test', ok: null, endTs: null });

  const classic = chat('classic', { title: 'Unfinished VS Code check' });
  classic.source = 'vscode-chat';
  edit(classic, 5, 'src\\other.ts');
  tool(classic, 6, { name: 'copilot_runTests', category: 'other', ok: null });

  const a = analyze([c, classic], { window: WINDOW, now: WINDOW.end });
  const meta = { version: 'test', scheduled: false, sources: {} };
  const md = renderMarkdown(a, meta);
  assert.match(md, /\| Checks without a recorded result \| 2 \|/);
  assert.match(md, /1 failed, 1 pending/);
  assert.match(md, /last pending \(no result recorded\)/);
  assert.doesNotMatch(md, /last .*passed/);

  const digest = buildDigest(a, meta);
  assert.equal(digest.totals.checks, 4);
  assert.equal(digest.totals.checksFailed, 1);
  assert.equal(digest.totals.checksPending, 2);
  assert.deepEqual(digest.sessions[0].checks.map((c) => c.passed), [true, false, null]);
  assert.equal(digest.sessions[1].checks[0].passed, null);
  assert.equal(digest.sessions[1].checkedAfterLastEdit, false);
});

test('mdInline keeps inline markdown, stops at tables and balances markers', () => {
  assert.equal(mdInline('Did **this** and `that`.\n\n| a | b |\n|---|---|'), 'Did **this** and `that`.');
  assert.equal(mdInline('# Heading\ntext <b>'), 'Heading text &lt;b&gt;');
  assert.equal(mdInline('**bold** and `code that is cut', 200), '**bold** and code that is cut');
  assert.equal(mdInline('see **this', 200), 'see this');
});
