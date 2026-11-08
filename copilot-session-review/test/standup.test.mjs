import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyze } from '../src/analyze.mjs';
import { newChat } from '../src/collect/common.mjs';
import { buildDigest, renderMarkdown } from '../src/report.mjs';
import { buildStandup, standupBusinessDay } from '../src/standup.mjs';

const now = () => new Date(2026, 10, 2, 19, 0);
const friday = (hour = 12) => new Date(2026, 9, 30, hour, 0).getTime();
const monday = (hour = 12) => new Date(2026, 10, 2, hour, 0).getTime();
const meta = { version: 'test', scheduled: true, sources: {} };

function chat(id, title, { source = 'agents', cwd = 'C:\\Work\\proj' } = {}) {
  const value = newChat({ id, source, title, cwd });
  value.prompts.push({ ts: friday(), text: `Work on ${title}`, chars: 20, steering: false, attachments: 0 });
  value.timestamps.push(friday());
  return value;
}

function complete(value, ts, summary, success = true) {
  value.completions.push({ ts, summary, success });
  value.timestamps.push(ts);
}

function standup(chats, options) {
  const businessDay = standupBusinessDay(now());
  const context = analyze(chats, { window: { start: businessDay.start, end: now().getTime() } });
  const daily = analyze([], { window: { start: monday(0), end: now().getTime() } });
  return { daily, value: buildStandup(context, daily, businessDay, options) };
}

test('standup starts tomorrow and uses the full previous Monday-Friday day', () => {
  assert.equal(standupBusinessDay(new Date(2026, 10, 1, 23, 59, 59, 999)), null);
  const day = standupBusinessDay(new Date(2026, 10, 2, 0));
  assert.equal(day.date, '2026-10-30');
  assert.equal(day.start, new Date(2026, 9, 30, 0).getTime());
  assert.equal(day.end, new Date(2026, 9, 30, 23, 59, 59, 999).getTime());
  assert.equal(standupBusinessDay(new Date(2026, 10, 3)).date, '2026-11-02');
  assert.equal(standupBusinessDay(new Date(2026, 10, 7)).date, '2026-11-06');
  assert.equal(standupBusinessDay(new Date(2026, 10, 8)).date, '2026-11-06');
  assert.throws(() => standupBusinessDay(new Date('invalid')), /valid report date/);
});

test('business-day boundaries follow the local calendar across daylight saving', () => {
  const saved = process.env.TZ;
  try {
    process.env.TZ = 'Pacific/Auckland';
    const day = standupBusinessDay(new Date(2027, 3, 5, 0, 15));
    assert.equal(day.date, '2027-04-02');
    assert.equal(new Date(day.start).toISOString(), '2027-04-01T11:00:00.000Z');
    assert.equal(new Date(day.end).toISOString(), '2027-04-02T10:59:59.999Z');
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
});

test('work uses Friday outcomes, not a newer Monday outcome or weekend-only work', () => {
  const task = chat('work', 'Withdrawal tests');
  complete(task, friday(15), 'Added offline tests. Live outcome is not verified.');
  complete(task, monday(14), 'Monday checks passed.');
  const weekend = chat('weekend', 'Weekend task');
  weekend.prompts[0].ts = new Date(2026, 10, 1, 12).getTime();
  weekend.timestamps = [weekend.prompts[0].ts];
  const { value } = standup([task, weekend]);
  assert.equal(value.date, '2026-11-02');
  assert.equal(value.work.length, 1);
  assert.match(value.work[0].summary, /Added offline tests/);
  assert.doesNotMatch(value.work[0].summary, /Monday checks/);
});

test('read-only tool work and classic chats without completion summaries are included', () => {
  const classic = chat('classic', 'Classic investigation', { source: 'vscode-chat' });
  const toolsOnly = newChat({ id: 'tools', source: 'agents', title: 'Read-only investigation', cwd: 'C:\\Work\\proj' });
  toolsOnly.toolCalls.push({ id: 'read', ts: friday(), endTs: friday(), name: 'view', category: 'read', ok: true });
  toolsOnly.timestamps.push(friday());
  const { value } = standup([classic, toolsOnly]);
  assert.equal(value.work.length, 2);
  assert.ok(value.work.every((item) => /No final outcome/.test(item.summary)));
  assert.equal(value.blockers.length, 0);
});

test('team blockers need evidence and a later partial success does not clear them', () => {
  const task = chat('blocked', 'Live test');
  complete(task, friday(15), 'Blocked on test data approval. The team needs to confirm safe downstream connections.');
  complete(task, monday(14), 'Offline checks passed. Live execution is not verified.');
  const { value } = standup([task]);
  assert.equal(value.blockers.length, 1);
  assert.match(value.blockers[0].detail, /test data approval/);
  assert.equal(value.blockers[0].recordedAt, new Date(friday(15)).toISOString());
  assert.match(value.focus[0], /Ask the team/);
  assert.ok(value.focus.length <= 3);
});

test('mixed resolutions keep the remaining blocker in either clause order', () => {
  for (const summary of [
    'The access blocker is resolved, but live testing is still blocked on test data approval.',
    'Live testing is still blocked on test data approval, but the access blocker is resolved.',
  ]) {
    const task = chat('mixed', 'Live test');
    complete(task, friday(15), 'Blocked on environment access.');
    complete(task, monday(14), summary);
    const { value } = standup([task]);
    assert.equal(value.blockers.length, 1, summary);
    assert.match(value.blockers[0].detail, /test data approval/);
    assert.doesNotMatch(value.blockers[0].detail, /access/);
    assert.equal(value.blockers[0].recordedAt, new Date(monday(14)).toISOString());
    assert.match(value.focus[0], /Ask the team.*test data approval/);
  }
});

test('negated or uncertain clearance does not erase a recorded blocker', () => {
  for (const summary of [
    'This does not prove there are no blockers.',
    'This does not prove we are not blocked on access.',
    'The access blocker might be resolved.',
    'We have not fixed the access blocker.',
    "We haven't fixed the access blocker.",
    'Are there no blockers?',
    'No blockers have been verified.',
  ]) {
    const task = chat('uncertain', 'Live test');
    complete(task, friday(15), 'Blocked on environment access.');
    complete(task, monday(14), summary);
    const { value } = standup([task]);
    assert.equal(value.blockers.length, 1, summary);
    assert.match(value.blockers[0].detail, /environment access/);
    assert.equal(value.blockers[0].recordedAt, new Date(friday(15)).toISOString());
  }
});

test('resolving one dependency keeps a different recorded dependency', () => {
  const task = chat('dependencies', 'Live test');
  complete(task, friday(15), 'Blocked on environment access. Need owner approval.');
  complete(task, monday(14), 'The access blocker is resolved.');
  const { value } = standup([task]);
  assert.equal(value.blockers.length, 1);
  assert.match(value.blockers[0].detail, /owner approval/);
  assert.doesNotMatch(value.blockers[0].detail, /environment access/);
  assert.equal(value.blockers[0].recordedAt, new Date(friday(15)).toISOString());
});

test('past-tense blockers stay open without actual resolution evidence', () => {
  for (const summary of [
    'Execution was blocked by missing owner approval. Approval is still pending.',
    'Previously blocked on owner approval. Approval is still pending.',
  ]) {
    const task = chat('past', 'Live test');
    complete(task, friday(15), summary);
    const { value } = standup([task]);
    assert.equal(value.blockers.length, 1, summary);
    assert.match(value.blockers[0].detail, /owner approval/);
    assert.match(value.focus[0], /Ask the team/);
  }
});

test('a recorded resolution clears a past-tense blocker in the same outcome', () => {
  const task = chat('past-fixed', 'Live test');
  complete(task, friday(15), 'Execution was blocked by missing owner approval. Fixed the owner approval blocker.');
  const { value } = standup([task]);
  assert.equal(value.blockers.length, 0);
  assert.ok(value.focus.every((item) => !/unblock|Ask the team/.test(item)));
});

test('unrelated team or owner wording does not turn a local error into a team blocker', () => {
  for (const summary of [
    'Local unit tests are blocked by a syntax error. The team README was updated.',
    'Local unit tests are blocked by a syntax error. The owner README was updated.',
    'The team unit tests are blocked by a syntax error.',
    'Need team README changes.',
  ]) {
    const task = chat('local-wording', 'Local unit tests');
    complete(task, friday(15), summary);
    const { value } = standup([task]);
    assert.equal(value.blockers.length, 0, summary);
    assert.ok(value.focus.every((item) => !/Ask the team/.test(item)), summary);
  }
});

test('team evidence uses the blocked cause without borrowing an unrelated sentence', () => {
  const task = chat('cause', 'Live test');
  complete(task, friday(15), 'The local tests are blocked by missing access. The team README was updated.');
  const { value } = standup([task]);
  assert.equal(value.blockers.length, 1);
  assert.match(value.blockers[0].detail, /missing access/);
  assert.doesNotMatch(value.blockers[0].detail, /README/);
});

test('fixing a local blocker does not clear an outside dependency', () => {
  const task = chat('local-fixed', 'Live test');
  complete(task, friday(15), 'Blocked on owner approval.');
  complete(task, monday(14), 'The local syntax blocker is resolved. The team README was updated.');
  const { value } = standup([task]);
  assert.equal(value.blockers.length, 1);
  assert.match(value.blockers[0].detail, /owner approval/);
});

test('a partial resolution keeps another dependency from the same blocked clause', () => {
  const task = chat('combined', 'Live test');
  complete(task, friday(15), 'Blocked on environment access and owner approval.');
  complete(task, monday(14), 'The access blocker is resolved.');
  const { value } = standup([task]);
  assert.equal(value.blockers.length, 1);
  assert.match(value.blockers[0].detail, /owner approval/);
  assert.doesNotMatch(value.blockers[0].detail, /access/);
});

test('a narrow local not-blocked status does not clear a team dependency', () => {
  for (const summary of [
    'Local unit tests are not blocked.',
    'Local unit tests are no longer blocked.',
    'The local tests are unblocked.',
  ]) {
    const task = chat('narrow', 'Live test');
    complete(task, friday(15), 'Blocked on owner approval.');
    complete(task, monday(14), summary);
    const { value } = standup([task]);
    assert.equal(value.blockers.length, 1, summary);
    assert.match(value.blockers[0].detail, /owner approval/);
  }
});

test('independent and clauses keep new blockers in either order', () => {
  for (const summary of [
    'Fixed the access blocker, and live testing is still blocked on test data approval.',
    'Fixed the access blocker and live testing is still blocked on test data approval.',
    'Live testing is still blocked on test data approval, and the access blocker is resolved.',
    'Live testing is still blocked on test data approval and the access blocker is resolved.',
  ]) {
    const task = chat('and-clauses', 'Live test');
    complete(task, friday(15), 'Blocked on environment access.');
    complete(task, monday(14), summary);
    const { value } = standup([task]);
    assert.equal(value.blockers.length, 1, summary);
    assert.match(value.blockers[0].detail, /test data approval/);
    assert.doesNotMatch(value.blockers[0].detail, /access/);
    assert.match(value.focus[0], /Ask the team/);
  }
});

test('same-sentence updates and file names are not outside dependencies', () => {
  for (const summary of [
    'Local unit tests are blocked by a syntax error, and the team README was updated.',
    'Local unit tests are blocked by a syntax error and the team README was updated.',
    'Local unit tests are blocked by a syntax error in owner.mjs.',
    'Local unit tests are blocked by a syntax error in team.mjs.',
    'Local unit tests are blocked by a syntax error in access.mjs.',
    'Local unit tests are blocked by a syntax error in C:\\Work\\owner.mjs.',
    'Local unit tests are blocked by a syntax error in the owner code.',
  ]) {
    const task = chat('file-words', 'Local unit tests');
    complete(task, friday(15), summary);
    const { value } = standup([task]);
    assert.equal(value.blockers.length, 0, summary);
    assert.ok(value.focus.every((item) => !/Ask the team/.test(item)), summary);
  }
});

test('inability to confirm is not affirmative clearance evidence', () => {
  for (const summary of [
    'Cannot confirm there are no blockers.',
    "Can't confirm there are no blockers.",
    'Unable to confirm there are no blockers.',
    'I cannot confirm that the access blocker is resolved.',
    'I cannot confirm live execution is no longer blocked on access.',
    'No evidence that we fixed the access blocker.',
    'Please confirm that we fixed the access blocker.',
    'We still need to confirm that we fixed the access blocker.',
  ]) {
    const task = chat('cannot-confirm', 'Live test');
    complete(task, friday(15), 'Blocked on environment access.');
    complete(task, monday(14), summary);
    const { value } = standup([task]);
    assert.equal(value.blockers.length, 1, summary);
    assert.match(value.blockers[0].detail, /environment access/);
    assert.equal(value.blockers[0].recordedAt, new Date(friday(15)).toISOString());
  }
});

test('no longer blocked clears a genuinely resolved dependency', () => {
  const task = chat('no-longer', 'Live test');
  complete(task, friday(15), 'Blocked on owner approval.');
  complete(task, monday(14), 'Live execution is no longer blocked on owner approval.');
  const { value } = standup([task]);
  assert.equal(value.blockers.length, 0);
  assert.ok(value.focus.every((item) => !/unblock|Ask the team/.test(item)));
});

test('no longer blocked on one dependency keeps another dependency', () => {
  const task = chat('no-longer-scoped', 'Live test');
  complete(task, friday(15), 'Blocked on owner approval and test data approval.');
  complete(task, monday(14), 'Live execution is no longer blocked on owner approval.');
  const { value } = standup([task]);
  assert.equal(value.blockers.length, 1);
  assert.match(value.blockers[0].detail, /test data approval/);
  assert.doesNotMatch(value.blockers[0].detail, /owner approval/);
});

test('a separate pending dependency survives another dependency resolution', () => {
  const task = chat('pending-dependency', 'Live test');
  complete(task, friday(15), 'Blocked on environment access.');
  complete(task, monday(14), 'The access blocker is resolved, and owner approval is still pending.');
  const { value } = standup([task]);
  assert.equal(value.blockers.length, 1);
  assert.match(value.blockers[0].detail, /owner approval/);
  assert.doesNotMatch(value.blockers[0].detail, /access/);
  assert.equal(value.blockers[0].recordedAt, new Date(monday(14)).toISOString());
});

test('a resolution can name multiple dependencies without clearing others', () => {
  for (const summary of [
    'Fixed the access and owner approval blockers.',
    'The access and owner approval blockers are resolved.',
  ]) {
    const task = chat('multiple-resolutions', 'Live test');
    complete(task, friday(15), 'Blocked on environment access and owner approval and test data.');
    complete(task, monday(14), summary);
    const { value } = standup([task]);
    assert.equal(value.blockers.length, 1, summary);
    assert.match(value.blockers[0].detail, /test data/);
    assert.doesNotMatch(value.blockers[0].detail, /access|owner approval/);
  }
});

test('clear whole-topic outcomes clear all recorded dependencies', () => {
  for (const summary of [
    'No blockers remain.',
    'There are no team blockers.',
    'All blockers are resolved.',
    'Resolved all blockers.',
    'We are unblocked.',
    'Not blocked.',
  ]) {
    const task = chat('whole-topic', 'Live test');
    complete(task, friday(15), 'Blocked on environment access and owner approval.');
    complete(task, monday(14), summary);
    assert.equal(standup([task]).value.blockers.length, 0, summary);
  }
});

test('an unnamed single blocker resolution does not erase multiple dependencies', () => {
  const task = chat('unnamed', 'Live test');
  complete(task, friday(15), 'Blocked on environment access and owner approval.');
  complete(task, monday(14), 'Fixed the blocker.');
  const { value } = standup([task]);
  assert.equal(value.blockers.length, 1);
  assert.match(value.blockers[0].detail, /environment access/);
  assert.match(value.blockers[0].detail, /owner approval/);
});

test('a reworded dependency still has one identity for later resolution', () => {
  const task = chat('reworded', 'Live test');
  complete(task, friday(15), 'Blocked on environment access.');
  complete(task, monday(12), 'Live execution is still blocked on access.');
  complete(task, monday(14), 'The access blocker is resolved.');
  assert.equal(standup([task]).value.blockers.length, 0);
});

test('distinct owner dependencies keep separate identities', () => {
  for (const summary of [
    'Blocked on owner approval and owner input.',
    'Blocked on owner input and owner approval.',
    'Blocked on owner approval, owner input, and test data.',
  ]) {
    const task = chat('owner-identities', 'Live test');
    complete(task, friday(15), summary);
    complete(task, monday(14), 'The owner input blocker is resolved.');
    const { value } = standup([task]);
    assert.equal(value.blockers.length, 1, summary);
    assert.match(value.blockers[0].detail, /owner approval/);
    assert.doesNotMatch(value.blockers[0].detail, /owner input/);
  }
});

test('trailing conditions and verification caveats do not clear blockers', () => {
  for (const summary of [
    'The access blocker is resolved only if the owner approves the request.',
    'The access blocker is resolved unless the owner rejects the request.',
    'We fixed the access blocker if the owner approved the request.',
    'The access blocker is resolved, but this is not verified.',
    'The access blocker is resolved. This is unverified.',
    'No blockers remain, but this is not confirmed.',
    'No blockers remain. This needs verification.',
  ]) {
    const task = chat('trailing-uncertainty', 'Live test');
    complete(task, friday(15), 'Blocked on environment access.');
    complete(task, monday(14), summary);
    const { value } = standup([task]);
    assert.equal(value.blockers.length, 1, summary);
    assert.match(value.blockers[0].detail, /environment access/);
    assert.equal(value.blockers[0].recordedAt, new Date(friday(15)).toISOString());
  }
});

test('pending subject lists keep every dependency', () => {
  for (const summary of [
    'Owner approval and test data are still pending.',
    'Owner approval, test data are still pending.',
    'Owner approval, environment access, and test data are still pending.',
  ]) {
    const task = chat('pending-subjects', 'Live test');
    complete(task, friday(15), summary);
    complete(task, monday(14), 'The owner approval blocker is resolved.');
    const { value } = standup([task]);
    assert.equal(value.blockers.length, 1, summary);
    assert.match(value.blockers[0].detail, /test data/);
    assert.doesNotMatch(value.blockers[0].detail, /owner approval/);
  }
});

test('local-only named clearance keeps a live outside dependency', () => {
  for (const summary of [
    'Local unit tests are not blocked on owner approval. Live execution is unverified.',
    'Local unit tests are no longer blocked on owner approval. Live execution is unverified.',
    'Offline checks are not blocked on owner approval. Live execution is unverified.',
  ]) {
    const task = chat('local-named-clearance', 'Live test');
    complete(task, friday(15), 'Blocked on owner approval.');
    complete(task, monday(14), summary);
    const { value } = standup([task]);
    assert.equal(value.blockers.length, 1, summary);
    assert.match(value.blockers[0].detail, /owner approval/);
    assert.equal(value.blockers[0].recordedAt, new Date(friday(15)).toISOString());
  }
});

test('negated need and waiting outcomes are not blockers', () => {
  for (const summary of [
    "We don't need owner approval.",
    'We are not waiting for owner approval.',
    'We aren\u2019t waiting for owner approval.',
    'We do not currently need owner approval.',
    'Not a blocker: owner approval.',
    'We might need owner approval.',
    'It may be blocked on owner approval.',
  ]) {
    const task = chat('negated-indicators', 'Live test');
    complete(task, friday(15), summary);
    const { value } = standup([task]);
    assert.equal(value.blockers.length, 0, summary);
    assert.ok(value.focus.every((item) => !/Ask the team/.test(item)), summary);
  }
});

test('a local dependency can clear within the same local work', () => {
  const task = chat('local-dependency', 'Local test');
  complete(task, friday(15), 'Local unit tests are blocked on owner approval.');
  complete(task, monday(14), 'Local unit tests are no longer blocked on owner approval.');
  assert.equal(standup([task]).value.blockers.length, 0);
});

test('generic pending confirmation keeps the known identity and latest evidence date', () => {
  const task = chat('pending-identity', 'Live test');
  complete(task, friday(15), 'Blocked on owner approval and test data.');
  complete(task, monday(12), 'Approval is still pending.');
  const pending = standup([task]).value;
  assert.equal(pending.blockers.length, 1);
  assert.equal(pending.blockers[0].recordedAt, new Date(monday(12)).toISOString());
  complete(task, monday(14), 'The owner approval blocker is resolved.');
  const { value } = standup([task]);
  assert.equal(value.blockers.length, 1);
  assert.match(value.blockers[0].detail, /test data/);
  assert.doesNotMatch(value.blockers[0].detail, /owner approval|Approval is still pending/);
  assert.equal(value.blockers[0].recordedAt, new Date(friday(15)).toISOString());
});

test('an ambiguous owner clearance does not erase distinct causes', () => {
  const task = chat('ambiguous-owner', 'Live test');
  complete(task, friday(15), 'Blocked on owner approval and owner input and the external owner and test data.');
  complete(task, monday(12), 'The owner blocker is resolved.');
  const pending = standup([task]).value;
  assert.equal(pending.blockers.length, 1);
  assert.match(pending.blockers[0].detail, /owner approval/);
  assert.match(pending.blockers[0].detail, /owner input/);
  complete(task, monday(14), 'All owner blockers are resolved.');
  const { value } = standup([task]);
  assert.equal(value.blockers.length, 1);
  assert.match(value.blockers[0].detail, /test data/);
  assert.doesNotMatch(value.blockers[0].detail, /owner approval|owner input/);
});

test('verification caveats without a pronoun stay attached to their status', () => {
  for (const summary of [
    'The access blocker is resolved, but not verified.',
    'The access blocker is resolved, but unconfirmed.',
    'The access blocker is resolved. Unverified.',
    'No blockers remain, but not confirmed.',
    'The access blocker is resolved, and only if the owner approves the request.',
  ]) {
    const task = chat('dangling-caveat', 'Live test');
    complete(task, friday(15), 'Blocked on environment access.');
    complete(task, monday(14), summary);
    const { value } = standup([task]);
    assert.equal(value.blockers.length, 1, summary);
    assert.match(value.blockers[0].detail, /environment access/);
    assert.equal(value.blockers[0].recordedAt, new Date(friday(15)).toISOString());
  }
});

test('local-only suffixes do not clear live dependencies', () => {
  for (const summary of [
    'The owner approval blocker is resolved for local testing. Live execution is unverified.',
    'The owner approval blocker is resolved locally. Live execution is unverified.',
    'Live execution is no longer blocked on owner approval for local testing.',
  ]) {
    const task = chat('local-suffix', 'Live test');
    complete(task, friday(15), 'Blocked on owner approval.');
    complete(task, monday(14), summary);
    const { value } = standup([task]);
    assert.equal(value.blockers.length, 1, summary);
    assert.match(value.blockers[0].detail, /owner approval/);
    assert.equal(value.blockers[0].recordedAt, new Date(friday(15)).toISOString());
  }
});

test('modal scope covers auxiliary verbs and adverbs without hiding proven past failures', () => {
  for (const summary of [
    'We may have been blocked on owner approval.',
    'We might previously have been blocked on owner approval.',
    'We could very well have been waiting for owner approval.',
    'We may have actually been blocked on owner approval.',
    'We possibly were blocked on owner approval.',
    'We may never have been blocked on owner approval.',
  ]) {
    const task = chat('modal-scope', 'Live test');
    complete(task, friday(15), summary);
    const { value } = standup([task]);
    assert.equal(value.blockers.length, 0, summary);
    assert.ok(value.focus.every((item) => !/Ask the team/.test(item)), summary);
  }
  const task = chat('actual-past-failure', 'Live test');
  complete(task, friday(15), 'Execution could not proceed because it was blocked by missing owner approval. Approval is still pending.');
  const { value } = standup([task]);
  assert.equal(value.blockers.length, 1);
  assert.match(value.blockers[0].detail, /owner approval/);
});

test('independent status indicators keep real waiting after a negated dependency', () => {
  for (const summary of [
    'We are not waiting for owner approval, only waiting for test data.',
    'We are not waiting for owner approval only waiting for test data.',
    'We have not been waiting for owner approval, only waiting for test data.',
    'We are waiting for test data, not waiting for owner approval.',
  ]) {
    const task = chat('independent-statuses', 'Live test');
    complete(task, friday(15), 'Blocked on owner approval.');
    complete(task, monday(14), summary);
    const { value } = standup([task]);
    assert.equal(value.blockers.length, 1, summary);
    assert.match(value.blockers[0].detail, /test data/);
    assert.doesNotMatch(value.blockers[0].detail, /owner approval/);
    assert.match(value.focus[0], /Ask the team.*test data/);
  }
});

test('explicit blocker labels and plural permissions are recognised', () => {
  const labelled = chat('labelled', 'Connection setup');
  complete(labelled, friday(15), 'Blocker: Waiting on the external owner to confirm the connection.');
  const permissions = chat('permissions', 'Permissions setup');
  complete(permissions, friday(15), 'Blocked on permissions for the required service.');
  const { value } = standup([labelled, permissions]);
  assert.equal(value.blockers.length, 2);
});

test('a clear later resolution clears a blocker, including in continuation sessions', () => {
  const blocked = chat('blocked', 'Live test - continued (Implement)');
  complete(blocked, friday(15), 'Blocked on environment access. Need owner approval.');
  const fixed = chat('fixed', 'Live test - continued (Verify)');
  fixed.prompts[0].ts = monday(12);
  fixed.timestamps = [monday(12)];
  complete(fixed, monday(14), 'Access is ready. No blockers remain.');
  assert.equal(standup([blocked, fixed]).value.blockers.length, 0);

  const independent = chat('independent', 'Different test');
  complete(independent, monday(15), 'Blocked on test data. Need team approval.');
  assert.equal(standup([blocked, fixed, independent]).value.blockers.length, 1);
});

test('negated and historical blockers and local failures are not team blockers', () => {
  const clear = chat('clear', 'Clear status');
  complete(clear, friday(15), 'No team blockers. Not blocked on access.');
  const historical = chat('old', 'Old issue');
  complete(historical, friday(15), 'Previously blocked on access. Fixed the access blocker.');
  const local = chat('local', 'Desktop update');
  complete(local, friday(15), 'Blocked on a desktop reload. The installed version is not active.');
  const check = chat('check', 'Local tests');
  check.toolCalls.push({ id: 'failed', ts: monday(13), endTs: monday(13), name: 'powershell', category: 'shell', command: 'npm test', ok: false, exitCode: 1 });
  check.timestamps.push(monday(13));
  const { value } = standup([clear, historical, local, check]);
  assert.equal(value.blockers.length, 0);
  assert.ok(value.focus.some((item) => /failed validation/.test(item)));
});

test('standup is persisted in Markdown and JSON with safe text and honest empty-history wording', () => {
  const task = chat('safe', 'Investigate <script> and jane@example.com');
  complete(task, friday(15), 'Blocked on access for jane@example.com. Need team approval; token=verySecret12345.');
  const { daily, value } = standup([task], { unreadable: 1 });
  const analysis = { ...daily, standup: value };
  const md = renderMarkdown(analysis, meta);
  const digest = buildDigest(analysis, meta);
  for (const heading of ['## Standup report', '### What I did last business day', '### What I will focus on today (suggestions)', '### Blockers the team should know about']) {
    assert.ok(md.includes(heading), heading);
  }
  assert.match(md, /Friday 30 October 2026/);
  assert.match(md, /suggestions, not an agreed plan/);
  assert.match(md, /Some local history could not be read/);
  assert.equal(digest.standup.date, '2026-11-02');
  assert.equal(digest.standup.previousBusinessDay.date, '2026-10-30');
  assert.doesNotMatch(md, /jane@example\.com|verySecret12345|<script>/);
  assert.doesNotMatch(JSON.stringify(digest.standup), /jane@example\.com|verySecret12345/);
  const empty = standup([]);
  assert.match(renderMarkdown({ ...empty.daily, standup: empty.value }, meta), /This does not mean no work was done/);
  assert.equal(empty.value.focus.length, 1);
  assert.equal(empty.value.blockers.length, 0);
});

test('the short work summary has an explicit omitted count', () => {
  const { value } = standup(Array.from({ length: 8 }, (_, i) => chat(`work-${i}`, `Task ${i}`)));
  assert.equal(value.work.length, 6);
  assert.equal(value.workOmitted, 2);
});
