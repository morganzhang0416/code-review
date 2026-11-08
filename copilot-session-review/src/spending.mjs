import { localDateKey } from './util.mjs';

export function recordedUsage(usage, ts) {
  const id = usage?.accounting?.usageId;
  const usageId = typeof id === 'string' && id.trim() ? id.trim() : null;
  const partial = usage?.aiCreditsStatus !== 'complete';
  const amount = usage?.copilotUsage?.totalNanoAiu;
  if (amount == null) return { ts, usageId, totalNanoAiu: null, partial, issue: 'missingAmounts' };
  const valid = (typeof amount === 'number' && Number.isSafeInteger(amount) && amount >= 0)
    || (typeof amount === 'string' && /^\d+$/.test(amount) && Number.isFinite(Number(amount)));
  if (!valid) return { ts, usageId, totalNanoAiu: null, partial, issue: 'invalidAmounts' };
  return { ts, usageId, totalNanoAiu: BigInt(amount).toString(), partial, issue: null };
}

function tally() {
  return {
    nanoAiu: 0n,
    usageRecords: 0,
    recordedCalls: 0,
    duplicatesRemoved: 0,
    unpricedCalls: 0,
    missingAmounts: 0,
    invalidAmounts: 0,
    partialAmounts: 0,
    missingUsageIds: 0,
    conflictingUsageIds: 0,
    unsupportedRequests: 0,
    activeChatsWithoutUsage: 0,
  };
}

function localDays(window) {
  const date = new Date(window.start);
  date.setHours(0, 0, 0, 0);
  const days = [];
  while (date.getTime() <= window.end) {
    const start = date.getTime();
    date.setDate(date.getDate() + 1);
    const end = date.getTime();
    days.push({
      date: localDateKey(start),
      partialDay: window.start > start || window.end < end - 1,
      window: {
        start: new Date(Math.max(start, window.start)).toISOString(),
        end: new Date(Math.min(end - 1, window.end)).toISOString(),
      },
      counts: tally(),
    });
  }
  return days;
}

function finish(counts, sourceIncomplete) {
  const { nanoAiu, ...rest } = counts;
  const hasAmounts = counts.recordedCalls > 0;
  const incomplete = sourceIncomplete || counts.unpricedCalls > 0 || counts.partialAmounts > 0
    || counts.unsupportedRequests > 0 || counts.activeChatsWithoutUsage > 0;
  const aiCredits = hasAmounts ? Number(nanoAiu) / 1e9 : null;
  return {
    status: hasAmounts ? (incomplete ? 'partial' : 'complete') : 'unavailable',
    totalNanoAiu: hasAmounts ? nanoAiu.toString() : null,
    aiCredits,
    usdEquivalent: aiCredits == null ? null : aiCredits / 100,
    ...rest,
  };
}

export function summarizeSpending(chats, { window, sourceStats = {} }) {
  const inWindow = (ts) => Number.isFinite(ts) && ts >= window.start && ts <= window.end;
  const records = chats.flatMap((c) => c.spendingRecords || []).filter((r) => inWindow(r.ts));
  const days = localDays(window);
  const byDay = new Map(days.map((d) => [d.date, d.counts]));
  const total = tally();
  const add = (ts, field, value = 1) => {
    total[field] += value;
    byDay.get(localDateKey(ts))[field] += value;
  };
  const groups = new Map();
  for (const record of records) {
    if (record.unsupported) {
      add(record.ts, 'unsupportedRequests');
      continue;
    }
    add(record.ts, 'usageRecords');
    if (!record.usageId) {
      add(record.ts, 'missingUsageIds');
      add(record.ts, 'unpricedCalls');
      if (record.issue) add(record.ts, record.issue);
      continue;
    }
    if (!groups.has(record.usageId)) groups.set(record.usageId, []);
    groups.get(record.usageId).push(record);
  }
  for (const group of groups.values()) {
    const ts = Math.min(...group.map((r) => r.ts));
    add(ts, 'duplicatesRemoved', group.length - 1);
    const complete = group.filter((r) => !r.partial && r.totalNanoAiu != null);
    const candidates = complete.length ? complete : group;
    const amounts = new Set(candidates.map((r) => r.totalNanoAiu).filter((n) => n != null));
    if (amounts.size === 1) {
      const amount = BigInt([...amounts][0]);
      total.nanoAiu += amount;
      byDay.get(localDateKey(ts)).nanoAiu += amount;
      add(ts, 'recordedCalls');
      if (!complete.length) add(ts, 'partialAmounts');
    } else {
      add(ts, 'unpricedCalls');
      add(ts, amounts.size > 1 ? 'conflictingUsageIds'
        : group.some((r) => r.issue === 'invalidAmounts') ? 'invalidAmounts' : 'missingAmounts');
    }
  }
  for (const chat of chats) {
    if (chat.source !== 'agents') continue;
    const pricedDates = new Set((chat.spendingRecords || []).filter((r) => inWindow(r.ts)).map((r) => localDateKey(r.ts)));
    const dates = new Set(chat.timestamps.filter((ts) => inWindow(ts) && !pricedDates.has(localDateKey(ts))).map(localDateKey));
    if (!dates.size) continue;
    total.activeChatsWithoutUsage++;
    for (const date of dates) byDay.get(date).activeChatsWithoutUsage++;
  }
  const sources = Object.values(sourceStats);
  const sourceIssues = {
    unreadableSources: sources.reduce((n, s) => n + (s.unreadable || 0), 0),
    unavailableSources: sources.filter((s) => s.unavailable).length,
    incompleteLines: sources.reduce((n, s) => n + (s.incompleteLines || 0), 0),
    untimedUsageRecords: sources.reduce((n, s) => n + (s.untimedUsageRecords || 0), 0),
  };
  const sourceIncomplete = Object.values(sourceIssues).some((n) => n > 0);
  const result = finish(total, sourceIncomplete);
  const warnings = [
    'Saved local usage on this PC only, not an account-wide invoice. Other devices, deleted history and calls without saved usage can be missing.',
    'USD equivalent is AI credits divided by 100. It does not mean an extra bill after plan allowances.',
  ];
  if (!result.recordedCalls) warnings.push('Actual spending is not available: no complete, safely deduplicated credit amounts were recorded in this window.');
  if (result.missingAmounts) warnings.push(`${result.missingAmounts} usage calls have no recorded credit amount. They are not treated as zero.`);
  if (result.invalidAmounts) warnings.push(`${result.invalidAmounts} usage calls have invalid credit amounts and were excluded.`);
  if (result.partialAmounts) warnings.push(`${result.partialAmounts} recorded credit amounts have incomplete or unknown aiCreditsStatus. Totals are recorded subtotals, not confirmed full spending.`);
  if (result.missingUsageIds) warnings.push(`${result.missingUsageIds} usage records have no accounting.usageId and were excluded because they cannot be safely deduplicated.`);
  if (result.conflictingUsageIds) warnings.push(`${result.conflictingUsageIds} usage IDs have conflicting credit amounts; those calls were excluded.`);
  if (result.unsupportedRequests) warnings.push(`${result.unsupportedRequests} classic VS Code requests have no supported per-call nano-AIU record. Their actual spending is unknown; legacy chat credits stay separate.`);
  if (result.activeChatsWithoutUsage) warnings.push(`${result.activeChatsWithoutUsage} active Agents/CLI chats have local days without usage records in this window. Spending on those days cannot be confirmed.`);
  if (sourceIssues.unreadableSources || sourceIssues.unavailableSources) warnings.push('Some local history could not be read or was unavailable. Recorded totals may be incomplete.');
  if (sourceIssues.incompleteLines || sourceIssues.untimedUsageRecords) warnings.push('Some local history lines were invalid, unfinished or had usage without a valid timestamp. Recorded totals may be incomplete.');
  return {
    scope: 'saved-local-copilot-usage',
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    windowBoundaries: 'inclusive',
    currency: 'USD',
    ...result,
    sourceIssues,
    days: days.map(({ counts, ...day }) => ({ ...day, ...finish(counts, sourceIncomplete) })),
    warnings,
  };
}

export function formatSpendingAmount(totalNanoAiu, nanoAiuPerUnit) {
  if (totalNanoAiu == null) return 'Not available';
  const cents = (BigInt(totalNanoAiu) * 100n + nanoAiuPerUnit / 2n) / nanoAiuPerUnit;
  return `${(cents / 100n).toLocaleString('en-NZ')}.${String(cents % 100n).padStart(2, '0')}`;
}
