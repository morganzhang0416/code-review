import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyze } from '../src/analyze.mjs';
import { collectAgentSessions } from '../src/collect/agent-sessions.mjs';
import { newChat } from '../src/collect/common.mjs';
import { chatFromState, collectVsCodeChats } from '../src/collect/vscode-chat.mjs';
import { buildDigest, renderMarkdown } from '../src/report.mjs';
import { formatSpendingAmount, recordedUsage, summarizeSpending } from '../src/spending.mjs';
import { HOUR, localDateKey } from '../src/util.mjs';
import { ev, tempDir, writeAgentSession, writeVsCodeJournal } from './_fixtures.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const local = (month, day, hour = 0, minute = 0, second = 0, ms = 0) =>
  new Date(2026, month - 1, day, hour, minute, second, ms).getTime();
const WINDOW = { start: local(10, 30, 17), end: local(11, 2, 8, 36, 11, 49) };
const META = { version: 'test', scheduled: false, sources: {} };

function usageEvent(id, amount, ts, extra = {}) {
  return ev('session.usage_record', ts, {
    usage: {
      accounting: { usageId: id, apiCallId: `api-${id}`, serviceRequestId: `request-${id}` },
      copilotUsage: { totalNanoAiu: amount, tokenDetails: [{ tokenType: 'input', tokenCount: 3, batchSize: 1_000_000, costPerBatch: 200_000_000_000 }] },
      aiCreditsStatus: 'complete',
      model: 'gpt-6.1-sol',
      modelDisplayName: 'GPT-6.1 Sol',
      initiator: 'agent',
      cost: 30,
      inputTokens: 3,
      outputTokens: 4,
      ...extra,
    },
  });
}

function usageChat(events, id = 'chat') {
  const chat = newChat({ id, source: 'agents' });
  chat.spendingRecords = events.map((e) => recordedUsage(e.data.usage, Date.parse(e.timestamp)));
  chat.timestamps = chat.spendingRecords.map((r) => r.ts);
  return chat;
}

test('real nested usage records include extra agents once and respect both window endpoints', async () => {
  const root = tempDir('spending-agents');
  try {
    const first = usageEvent('first', 1_250_000_000, WINDOW.start, { initiator: 'user', cost: 15 });
    const agent = usageEvent('agent', 12_345_678_900, local(10, 31, 10));
    writeAgentSession(root, 'parent', [
      usageEvent('too-old', 999_000_000_000, WINDOW.start - 1),
      first, first, agent,
      usageEvent('free', 0, WINDOW.end, { initiator: 'user', cost: 15 }),
      usageEvent('too-new', 999_000_000_000, WINDOW.end + 1),
      ev('session.usage_checkpoint', WINDOW.end, { usage: { copilotUsage: { totalNanoAiu: 999_000_000_000 } } }),
    ]);
    writeAgentSession(root, 'extra-agent', [usageEvent('extra', 5_000_000_000, local(11, 1, 10), { cost: 999 })]);
    writeAgentSession(root, 'mirrored-agent', [agent]);
    const collected = await collectAgentSessions({ sessionStateDir: root, window: WINDOW });
    const analysis = analyze(collected.chats, { window: WINDOW, now: WINDOW.end, sourceStats: { agents: collected.stats } });
    const spending = analysis.spending;
    assert.equal(spending.totalNanoAiu, '18595678900');
    assert.equal(spending.aiCredits, 18.5956789);
    assert.equal(spending.usdEquivalent, spending.aiCredits / 100);
    assert.equal(spending.recordedCalls, 4);
    assert.equal(spending.usageRecords, 6);
    assert.equal(spending.duplicatesRemoved, 2);
    assert.equal(spending.status, 'complete');
    assert.equal(spending.timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone);
    assert.deepEqual(spending.days.map((d) => d.date), ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
    assert.deepEqual(spending.days.map((d) => d.partialDay), [true, false, false, true]);
    assert.deepEqual(spending.days.map((d) => d.totalNanoAiu), ['1250000000', '12345678900', '5000000000', '0']);
    assert.equal(spending.days.reduce((n, d) => n + BigInt(d.totalNanoAiu), 0n).toString(), spending.totalNanoAiu);
    assert.equal(spending.days[0].window.start, new Date(WINDOW.start).toISOString());
    assert.equal(spending.days.at(-1).window.end, new Date(WINDOW.end).toISOString());
    assert.equal(analysis.totals.premium, 45, 'legacy user-initiated multipliers remain separate');
    const md = renderMarkdown(analysis, META);
    assert.match(md, /\| Recorded AI credits \| 18\.60 \|/);
    assert.match(md, /\| USD equivalent \(not a bill\) \| US\$0\.19 \|/);
    assert.match(md, /\| 2026-10-30 \| Partial day \(17:00-24:00\)/);
    assert.match(md, /\| 2026-10-31 \| Full day \|/);
    assert.match(md, /\| 2026-11-02 \| Partial day \(00:00-08:36\) \| 0\.00 \| US\$0\.00 \|/);
    const digest = JSON.parse(JSON.stringify(buildDigest(analysis, META)));
    assert.deepEqual(digest.spending, spending);
    assert.equal(digest.totals.premiumUnitsEstimate, 45);
    assert.doesNotMatch(JSON.stringify(digest), /api-first|request-agent/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('unknown amounts are not zero and legacy cost is never converted to spending', () => {
  const ts = local(10, 31, 12);
  const missing = usageEvent('missing', undefined, ts, { initiator: 'user', cost: 15 });
  const analysis = analyze([usageChat([missing])], { window: WINDOW, now: WINDOW.end });
  assert.equal(analysis.spending.status, 'unavailable');
  assert.equal(analysis.spending.totalNanoAiu, null);
  assert.equal(analysis.spending.aiCredits, null);
  assert.equal(analysis.spending.usdEquivalent, null);
  assert.equal(analysis.spending.missingAmounts, 1);
  assert.match(renderMarkdown(analysis, META), /\| Recorded AI credits \| Not available \|/);
  assert.match(renderMarkdown(analysis, META), /not treated as zero/);
  const zero = summarizeSpending([usageChat([usageEvent('zero', 0, ts)])], { window: WINDOW });
  assert.equal(zero.status, 'complete');
  assert.equal(zero.totalNanoAiu, '0');
  assert.equal(zero.aiCredits, 0);
  assert.equal(zero.usdEquivalent, 0);
  assert.equal(zero.days.find((d) => d.date === '2026-10-31').aiCredits, 0);
  assert.equal(zero.days.find((d) => d.date === '2026-11-01').aiCredits, null);
  const empty = analyze([], { window: WINDOW });
  assert.equal(empty.spending.aiCredits, null);
  assert.match(renderMarkdown(empty, META), /Actual spending is not available/);
});

test('missing IDs, invalid amounts and conflicting mirrors produce a clear recorded subtotal', () => {
  const ts = local(10, 31, 12);
  const events = [
    usageEvent('known', 2_000_000_000, ts),
    usageEvent('missing', null, ts),
    usageEvent(null, 9_000_000_000, ts),
    usageEvent('negative', -1, ts),
    usageEvent('fraction', 1.5, ts),
    usageEvent('unsafe', Number.MAX_SAFE_INTEGER + 1, ts),
    usageEvent('conflict', 3_000_000_000, ts),
    usageEvent('conflict', 4_000_000_000, ts),
  ];
  const result = summarizeSpending([usageChat(events)], { window: WINDOW });
  assert.equal(result.totalNanoAiu, '2000000000');
  assert.equal(result.status, 'partial');
  assert.equal(result.recordedCalls, 1);
  assert.equal(result.unpricedCalls, 6);
  assert.equal(result.missingAmounts, 1);
  assert.equal(result.missingUsageIds, 1);
  assert.equal(result.invalidAmounts, 3);
  assert.equal(result.conflictingUsageIds, 1);
  assert.equal(result.duplicatesRemoved, 1);
  assert.match(result.warnings.join('\n'), /cannot be safely deduplicated/);
  assert.match(result.warnings.join('\n'), /conflicting credit amounts/);
  assert.match(renderMarkdown(analyze([usageChat(events)], { window: WINDOW }), META), /Partial usage; recorded subtotal/);
});

test('complete mirrors fill missing or partial amounts without adding checkpoints or charging twice', () => {
  const ts = local(10, 31, 12);
  const result = summarizeSpending([
    usageChat([
      usageEvent('filled', null, ts),
      usageEvent('updated', 1_000_000_000, ts, { aiCreditsStatus: 'partial' }),
      usageEvent('still-partial', 7_000_000_000, ts, { aiCreditsStatus: 'partial' }),
    ], 'parent'),
    usageChat([
      usageEvent('filled', 3_000_000_000, ts),
      usageEvent('updated', 2_000_000_000, ts),
    ], 'mirror'),
  ], { window: WINDOW });
  assert.equal(result.totalNanoAiu, '12000000000');
  assert.equal(result.recordedCalls, 3);
  assert.equal(result.duplicatesRemoved, 2);
  assert.equal(result.missingAmounts, 0);
  assert.equal(result.conflictingUsageIds, 0);
  assert.equal(result.partialAmounts, 1);
  assert.equal(result.status, 'partial');
  assert.match(result.warnings.join('\n'), /incomplete or unknown aiCreditsStatus/);
});

test('classic chat credits stay separate and unreadable or unpriced activity stays explicit', () => {
  const ts = local(10, 31, 12);
  const classic = chatFromState({
    requests: [{ timestamp: ts, copilotCredits: 500, message: { text: 'A classic request' }, response: [] }],
  }, { id: 'classic', window: WINDOW });
  const active = newChat({ id: 'unpriced', source: 'agents' });
  active.timestamps.push(ts);
  const analysis = analyze([usageChat([usageEvent('known', 2_000_000_000, ts)]), classic, active], {
    window: WINDOW,
    sourceStats: { agents: { unreadable: 1, unavailable: true, incompleteLines: 1, untimedUsageRecords: 1 } },
  });
  assert.equal(analysis.spending.totalNanoAiu, '2000000000');
  assert.equal(analysis.spending.status, 'partial');
  assert.equal(analysis.spending.unsupportedRequests, 1);
  assert.equal(analysis.spending.activeChatsWithoutUsage, 1);
  assert.equal(analysis.totals.credits, 500);
  assert.deepEqual(analysis.spending.sourceIssues, { unreadableSources: 1, unavailableSources: 1, incompleteLines: 1, untimedUsageRecords: 1 });
  assert.match(analysis.spending.warnings.join('\n'), /classic VS Code requests/);
  assert.match(analysis.spending.warnings.join('\n'), /could not be read/);
  assert.match(analysis.spending.warnings.join('\n'), /without a valid timestamp/);
});

test('collectors expose unavailable roots, unfinished lines and untimed usage', async () => {
  const root = tempDir('spending-errors');
  const warnings = [];
  const log = { warn: (message) => warnings.push(message) };
  try {
    const ts = local(10, 31, 12);
    const dir = writeAgentSession(root, 'session', [
      usageEvent('known', 1_000_000_000, ts),
      { type: 'session.usage_record', timestamp: 'bad timestamp', data: usageEvent('untimed', 5_000_000_000, ts).data },
    ]);
    fs.appendFileSync(path.join(dir, 'events.jsonl'), 'unfinished line\n');
    const agents = await collectAgentSessions({ sessionStateDir: root, window: WINDOW, log });
    assert.equal(agents.stats.incompleteLines, 1);
    assert.equal(agents.stats.untimedUsageRecords, 1);
    assert.equal(summarizeSpending(agents.chats, { window: WINDOW, sourceStats: { agents: agents.stats } }).status, 'partial');
    const absent = await collectAgentSessions({ sessionStateDir: path.join(root, 'absent'), window: WINDOW, log });
    assert.equal(absent.stats.unavailable, true);
    const userDir = path.join(root, 'vscode');
    const journal = writeVsCodeJournal(userDir, 'workspace', 'file:///c%3A/Work/proj', 'classic', [
      { kind: 0, v: { requests: [{ timestamp: ts, message: { text: 'A request' } }] } },
    ]);
    fs.appendFileSync(journal, '{unfinished\n');
    const vscode = collectVsCodeChats({ vscodeUserDirs: [userDir], window: WINDOW, log });
    assert.equal(vscode.stats.incompleteLines, 1);
    assert.ok(warnings.length >= 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('nano-AIU sums and two-decimal rounding stay exact beyond safe integer totals', () => {
  const ts = local(10, 31, 12);
  const records = [usageEvent('one', Number.MAX_SAFE_INTEGER, ts), usageEvent('two', Number.MAX_SAFE_INTEGER, ts)];
  const result = summarizeSpending([usageChat(records)], { window: WINDOW });
  assert.equal(result.totalNanoAiu, (2n * BigInt(Number.MAX_SAFE_INTEGER)).toString());
  assert.equal(recordedUsage({ accounting: { usageId: 'string' }, copilotUsage: { totalNanoAiu: '1250000000' } }, ts).totalNanoAiu, '1250000000');
  assert.equal(formatSpendingAmount('30555076592550', 1_000_000_000n), '30,555.08');
  assert.equal(formatSpendingAmount('30555076592550', 100_000_000_000n), '305.55');
  assert.equal(formatSpendingAmount('5000000', 1_000_000_000n), '0.01');
  assert.equal(formatSpendingAmount(null, 1_000_000_000n), 'Not available');
});

test('local-day boundaries follow both daylight-saving changes, not a fixed UTC offset', () => {
  const moduleUrl = new URL('../src/spending.mjs', import.meta.url).href;
  const code = `
    import { summarizeSpending, recordedUsage } from ${JSON.stringify(moduleUrl)};
    const results = [];
    for (const [month, day] of [[9, 27], [4, 5]]) {
      const start = new Date(2026, month - 1, day).getTime();
      const end = new Date(2026, month - 1, day + 1).getTime();
      const record = recordedUsage({ accounting: { usageId: 'day' }, copilotUsage: { totalNanoAiu: 0 } }, start + 3600000);
      const spending = summarizeSpending([{ source: 'agents', timestamps: [record.ts], spendingRecords: [record] }], { window: { start, end } });
      results.push({ timeZone: spending.timeZone, days: spending.days });
    }
    console.log(JSON.stringify(results));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, TZ: 'Pacific/Auckland' }, encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr);
  const results = JSON.parse(child.stdout);
  for (const [index, hours] of [[0, 23], [1, 25]]) {
    const result = results[index];
    assert.equal(result.timeZone, 'Pacific/Auckland');
    assert.equal(result.days[0].partialDay, false);
    assert.equal(Date.parse(result.days[0].window.end) - Date.parse(result.days[0].window.start) + 1, hours * HOUR);
    assert.equal(result.days[0].aiCredits, 0);
    assert.equal(result.days[1].partialDay, true, 'the inclusive midnight endpoint is a partial next day');
    assert.equal(result.days[1].aiCredits, null, 'a day with no records is not a confirmed zero');
  }
});

test('a priced day does not hide missing usage on another active day in the same chat', () => {
  const first = usageChat([usageEvent('first-day', 1_000_000_000, local(10, 31, 12))], 'continued');
  const unpricedTs = local(11, 1, 12);
  first.timestamps.push(unpricedTs);
  first.prompts.push({ ts: unpricedTs, text: 'Continue this work', chars: 18, steering: false, attachments: 0 });
  const second = usageChat([usageEvent('second-day', 2_000_000_000, unpricedTs)], 'other');
  const analysis = analyze([first, second], { window: WINDOW });
  assert.equal(analysis.spending.totalNanoAiu, '3000000000');
  assert.equal(analysis.spending.status, 'partial');
  assert.equal(analysis.spending.activeChatsWithoutUsage, 1);
  assert.equal(analysis.spending.days.find((d) => d.date === '2026-10-31').status, 'complete');
  const unpricedDay = analysis.spending.days.find((d) => d.date === '2026-11-01');
  assert.equal(unpricedDay.status, 'partial');
  assert.equal(unpricedDay.activeChatsWithoutUsage, 1);
  assert.match(renderMarkdown(analysis, META), /local days without usage records/);
});

test('an inclusive window through the last millisecond covers a full local day', () => {
  const start = local(11, 1);
  const end = local(11, 2) - 1;
  const analysis = analyze([usageChat([usageEvent('full-day', 0, start)])], { window: { start, end } });
  assert.equal(analysis.spending.days.length, 1);
  const day = analysis.spending.days[0];
  assert.equal(day.partialDay, false);
  assert.equal(day.window.end, new Date(end).toISOString());
  assert.match(renderMarkdown(analysis, META), /\| 2026-11-01 \| Full day \| 0\.00 \|/);
  assert.doesNotMatch(renderMarkdown(analysis, META), /Partial day/);
});

test('a recorded amount without aiCreditsStatus is kept as an unknown-completeness subtotal', () => {
  const ts = local(10, 31, 12);
  const event = usageEvent('unknown-status', 2_000_000_000, ts, { aiCreditsStatus: undefined });
  const analysis = analyze([usageChat([event])], { window: WINDOW });
  assert.equal(analysis.spending.totalNanoAiu, '2000000000');
  assert.equal(analysis.spending.status, 'partial');
  assert.equal(analysis.spending.partialAmounts, 1);
  assert.match(analysis.spending.warnings.join('\n'), /unknown aiCreditsStatus/);
});

test('local CLI writes spending in Markdown and JSON without changing the latest report or schedule', () => {
  const root = tempDir('spending-cli');
  try {
    const sessionStateDir = path.join(root, 'session-state');
    writeAgentSession(sessionStateDir, 'cli', [usageEvent('cli', 12_345_678_900, Date.now() - 60_000)]);
    const reportsDir = path.join(root, 'reports');
    const outDir = path.join(root, 'check');
    const stateDir = path.join(root, 'state');
    fs.mkdirSync(reportsDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(reportsDir, 'latest.md'), 'Keep latest unchanged.\n');
    const schedule = { mode: 'logon', installedAt: 'test' };
    fs.writeFileSync(path.join(stateDir, 'state.json'), JSON.stringify({ schedule, lastScheduledSuccessDate: '2026-10-31' }));
    const child = spawnSync(process.execPath, [path.join(ROOT, 'src', 'cli.mjs'), '--out', outDir], {
      cwd: ROOT,
      env: {
        ...process.env,
        SESSION_REVIEW_SESSION_STATE: sessionStateDir,
        SESSION_REVIEW_VSCODE_DIRS: path.join(root, 'vscode'),
        SESSION_REVIEW_STATE_DIR: stateDir,
        SESSION_REVIEW_REPORTS_DIR: reportsDir,
        SESSION_REVIEW_LOGS_DIR: path.join(root, 'logs'),
        SESSION_REVIEW_TITLES: '0',
      },
      encoding: 'utf8',
    });
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /Report: /);
    const digestFile = fs.readdirSync(outDir).find((name) => name.endsWith('.json'));
    const digest = JSON.parse(fs.readFileSync(path.join(outDir, digestFile), 'utf8'));
    const md = fs.readFileSync(path.join(outDir, digestFile.replace(/\.json$/, '.md')), 'utf8');
    assert.equal(digest.spending.totalNanoAiu, '12345678900');
    assert.match(md, /\| Recorded AI credits \| 12\.35 \|/);
    assert.match(md, /\| USD equivalent \(not a bill\) \| US\$0\.12 \|/);
    assert.equal(fs.readFileSync(path.join(reportsDir, 'latest.md'), 'utf8'), 'Keep latest unchanged.\n');
    const state = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'));
    assert.deepEqual(state.schedule, schedule);
    assert.equal(state.lastScheduledSuccessDate, '2026-10-31');
    assert.equal(localDateKey(Date.parse(digest.window.end)), digestFile.replace(/\.json$/, ''));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
