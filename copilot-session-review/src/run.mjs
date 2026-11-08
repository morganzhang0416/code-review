import fs from 'node:fs';
import path from 'node:path';
import { analyze } from './analyze.mjs';
import { applyAgentHostTitles, loadAgentHostTitles } from './collect/agent-host-titles.mjs';
import { collectAgentSessions } from './collect/agent-sessions.mjs';
import { collectVsCodeChats } from './collect/vscode-chat.mjs';
import { FIRST_HOUR, LAST_HOUR, VERSION } from './config.mjs';
import { notifyReportReady } from './notify.mjs';
import { buildDigest, renderMarkdown } from './report.mjs';
import { buildStandup, standupBusinessDay } from './standup.mjs';
import { ensureDir, HOUR, localDateKey, MINUTE, readJson, silentLogger, writeFileAtomic } from './util.mjs';

const STALE_LOCK_MS = 30 * MINUTE;

export function readState(stateDir) {
  return readJson(path.join(stateDir, 'state.json'), {});
}

function writeState(stateDir, state) {
  writeFileAtomic(path.join(stateDir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
}

/** Read-modify-write of state.json. */
export function updateState(stateDir, mutate) {
  const state = readState(stateDir);
  mutate(state);
  writeState(stateDir, state);
  return state;
}

/** True when a scheduled attempt at `now` should run (inside the evening window and not yet done today). */
export function scheduledDecision(now, state, { firstHour = FIRST_HOUR, lastHour = LAST_HOUR } = {}) {
  const hour = now.getHours();
  if (hour < firstHour || hour > lastHour) return { run: false, reason: 'outside-window' };
  if (state.lastScheduledSuccessDate === localDateKey(now)) return { run: false, reason: 'already-done' };
  return { run: true, reason: 'due' };
}

function acquireLock(stateDir) {
  ensureDir(stateDir);
  const file = path.join(stateDir, 'run.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      fs.closeSync(fd);
      return () => fs.rmSync(file, { force: true });
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let stale = true;
      try {
        stale = Date.now() - fs.statSync(file).mtimeMs > STALE_LOCK_MS;
      } catch {
        // lock vanished; retry
      }
      if (!stale) return null;
      fs.rmSync(file, { force: true });
    }
  }
  return null;
}

/**
 * Generate the review.
 * @param {{
 *   config: ReturnType<import('./config.mjs').loadConfig>,
 *   now?: Date, scheduled?: boolean, force?: boolean, hours?: number, outDir?: string,
 *   notify?: boolean, log?: typeof silentLogger
 * }} options
 */
export async function runReview({ config, now = new Date(), scheduled = false, force = false, hours, outDir, notify, log = silentLogger }) {
  const state = readState(config.stateDir);
  if (scheduled && !force) {
    const decision = scheduledDecision(now, state);
    if (!decision.run) {
      log.info(`scheduled attempt skipped (${decision.reason})`);
      return { status: 'skipped', reason: decision.reason, report: state.lastReport || null };
    }
  }

  const release = acquireLock(config.stateDir);
  if (!release) {
    log.warn('another Copilot Session Review run is in progress; skipped');
    return { status: 'skipped', reason: 'locked' };
  }

  const started = Date.now();
  try {
    state.lastAttemptAt = now.toISOString();
    writeState(config.stateDir, state);

    const lookback = hours || config.lookbackHours;
    const window = { start: now.getTime() - lookback * HOUR, end: now.getTime() };
    const agents = await collectAgentSessions({ sessionStateDir: config.sessionStateDir, window, log });
    const vscode = collectVsCodeChats({ vscodeUserDirs: config.vscodeUserDirs, window, log });
    const businessDay = standupBusinessDay(now);
    const contextWindow = businessDay ? { start: businessDay.start, end: window.end } : null;
    const standupActivity = contextWindow ? {
      agents: await collectAgentSessions({ sessionStateDir: config.sessionStateDir, window: contextWindow, log }),
      vscode: collectVsCodeChats({ vscodeUserDirs: config.vscodeUserDirs, window: contextWindow, log }),
    } : null;

    let titleSource = '';
    let titleError = '';
    const titleChats = [...agents.chats, ...(standupActivity?.agents.chats || [])];
    if (config.titleLookup && titleChats.length) {
      const lookup = await loadAgentHostTitles({ vscodeUserDirs: config.vscodeUserDirs, python: config.python, log });
      if (lookup.bySdkId.size && applyAgentHostTitles(titleChats, lookup)) titleSource = 'agent-host.db';
      else titleError = lookup.error || '';
    }

    const daily = analyze([...agents.chats, ...vscode.chats], {
      window,
      now: now.getTime(),
      sourceStats: { agents: agents.stats, vscode: vscode.stats },
    });
    const analysis = standupActivity ? {
      ...daily,
      standup: buildStandup(
        analyze([...standupActivity.agents.chats, ...standupActivity.vscode.chats], { window: contextWindow, now: now.getTime() }),
        daily,
        businessDay,
        { unreadable: standupActivity.agents.stats.unreadable + standupActivity.vscode.stats.unreadable },
      ),
    } : daily;
    const meta = {
      version: VERSION,
      scheduled,
      sources: {
        agents: { dir: config.sessionStateDir, ...agents.stats },
        vscode: vscode.stats,
        titles: titleSource,
        titleError: titleSource ? '' : titleError,
        ...(standupActivity ? {
          standup: {
            window: { start: new Date(contextWindow.start).toISOString(), end: new Date(contextWindow.end).toISOString() },
            agents: standupActivity.agents.stats,
            vscode: standupActivity.vscode.stats,
          },
        } : {}),
      },
    };
    const markdown = renderMarkdown(analysis, meta);
    const digest = buildDigest(analysis, meta);

    const dir = outDir || config.reportsDir;
    const base = path.join(dir, localDateKey(now));
    writeFileAtomic(`${base}.md`, markdown);
    writeFileAtomic(`${base}.json`, `${JSON.stringify(digest, null, 2)}\n`);
    if (!outDir) writeFileAtomic(path.join(dir, 'latest.md'), markdown);

    const result = {
      status: 'ok',
      report: `${base}.md`,
      digest: `${base}.json`,
      totals: analysis.totals,
      improve: analysis.improve.length,
      good: analysis.good.length,
      ms: Date.now() - started,
    };
    if (scheduled) {
      state.lastScheduledSuccessDate = localDateKey(now);
      state.lastScheduledSuccessAt = new Date().toISOString();
    }
    state.lastSuccessAt = new Date().toISOString();
    state.lastReport = result.report;
    delete state.lastError;
    writeState(config.stateDir, state);
    log.info(
      `review written: ${result.report} (${analysis.totals.entries} sessions, ${analysis.totals.chats} chats, ${analysis.totals.prompts} prompts, ${analysis.improve.length} improvements) in ${result.ms} ms`,
    );

    const shouldNotify = notify ?? (scheduled && config.notify);
    if (shouldNotify) {
      const t = analysis.totals;
      const body = t.chats
        ? `${t.entries} sessions · ${t.prompts} prompts · ${analysis.good.length} went well · ${analysis.improve.length} to improve. Click to open.`
        : 'No Copilot activity in the last 24 hours. Click to open.';
      result.notified = await notifyReportReady({ title: 'Your Copilot daily review is ready', body, reportPath: result.report, log });
    }
    return result;
  } catch (err) {
    state.lastError = { at: new Date().toISOString(), message: String(err && err.message) };
    writeState(config.stateDir, state);
    log.error(`review failed: ${err && err.stack ? err.stack : err}`);
    throw err;
  } finally {
    release();
  }
}
