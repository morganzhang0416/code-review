import fs from 'node:fs';
import path from 'node:path';
import { addFile, addModelUse, categorize, newChat, uriToPath } from './common.mjs';

/**
 * Classic VS Code Copilot Chat sessions:
 *   <VS Code user dir>/workspaceStorage/<hash>/chatSessions/<id>.jsonl (incremental journal) or .json,
 *   <VS Code user dir>/globalStorage/emptyWindowChatSessions/<id>.jsonl|.json (no folder open).
 * @param {{ vscodeUserDirs: string[], window: { start: number, end: number }, log?: any }} options
 */
export function collectVsCodeChats({ vscodeUserDirs, window, log }) {
  const chats = [];
  const stats = { files: 0, scanned: 0, unreadable: 0, incompleteLines: 0 };
  for (const userDir of vscodeUserDirs) {
    const locations = [];
    const wsRoot = path.join(userDir, 'workspaceStorage');
    for (const hash of safeReaddir(wsRoot, stats, log)) {
      const folder = readWorkspaceFolder(path.join(wsRoot, hash, 'workspace.json'));
      locations.push({ dir: path.join(wsRoot, hash, 'chatSessions'), folder });
    }
    locations.push({ dir: path.join(userDir, 'globalStorage', 'emptyWindowChatSessions'), folder: '' });

    for (const { dir, folder } of locations) {
      for (const name of safeReaddir(dir, stats, log)) {
        if (!/\.jsonl?$/i.test(name)) continue;
        stats.files++;
        const file = path.join(dir, name);
        let mtime;
        try {
          mtime = fs.statSync(file).mtimeMs;
        } catch (err) {
          if (err.code !== 'ENOENT') {
            stats.unreadable++;
            log?.warn(`could not inspect ${file}: ${err.message}`);
          }
          continue;
        }
        if (mtime < window.start) continue;
        stats.scanned++;
        try {
          const text = fs.readFileSync(file, 'utf8');
          const state = name.toLowerCase().endsWith('.jsonl') ? replayJournal(text, {
            onInvalidLine: () => {
              stats.incompleteLines++;
              log?.warn(`invalid or unfinished journal line in ${file}; usage may be missing`);
            },
          }) : JSON.parse(text);
          const chat = chatFromState(state, { id: name.replace(/\.jsonl?$/i, ''), folder, window });
          if (chat && chat.timestamps.length) chats.push(chat);
        } catch (err) {
          stats.unreadable++;
          log?.warn(`could not read ${file}: ${err.message}`);
        }
      }
    }
  }
  return { chats, stats };
}

function safeReaddir(dir, stats, log) {
  try {
    return fs.readdirSync(dir);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      stats.unreadable++;
      log?.warn(`could not list ${dir}: ${err.message}`);
    }
    return [];
  }
}

function readWorkspaceFolder(file) {
  try {
    const ws = JSON.parse(fs.readFileSync(file, 'utf8'));
    const target = ws.folder || ws.workspace || '';
    return target.startsWith('file:') ? uriToPath(target) : '';
  } catch {
    return '';
  }
}

/**
 * Rebuild the final session state from VS Code's chat journal:
 * kind 0 = full state, 1 = set value at path `k`, 2 = append items at path `k`
 * (truncating to index `i` first when present), 3 = delete path `k`.
 */
export function replayJournal(text, { onInvalidLine } = {}) {
  let state;
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      onInvalidLine?.();
      continue;
    }
    if (entry.kind === 0) {
      state = entry.v;
      continue;
    }
    if (!state || !Array.isArray(entry.k)) continue;
    if (entry.kind === 1) {
      if (entry.k.length === 0) state = entry.v;
      else setAt(state, entry.k, entry.v);
    } else if (entry.kind === 2) {
      appendAt(state, entry.k, entry.v, entry.i);
    } else if (entry.kind === 3) {
      deleteAt(state, entry.k);
    }
  }
  return state;
}

function getAt(root, keys) {
  let node = root;
  for (const key of keys) {
    if (node == null) return undefined;
    node = node[key];
  }
  return node;
}

function setAt(root, keys, value) {
  let node = root;
  for (let i = 0; i < keys.length - 1; i++) {
    if (node[keys[i]] == null || typeof node[keys[i]] !== 'object') node[keys[i]] = typeof keys[i + 1] === 'number' ? [] : {};
    node = node[keys[i]];
  }
  node[keys[keys.length - 1]] = value;
}

function appendAt(root, keys, items, start) {
  let arr = getAt(root, keys);
  if (!Array.isArray(arr)) {
    arr = [];
    setAt(root, keys, arr);
  }
  if (Number.isInteger(start)) arr.splice(start);
  if (Array.isArray(items)) for (const item of items) arr.push(item);
  else if (items !== undefined) arr.push(items);
}

function deleteAt(root, keys) {
  const parent = getAt(root, keys.slice(0, -1));
  const last = keys[keys.length - 1];
  if (Array.isArray(parent) && Number.isInteger(last)) parent.splice(last, 1);
  else if (parent && typeof parent === 'object') delete parent[last];
}

export function chatFromState(state, { id, folder = '', window }) {
  if (!state || typeof state !== 'object') return null;
  const chat = newChat({
    id: state.sessionId || id,
    source: 'vscode-chat',
    title: state.customTitle || '',
    titleSource: state.customTitle ? 'vscode' : '',
    cwd: folder,
    createdAt: Number(state.creationDate) || null,
  });
  for (const request of Array.isArray(state.requests) ? state.requests : []) {
    const ts = Number(request && request.timestamp);
    if (!Number.isFinite(ts) || ts < window.start || ts > window.end) continue;
    chat.timestamps.push(ts);
    chat.spendingRecords.push({ ts, unsupported: true });
    const error = request.result && request.result.errorDetails;
    const responseTs = Number(request.responseTimestamp) || (Number(request.elapsedMs) ? ts + Number(request.elapsedMs) : null);
    if (responseTs && responseTs <= window.end) {
      chat.timestamps.push(responseTs);
      if (!(error && error.message)) chat.lastAssistantTs = responseTs;
    }
    const text = String((request.message && request.message.text) || '');
    if (text.trim()) {
      chat.prompts.push({ ts, text, chars: text.length, steering: false, attachments: countAttachments(request) });
      const model = String(request.modelId || '').replace(/^copilot\//, '');
      addModelUse(chat, model, { prompts: 1 });
      if (request.response) chat.assistantTurns++;
    }
    if (typeof request.copilotCredits === 'number') chat.credits += request.copilotCredits;
    if (error && error.message) chat.errors.push({ ts, type: 'request', message: String(error.message) });
    for (const part of Array.isArray(request.response) ? request.response : []) {
      if (!part || typeof part !== 'object') continue;
      if (part.kind === 'toolInvocationSerialized') {
        if (part.presentation === 'hidden' && part.toolId === 'manage_todo_list') continue;
        chat.toolCalls.push({
          id: part.toolCallId,
          name: part.toolId || '(unknown)',
          category: categorize(part.toolId),
          ts,
          endTs: responseTs,
          ok: part.isComplete === false ? null : true,
        });
      } else if (part.kind === 'textEditGroup' && part.uri) {
        addFile(chat, uriToPath(part.uri), 'edit', ts);
      }
    }
  }
  return chat;
}

function countAttachments(request) {
  const vars = request.variableData && request.variableData.variables;
  return Array.isArray(vars) ? vars.length : 0;
}
