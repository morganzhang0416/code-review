import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Normalised record for one chat (an Agents-window chat / Copilot runtime session, or a classic
 * VS Code Copilot Chat session). Only activity inside the review window is recorded.
 */
export function newChat({ id, source, title = '', titleSource = '', cwd = '', branch = '', clientName = '', createdAt = null }) {
  return {
    id,
    source,
    title,
    titleSource,
    group: null,
    cwd,
    branch,
    clientName,
    createdAt,
    timestamps: [],
    prompts: [],
    delegatedPrompts: [],
    importedMessages: 0,
    firstPromptEver: '',
    autopilotContinuations: 0,
    assistantTurns: 0,
    assistantMessages: 0,
    lastAssistantTs: null,
    toolCalls: [],
    files: new Map(),
    premium: 0,
    credits: 0,
    spendingRecords: [],
    incompleteLines: 0,
    untimedUsageRecords: 0,
    modelUse: {},
    modelNames: {},
    modelCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    maxInputTokens: 0,
    completions: [],
    skills: [],
    subagents: [],
    approvals: { human: 0, auto: 0, denied: 0 },
    aborts: 0,
    errors: [],
    notifications: 0,
    images: 0,
    modes: new Set(),
  };
}

export function addModelUse(chat, model, { prompts = 0, premium = 0 } = {}) {
  if (!model) return;
  const entry = (chat.modelUse[model] ||= { prompts: 0, premium: 0 });
  entry.prompts += prompts;
  entry.premium += premium;
}

const ignoredRoots = () => [os.tmpdir(), path.join(os.homedir(), '.copilot')].map((p) => p.toLowerCase());

/** Record a changed file, skipping Copilot's own session artefacts and temp files. */
export function addFile(chat, filePath, kind, ts, extraIgnored = []) {
  if (!filePath || typeof filePath !== 'string') return;
  const normalised = path.normalize(filePath);
  const key = normalised.toLowerCase();
  const ignored = [...ignoredRoots(), ...extraIgnored.map((p) => path.normalize(p).toLowerCase())];
  if (ignored.some((root) => root && key.startsWith(root))) return;
  const existing = chat.files.get(key);
  if (existing) {
    existing.ts = Math.max(existing.ts, ts);
    existing.count += 1;
  } else {
    chat.files.set(key, { path: normalised, kind: kind || 'edit', ts, count: 1 });
  }
}

/** Convert a VS Code URI (string or serialised object) to a file-system path. */
export function uriToPath(uri) {
  try {
    if (!uri) return '';
    if (typeof uri === 'string') return uri.startsWith('file:') ? fileURLToPath(uri) : uri;
    if (uri.fsPath) return uri.fsPath;
    if (uri.scheme === 'file' && uri.path) return fileURLToPath(`file://${uri.authority || ''}${encodeURI(uri.path)}`);
  } catch {
    // fall through
  }
  return '';
}

const META_TOOLS = new Set([
  'sql',
  'task_complete',
  'tool_search_tool',
  'manage_todo_list',
  'report_intent',
  'update_todo',
  'think',
  'session_store_sql',
  'get_current_session',
  'list_sessions',
  'get_session_context',
]);

/** Coarse category for a tool name across the Copilot runtime and classic VS Code chat. */
export function categorize(name) {
  const n = String(name || '').toLowerCase();
  if (!n) return 'other';
  if (META_TOOLS.has(n)) return 'meta';
  if (n === 'skill') return 'skill';
  if (n === 'ask_user' || n.includes('askquestion')) return 'ask';
  if (/^(task|read_agent|write_agent|list_agents|create_session|send_message)$/.test(n) || n.includes('subagent')) return 'delegate';
  if (/(powershell|bash|shell|terminal)/.test(n)) return 'shell';
  if (/^(edit|create|apply_patch|str_replace_editor|write)$/.test(n) || /(replacestring|insertedit|createfile|applypatch|editfile|write_file|createdirectory)/.test(n)) return 'edit';
  if (/^web_|fetch|browser|page$|navigatepage|screenshot|clickelement|typeinpage|hoverelement|dragelement|playwright/.test(n)) return 'web';
  if (/(grep|glob|search|find|semantic|usages)/.test(n)) return 'search';
  if (/(^view$|read|list_dir|listdirectory|get_file|changes|errors)/.test(n)) return 'read';
  if (/(github|mcp|jira|confluence|servicenow|splunk|m365|outlook|teams)/.test(n)) return 'integration';
  return 'other';
}

const CMD_START = String.raw`(?:^|[\s;&])`;
const CMD_END = String.raw`(?=$|[\s;&|)])`;
const VALIDATION_RE = new RegExp(
  [
    String.raw`\b(?:npm|pnpm|yarn)(?:\.cmd)?\s+(?:run\s+)?(?:test|tests|check|lint|typecheck|type-check|build|verify)\b`,
    String.raw`\b(?:node(?:\.exe)?|tsx(?:\.cmd)?)\s+(?:[^|;&\n]*\s)?--test\b`,
    String.raw`\bnode(?:\.exe)?\s+(?:[^|;&\n]*\s)?[^\s|;&]+\.(?:test|spec)\.[cm]?[jt]s\b`,
    `${CMD_START}(?:npx\\s+(?:--no-install\\s+)?)?(?:vitest|jest|mocha|pytest|cucumber-js|eslint|tsc|playwright\\s+test)(?:\\.cmd)?${CMD_END}`,
    String.raw`\bpython3?(?:\.exe)?\s+-m\s+(?:pytest|unittest|mypy|ruff)\b`,
    String.raw`\bmvnw?(?:\.cmd)?\b[^|;&\n]*\b(?:test|verify|package|install)\b`,
    String.raw`\bgradlew?(?:\.bat)?\b[^|;&\n]*\b(?:test|build|check)\b`,
    String.raw`\bdotnet\s+(?:test|build)\b`,
    String.raw`\bgo\s+(?:test|build|vet)\b`,
    String.raw`\bcargo\s+(?:test|build|check|clippy)\b`,
    String.raw`\bInvoke-Pester\b`,
  ].join('|'),
  'gi',
);
// Listing, version or help flags do not exercise the code.
const NOT_A_RUN_RE = /\s--(?:list|listTests|list-tests|version|help)\b|\s-v\s*$/i;

/**
 * The part of a shell command that runs tests, a build, a type check or a linter
 * (e.g. "npm test -- --test-reporter=tap"), or '' when there is none.
 */
export function validationLabel(command) {
  const text = String(command || '');
  VALIDATION_RE.lastIndex = 0;
  let match;
  while ((match = VALIDATION_RE.exec(text))) {
    const start = match.index + match[0].match(/^[\s;&|(]*/)[0].length;
    const rest = text.slice(start);
    const end = rest.search(/[;|\n]|&&|\s2>&1|\s\d?>\s?\S/);
    const segment = (end === -1 ? rest : rest.slice(0, end)).replace(/^[(\s]+/, '').trim();
    const insideString = (segment.match(/"/g) || []).length % 2 === 1 || (segment.match(/'/g) || []).length % 2 === 1;
    if (segment && !insideString && !NOT_A_RUN_RE.test(` ${segment}`)) return segment.length > 60 ? `${segment.slice(0, 59)}…` : segment;
    if (match[0].length === 0) VALIDATION_RE.lastIndex++;
  }
  return '';
}

/** True when a shell command runs tests, a build, a type check or a linter. */
export function isValidationCommand(command) {
  return validationLabel(command) !== '';
}

/** Short, recognisable label for a shell command: skips cd/Set-Location, variable assignments and echo banners. */
export function commandLabel(command, max = 60) {
  const segments = String(command || '')
    .split(/;|\r?\n|&&/)
    .map((s) => s.trim())
    .filter(Boolean);
  const boring = /^(?:cd|set-location|push-location|pop-location)\b|^\$[\w:]+\s*=|^["'][^"']*["']$|^#|^\$ErrorActionPreference/i;
  const chosen = segments.find((s) => !boring.test(s)) || segments[0] || '';
  const flat = chosen.replace(/\s+/g, ' ');
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Non-shell verification tools (classic VS Code chat). */
export function isValidationTool(name) {
  return /(runtests|run_tests|testfailure|geterrors|get_errors)/i.test(String(name || ''));
}

const GIT_PREFIX = String.raw`\bgit(?:\.exe)?(?:\s+(?:-C\s+(?:"[^"]*"|'[^']*'|\S+)|--no-pager|-c\s+\S+))*\s+`;
export const GIT_COMMIT_RE = new RegExp(`${GIT_PREFIX}commit\\b`, 'i');
export const GIT_PUSH_RE = new RegExp(`${GIT_PREFIX}push\\b`, 'i');

/** Documentation, scratch or generated output: changes that do not need a test run. */
export function isDocOrScratch(filePath) {
  const p = String(filePath || '').toLowerCase().replace(/\//g, '\\');
  if (/\.(md|markdown|txt|rst|adoc|csv|log|png|jpg|jpeg|gif|svg)$/.test(p)) return true;
  return /\\(scratch|output|reports|tmp|temp)\\/.test(p);
}
