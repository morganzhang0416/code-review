import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { applyAgentHostTitles } from '../src/collect/agent-host-titles.mjs';
import { collectAgentSessions, parseWorkspaceYaml } from '../src/collect/agent-sessions.mjs';
import { chatFromState, collectVsCodeChats, replayJournal } from '../src/collect/vscode-chat.mjs';
import { ev, sampleAgentEvents, tempDir, writeAgentSession, writeVsCodeJournal } from './_fixtures.mjs';

const T0 = Date.parse('2026-10-23T01:00:00Z');
const WINDOW = { start: Date.parse('2026-10-23T00:00:00Z'), end: Date.parse('2026-10-24T00:00:00Z') };

test('parseWorkspaceYaml reads quoted and plain values', () => {
  const y = parseWorkspaceYaml('id: abc\ncwd: c:\\Work\\Sample\nname: "first line\\r\\nsecond"\nuser_named: false\n');
  assert.equal(y.id, 'abc');
  assert.equal(y.cwd, 'c:\\Work\\Sample');
  assert.equal(y.name, 'first line\r\nsecond');
  assert.equal(y.user_named, 'false');
});

test('collectAgentSessions keeps only in-window activity and classifies messages', async () => {
  const root = tempDir('agents');
  try {
    const events = [
      ev('user.message', WINDOW.start - 3_600_000, { content: 'yesterday prompt', source: '', delivery: 'idle', interactionId: 'old' }),
      ...sampleAgentEvents(T0, { sessionStateDir: root }),
      ev('user.message', WINDOW.end + 3_600_000, { content: 'tomorrow prompt', source: '', delivery: 'idle', interactionId: 'new' }),
    ];
    writeAgentSession(root, 'sess-1', events, { cwd: 'C:\\Fallback', name: 'Fix the login bug', user_named: 'false', client_name: 'vscode-agent-host' });
    writeAgentSession(root, 'sess-old', [ev('user.message', WINDOW.start - 86_400_000, { content: 'old', interactionId: 'x' })]);
    fs.utimesSync(path.join(root, 'sess-old', 'events.jsonl'), new Date(WINDOW.start - 86_400_000), new Date(WINDOW.start - 86_400_000));
    fs.mkdirSync(path.join(root, '.session-operation-locks'));

    const { chats, stats } = await collectAgentSessions({ sessionStateDir: root, window: WINDOW });
    assert.equal(stats.scanned, 1, 'old session skipped by mtime');
    assert.equal(chats.length, 1);
    const c = chats[0];
    assert.equal(c.source, 'agents');
    assert.equal(c.cwd, 'C:\\Work\\proj', 'cwd from session.start context');
    assert.deepEqual(c.prompts.map((p) => p.text.slice(0, 20)), ['Fix the login bug in', 'also update the READ']);
    assert.equal(c.prompts[1].steering, true);
    assert.equal(c.importedMessages, 1);
    assert.equal(c.autopilotContinuations, 1);
    assert.equal(c.delegatedPrompts.length, 1);
    assert.equal(c.toolCalls.length, 6);
    assert.equal(c.toolCalls.filter((t) => t.ok === false).length, 1);
    assert.deepEqual(c.toolCalls.filter((t) => t.exitCode === 1).map((t) => t.id), ['p1']);
    assert.deepEqual([...c.files.values()].map((f) => path.basename(f.path)), ['api.ts'], 'session-state artefacts ignored');
    assert.equal(c.premium, 15, 'only user-initiated cost counts');
    assert.deepEqual(c.modelUse, { 'claude-opus-5.5': { prompts: 1, premium: 15 } });
    assert.equal(c.modelNames['claude-opus-5.5'], 'Claude Opus 5.5');
    assert.equal(c.maxInputTokens, 5000);
    assert.equal(c.completions.length, 1);
    assert.deepEqual(c.skills, ['repo-search']);
    assert.equal(c.subagents[0].toolCalls, 12);
    assert.deepEqual(c.approvals, { human: 1, auto: 1, denied: 0 });
    assert.equal(c.aborts, 1);
    assert.equal(c.errors.length, 1);
    assert.ok(c.lastAssistantTs > c.errors[0].ts, 'recovered after the error');
    assert.ok(c.modes.has('autopilot'));
    assert.equal(c.firstPromptEver, 'Fix the login bug');
    assert.ok(c.timestamps.every((ts) => ts >= WINDOW.start && ts <= WINDOW.end));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('replayJournal applies set, append, truncate and delete operations', () => {
  const text = [
    { kind: 0, v: { requests: [], inputState: { inputText: '' } } },
    { kind: 1, k: ['customTitle'], v: 'Title' },
    { kind: 2, k: ['requests'], v: [{ id: 1 }, { id: 2 }, { id: 3 }] },
    { kind: 2, k: ['requests'], v: [{ id: 4 }], i: 1 },
    { kind: 1, k: ['requests', 0, 'result'], v: { ok: true } },
    { kind: 2, k: ['requests', 0, 'response'], v: [{ kind: 'markdownContent' }] },
    { kind: 3, k: ['inputState'] },
    'not json',
  ]
    .map((x) => (typeof x === 'string' ? x : JSON.stringify(x)))
    .join('\n');
  const state = replayJournal(text);
  assert.equal(state.customTitle, 'Title');
  assert.deepEqual(state.requests.map((r) => r.id), [1, 4]);
  assert.deepEqual(state.requests[0].result, { ok: true });
  assert.equal(state.requests[0].response.length, 1);
  assert.equal('inputState' in state, false);
});

test('collectVsCodeChats replays journals and keeps in-window requests', () => {
  const userDir = tempDir('vscode');
  try {
    writeVsCodeJournal(userDir, 'h1', 'file:///c%3A/Work/proj2', 'chat-1', [
      { kind: 0, v: { version: 3, sessionId: 'chat-1', creationDate: T0, requests: [] } },
      { kind: 1, k: ['customTitle'], v: 'Rename things' },
      { kind: 2, k: ['requests'], v: [{ requestId: 'r0', timestamp: WINDOW.start - 60_000, message: { text: 'too old' } }] },
      { kind: 2, k: ['requests'], v: [{ requestId: 'r1', timestamp: T0, message: { text: 'rename foo to bar' }, modelId: 'copilot/gpt-6', copilotCredits: 2, response: [] }] },
      {
        kind: 2,
        k: ['requests', 1, 'response'],
        v: [
          { kind: 'toolInvocationSerialized', toolId: 'copilot_replaceString', toolCallId: 'c1', isComplete: true },
          { kind: 'textEditGroup', uri: { $mid: 1, scheme: 'file', path: '/c:/Work/proj2/src/foo.ts' } },
        ],
      },
      { kind: 1, k: ['requests', 1, 'elapsedMs'], v: 5000 },
      {
        kind: 2,
        k: ['requests'],
        v: [{ requestId: 'r2', timestamp: T0 + 600_000, message: { text: 'second try' }, modelId: 'copilot/gpt-6', elapsedMs: 100, result: { errorDetails: { message: 'The selected model is not available' } } }],
      },
    ]);
    const { chats, stats } = collectVsCodeChats({ vscodeUserDirs: [userDir, path.join(userDir, 'missing')], window: WINDOW });
    assert.equal(stats.scanned, 1);
    assert.equal(chats.length, 1);
    const c = chats[0];
    assert.equal(c.source, 'vscode-chat');
    assert.equal(c.title, 'Rename things');
    assert.equal(c.cwd.toLowerCase(), 'c:\\work\\proj2');
    assert.deepEqual(c.prompts.map((p) => p.text), ['rename foo to bar', 'second try']);
    assert.equal(c.credits, 2);
    assert.equal(c.toolCalls.length, 1);
    assert.equal(c.toolCalls[0].category, 'edit');
    assert.deepEqual([...c.files.values()].map((f) => f.path.toLowerCase()), ['c:\\work\\proj2\\src\\foo.ts']);
    assert.equal(c.errors.length, 1);
    assert.equal(c.lastAssistantTs, T0 + 5000, 'failed request is not an answer');
    assert.deepEqual(c.modelUse, { 'gpt-6': { prompts: 2, premium: 0 } });
  } finally {
    fs.rmSync(userDir, { recursive: true, force: true });
  }
});

test('applyAgentHostTitles attaches chat titles and session groups', () => {
  const chats = [
    { id: 'sdk-1', title: '', titleSource: '', group: null },
    { id: 'sdk-2', title: 'Renamed by user', titleSource: 'user', group: null },
    { id: 'sdk-3', title: '', titleSource: '', group: null },
  ];
  const bySdkId = new Map([
    ['sdk-1', { sessionId: 'S1', sessionTitle: 'Session one', chatTitle: 'First chat', order: 0 }],
    ['sdk-2', { sessionId: 'S1', sessionTitle: 'Session one', chatTitle: 'Second chat', order: 1 }],
  ]);
  assert.equal(applyAgentHostTitles(chats, { bySdkId }), 2);
  assert.equal(chats[0].title, 'First chat');
  assert.equal(chats[1].title, 'Renamed by user');
  assert.deepEqual(chats[1].group, { id: 'S1', title: 'Session one', order: 1 });
  assert.equal(chats[2].group, null);
});

test('classic VS Code keeps an unfinished check unconfirmed after the request ends', () => {
  const c = chatFromState({
    requests: [{
      timestamp: T0,
      elapsedMs: 5000,
      message: { text: 'Run the tests' },
      response: [{ kind: 'toolInvocationSerialized', toolId: 'copilot_runTests', toolCallId: 'pending', isComplete: false }],
    }],
  }, { id: 'unfinished', window: WINDOW });
  assert.equal(c.toolCalls[0].name, 'copilot_runTests');
  assert.equal(c.toolCalls[0].endTs, T0 + 5000);
  assert.equal(c.toolCalls[0].ok, null);
});
