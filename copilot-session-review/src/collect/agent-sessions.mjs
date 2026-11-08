import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { recordedUsage } from '../spending.mjs';
import { addFile, addModelUse, categorize, newChat } from './common.mjs';

/**
 * Agents-window chats and Copilot CLI sessions: ~/.copilot/session-state/<id>/events.jsonl.
 * Each folder is one Copilot runtime session (one chat in the VS Code Agents window).
 * @param {{ sessionStateDir: string, window: { start: number, end: number }, log?: any }} options
 */
export async function collectAgentSessions({ sessionStateDir, window, log }) {
  const chats = [];
  const stats = { folders: 0, scanned: 0, unreadable: 0, unavailable: false, incompleteLines: 0, untimedUsageRecords: 0 };
  let entries = [];
  try {
    entries = fs.readdirSync(sessionStateDir, { withFileTypes: true });
  } catch (err) {
    stats.unavailable = true;
    log?.warn(`could not list ${sessionStateDir}: ${err.message}`);
    return { chats, stats };
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    stats.folders++;
    const dir = path.join(sessionStateDir, entry.name);
    const eventsFile = path.join(dir, 'events.jsonl');
    let mtime;
    try {
      mtime = fs.statSync(eventsFile).mtimeMs;
    } catch (err) {
      if (err.code !== 'ENOENT') {
        stats.unreadable++;
        log?.warn(`could not inspect ${eventsFile}: ${err.message}`);
      }
      continue;
    }
    if (mtime < window.start) continue;
    stats.scanned++;
    try {
      const meta = readWorkspaceYaml(path.join(dir, 'workspace.yaml'));
      const chat = await parseEventsFile(eventsFile, { id: entry.name, meta, window, sessionStateDir });
      stats.incompleteLines += chat.incompleteLines;
      stats.untimedUsageRecords += chat.untimedUsageRecords;
      if (chat.incompleteLines || chat.untimedUsageRecords) log?.warn(`incomplete history in ${eventsFile}: ${chat.incompleteLines} invalid or unfinished lines, ${chat.untimedUsageRecords} usage records without valid timestamps`);
      if (chat.timestamps.length) chats.push(chat);
    } catch (err) {
      stats.unreadable++;
      log?.warn(`could not read ${eventsFile}: ${err.message}`);
    }
  }
  return { chats, stats };
}

export function readWorkspaceYaml(file) {
  try {
    return parseWorkspaceYaml(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

/** Minimal parser for the flat `key: value` workspace.yaml written by the Copilot runtime. */
export function parseWorkspaceYaml(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^([A-Za-z_][\w-]*):\s?(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if (value.startsWith('"')) {
      try {
        value = JSON.parse(value);
      } catch {
        value = value.replace(/^"|"$/g, '');
      }
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1).replace(/''/g, "'");
    }
    out[m[1]] = value;
  }
  return out;
}

/**
 * Stream one events.jsonl file and keep activity inside the window.
 * Context events (session start/resume) are read even when they precede the window.
 */
export async function parseEventsFile(file, { id, meta = {}, window, sessionStateDir = '' }) {
  const chat = newChat({
    id,
    source: 'agents',
    title: meta.user_named === 'true' && meta.name ? meta.name : '',
    titleSource: meta.user_named === 'true' && meta.name ? 'user' : '',
    cwd: meta.cwd || '',
    branch: meta.branch || '',
    clientName: meta.client_name || '',
    createdAt: meta.created_at ? Date.parse(meta.created_at) : null,
  });
  chat.firstPromptEver = typeof meta.name === 'string' ? meta.name : '';
  const pending = new Map();
  const subagentsById = new Map();
  const ignored = sessionStateDir ? [sessionStateDir] : [];

  const lines = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      chat.incompleteLines++;
      continue;
    }
    if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') {
      chat.incompleteLines++;
      continue;
    }
    const data = event.data || {};
    const ts = Date.parse(event.timestamp);
    if (event.type === 'session.usage_record' && !Number.isFinite(ts)) chat.untimedUsageRecords++;
    if (event.type === 'session.start' || event.type === 'session.resume') {
      const ctx = data.context || {};
      chat.cwd = ctx.cwd || chat.cwd;
      chat.branch = ctx.branch || chat.branch;
      if (data.selectedModel) chat.lastModel = data.selectedModel;
    }
    if (!Number.isFinite(ts) || ts < window.start || ts > window.end) continue;
    chat.timestamps.push(ts);

    switch (event.type) {
      case 'user.message':
        recordUserMessage(chat, data, ts);
        break;
      case 'assistant.turn_start':
        chat.assistantTurns++;
        break;
      case 'assistant.message':
        chat.assistantMessages++;
        chat.lastAssistantTs = ts;
        break;
      case 'tool.execution_start': {
        const args = data.arguments && typeof data.arguments === 'object' ? data.arguments : {};
        const call = {
          id: data.toolCallId,
          name: data.toolName || '(unknown)',
          category: categorize(data.toolName),
          ts,
          endTs: null,
          ok: null,
          command: typeof args.command === 'string' ? args.command : undefined,
          path: typeof args.path === 'string' ? args.path : undefined,
          subagent: Boolean(data.parentToolCallId),
        };
        pending.set(call.id, call);
        chat.toolCalls.push(call);
        break;
      }
      case 'tool.execution_complete': {
        let call = pending.get(data.toolCallId);
        if (!call) {
          call = { id: data.toolCallId, name: '(unknown)', category: 'other', ts, endTs: null, ok: null, subagent: Boolean(data.parentToolCallId) };
          chat.toolCalls.push(call);
        }
        pending.delete(data.toolCallId);
        call.endTs = ts;
        call.ok = data.success !== false;
        if (data.shellExecution && typeof data.shellExecution.exitCode === 'number') call.exitCode = data.shellExecution.exitCode;
        if (data.error && data.error.message) call.error = String(data.error.message);
        if (Array.isArray(data.fileEdits)) {
          for (const edit of data.fileEdits) addFile(chat, edit && edit.path, edit && edit.kind, ts, ignored);
        } else if (call.ok && call.path && (call.name === 'edit' || call.name === 'create')) {
          addFile(chat, call.path, call.name, ts, ignored);
        }
        break;
      }
      case 'session.usage_record': {
        const usage = data.usage || {};
        chat.spendingRecords.push(recordedUsage(usage, ts));
        const cost = Number(usage.cost) || 0;
        chat.modelCalls++;
        chat.inputTokens += Number(usage.inputTokens) || 0;
        chat.outputTokens += Number(usage.outputTokens) || 0;
        chat.maxInputTokens = Math.max(chat.maxInputTokens, Number(usage.inputTokens) || 0);
        if (usage.model && usage.modelDisplayName) chat.modelNames[usage.model] = String(usage.modelDisplayName);
        if (usage.initiator === 'user') {
          chat.premium += cost;
          addModelUse(chat, usage.model || usage.modelDisplayName, { prompts: 1, premium: cost });
        }
        break;
      }
      case 'session.task_complete':
        chat.completions.push({ ts, summary: String(data.summary || ''), success: data.success !== false });
        break;
      case 'skill.invoked':
        if (data.name) chat.skills.push(String(data.name));
        break;
      case 'subagent.started': {
        const sub = { name: data.agentName || 'subagent', display: data.agentDisplayName || '', ts, toolCalls: 0, durationMs: 0 };
        chat.subagents.push(sub);
        if (data.toolCallId) subagentsById.set(data.toolCallId, sub);
        break;
      }
      case 'subagent.completed': {
        const sub = subagentsById.get(data.toolCallId);
        if (sub) {
          sub.toolCalls = Number(data.totalToolCalls) || 0;
          sub.durationMs = Number(data.durationMs) || 0;
        }
        break;
      }
      case 'permission.completed':
        if (data.decisionSource === 'human_response') chat.approvals.human++;
        else chat.approvals.auto++;
        if (data.result && data.result.kind && data.result.kind !== 'approved') chat.approvals.denied++;
        break;
      case 'abort':
        chat.aborts++;
        chat.lastAbortTs = ts;
        break;
      case 'session.error':
        chat.errors.push({ ts, type: String(data.errorType || 'error'), message: String(data.message || '') });
        break;
      case 'system.notification':
        chat.notifications++;
        break;
      case 'session.binary_asset':
        chat.images++;
        break;
      case 'session.mode_changed':
        if (data.newMode) chat.modes.add(String(data.newMode));
        break;
      default:
        break;
    }
  }
  return chat;
}

function recordUserMessage(chat, data, ts) {
  const text = typeof data.content === 'string' ? data.content : '';
  if (data.isAutopilotContinuation || data.source === 'autopilot') {
    chat.autopilotContinuations++;
    return;
  }
  if (!text.trim()) return;
  // History carried over from another chat (e.g. moved into the Agents window) never starts a turn.
  if (data.source === 'user' && !data.interactionId) {
    chat.importedMessages++;
    return;
  }
  if (typeof data.source === 'string' && data.source.startsWith('agent-')) {
    chat.delegatedPrompts.push({ ts, text, chars: text.length, from: data.source.slice('agent-'.length) });
    return;
  }
  // The same prompt can be journalled twice (initial submission and delivery).
  if (chat.prompts.some((p) => p.text === text && Math.abs(p.ts - ts) < 2 * 60_000)) return;
  chat.prompts.push({
    ts,
    text,
    chars: text.length,
    steering: data.delivery === 'steering',
    attachments: Array.isArray(data.attachments) ? data.attachments.length : 0,
  });
}
