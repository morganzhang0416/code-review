import os from 'node:os';
import path from 'node:path';
import { isFailure, isPending, short, topModelName } from './analyze.mjs';
import { code, mdInline, mdText, quote } from './md.mjs';
import { redact, snippet } from './redact.mjs';
import { formatSpendingAmount } from './spending.mjs';
import { fmtDateTime, fmtDuration, fmtLongDate, fmtNumber, fmtTime, fmtZone, localDateKey, plural } from './util.mjs';

/**
 * @param {ReturnType<import('./analyze.mjs').analyze> & { standup?: ReturnType<import('./standup.mjs').buildStandup> }} a
 * @param {{ version: string, scheduled: boolean, sources: any }} meta
 */
export function renderMarkdown(a, meta) {
  const t = a.totals;
  const zone = fmtZone(a.window.end);
  const out = [];
  out.push(`# Copilot daily review — ${fmtLongDate(a.window.end)}`, '');
  out.push(
    `> Window: ${fmtDateTime(a.window.start)} → ${fmtDateTime(a.window.end)}${zone ? ` ${zone}` : ''} · generated ${fmtTime(a.generatedAt)} by Copilot Session Review ${meta.version}${meta.scheduled ? ' (scheduled run)' : ' (manual run)'}`,
    '',
  );

  out.push('## Summary', '', a.summary, '');
  if (t.chats) {
    out.push('| Measure | Value |', '| --- | ---: |');
    const rows = [
      ['Sessions / chats', `${fmtNumber(t.entries)} / ${fmtNumber(t.chats)}`],
      ['Your prompts', `${fmtNumber(t.prompts)}${t.steering ? ` (${t.steering} steering)` : ''}`],
      ['Prompts from other sessions', t.delegated ? fmtNumber(t.delegated) : ''],
      ['Tool calls (failed)', `${fmtNumber(t.tools)} (${fmtNumber(t.toolsFailed)})`],
      ['Files changed (code)', `${fmtNumber(t.files.length)} (${fmtNumber(t.codeFiles.length)})`],
      ['Tests / builds / lint runs (failed)', `${fmtNumber(t.checks)} (${fmtNumber(t.checksFailed)})`],
      ['Checks without a recorded result', t.checksPending ? fmtNumber(t.checksPending) : ''],
      ['Commits / pushes', t.commits || t.pushes ? `${t.commits} / ${t.pushes}` : ''],
      ['Tasks completed', fmtNumber(t.completionsOk)],
      ['Subagents', t.subagents ? fmtNumber(t.subagents) : ''],
      ['Approvals you gave', fmtNumber(t.approvalsHuman)],
      ['Cancelled runs / AI errors', t.aborts || t.errors ? `${t.aborts} / ${t.errors}` : ''],
      ['Agents / CLI premium units (estimate)', fmtNumber(t.premium)],
      ['VS Code chat credits', fmtNumber(t.credits)],
      ['Recorded input tokens', fmtNumber(t.inputTokens)],
      ['Recorded output tokens', fmtNumber(t.outputTokens)],
      ['Recorded total tokens', fmtNumber(t.inputTokens + t.outputTokens)],
      ['Active time', fmtDuration(t.activeMin)],
      ['Most sessions at once', t.maxParallel > 1 ? fmtNumber(t.maxParallel) : ''],
    ];
    for (const [label, value] of rows) if (value !== '') out.push(`| ${label} | ${value} |`);
    out.push('');
    const models = Object.entries(t.modelUse).sort((x, y) => y[1].prompts - x[1].prompts);
    if (models.length) {
      out.push(
        `Models: ${models.map(([m, u]) => `${mdText(t.modelNames[m] || m)} ×${u.prompts}${u.premium ? ` (~${fmtNumber(u.premium)} units)` : ''}`).join(', ')}.`,
        '',
      );
    }
    const hours = t.hourly.map((n, h) => [h, n]).filter(([, n]) => n > 0);
    if (hours.length) {
      const max = Math.max(...t.hourly);
      const blocks = '▁▂▃▄▅▆▇█';
      out.push(
        `Prompts by hour: ${hours.map(([h, n]) => `${String(h).padStart(2, '0')}h ${blocks[Math.min(7, Math.floor((n / max) * 7.999))]}${n}`).join(' · ')}`,
        '',
      );
    }
  }

  out.push(...renderSpending(a.spending));
  if (a.standup) out.push(...renderStandup(a.standup));

  out.push('## Things you did', '');
  if (!a.entries.length) out.push('_Nothing recorded in this window._', '');
  a.entries.forEach((e, i) => out.push(renderEntry(e, i), ''));

  out.push('## What went well', '');
  if (a.good.length) for (const g of a.good) out.push(`- **${g.title}.** ${g.detail}`);
  else out.push('- _Not enough activity to call out strengths._');
  out.push('');

  out.push('## What to improve', '');
  if (a.improve.length) {
    a.improve.forEach((f, i) => out.push(`${i + 1}. **${f.title}** ${'●'.repeat(f.severity)}${'○'.repeat(3 - f.severity)} — ${f.detail}`, `   - _Try:_ ${f.action}`));
  } else {
    out.push('- _No issues detected by the checks this run._');
  }
  out.push('');

  if (a.focus.length) {
    out.push('## Focus for tomorrow', '');
    a.focus.forEach((f, i) => out.push(`${i + 1}. ${f}`));
    out.push('');
  }

  out.push('## About this report', '');
  const s = meta.sources || {};
  out.push(
    `- Sources: ${plural(s.agents?.scanned ?? 0, 'Agents/CLI chat log')} in ${code(tildify(s.agents?.dir || ''), 60)}; ${plural(s.vscode?.scanned ?? 0, 'VS Code chat file')}${s.titles ? `; session titles from VS Code (${mdText(s.titles)})` : '; session titles from first prompts'}.`,
    '- Built locally from your own Copilot history; nothing was sent anywhere. Prompts are shortened and emails, secrets and long numbers are masked.',
    '- “Went well / improve” are rule-based signals, not judgements. Agents / CLI premium units are estimates from local usage records, not billing data. Token totals come from Agents / CLI usage records; classic VS Code chats do not expose token totals here. Premium units and VS Code chat credits are separate measures.',
    '- Legacy premium units and VS Code chat credits are separate from recorded AI-credit spending. Neither is used to calculate actual spending.',
    '- This report is generated locally by Copilot Session Review.',
  );
  if (s.titleError) out.push(`- Session titles unavailable this run: ${mdText(snippet(s.titleError, 120))}.`);
  out.push('');
  return out.join('\n');
}

function renderSpending(s) {
  const credits = (nano) => formatSpendingAmount(nano, 1_000_000_000n);
  const usd = (nano) => nano == null ? 'Not available' : `US$${formatSpendingAmount(nano, 100_000_000_000n)}`;
  const coverage = (status) => status === 'complete' ? 'Complete for recorded calls'
    : status === 'partial' ? 'Partial usage; recorded subtotal' : 'Not available';
  const lines = [
    '## Recorded Copilot spending', '',
    '| Measure | Value |', '| --- | ---: |',
    `| Recorded AI credits | ${credits(s.totalNanoAiu)} |`,
    `| USD equivalent (not a bill) | ${usd(s.totalNanoAiu)} |`,
    `| Usage coverage | ${coverage(s.status)} |`,
    `| Unique calls with recorded amounts | ${fmtNumber(s.recordedCalls)} |`,
    `| Duplicate usage records removed | ${fmtNumber(s.duplicatesRemoved)} |`, '',
    '### Spending by local day', '',
    `Local time: ${mdText(s.timeZone)}. Each row covers only the part of the day inside the report window.`, '',
    '| Local day | Report-window coverage | Recorded AI credits | USD equivalent | Usage coverage |',
    '| --- | --- | ---: | ---: | --- |',
  ];
  for (const day of s.days) {
    const start = Date.parse(day.window.start);
    const end = Date.parse(day.window.end);
    const endTime = localDateKey(end + 1) !== day.date ? '24:00' : fmtTime(end);
    const period = day.partialDay ? `Partial day (${fmtTime(start)}-${endTime})` : 'Full day';
    lines.push(`| ${day.date} | ${period} | ${credits(day.totalNanoAiu)} | ${usd(day.totalNanoAiu)} | ${coverage(day.status)} |`);
  }
  lines.push('', ...s.warnings.map((warning) => `- ${mdText(warning)}`), '');
  return lines;
}

function renderStandup(s) {
  const lines = [
    '## Standup report', '',
    '### What I did last business day', '',
    `_${fmtLongDate(Date.parse(s.previousBusinessDay.start))}. Business days mean Monday-Friday; public holidays are not excluded._`, '',
  ];
  if (s.historyIncomplete) lines.push('Some local history could not be read. Work and blockers may be missing.', '');
  if (s.work.length) {
    for (const item of s.work) lines.push(`- **${mdText(item.project)} — ${mdText(item.title)}:** ${mdInline(item.summary, 360)}`);
    if (s.workOmitted) lines.push(`- _${plural(s.workOmitted, 'other work topic')} recorded that day are not shown in this short standup._`);
  } else {
    lines.push('- No work was found for that business day in the local Copilot history. This does not mean no work was done.');
  }
  lines.push('', '### What I will focus on today (suggestions)', '', `_${mdText(s.date)}. These are suggestions, not an agreed plan._`, '');
  for (const item of s.focus) lines.push(`- ${mdText(item)}`);
  lines.push('', '### Blockers the team should know about', '', '_Based on recorded local outcomes, not live checks. Please confirm whether these blockers still apply._', '');
  if (s.blockers.length) {
    for (const item of s.blockers) lines.push(`- **${mdText(item.project)} — ${mdText(item.title)}:** ${mdText(item.detail)} (recorded ${fmtDateTime(Date.parse(item.recordedAt))})`);
  } else {
    lines.push('- No clear team blocker was recorded in the available local outcomes. This does not prove there are no blockers.');
  }
  lines.push('');
  return lines;
}

function renderEntry(e, i) {
  const lines = [];
  const where = [e.project, ...e.areas.filter((x) => x.toLowerCase() !== String(e.project).toLowerCase())].join(' › ');
  lines.push(`### ${i + 1}. ${mdText(short(e.title, 90))}${where ? ` — ${mdText(where)}` : ''}`);
  const sameDay = localDateKey(e.first) === localDateKey(e.last);
  const when = sameDay ? `${fmtTime(e.first)}–${fmtTime(e.last)}` : `${fmtDateTime(e.first)} → ${fmtDateTime(e.last)}`;
  const facts = [
    when,
    e.chatCount > 1 ? plural(e.chatCount, 'chat') : '',
    plural(e.prompts.length, 'prompt'),
    e.tools ? plural(e.tools, 'tool call') : '',
    e.activeMin >= 1 ? `${fmtDuration(e.activeMin)} active` : '',
    mdText(topModelName(e.modelUse, e.modelNames)),
    e.sources.includes('vscode-chat') ? 'VS Code chat' : '',
  ].filter(Boolean);
  lines.push(`_${facts.join(' · ')}_`, '');

  const first = e.prompts[0];
  if (first) {
    lines.push(`- **You asked:** ${quote(snippet(first.text, 220))}${e.prompts.length > 1 ? ` _(+${e.prompts.length - 1} more)_` : ''}`);
  } else if (e.delegated.length) {
    lines.push(`- **Started by another session:** ${quote(snippet(e.delegated[0].text, 220))}`);
  } else if (e.continuedFrom) {
    lines.push(`- **Continued from earlier:** ${quote(snippet(e.continuedFrom, 220))}`);
  }
  const completions = e.completions.slice(-3);
  for (const c of completions) lines.push(`- **Outcome:** ${c.success ? '✅' : '⚠️'} ${mdInline(redact(c.summary), 320)}`);
  if (e.completions.length > completions.length) lines.push(`- _(+${e.completions.length - completions.length} earlier completion summaries)_`);
  if (!e.completions.length) lines.push(`- **Outcome:** _no completion summary recorded${e.endedOnError ? '; stopped on an AI error' : ''}_`);
  if (e.files.length) {
    const recent = e.files.slice(-6).reverse();
    lines.push(`- **Changed:** ${plural(e.files.length, 'file')} — ${recent.map((f) => code(displayPath(f.path, e.cwd), 70)).join(', ')}${e.files.length > recent.length ? ` _+${e.files.length - recent.length} more_` : ''}`);
  }
  if (e.checks.length) {
    const result = isPending(e.lastCheck) ? 'pending (no result recorded)' : isFailure(e.lastCheck) ? '❌ failed' : '✅ passed';
    lines.push(`- **Checks:** ${summarizeChecks(e.checks)} — last ${result}`);
  }
  if (e.commits || e.pushes) {
    lines.push(`- **Git:** ${[e.commits ? plural(e.commits, 'commit') : '', e.pushes ? plural(e.pushes, 'push', 'pushes') : ''].filter(Boolean).join(', ')}`);
  }
  const help = [];
  const skills = Object.entries(e.skills);
  if (skills.length) help.push(`skills ${skills.map(([s, n]) => `${code(s, 40)}${n > 1 ? ` ×${n}` : ''}`).join(', ')}`);
  if (e.subagents.length) help.push(`subagents ${e.subagents.map((s) => code(s.display || s.name, 40)).join(', ')}`);
  if (help.length) lines.push(`- **Help used:** ${help.join(' · ')}`);
  const friction = [
    e.toolsFailed ? plural(e.toolsFailed, 'failed tool call') : '',
    e.approvals.human ? plural(e.approvals.human, 'approval') : '',
    e.aborts ? plural(e.aborts, 'cancelled run') : '',
    e.errors.length ? plural(e.errors.length, 'AI error') : '',
  ].filter(Boolean);
  if (friction.length) lines.push(`- **Friction:** ${friction.join(' · ')}`);
  return lines.join('\n');
}

function summarizeChecks(checks) {
  const groups = new Map();
  for (const c of checks) {
    const label = snippet(c.checkLabel || c.name, 50);
    const g = groups.get(label) || { label, runs: 0, failed: 0, pending: 0 };
    g.runs++;
    if (isFailure(c)) g.failed++;
    if (isPending(c)) g.pending++;
    groups.set(label, g);
  }
  const top = [...groups.values()].sort((a, b) => b.runs - a.runs);
  const shown = top.slice(0, 3).map((g) => {
    const outcomes = [g.failed ? `${g.failed} failed` : '', g.pending ? `${g.pending} pending` : ''].filter(Boolean);
    return `${code(g.label, 50)}${g.runs > 1 ? ` ×${g.runs}` : ''}${outcomes.length ? ` (${outcomes.join(', ')})` : ''}`;
  });
  return `${shown.join(', ')}${top.length > 3 ? ` +${top.length - 3} more` : ''}`;
}

export function displayPath(filePath, cwd) {
  const p = path.normalize(filePath);
  if (cwd) {
    const root = path.normalize(cwd);
    if (p.toLowerCase().startsWith(`${root.toLowerCase()}${path.sep}`)) return p.slice(root.length + 1);
  }
  return tildify(p);
}

function tildify(p) {
  const home = os.homedir();
  return p && p.toLowerCase().startsWith(home.toLowerCase()) ? `~${p.slice(home.length)}` : p;
}

/** Compact, redacted JSON for an optional follow-up review. */
export function buildDigest(a, meta) {
  const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
  const t = a.totals;
  return {
    tool: 'copilot-session-review',
    version: meta.version,
    generatedAt: iso(a.generatedAt),
    scheduled: Boolean(meta.scheduled),
    window: { start: iso(a.window.start), end: iso(a.window.end) },
    spending: a.spending,
    summary: a.summary,
    ...(a.standup ? { standup: a.standup } : {}),
    totals: {
      sessions: t.entries,
      chats: t.chats,
      prompts: t.prompts,
      steering: t.steering,
      promptsFromOtherSessions: t.delegated,
      toolCalls: t.tools,
      toolCallsFailed: t.toolsFailed,
      toolCategories: t.byCategory,
      filesChanged: t.files.length,
      codeFilesChanged: t.codeFiles.length,
      checks: t.checks,
      checksFailed: t.checksFailed,
      checksPending: t.checksPending,
      commits: t.commits,
      pushes: t.pushes,
      tasksCompleted: t.completionsOk,
      subagents: t.subagents,
      skills: t.skills,
      approvalsByYou: t.approvalsHuman,
      cancelledRuns: t.aborts,
      aiErrors: t.errors,
      premiumUnitsEstimate: t.premium,
      vscodeChatCredits: t.credits,
      inputTokens: t.inputTokens,
      outputTokens: t.outputTokens,
      totalTokens: t.inputTokens + t.outputTokens,
      models: t.modelUse,
      modelNames: t.modelNames,
      activeMinutes: Math.round(t.activeMin),
      firstActivity: iso(t.first),
      lastActivity: iso(t.last),
      promptsByHour: t.hourly,
      projects: t.projects,
      maxParallelSessions: t.maxParallel,
    },
    sessions: a.entries.map((e) => ({
      title: snippet(e.title, 120),
      chats: e.chatTitles.map((x) => snippet(x, 120)),
      project: e.project,
      areas: e.areas,
      first: iso(e.first),
      last: iso(e.last),
      activeMinutes: Math.round(e.activeMin),
      prompts: e.prompts.slice(0, 25).map((p) => ({ at: iso(p.ts), chars: p.chars, steering: p.steering, text: snippet(p.text, 300) })),
      promptsOmitted: Math.max(0, e.prompts.length - 25),
      continuedFrom: e.continuedFrom ? snippet(e.continuedFrom, 300) : undefined,
      promptsFromOtherSessions: e.delegated.length,
      completions: e.completions.map((c) => ({ at: iso(c.ts), success: c.success, summary: snippet(c.summary, 700) })),
      filesChanged: e.files.length,
      files: e.files.slice(-25).map((f) => displayPath(f.path, e.cwd)),
      checks: e.checks.slice(-10).map((c) => ({ command: snippet(c.checkLabel || c.name, 100), passed: isPending(c) ? null : !isFailure(c) })),
      checkedAfterLastEdit: e.checkedAfterEdit,
      commits: e.commits,
      pushes: e.pushes,
      toolCalls: e.tools,
      toolCallsFailed: e.toolsFailed,
      topFailures: e.failureGroups.slice(0, 5).map((g) => ({ example: g.example, count: g.count })),
      skills: e.skills,
      subagents: e.subagents.map((s) => s.display || s.name),
      approvalsByYou: e.approvals.human,
      cancelledRuns: e.aborts,
      aiErrors: e.errors.map((x) => snippet(x.message, 160)),
      premiumUnitsEstimate: e.premium,
      models: e.modelUse,
      maxContextTokens: e.maxInputTokens,
    })),
    wentWell: a.good,
    toImprove: a.improve,
    focus: a.focus,
    sources: meta.sources,
  };
}
