import path from 'node:path';
import { commandLabel, GIT_COMMIT_RE, GIT_PUSH_RE, isDocOrScratch, isValidationTool, validationLabel } from './collect/common.mjs';
import { code, quote } from './md.mjs';
import { snippet, titleFrom } from './redact.mjs';
import { summarizeSpending } from './spending.mjs';
import { activeMinutes, fmtDateTime, fmtDuration, fmtNumber, fmtTime, localDateKey, MINUTE, plural } from './util.mjs';

export const LIMITS = {
  largePromptChars: 20_000,
  longSessionPrompts: 15,
  longSessionMinutes: 180,
  hugeContextTokens: 300_000,
  approvalPrompts: 5,
  quickQuestionPremium: 10,
};

const CORRECTION_RE =
  /\b(still (?:not|failing|broken|wrong|the same)|not what i|not working|doesn'?t work|didn'?t work|you (?:missed|forgot|didn'?t|did not)|i (?:already )?(?:said|told you|asked you)|why did you|that'?s not (?:right|correct|what)|is wrong|was wrong|wrong (?:again|file|place|one))/i;

export const isFailure = (t) => t.ok === false || (typeof t.exitCode === 'number' && t.exitCode !== 0);
export const isPending = (t) => t.ok == null && typeof t.exitCode !== 'number';
const doneTs = (t) => t.endTs ?? t.ts;

/**
 * Turn collected chats into totals, per-session entries and review findings.
 * @param {any[]} chats
 * @param {{ window: { start: number, end: number }, now?: number, sourceStats?: object }} options
 */
export function analyze(chats, { window, now = Date.now(), sourceStats }) {
  const described = chats.map(describeChat);
  const entries = groupEntries(described);
  const totals = computeTotals(described, entries);
  const good = findGood(totals, entries);
  const improve = findImprovements(totals, entries);
  return {
    window,
    generatedAt: now,
    spending: summarizeSpending(chats, { window, sourceStats }),
    totals,
    entries,
    good,
    improve,
    focus: pickFocus(improve, good),
    summary: buildSummary(totals, entries),
  };
}

function describeChat(chat) {
  const timestamps = chat.timestamps.slice().sort((a, b) => a - b);
  const prompts = chat.prompts.slice().sort((a, b) => a.ts - b.ts);
  const tools = chat.toolCalls;
  const failed = tools.filter(isFailure);
  const shell = tools.filter((t) => typeof t.command === 'string');
  const checks = [];
  for (const t of tools) {
    const label = t.command ? validationLabel(t.command) : isValidationTool(t.name) ? t.name : '';
    if (label) {
      t.checkLabel = label;
      checks.push(t);
    }
  }
  const files = [...chat.files.values()].sort((a, b) => a.ts - b.ts);
  const firstText = prompts[0]?.text || chat.delegatedPrompts[0]?.text || chat.firstPromptEver || '';
  let title = chat.title || titleFrom(firstText);
  // Titles such as "d .." say nothing; prefer the first real request or outcome.
  if ((title.match(/[A-Za-z]/g) || []).length < 3) {
    const better = prompts.find((p) => (p.text.match(/[A-Za-z]/g) || []).length >= 3)?.text || chat.completions[0]?.summary || '';
    if (better) title = titleFrom(better);
  }
  return {
    chat,
    id: chat.id,
    source: chat.source,
    title: title || '(untitled chat)',
    cwd: chat.cwd,
    timestamps,
    prompts,
    tools,
    failed,
    shell,
    checks,
    files,
    endedOnError: endedOnError(chat),
  };
}

function endedOnError(chat) {
  if (!chat.errors.length) return false;
  const lastError = Math.max(...chat.errors.map((e) => e.ts));
  return chat.lastAssistantTs == null || lastError > chat.lastAssistantTs;
}

/** One entry per Agents-window session (its chats merged) or per standalone chat. */
function groupEntries(described) {
  const groups = new Map();
  for (const d of described) {
    const group = d.chat.group;
    const key = group?.id ? `session:${group.id}` : `chat:${d.source}:${d.id}`;
    if (!groups.has(key)) groups.set(key, { key, sessionId: group?.id || null, title: group?.title || '', parts: [] });
    groups.get(key).parts.push(d);
  }
  return [...groups.values()].map(buildEntry).sort((a, b) => a.first - b.first);
}

function buildEntry({ key, sessionId, title, parts }) {
  parts.sort((a, b) => (a.chat.group?.order ?? 0) - (b.chat.group?.order ?? 0) || a.timestamps[0] - b.timestamps[0]);
  const chats = parts.map((p) => p.chat);
  const timestamps = parts.flatMap((p) => p.timestamps).sort((a, b) => a - b);
  const prompts = parts.flatMap((p) => p.prompts).sort((a, b) => a.ts - b.ts);
  const tools = parts.flatMap((p) => p.tools);
  const failed = parts.flatMap((p) => p.failed);
  const checks = parts.flatMap((p) => p.checks).sort((a, b) => doneTs(a) - doneTs(b));
  const shell = parts.flatMap((p) => p.shell);

  const fileMap = new Map();
  for (const f of parts.flatMap((p) => p.files)) {
    const k = f.path.toLowerCase();
    const prev = fileMap.get(k);
    if (!prev || f.ts > prev.ts) fileMap.set(k, f);
  }
  const files = [...fileMap.values()].sort((a, b) => a.ts - b.ts);
  const codeFiles = files.filter((f) => !isDocOrScratch(f.path));
  const lastCodeEditTs = codeFiles.length ? Math.max(...codeFiles.map((f) => f.ts)) : null;
  const lastCheck = checks.length ? checks[checks.length - 1] : null;
  const lastCompletedCheck = checks.findLast((t) => !isPending(t)) || null;

  const modelUse = {};
  const modelNames = {};
  for (const c of chats) {
    Object.assign(modelNames, c.modelNames);
    for (const [model, use] of Object.entries(c.modelUse)) {
      const m = (modelUse[model] ||= { prompts: 0, premium: 0 });
      m.prompts += use.prompts;
      m.premium += use.premium;
    }
  }
  const cwd = mostCommon(parts.map((p) => p.cwd).filter(Boolean)) || '';
  const groupTitle = title && (title.match(/[A-Za-z]/g) || []).length >= 3 ? title : '';
  return {
    key,
    sessionId,
    title: groupTitle || parts[0].title,
    chatTitles: parts.map((p) => p.title),
    sources: [...new Set(parts.map((p) => p.source))],
    chatCount: parts.length,
    cwd,
    project: projectName(cwd),
    areas: workAreas(files, cwd),
    first: timestamps[0],
    last: timestamps[timestamps.length - 1],
    timestamps,
    activeMin: activeMinutes(timestamps),
    prompts,
    continuedFrom: prompts.length ? '' : chats.map((c) => c.firstPromptEver).find(Boolean) || '',
    steering: prompts.filter((p) => p.steering).length,
    delegated: chats.flatMap((c) => c.delegatedPrompts),
    autopilotContinuations: sum(chats, (c) => c.autopilotContinuations),
    tools: tools.length,
    toolTimestamps: tools.map((t) => t.ts),
    toolsFailed: failed.length,
    subagentTools: tools.filter((t) => t.subagent).length,
    byCategory: countBy(tools, (t) => t.category),
    failureGroups: failureGroups(failed),
    files,
    codeFiles,
    lastCodeEditTs,
    checks,
    checksFailed: checks.filter(isFailure).length,
    checksPending: checks.filter(isPending).length,
    lastCheck,
    lastCompletedCheck,
    checkedAfterEdit: lastCodeEditTs == null ? null : checks.some((t) => !isPending(t) && doneTs(t) >= lastCodeEditTs),
    commits: shell.filter((t) => GIT_COMMIT_RE.test(t.command) && !isFailure(t)).length,
    pushes: shell.filter((t) => GIT_PUSH_RE.test(t.command) && !isFailure(t)).length,
    completions: chats.flatMap((c) => c.completions).sort((a, b) => a.ts - b.ts),
    skills: countBy(chats.flatMap((c) => c.skills), (s) => s),
    subagents: chats.flatMap((c) => c.subagents),
    approvals: {
      human: sum(chats, (c) => c.approvals.human),
      auto: sum(chats, (c) => c.approvals.auto),
      denied: sum(chats, (c) => c.approvals.denied),
    },
    aborts: sum(chats, (c) => c.aborts),
    errors: chats.flatMap((c) => c.errors),
    endedOnError: parts.some((p) => p.endedOnError),
    premium: sum(chats, (c) => c.premium),
    credits: sum(chats, (c) => c.credits),
    modelUse,
    modelNames,
    inputTokens: sum(chats, (c) => c.inputTokens),
    outputTokens: sum(chats, (c) => c.outputTokens),
    maxInputTokens: Math.max(0, ...chats.map((c) => c.maxInputTokens)),
    images: sum(chats, (c) => c.images),
    modes: [...new Set(chats.flatMap((c) => [...c.modes]))],
    corrections: prompts.filter((p) => CORRECTION_RE.test(p.text)),
    largePrompts: prompts.filter((p) => p.chars >= LIMITS.largePromptChars),
  };
}

function computeTotals(described, entries) {
  const allTimestamps = described.flatMap((d) => d.timestamps).sort((a, b) => a - b);
  const files = new Map();
  for (const e of entries) for (const f of e.files) files.set(f.path.toLowerCase(), f);
  const modelUse = {};
  const modelNames = {};
  for (const e of entries) {
    Object.assign(modelNames, e.modelNames);
    for (const [model, use] of Object.entries(e.modelUse)) {
      const m = (modelUse[model] ||= { prompts: 0, premium: 0 });
      m.prompts += use.prompts;
      m.premium += use.premium;
    }
  }
  const skills = {};
  for (const e of entries) for (const [name, n] of Object.entries(e.skills)) skills[name] = (skills[name] || 0) + n;
  const hourly = new Array(24).fill(0);
  for (const e of entries) {
    for (const p of e.prompts) hourly[new Date(p.ts).getHours()] += 1;
  }
  const projects = countBy(entries, (e) => e.project);
  return {
    entries: entries.length,
    chats: described.length,
    agentsChats: described.filter((d) => d.source === 'agents').length,
    vscodeChats: described.filter((d) => d.source === 'vscode-chat').length,
    prompts: sum(entries, (e) => e.prompts.length),
    steering: sum(entries, (e) => e.steering),
    delegated: sum(entries, (e) => e.delegated.length),
    autopilotContinuations: sum(entries, (e) => e.autopilotContinuations),
    tools: sum(entries, (e) => e.tools),
    toolsFailed: sum(entries, (e) => e.toolsFailed),
    byCategory: mergeCounts(entries.map((e) => e.byCategory)),
    files: [...files.values()],
    codeFiles: [...files.values()].filter((f) => !isDocOrScratch(f.path)),
    checks: sum(entries, (e) => e.checks.length),
    checksFailed: sum(entries, (e) => e.checksFailed),
    checksPending: sum(entries, (e) => e.checksPending),
    commits: sum(entries, (e) => e.commits),
    pushes: sum(entries, (e) => e.pushes),
    completions: sum(entries, (e) => e.completions.length),
    completionsOk: sum(entries, (e) => e.completions.filter((c) => c.success).length),
    skills,
    subagents: sum(entries, (e) => e.subagents.length),
    subagentNames: countBy(entries.flatMap((e) => e.subagents), (s) => s.name),
    approvalsHuman: sum(entries, (e) => e.approvals.human),
    approvalsAuto: sum(entries, (e) => e.approvals.auto),
    denied: sum(entries, (e) => e.approvals.denied),
    aborts: sum(entries, (e) => e.aborts),
    errors: sum(entries, (e) => e.errors.length),
    premium: sum(entries, (e) => e.premium),
    credits: sum(entries, (e) => e.credits),
    modelUse,
    modelNames,
    inputTokens: sum(entries, (e) => e.inputTokens),
    outputTokens: sum(entries, (e) => e.outputTokens),
    activeMin: activeMinutes(allTimestamps),
    first: allTimestamps[0],
    last: allTimestamps[allTimestamps.length - 1],
    hourly,
    projects,
    maxParallel: maxParallel(described),
    largePrompts: entries.flatMap((e) => e.largePrompts),
    corrections: entries.flatMap((e) => e.corrections),
  };
}

function findGood(t, entries) {
  const good = [];
  const completed = entries.filter((e) => e.completions.some((c) => c.success));
  if (completed.length) {
    good.push({
      id: 'completed',
      title: `Closed the loop on ${plural(t.completionsOk, 'task')}`,
      detail: `Finished with a completion summary in ${titles(completed)}.`,
    });
  }
  const editing = entries.filter((e) => e.codeFiles.length);
  const checked = editing.filter((e) => e.checkedAfterEdit === true);
  if (checked.length) {
    good.push({
      id: 'checked',
      title: 'Code changes were checked',
      detail: `${checked.length} of ${plural(editing.length, 'session')} that changed code ran tests, builds or linters after the last edit (${plural(t.checks - t.checksPending, 'completed check')} in total${t.checksFailed ? `, ${t.checksFailed} failing along the way` : ''}).`,
    });
  }
  if (t.subagents || t.delegated) {
    const names = Object.keys(t.subagentNames);
    good.push({
      id: 'delegation',
      title: 'Used independent agents',
      detail: [
        t.subagents ? `${plural(t.subagents, 'subagent')} ran${names.length ? ` (${names.map((n) => code(n, 40)).join(', ')})` : ''}` : '',
        t.delegated ? `${plural(t.delegated, 'prompt')} handed to another session` : '',
      ]
        .filter(Boolean)
        .join('; ') + ' — good for independent review and parallel work.',
    });
  }
  const skillNames = Object.keys(t.skills);
  if (skillNames.length) {
    good.push({
      id: 'skills',
      title: 'Reused your own tooling',
      detail: `Skills used: ${skillNames.map((s) => `${code(s, 40)} ×${t.skills[s]}`).join(', ')}.`,
    });
  }
  if (t.tools >= 30 && t.toolsFailed / t.tools <= 0.05) {
    good.push({
      id: 'smooth',
      title: 'Smooth execution',
      detail: `Only ${pct(t.toolsFailed, t.tools)} of ${fmtNumber(t.tools)} tool calls failed.`,
    });
  }
  const promptCounts = entries.map((e) => e.prompts.length).filter((n) => n > 0);
  if (promptCounts.length >= 2 && median(promptCounts) <= 6 && !entries.some((e) => e.prompts.length >= LIMITS.longSessionPrompts)) {
    good.push({
      id: 'focused',
      title: 'Focused sessions',
      detail: `A median of ${median(promptCounts)} prompts per session and none overly long, so each topic kept its own context.`,
    });
  }
  if (t.tools >= 50 && t.approvalsHuman <= 2) {
    good.push({
      id: 'flow',
      title: 'Few interruptions',
      detail: `${plural(t.approvalsHuman, 'approval prompt')} needed you across ${fmtNumber(t.tools)} tool calls.`,
    });
  }
  if (t.steering) {
    good.push({
      id: 'steering',
      title: 'Steered instead of restarting',
      detail: `You course-corrected ${plural(t.steering, 'time')} while the agent was still working.`,
    });
  }
  if (t.commits) {
    good.push({
      id: 'commits',
      title: 'Work was committed',
      detail: `${plural(t.commits, 'commit')}${t.pushes ? ` and ${plural(t.pushes, 'push', 'pushes')}` : ''} by the agents.`,
    });
  }
  return good;
}

function findImprovements(t, entries) {
  const out = [];

  const unchecked = entries.filter((e) => e.codeFiles.length && e.checkedAfterEdit !== true);
  if (unchecked.length) {
    out.push({
      id: 'unchecked',
      severity: 3,
      title: 'Code changed without a final check',
      detail: `${list(unchecked, (e) => {
        const reason = e.lastCompletedCheck ? 'last completed check ran before the final edit' : e.checks.length ? 'no completed test, build or lint run' : 'no test, build or lint run';
        return `${quote(short(e.title))} (${plural(e.codeFiles.length, 'file')}; ${reason})`;
      })}.`,
      action: 'Finish coding tasks with “run the relevant tests/build and fix any failures before you stop”, or name the exact command.',
    });
  }

  const failingEnd = entries.filter((e) => e.lastCompletedCheck && isFailure(e.lastCompletedCheck));
  if (failingEnd.length) {
    out.push({
      id: 'failing-check',
      severity: 3,
      title: 'Last completed check was still failing',
      detail: `${list(failingEnd, (e) => `${quote(short(e.title))}: ${code(snippet(e.lastCompletedCheck.checkLabel || e.lastCompletedCheck.name, 70), 70)} ${typeof e.lastCompletedCheck.exitCode === 'number' ? `exited ${e.lastCompletedCheck.exitCode}` : 'failed'}`)}.`,
      action: 'Before closing, ask whether the failure is new or pre-existing and record the decision (fix, follow-up ticket or known issue).',
    });
  }

  const pending = entries.filter((e) => e.checksPending);
  if (pending.length) {
    out.push({
      id: 'pending-checks',
      severity: 2,
      title: 'Checks had no recorded result',
      detail: `${list(pending, (e) => `${quote(short(e.title))} (${plural(e.checksPending, 'check')} without a recorded result)`)}.`,
      action: 'Check whether the command is still running, was cancelled or completed later. Collect its result before calling the task verified.',
    });
  }

  const ended = entries.filter((e) => e.endedOnError);
  if (ended.length) {
    out.push({
      id: 'ended-on-error',
      severity: 2,
      title: 'Sessions stopped on an AI error',
      detail: `${list(ended, (e) => `${quote(short(e.title))} (${snippet(e.errors[e.errors.length - 1].message, 90)})`)}.`,
      action:
        'Resume with “continue from where you stopped”. If the error says the model is unavailable, pick another model; if errors repeat, start a fresh chat from a short summary (very large context is a common cause).',
    });
  }

  const long = entries.filter(
    (e) => e.prompts.length >= LIMITS.longSessionPrompts || e.activeMin >= LIMITS.longSessionMinutes || e.maxInputTokens >= LIMITS.hugeContextTokens,
  );
  if (long.length) {
    out.push({
      id: 'long',
      severity: 2,
      title: 'Very long sessions',
      detail: `${list(long, (e) => `${quote(short(e.title))} (${[
        e.prompts.length >= LIMITS.longSessionPrompts ? plural(e.prompts.length, 'prompt') : '',
        e.activeMin >= LIMITS.longSessionMinutes ? `${fmtDuration(e.activeMin)} active` : '',
        e.maxInputTokens >= LIMITS.hugeContextTokens ? `context up to ${fmtNumber(e.maxInputTokens / 1000)}k tokens` : '',
      ]
        .filter(Boolean)
        .join(', ')})`)}.`,
      action: 'Split at stage boundaries (investigate → implement → verify): ask for a short handoff summary, then start a fresh chat with it.',
    });
  }

  if (t.largePrompts.length) {
    const largest = Math.max(...t.largePrompts.map((p) => p.chars));
    out.push({
      id: 'large-prompts',
      severity: 2,
      title: 'Very large pasted prompts',
      detail: `${plural(t.largePrompts.length, 'prompt')} over ${fmtNumber(LIMITS.largePromptChars)} characters (largest ${fmtNumber(largest)}).`,
      action: 'Save logs or payloads to a local file and give the path, the time window and the question instead of pasting them.',
    });
  }

  if (t.corrections.length >= 2) {
    out.push({
      id: 'corrections',
      severity: 2,
      title: 'Several follow-ups were corrections',
      detail: `${plural(t.corrections.length, 'prompt')} corrected earlier work, e.g. ${quote(snippet(t.corrections[0].text, 90))}.`,
      action: 'Front-load the goal, environment, constraints and what “done” means in the first prompt; for big changes ask the agent to restate its plan first.',
    });
  }

  const hotspots = entries.filter((e) => e.toolsFailed >= 5 && e.toolsFailed / Math.max(e.tools, 1) >= 0.15);
  const loops = entries.flatMap((e) => e.failureGroups.filter((g) => g.count >= 3).map((g) => ({ e, g })));
  if (hotspots.length || loops.length) {
    const parts = [];
    if (hotspots.length) parts.push(list(hotspots, (e) => `${quote(short(e.title))}: ${e.toolsFailed} of ${e.tools} tool calls failed`));
    if (loops.length) parts.push(`repeated failures: ${list(loops.slice(0, 4), ({ g }) => `${code(g.example, 60)} ×${g.count}`)}`);
    out.push({
      id: 'failures',
      severity: 2,
      title: 'Tool-call failure hotspots',
      detail: `${parts.join('; ')}.`,
      action: 'When the same step keeps failing, stop and ask for the root cause (missing tool, path, auth or environment), then capture the fix in instructions so the next session avoids it.',
    });
  }

  const collisions = parallelSameFolderEdits(entries);
  if (collisions.length) {
    out.push({
      id: 'parallel-edits',
      severity: 2,
      title: 'Parallel sessions edited the same folder',
      detail: `${list(collisions, ([a, b]) => `${quote(short(a.title))} and ${quote(short(b.title))} in ${code(a.cwd, 50)}`)}.`,
      action: 'Give each parallel coding session its own Git worktree (or run them one after another) so their edits cannot collide.',
    });
  }

  if (t.approvalsHuman >= LIMITS.approvalPrompts) {
    out.push({
      id: 'approvals',
      severity: 1,
      title: 'Frequent approval prompts',
      detail: `${plural(t.approvalsHuman, 'tool call')} waited for your approval.`,
      action: 'Pre-approve safe read-only commands (VS Code `chat.tools.terminal.autoApprove`) or use Autopilot for well-scoped tasks.',
    });
  }

  const quick = entries.filter(
    (e) => e.prompts.length > 0 && e.prompts.length <= 2 && e.tools <= 10 && e.files.length === 0 && e.premium >= LIMITS.quickQuestionPremium,
  );
  if (quick.length) {
    out.push({
      id: 'model-choice',
      severity: 1,
      title: 'Premium model used for quick questions',
      detail: `${list(quick, (e) => `${quote(short(e.title))} (~${fmtNumber(e.premium)} premium units${topModelName(e.modelUse, e.modelNames) ? ` on ${topModelName(e.modelUse, e.modelNames)}` : ''})`)}.`,
      action: 'Use Auto or a lighter model for quick questions and keep the top models for complex, multi-step work.',
    });
  }

  if (t.aborts >= 3) {
    out.push({
      id: 'aborts',
      severity: 1,
      title: 'Several runs were cancelled',
      detail: `${plural(t.aborts, 'run')} cancelled.`,
      action: 'If you cancel because the agent went off track, add the missing constraint as a steering message instead of restarting.',
    });
  }

  return out.sort((a, b) => b.severity - a.severity);
}

function pickFocus(improve, good) {
  if (improve.length) return improve.slice(0, 3).map((f) => `**${f.title}** — ${f.action}`);
  if (good.length) return [`Keep doing what worked: ${good.slice(0, 3).map((g) => g.title.toLowerCase()).join('; ')}.`];
  return [];
}

function buildSummary(t, entries) {
  if (!t.chats) return 'No Copilot activity was found in this window.';
  const projects = Object.entries(t.projects).sort((a, b) => b[1] - a[1]);
  const projectText = projects.length
    ? ` across ${projects.slice(0, 4).map(([name, n]) => `${name}${projects.length > 1 ? ` (${n})` : ''}`).join(', ')}`
    : '';
  const sameDay = localDateKey(t.first) === localDateKey(t.last);
  const span = sameDay ? `${fmtTime(t.first)} and ${fmtTime(t.last)}` : `${fmtDateTime(t.first)} and ${fmtDateTime(t.last)}`;
  const top = topModelName(t.modelUse, t.modelNames);
  const threads = entries
    .slice()
    .sort((a, b) => b.prompts.length + b.tools / 20 - (a.prompts.length + a.tools / 20))
    .slice(0, 3)
    .map((e) => quote(short(e.title)));
  const sentences = [
    `You worked with Copilot in **${plural(t.entries, 'session')}**${t.chats !== t.entries ? ` (${plural(t.chats, 'chat')})` : ''}${projectText}.`,
    `You sent **${plural(t.prompts, 'prompt')}**${t.steering ? ` (${t.steering} while the agent was working)` : ''}; the agents made **${plural(t.tools, 'tool call')}**${t.tools ? ` (${pct(t.toolsFailed, t.tools)} failed)` : ''}, changed **${plural(t.files.length, 'file')}** and finished **${plural(t.completionsOk, 'task')}**.`,
    `Active for about **${fmtDuration(t.activeMin)}** between ${span}.`,
  ];
  if (t.premium) sentences.push(`Estimated premium usage: **${fmtNumber(t.premium)} units**${top ? `, mostly ${top}` : ''}.`);
  if (threads.length) sentences.push(`Main threads: ${threads.join('; ')}.`);
  return sentences.join(' ');
}

function parallelSameFolderEdits(entries) {
  const editing = entries.filter((e) => e.codeFiles.length && e.cwd);
  const pairs = [];
  for (let i = 0; i < editing.length; i++) {
    for (let j = i + 1; j < editing.length; j++) {
      const a = editing[i];
      const b = editing[j];
      if (a.cwd.toLowerCase() !== b.cwd.toLowerCase()) continue;
      const [a0, a1] = editSpan(a);
      const [b0, b1] = editSpan(b);
      if (a0 <= b1 && b0 <= a1) pairs.push([a, b]);
    }
  }
  return pairs.slice(0, 4);
}

function editSpan(entry) {
  const times = entry.codeFiles.map((f) => f.ts);
  return [Math.min(...times) - 5 * MINUTE, Math.max(...times) + 5 * MINUTE];
}

function failureGroups(failed) {
  const groups = new Map();
  for (const t of failed) {
    const detail = t.command || t.path || t.error || '';
    const label = t.command ? commandLabel(snippet(t.command, 400), 60) : snippet(detail, 60);
    const example = `${t.name}${label ? `: ${label}` : ''}`;
    const key = `${t.name}|${String(detail).replace(/\s+/g, ' ').trim().slice(0, 120).toLowerCase()}`;
    const g = groups.get(key) || { key, tool: t.name, example, count: 0 };
    g.count++;
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

function maxParallel(described) {
  const buckets = new Map();
  for (const d of described) {
    const seen = new Set(d.timestamps.map((ts) => Math.floor(ts / (15 * MINUTE))));
    for (const b of seen) buckets.set(b, (buckets.get(b) || 0) + 1);
  }
  return Math.max(0, ...buckets.values());
}

export function projectName(cwd) {
  if (!cwd) return '(no folder)';
  return path.basename(path.normalize(cwd)) || cwd;
}

/** Top-level folders (relative to the session folder) that received edits. */
function workAreas(files, cwd) {
  const counts = {};
  const root = cwd ? path.normalize(cwd).toLowerCase() : '';
  for (const f of files) {
    const p = path.normalize(f.path);
    let area;
    if (root && p.toLowerCase().startsWith(`${root}${path.sep}`)) {
      const rel = p.slice(root.length + 1).split(path.sep);
      area = rel.length > 1 ? rel[0] : '.';
    } else {
      area = path.basename(path.dirname(p));
    }
    counts[area] = (counts[area] || 0) + 1;
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name)
    .filter((name) => name !== '.')
    .slice(0, 2);
}

export function topModelName(modelUse, modelNames = {}) {
  const entries = Object.entries(modelUse || {});
  if (!entries.length) return '';
  entries.sort((a, b) => b[1].premium - a[1].premium || b[1].prompts - a[1].prompts);
  return modelNames[entries[0][0]] || entries[0][0];
}

function titles(entries) {
  return list(entries.slice(0, 5), (e) => quote(short(e.title))) + (entries.length > 5 ? ` and ${entries.length - 5} more` : '');
}

function list(items, fn) {
  return items.map(fn).join('; ');
}

export function short(text, max = 70) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function sum(items, fn) {
  return items.reduce((acc, item) => acc + (Number(fn(item)) || 0), 0);
}

function countBy(items, fn) {
  const out = {};
  for (const item of items) {
    const key = fn(item);
    if (key == null || key === '') continue;
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function mergeCounts(maps) {
  const out = {};
  for (const m of maps) for (const [k, v] of Object.entries(m)) out[k] = (out[k] || 0) + v;
  return out;
}

function mostCommon(values) {
  const counts = countBy(values, (v) => v);
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
}

function median(values) {
  if (!values.length) return 0;
  const s = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

export function pct(part, whole) {
  if (!whole) return '0%';
  const value = (100 * part) / whole;
  return `${value < 10 && value > 0 ? value.toFixed(1) : Math.round(value)}%`;
}
