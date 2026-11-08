// Shared fixture builders for the test files (no tests here).
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `copilot-session-review-${prefix}-`));
}

export function ev(type, timestamp, data = {}) {
  return { type, data, id: randomUUID(), timestamp: new Date(timestamp).toISOString(), parentId: null };
}

/** Write ~/.copilot/session-state/<id>/events.jsonl (+ workspace.yaml) under `root`. */
export function writeAgentSession(root, id, events, yaml = {}) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
  const lines = Object.entries({ id, ...yaml }).map(([k, v]) => `${k}: ${typeof v === 'string' && /[:"\n]/.test(v) ? JSON.stringify(v) : v}`);
  fs.writeFileSync(path.join(dir, 'workspace.yaml'), `${lines.join('\n')}\n`);
  return dir;
}

/** Write a classic VS Code chat journal under <userDir>/workspaceStorage/<hash>/chatSessions. */
export function writeVsCodeJournal(userDir, hash, folderUri, sessionId, entries) {
  const ws = path.join(userDir, 'workspaceStorage', hash);
  fs.mkdirSync(path.join(ws, 'chatSessions'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'workspace.json'), JSON.stringify({ folder: folderUri }));
  const file = path.join(ws, 'chatSessions', `${sessionId}.jsonl`);
  fs.writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`);
  return file;
}

/** Events for one realistic Agents chat between `t0` and `t0 + 40 min`. */
export function sampleAgentEvents(t0, { cwd = 'C:\\Work\\proj', sessionStateDir = '' } = {}) {
  const m = (min) => t0 + min * 60_000;
  return [
    ev('session.start', t0 - 3_600_000, { context: { cwd, branch: 'main' }, selectedModel: 'claude-opus-5.5' }),
    ev('user.message', m(0), { content: 'Fix the login bug in api.ts, contact me at jane.doe@example.com', source: '', delivery: 'idle', interactionId: 'i1' }),
    ev('user.message', m(0.2), { content: 'Fix the login bug in api.ts, contact me at jane.doe@example.com', source: '', delivery: 'idle', interactionId: 'i1' }),
    ev('user.message', m(0.3), { content: 'history carried over from another chat', source: 'user' }),
    ev('user.message', m(0.4), { content: '', source: 'autopilot', isAutopilotContinuation: true, interactionId: 'i1' }),
    ev('assistant.turn_start', m(1), { turnId: '0' }),
    ev('assistant.message', m(1), { content: 'Looking at api.ts' }),
    ev('session.usage_record', m(1), { usage: { model: 'claude-opus-5.5', modelDisplayName: 'Claude Opus 5.5', initiator: 'user', cost: 15, inputTokens: 1200, outputTokens: 300 } }),
    ev('session.usage_record', m(2), { usage: { model: 'claude-opus-5.5', modelDisplayName: 'Claude Opus 5.5', initiator: 'agent', cost: 30, inputTokens: 5000, outputTokens: 200 } }),
    ev('tool.execution_start', m(2), { toolCallId: 'v1', toolName: 'view', arguments: { path: `${cwd}\\missing.ts` } }),
    ev('tool.execution_complete', m(2), { toolCallId: 'v1', success: false, error: { message: 'Path does not exist' } }),
    ev('tool.execution_start', m(3), { toolCallId: 'e1', toolName: 'edit', arguments: { path: `${cwd}\\src\\api.ts`, old_str: 'a', new_str: 'b' } }),
    ev('tool.execution_complete', m(3), { toolCallId: 'e1', success: true, fileEdits: [{ path: `${cwd}\\src\\api.ts`, kind: 'edit' }] }),
    ev('tool.execution_start', m(4), { toolCallId: 'c1', toolName: 'create', arguments: { path: path.join(sessionStateDir, 'x', 'plan.md') } }),
    ev('tool.execution_complete', m(4), { toolCallId: 'c1', success: true, fileEdits: [{ path: path.join(sessionStateDir, 'x', 'plan.md'), kind: 'create' }] }),
    ev('tool.execution_start', m(5), { toolCallId: 'p1', toolName: 'powershell', arguments: { command: `Set-Location ${cwd}; npm test 2>&1 | Select-Object -Last 20` } }),
    ev('tool.execution_complete', m(6), { toolCallId: 'p1', success: true, shellExecution: { exitCode: 1 } }),
    ev('user.message', m(7), { content: 'also update the README please', source: '', delivery: 'steering', interactionId: 'i2' }),
    ev('tool.execution_start', m(8), { toolCallId: 'p2', toolName: 'powershell', arguments: { command: 'npm test' } }),
    ev('tool.execution_complete', m(9), { toolCallId: 'p2', success: true, shellExecution: { exitCode: 0 } }),
    ev('tool.execution_start', m(10), { toolCallId: 'p3', toolName: 'powershell', arguments: { command: 'git -C C:\\Work\\proj commit -m "fix login"' } }),
    ev('tool.execution_complete', m(10), { toolCallId: 'p3', success: true, shellExecution: { exitCode: 0 } }),
    ev('skill.invoked', m(11), { name: 'repo-search' }),
    ev('subagent.started', m(12), { toolCallId: 't9', agentName: 'code-review', agentDisplayName: 'diff-review' }),
    ev('subagent.completed', m(20), { toolCallId: 't9', agentName: 'code-review', totalToolCalls: 12, durationMs: 480_000 }),
    ev('permission.completed', m(21), { decisionSource: 'human_response', result: { kind: 'approved' } }),
    ev('permission.completed', m(21), { decisionSource: 'host_policy', result: { kind: 'approved' } }),
    ev('user.message', m(22), { content: 'Review this diff for bugs', source: 'agent-abc', delivery: 'idle', interactionId: 'i3' }),
    ev('abort', m(23), { reason: 'user_initiated' }),
    ev('session.error', m(24), { errorType: 'query', message: 'Failed to get response from the AI model' }),
    ev('assistant.message', m(25), { content: 'Recovered' }),
    ev('session.task_complete', m(26), { summary: 'Fixed the **login** bug and added a `test`.', success: true }),
    ev('session.mode_changed', m(27), { newMode: 'autopilot' }),
  ];
}
