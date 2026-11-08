import { isFailure, isPending } from './analyze.mjs';
import { snippet } from './redact.mjs';
import { localDateKey } from './util.mjs';

const START_DATE = '2026-11-02';
const BLOCKED = /\b(?:blocked|blockers?(?=\s*:)|waiting (?:for|on)|cannot proceed|can't proceed|need(?:s)?(?=\s+(?:(?:the )?(?:team|owner)\s+(?:approval|to)\b|access\b|permissions?\b|approvals?\b|test data\b|environment\b|downstream\b)))\b/i;
const CLEARED = /\b(?:no (?:\w+ ){0,4}blockers?|(?:not (?:currently |still |now )?|no longer )blocked|unblocked|(?:fixed|resolved|cleared) (?:the |all )?(?:\w+ ){0,4}blockers?|blockers? (?:(?:is|are|was|were|has been|have been) )?(?:now )?(?:fixed|resolved|cleared))\b/i;
const UNCERTAIN_RESOLUTION = /\b(?:not|never|cannot|unable|neither|may|might|could|should|would|if|unless|whether|unknown|uncertain|unconfirmed|unverified|\w+n't)\b|\bno (?:\w+ ){0,4}blockers? (?:(?:have|has|are|is|were|was) )?(?:been )?(?:verified|confirmed|proven|recorded|reported|identified)\b/i;
const RESOLUTION_REQUEST = /^(?:please )?(?:confirm|verify|check|ensure)\b|\b(?:need to|must) (?:confirm|verify|prove)\b|\b(?:needs?|pending) (?:verification|confirmation|proof)\b/i;
const MISSING_RESOLUTION_EVIDENCE = /\b(?:no|without|lack of) (?:clear |enough |any )?(?:evidence|proof|confirmation)\b/i;
const RESOLUTION_CAVEAT = /^(?:not (?:(?:yet|fully) )?(?:verified|confirmed|proven)|unverified|unconfirmed|pending (?:verification|confirmation|proof)|only if|if|unless)\b|^(?:this|that|it|the resolution|the clearance|the outcome)\b(?=.*\b(?:not|unverified|unconfirmed|uncertain|unknown|cannot|unable|needs?|pending|\w+n't)\b)/i;
const NEGATED_BLOCKED = /\b(?:not (?:currently |still |now )?|no longer )blocked\b/i;
const NEGATED_INDICATOR = /\b(?:not|never|no longer|\w+n't)\s+(?:(?:a|the|be|been|being|have|has|had|is|are|was|were|very|well|just|still|already|now|ever|yet|\w+ly)\s+)*$/i;
const UNCERTAIN_INDICATOR = /\b(?:may|might|could|should|would|possibly|perhaps|if|whether)\b/i;
const UNPROVEN_STATUS = /\b(?:unverified|unconfirmed|not (?:(?:yet|fully) )?(?:verified|confirmed|proven)|(?:not|\w+n't) (?:prove|confirm|verify)|(?:needs?|pending) (?:verification|confirmation|proof))\b/i;
const PENDING_DEPENDENCY = /^(.*?)\s+(?:(?:is|are|remains?)\s+)?(?:still )?(pending|missing|unavailable|unapproved|not ready)\b/i;
const LOCAL_SCOPE = /\b(?:locally|local (?:unit )?(?:testing|tests?|checks?|validation|development|work)|offline|unit tests?|desktop|documentation|readme|dry[- ]run|mock(?:ed)?|fixtures?)\b/i;
// File and path names are not outside dependencies.
const TEAM_DEPENDENCY = /(?<![\w.\x2f\x5c-])(?:team|owner|access|permissions?|approvals?|authentication|credentials?|environments?|test data|downstream|dependenc(?:y|ies)|external|certificates?|vendors?|responses?|confirmations?|decisions?|inputs?|reviews?)(?![\w\x2f\x5c-]|\.\w)/gi;
const DEPENDENCY_PHRASE = /^(?:(?:the|a|an|all|missing|required|pending|unavailable|unapproved|our|safe|necessary|lack of)\s+)*(?<cause>(?:environment )?access|permissions?|approvals?|authentication|credentials?|test data(?: approvals?)?|environments?|downstream|dependenc(?:y|ies)|certificates?|vendors?|(?:external )?(?:team|owner)(?:'s)? (?:approvals?|responses?|confirmations?|decisions?|inputs?|reviews?|to (?:approve|confirm|provide|review))|external(?: (?:team|owner))?)(?![\w\x2f\x5c-]|\.\w)/i;
const CAUSE_PREFIX = /^\s*(?::\s*)?(?:waiting (?:for|on)\s+)?(?:(?:on|by|for|due to|because of|without|until)\s+)?/i;

export function standupBusinessDay(now) {
  const day = new Date(now);
  if (!Number.isFinite(day.getTime())) throw new RangeError('Standup needs a valid report date');
  if (localDateKey(day) < START_DATE) return null;
  day.setHours(0, 0, 0, 0);
  do {
    day.setDate(day.getDate() - 1);
  } while (day.getDay() === 0 || day.getDay() === 6);
  const next = new Date(day);
  next.setDate(next.getDate() + 1);
  return { date: localDateKey(day), start: day.getTime(), end: next.getTime() - 1 };
}

function plain(summary) {
  return String(summary).replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, '').replace(/[*`]/g, '').replace(/\u2019/g, "'");
}

function dependencyNames(text) {
  return [...new Set((text.match(TEAM_DEPENDENCY) || []).map((name) =>
    name.toLowerCase().replace(/^(permission|approval|credential|environment|certificate|vendor|response|confirmation|decision|input|review)s$/, '$1').replace(/^dependencies$/, 'dependency'),
  ))];
}

function outsideDependency(text) {
  const phrase = DEPENDENCY_PHRASE.exec(text.trim());
  if (!phrase) return null;
  const id = phrase.groups.cause.toLowerCase().replace(/^environment access$/, 'access').replace(/^external /, '')
    .replace(/\b(permission|approval|credential|environment|certificate|vendor|response|confirmation|decision|input|review)s\b/g, '$1')
    .replace(/^dependencies$/, 'dependency').replace(/^(team|owner)'s /, '$1 ')
    .replace(/^(team|owner) to approve$/, '$1 approval').replace(/^(team|owner) to confirm$/, '$1 confirmation')
    .replace(/^(team|owner) to provide$/, '$1 input').replace(/^(team|owner) to review$/, '$1 review');
  return { id, names: dependencyNames(id) };
}

function outsideDependencyNames(text) {
  return outsideDependency(text)?.names || [];
}

function dependencyList(text) {
  return text.split(/,\s*(?:and\s+)?|\s+and\s+/i).map((part) => part.trim()).filter(Boolean);
}

function hasStatus(text) {
  return BLOCKED.test(text) || CLEARED.test(text) || PENDING_DEPENDENCY.test(text) ||
    /\b(?:is|are|was|were|has|have|remains?)\b/i.test(text);
}

function splitStatuses(sentence) {
  const parts = [];
  for (const part of sentence.split(/,\s*/)) {
    const previous = parts.at(-1);
    const nounSubject = previous && !hasStatus(previous) && outsideDependencyNames(previous).length;
    if (previous && !(hasStatus(part) && (hasStatus(previous) || !nounSubject))) {
      parts[parts.length - 1] += `, ${part}`;
    } else {
      parts.push(part.replace(/^(?:and|but|however|yet)\s+/i, ''));
    }
  }
  return parts;
}

function blockerLines(summary) {
  const sentences = plain(summary).split(/\r?\n|(?<=[.!?])\s+|;\s*/i)
    .map((line) => line.trim().replace(/^(?:[-+>]\s+|\d+[.)]\s+)/, '')).filter(Boolean).flatMap(splitStatuses);
  const clauses = [];
  for (const sentence of sentences) {
    const parts = sentence.split(/,?\s+\b(and|but|however|yet|only(?=\s+(?:not\s+)?(?:blocked|waiting (?:for|on)|needs?|cannot proceed|can't proceed)))\b\s+/i);
    for (let i = 0; i < parts.length; i += 2) {
      const part = parts[i].trim();
      if (!part) continue;
      const previous = clauses.at(-1);
      const caveat = previous && hasStatus(previous) && RESOLUTION_CAVEAT.test(part);
      const nounSubject = i > 0 && previous && !BLOCKED.test(previous) && !CLEARED.test(previous) && outsideDependencyNames(previous).length;
      const separateStatus = hasStatus(part);
      if (caveat) {
        clauses[clauses.length - 1] += i > 0 ? ` ${parts[i - 1]} ${part}` : ` ${part}`;
      } else if (i > 0 && previous && outsideDependencyNames(part).length && (nounSubject || !separateStatus)) {
        clauses[clauses.length - 1] += ` and ${part}`;
      } else {
        clauses.push(part);
      }
    }
  }
  return clauses;
}

function wholeTopicCleared(line, count) {
  const status = line.replace(/[.!]$/, '').trim();
  return /^(?:there (?:is|are) )?no (?:team |remaining |open |current )?blockers?(?: (?:remain|left)(?: now| today)?)?$/i.test(status) ||
    /^(?:(?:we|i|it|this task|the task|this topic|the work) (?:are|am|is) )?(?:unblocked|not (?:currently |still |now )?blocked|no longer blocked)(?: now| today)?$/i.test(status) ||
    /^(?:(?:we|i|the team) (?:(?:have|has) )?)?(?:fixed|resolved|cleared) all (?:team )?blockers?$/i.test(status) ||
    /^(?:all |the )?(?:team )?blockers (?:(?:are|were|have been) )?(?:now )?(?:fixed|resolved|cleared)$/i.test(status) ||
    (count <= 1 && (
      /^(?:(?:we|i|the team) (?:(?:have|has) )?)?(?:fixed|resolved|cleared) (?:the )?blocker$/i.test(status) ||
      /^(?:the )?blocker (?:(?:is|was|has been) )?(?:now )?(?:fixed|resolved|cleared)$/i.test(status)
    ));
}

function resolutionDependencies(line, resolution) {
  let reference;
  if (/^(?:fixed|resolved|cleared)\b/i.test(resolution[0])) {
    reference = resolution[0].replace(/^(?:fixed|resolved|cleared)\s+/i, '').replace(/\s+blockers?$/i, '');
  } else if (/^blockers?\b/i.test(resolution[0])) {
    reference = line.slice(0, resolution.index).trim();
  } else if (/^no\b.*\bblockers?$/i.test(resolution[0])) {
    reference = resolution[0].replace(/^no\s+/i, '').replace(/\s*blockers?$/i, '');
  } else {
    const after = line.slice(resolution.index + resolution[0].length).replace(CAUSE_PREFIX, '').trim();
    reference = after || line.slice(0, resolution.index).replace(/\b(?:is|are|was|were|am)\s*$/i, '').trim();
  }
  return dependencyList(reference).map((part) => {
    const dependency = outsideDependency(part);
    if (dependency) return { ...dependency, all: /\ball\b/i.test(part), generic: false };
    const role = /^(?:(?:the|all) )?(team|owner|input|response|confirmation|decision)$/i.exec(part.trim());
    return role ? { id: role[1].toLowerCase(), names: dependencyNames(role[1]), all: /\ball\b/i.test(part), generic: true } : null;
  }).filter(Boolean);
}

function executionScope(line, indicatorAt) {
  if (/\blocally\b|\b(?:for|in|during) (?:the )?local (?:testing|tests?|checks?|validation|development|work)\b/i.test(line)) return 'local';
  const before = line.slice(0, indicatorAt);
  if (/\b(?:live|remote|integration|end-to-end)\b/i.test(before)) return 'topic';
  return /\blocal\b/i.test(before) || LOCAL_SCOPE.test(line) ? 'local' : 'topic';
}

function recordDependency(pending, detail, dependency, scope, ts) {
  const id = dependency?.id || `local:${detail.toLowerCase()}`;
  const item = { id, scope, detail, dependencies: dependency?.names || [], ts };
  return [...pending.filter((known) => known.id !== id || known.scope !== scope), item];
}

function clearDependencies(pending, references, localOnly) {
  const candidates = pending.filter((item) => !localOnly || item.scope === 'local');
  const cleared = new Set();
  for (const dependency of references) {
    const exact = candidates.filter((item) => item.id === dependency.id);
    const named = candidates.filter((item) => dependency.names.every((name) => item.dependencies.includes(name)));
    const matches = dependency.all || dependency.generic ? named : exact.length ? exact : named;
    const distinct = new Set(matches.map((item) => item.id));
    if (distinct.size <= 1 || dependency.all) {
      for (const item of matches) cleared.add(item);
    }
  }
  return pending.filter((item) => !cleared.has(item));
}

function remainingBlockers(completions) {
  let pending = [];
  for (const completion of completions) {
    for (const line of blockerLines(completion.summary)) {
      if (line.includes('?')) continue;
      const resolution = CLEARED.exec(line);
      if (resolution) {
        if (!UNCERTAIN_RESOLUTION.test(line.replace(NEGATED_BLOCKED, 'unblocked')) &&
          !RESOLUTION_REQUEST.test(line) && !MISSING_RESOLUTION_EVIDENCE.test(line)) {
          if (wholeTopicCleared(line, pending.length)) {
            pending = [];
          } else {
            pending = clearDependencies(pending, resolutionDependencies(line, resolution), executionScope(line, resolution.index) === 'local');
          }
          continue;
        }
      }
      const blocked = BLOCKED.exec(line);
      if (!blocked) {
        const waiting = PENDING_DEPENDENCY.exec(line);
        if (waiting) {
          const subjects = dependencyList(waiting[1]);
          const scope = executionScope(line, waiting[1].length);
          for (const subject of subjects) {
            const dependency = outsideDependency(subject);
            if (!dependency) continue;
            const detail = snippet(subjects.length === 1 ? line : `${subject.trim()}: ${waiting[2]}.`, 360);
            const exact = pending.some((item) => item.id === dependency.id && item.scope === scope);
            const matches = !exact && subjects.length === 1 && dependency.names.length === 1 ?
              pending.filter((item) => item.scope === scope && dependency.names.every((name) => item.dependencies.includes(name))) : [];
            pending = matches.length ? pending.map((item) => matches.includes(item) ? {
              ...item, detail: snippet(`${item.detail} ${detail}`, 360), ts: completion.ts,
            } : item) : recordDependency(pending, detail, dependency, scope, completion.ts);
          }
        }
        continue;
      }
      const before = line.slice(0, blocked.index);
      const modality = before.replace(/\bcould(?: not|n't)\s+(?:proceed|run|execute|continue|test|get|obtain|receive|secure)\b/gi, 'failed');
      if (NEGATED_BLOCKED.test(line) || UNCERTAIN_INDICATOR.test(modality) ||
        UNPROVEN_STATUS.test(line) || RESOLUTION_REQUEST.test(line) || MISSING_RESOLUTION_EVIDENCE.test(line)) continue;
      const negated = NEGATED_INDICATOR.exec(before);
      const remainder = line.slice(blocked.index + blocked[0].length);
      const prefixLength = CAUSE_PREFIX.exec(remainder)[0].length;
      const prefix = line.slice(0, blocked.index + blocked[0].length + prefixLength);
      const reasons = dependencyList(remainder.slice(prefixLength));
      if (negated) {
        const claim = line.slice(0, negated.index) + line.slice(blocked.index);
        if (!UNCERTAIN_RESOLUTION.test(claim)) {
          const references = reasons.map(outsideDependency).filter(Boolean);
          pending = clearDependencies(pending, references, executionScope(line, blocked.index) === 'local');
        }
        continue;
      }
      for (const reason of reasons) {
        const detail = snippet(reasons.length === 1 ? line : `${prefix}${reason}`, 360);
        pending = recordDependency(pending, detail, outsideDependency(reason), executionScope(line, blocked.index), completion.ts);
      }
    }
  }
  return pending;
}

function groupTopics(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const title = entry.title.replace(/\s*[-\u2013\u2014]\s*continued\b.*$/i, '').trim();
    const key = `${entry.cwd || entry.project || entry.key}\0${title}`.toLowerCase();
    if (!groups.has(key)) groups.set(key, { title: snippet(title, 120), project: snippet(entry.project || 'Other work', 80), entries: [] });
    groups.get(key).entries.push(entry);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    last: group.entries.reduce((last, entry) => Math.max(last, entry.last), 0),
    completions: group.entries.flatMap((entry) => entry.completions).filter((c) => c.summary.trim()).sort((a, b) => a.ts - b.ts),
    checks: group.entries.flatMap((entry) => entry.checks).sort((a, b) => (a.endTs ?? a.ts) - (b.endTs ?? b.ts)),
  })).sort((a, b) => b.last - a.last);
}

/** Use the business day's evidence for work, and later outcomes for current blockers. */
export function buildStandup(context, daily, businessDay, { unreadable = 0 } = {}) {
  const topics = groupTopics(context.entries);
  const inside = (ts) => ts >= businessDay.start && ts <= businessDay.end;
  const work = [];
  const blockers = [];
  const focus = [];
  const suggest = (text) => {
    const safe = snippet(text, 300);
    if (focus.length < 3 && !focus.includes(safe)) focus.push(safe);
  };

  for (const topic of topics) {
    const activity = topic.entries.flatMap((entry) => [
      ...entry.prompts.map((p) => p.ts),
      ...entry.delegated.map((p) => p.ts),
      ...entry.completions.map((c) => c.ts),
      ...entry.files.map((f) => f.ts),
      ...entry.toolTimestamps,
    ]).filter(inside);
    if (activity.length) {
      const outcome = topic.completions.filter((c) => inside(c.ts)).at(-1);
      work.push({
        project: topic.project,
        title: topic.title,
        summary: outcome ? snippet(outcome.summary, 360) : 'Worked on this topic. No final outcome was recorded that day.',
        recordedAt: new Date(activity.reduce((last, ts) => Math.max(last, ts), 0)).toISOString(),
      });
    }

    const pending = remainingBlockers(topic.completions).filter((item) => item.dependencies.length);
    if (pending.length) blockers.push({
      project: topic.project,
      title: topic.title,
      detail: snippet(pending.map((item) => item.detail).join(' '), 360),
      recordedAt: new Date(pending.reduce((latest, item) => Math.max(latest, item.ts), 0)).toISOString(),
    });
  }

  for (const blocker of blockers) suggest(`Ask the team about ${blocker.title} (${blocker.project}): ${blocker.detail}`);
  for (const topic of topics) {
    const completion = topic.completions.at(-1);
    const check = topic.checks.at(-1);
    const label = `${topic.title} (${topic.project})`;
    if (check && (!completion || (check.endTs ?? check.ts) > completion.ts) && isPending(check)) {
      suggest(`Finish the recorded check for ${label} and save its result.`);
    } else if (check && (!completion || (check.endTs ?? check.ts) > completion.ts) && isFailure(check)) {
      suggest(`Check the latest failed validation for ${label} before continuing.`);
    } else if (completion && remainingBlockers([completion]).length) {
      suggest(`Confirm what is needed to unblock ${label} before continuing.`);
    } else if (!completion || !completion.success) {
      suggest(`Review the next safe step for ${label}, then record the outcome and relevant checks.`);
    }
  }
  for (const finding of daily.improve) suggest(finding.action);
  if (!focus.length) suggest("Choose today's main task and the checks that will prove it is done.");

  work.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  return {
    date: localDateKey(daily.window.end),
    previousBusinessDay: { date: businessDay.date, start: new Date(businessDay.start).toISOString(), end: new Date(businessDay.end).toISOString() },
    work: work.slice(0, 6),
    workOmitted: Math.max(0, work.length - 6),
    focus,
    blockers,
    historyIncomplete: unreadable > 0,
  };
}
