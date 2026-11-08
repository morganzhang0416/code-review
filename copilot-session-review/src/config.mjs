import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP = 'copilot-session-review';
export const VERSION = '0.1.0';
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TASK_NAME = 'CopilotSessionReview';

/** Scheduled attempts start at every whole hour from FIRST_HOUR to LAST_HOUR (local time). */
export const FIRST_HOUR = 19;
export const LAST_HOUR = 23;

/**
 * Runtime configuration. Environment overrides exist mainly for tests and unusual installs.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function loadConfig(env = process.env) {
  const home = env.USERPROFILE || os.homedir();
  const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const vscodeUserDirs = env.SESSION_REVIEW_VSCODE_DIRS
    ? env.SESSION_REVIEW_VSCODE_DIRS.split(path.delimiter).filter(Boolean)
    : ['Code', 'Code - Insiders'].map((name) => path.join(appData, name, 'User'));
  return {
    lookbackHours: positiveNumber(env.SESSION_REVIEW_LOOKBACK_HOURS, 24),
    sessionStateDir: env.SESSION_REVIEW_SESSION_STATE || path.join(home, '.copilot', 'session-state'),
    vscodeUserDirs,
    reportsDir: env.SESSION_REVIEW_REPORTS_DIR || path.join(ROOT, 'reports'),
    stateDir: env.SESSION_REVIEW_STATE_DIR || path.join(ROOT, 'state'),
    logsDir: env.SESSION_REVIEW_LOGS_DIR || path.join(ROOT, 'logs'),
    python: env.SESSION_REVIEW_PYTHON || '',
    titleLookup: env.SESSION_REVIEW_TITLES !== '0',
    notify: env.SESSION_REVIEW_NOTIFY !== '0',
  };
}

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
