import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/*
 * Optional enrichment: chat titles and session grouping as shown in the VS Code Agents window.
 * They live in VS Code's internal SQLite store (globalStorage/agent-host.db). Node 20 has no SQLite
 * module, so Python's built-in sqlite3 reads it in read-only mode. The schema is internal to VS Code;
 * any failure simply falls back to titles derived from the first prompt.
 */
const PY_SCRIPT = String.raw`
import json, pathlib, sqlite3, sys
uri = pathlib.Path(sys.argv[1]).resolve().as_uri() + '?mode=ro'
con = sqlite3.connect(uri, uri=True, timeout=5)
rows = []
for owner, order, provider_data, metadata in con.execute('select owner_session_uri, chat_order, provider_data, metadata from chats_v2'):
    try:
        sdk = (json.loads(provider_data) if provider_data else {}).get('sdkSessionId')
        data = (json.loads(metadata) if metadata else {}).get('data') or {}
        if sdk:
            rows.append({'sdk': sdk, 'owner': owner, 'order': order, 'title': data.get('summary')})
    except Exception:
        pass
con.close()
print(json.dumps(rows))
`;

/**
 * @returns {Promise<{ bySdkId: Map<string, { sessionId: string, sessionTitle: string, chatTitle: string, order: number }>, source: string, error?: string }>}
 */
export async function loadAgentHostTitles({ vscodeUserDirs, python = '', log }) {
  const empty = { bySdkId: new Map(), source: '' };
  const dbs = vscodeUserDirs.map((dir) => path.join(dir, 'globalStorage', 'agent-host.db')).filter((p) => fs.existsSync(p));
  if (!dbs.length) return { ...empty, error: 'agent-host.db not found' };

  const candidates = python ? [[python, []]] : [['python', []], ['py', ['-3']]];
  const bySdkId = new Map();
  let lastError = '';
  for (const db of dbs) {
    let rows = null;
    for (const [exe, prefix] of candidates) {
      try {
        const out = await execFileText(exe, [...prefix, '-c', PY_SCRIPT, db]);
        rows = JSON.parse(out);
        break;
      } catch (err) {
        lastError = err.message;
      }
    }
    if (!Array.isArray(rows)) continue;
    // A session's title is the title of its first titled chat.
    const sessionTitles = new Map();
    const infos = [];
    for (const row of rows) {
      const sessionId = String(row.owner || '').split('/').pop() || '';
      const order = Number.isFinite(row.order) ? row.order : 999;
      const title = typeof row.title === 'string' ? row.title : '';
      const best = sessionTitles.get(sessionId);
      if (title && (!best || order < best.order)) sessionTitles.set(sessionId, { title, order });
      const info = { sessionId, sessionTitle: '', chatTitle: title, order };
      infos.push(info);
      bySdkId.set(String(row.sdk), info);
    }
    for (const info of infos) info.sessionTitle = sessionTitles.get(info.sessionId)?.title || info.chatTitle;
  }
  if (!bySdkId.size) {
    log?.warn(`session titles unavailable: ${lastError || 'no rows'}`);
    return { ...empty, error: lastError || 'no rows' };
  }
  return { bySdkId, source: 'agent-host.db' };
}

function execFileText(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 20_000, windowsHide: true, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${file}: ${String(stderr || err.message).trim().split(/\r?\n/).pop()}`));
      else resolve(stdout);
    });
  });
}

/** Attach Agents-window titles/sessions to collected chats. */
export function applyAgentHostTitles(chats, lookup) {
  let applied = 0;
  for (const chat of chats) {
    const info = lookup.bySdkId.get(chat.id);
    if (!info) continue;
    applied++;
    if (info.chatTitle && chat.titleSource !== 'user') {
      chat.title = info.chatTitle;
      chat.titleSource = 'agents';
    }
    chat.group = { id: info.sessionId, title: info.sessionTitle || info.chatTitle || '', order: info.order };
  }
  return applied;
}
