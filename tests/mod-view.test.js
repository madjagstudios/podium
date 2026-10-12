import test from 'node:test';
import assert from 'node:assert/strict';
import { jobState, jobLine, statusText, newlyFinished, detailLines, finishedMessage, committedText, shorten, duration, laneOf, toneOf, lanes, clock, elapsedText, doneText, parseLive, quietText, isQuiet, askText, paletteName, readiness, same, threads, organise, checkRows, sizeText, removalText, isPrEvent, finishedHeadline, sprintStepLine, isFoldOpen, foldsLeaving, accessWord, prChecks, prSub, attentionLine, jobStatusLine, workingRowLine, doneRowLine, isFailedTurn, turnItems, jobDetails, fromAnotherChat, andList, turnLabel, sprintStatusLine, ticketState, ticketStatusLine, whoLine, optionsLine, agentState, agentLine, agentNeedsFix, setupSummary, instructionsSummary, storageSummary, limitsSummary, accessLine, moreSummary, sprintTone, ticketTone, finishedTone, jobTone, REPLY_RULE, isFinishedSprint, finishedSprintTone, finishedSprintLine, sprintWorkingLine, isSprintMine, finishedSprints, FINISHED_SPRINTS, FROM_OTHER_CHAT, isOpenSprint, olderSprintsLine } from '../mod/view.js';

const NOW = Date.parse('2026-10-05T12:00:00Z');
const job = (over = {}) => ({
  id: 'j1', agent: 'codex', title: 'Review the branch', ticket: 'ABC-4', permission: 'read-only', status: 'running',
  createdAt: '2026-10-05T11:56:00Z', startedAt: '2026-10-05T11:56:00Z', endedAt: null, delivered: false, isLong: false, error: null, ...over,
});

test('three states only', () => {
  assert.equal(jobState(job()), 'working');
  assert.equal(jobState(job({ isLong: true })), 'needs-you');
  for (const s of ['needs-review', 'failed', 'lost']) assert.equal(jobState(job({ status: s })), 'needs-you');
  for (const s of ['done', 'kept', 'discarded', 'cancelled']) assert.equal(jobState(job({ status: s })), 'done');
});

test('job lines read as plain English', () => {
  assert.deepEqual(jobLine(job(), NOW), { id: 'j1', state: 'working', icon: '⏳', who: 'Codex', what: 'Review the branch', when: '4 min so far', ticket: 'ABC-4' });
  const review = jobLine(job({ status: 'needs-review', agent: 'muse' }), NOW);
  assert.equal(review.icon, '✋');
  assert.equal(review.who, 'Muse — needs you');
  assert.equal(review.when, 'Changes ready to review');
  assert.equal(jobLine(job({ status: 'done', endedAt: '2026-10-05T11:50:00Z' }), NOW).when, 'Done 10 min ago');
  assert.match(jobLine(job({ isLong: true }), NOW).when, /Keep going or cancel\?/);
});

test('status line counts and hides when idle', () => {
  assert.equal(statusText([job(), job({ status: 'failed' }), job({ status: 'done' })]), '🎼 Podium: 1 working · 1 needs you');
  assert.equal(statusText([job({ status: 'done' })]), undefined);
});

test('newlyFinished picks undelivered finished jobs only', () => {
  const list = [job(), job({ id: 'a', status: 'done' }), job({ id: 'b', status: 'done', delivered: true }), job({ id: 'c', status: 'kept' }), job({ id: 'd', status: 'lost' })];
  assert.deepEqual(newlyFinished(list).map((j) => j.id), ['a', 'd']);
});

test('detail line and finished message', () => {
  const done = job({ status: 'needs-review', permission: 'edit-worktree', endedAt: '2026-10-05T12:03:00Z' });
  assert.equal(detailLines(done), 'Ticket ABC-4 · took 7 min · Codex could edit files in a separate copy');
  const msg = finishedMessage(done, 'Added the calculator.\nTests pass.');
  assert.match(msg, /^\[Podium\] Codex finished with changes to review: "Review the branch"/);
  assert.match(msg, /Summary:\nAdded the calculator\.\nTests pass\./);
  assert.match(msg, /waiting in the Podium pane/);
  assert.match(msg, /Job j1\./);
  assert.match(finishedMessage(job({ status: 'failed', error: 'Codex exited with code 3.' }), null), /Codex exited with code 3\./);
  assert.equal(detailLines(job({ ticket: 'NO-TICKET', startedAt: null })), 'No ticket · Codex could only read files');
});

test('helpers', () => {
  assert.equal(shorten('  first\nsecond', 60), 'first');
  assert.equal(shorten('x'.repeat(10), 5), 'xxxx…');
  assert.equal(duration(30_000), '30s');
  assert.equal(duration(7 * 60_000), '7 min');
  assert.equal(duration(3 * 3_600_000), '3 h');
});

const T0 = Date.parse('2026-10-05T12:00:00Z');
const j = (over = {}) => ({ id: 'j1', agent: 'codex', title: 'Review the auth branch', status: 'running', startedAt: '2026-10-05T11:55:48Z', createdAt: '2026-10-05T11:55:40Z', endedAt: null, ...over });

test('lanes and tones follow job status', () => {
  assert.equal(laneOf(j({ status: 'needs-review' })), 'needs');
  assert.equal(laneOf(j({ status: 'queued' })), 'working');
  assert.equal(laneOf(j({ status: 'failed' })), 'done');
  assert.equal(toneOf(j({ status: 'failed' })), 'failed');
  assert.equal(toneOf(j({ status: 'lost' })), 'failed');
  assert.equal(toneOf(j({ status: 'kept' })), 'done');
  const many = Array.from({ length: 35 }, (_, i) => j({ id: `d${i}`, status: 'done' }));
  const l = lanes([j(), j({ id: 'n', status: 'needs-review' }), ...many]);
  assert.equal(l.working.length, 1);
  assert.equal(l.needs.length, 1);
  assert.equal(l.done.length, 30);
  assert.equal(l.done[0].id, 'd0');
});

test('clock, elapsed and done text', () => {
  assert.equal(clock(18_000), '18s');
  assert.equal(clock(252_000), '4m 12s');
  assert.equal(clock(3_780_000), '1h 03m');
  assert.equal(elapsedText(j(), T0), '4m 12s');
  assert.equal(doneText(j({ status: 'done', startedAt: '2026-10-05T11:58:54Z', endedAt: '2026-10-05T11:59:21Z' }), T0), 'took 27s · 39s ago');
});

test('parseLive accepts v1 and rejects anything else', () => {
  const ok = parseLive(JSON.stringify({ v: 1, updatedAt: '2026-10-05T11:59:58Z', activity: 'reading', lines: ['a', 'reading'], bytes: 9 }));
  assert.deepEqual(ok, { activity: 'reading', lines: ['a', 'reading'], updatedAt: '2026-10-05T11:59:58Z' });
  assert.equal(parseLive('{"v":2}'), null);
  assert.equal(parseLive('{half'), null);
  assert.equal(parseLive(''), null);
});

test('quiet after 10 seconds without new output', () => {
  const live = { activity: 'x', lines: [], updatedAt: '2026-10-05T11:58:40Z' };
  assert.equal(isQuiet(live, T0), true);
  assert.equal(quietText(live, T0), 'quiet for 1m 20s');
  assert.equal(isQuiet({ ...live, updatedAt: '2026-10-05T11:59:55Z' }, T0), false);
  assert.equal(quietText({ ...live, updatedAt: '2026-10-05T11:59:55Z' }, T0), null);
  assert.equal(quietText(null, T0), null);
});

test('askText names the job and quotes the last five lines', () => {
  const text = askText(j(), { activity: 'l7', lines: ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7'], updatedAt: '' }, T0);
  assert.match(text, /^About Podium job "Review the auth branch" \(Codex, 4m 12s in, id j1\)\. Latest output:/);
  assert.match(text, /```\nl3\nl4\nl5\nl6\nl7\n```\n\n$/);
  assert.match(askText(j({ status: 'done' }), null, T0), /no output yet/);
});

test('paletteName, readiness and same', () => {
  assert.equal(paletteName('light'), 'light');
  assert.equal(paletteName('light-daltonized'), 'light');
  assert.equal(paletteName('light-ansi'), 'light');
  assert.equal(paletteName('dark'), 'dark');
  assert.equal(paletteName(undefined), 'dark');
  assert.deepEqual(readiness({ name: 'codex', installed: true, enabled: true, signedIn: true }), { tone: 'ok', note: null });
  assert.deepEqual(readiness({ name: 'claude', installed: true, enabled: true, signedIn: false }), { tone: 'warn', note: 'Not signed in: run "claude login" once, then press Test.' });
  assert.deepEqual(readiness({ name: 'gemini', installed: false, enabled: true, signedIn: null }), { tone: 'off', note: 'Not installed' });
  assert.deepEqual(readiness({ name: 'muse', installed: true, enabled: false, signedIn: null }), { tone: 'off', note: 'Switched off' });
  assert.equal(same({ a: [1] }, { a: [1] }), true);
  assert.equal(same({ a: [1] }, { a: [2] }), false);
});

test('committed work reads as commits, never as something to keep', () => {
  const job = { id: 'j9', agent: 'muse', title: 'Officer roster', status: 'done', ticket: 'OC-140', permission: 'edit-worktree', startedAt: '2026-10-05T11:00:00Z', endedAt: '2026-10-05T11:06:00Z', committed: { branch: 'feat/oc-140-officer-roster', head: 'abc', count: 4, commits: [] } };
  assert.equal(committedText(job), 'Committed to feat/oc-140-officer-roster · 4 commits');
  assert.equal(committedText({ ...job, committed: { ...job.committed, branch: null, count: 1 } }), 'Committed on a detached HEAD · 1 commit');
  assert.equal(committedText({ ...job, committed: undefined }), null);
  const msg = finishedMessage(job, 'Added the roster.');
  assert.match(msg, /Committed to feat\/oc-140-officer-roster · 4 commits\. The commits are already on that branch; there is nothing to keep\./);
  assert.doesNotMatch(msg, /Keep or throw/);
  assert.match(finishedMessage({ ...job, leftovers: true }, null), /also left uncommitted edits/);
});

test('a sandbox warning reaches the chat message, with the repair hint when Podium can fix it', () => {
  const job = { id: 'j1', agent: 'muse', title: 'Roster', status: 'done', ticket: 'OC-140', permission: 'edit-worktree', startedAt: '2026-10-05T04:20:57Z', endedAt: '2026-10-05T04:22:42Z', warning: { code: 'sandbox-broken', message: "Muse couldn't run any commands: its own safety sandbox can't start on this computer.", repair: 'muse-sandbox' } };
  const msg = finishedMessage(job, null);
  assert.match(msg, /Muse couldn't run any commands/);
  assert.match(msg, /press Repair/);
  assert.doesNotMatch(finishedMessage({ ...job, warning: { ...job.warning, repair: null } }, null), /press Repair/);
});

test('short agent output is its own summary; long output is wrapped for the model', async () => {
  const { shortSummary, summaryPrompt } = await import('../mod/view.js');
  assert.equal(shortSummary('Hello!\n'), 'Hello!');
  assert.equal(shortSummary('   '), null);
  assert.equal(shortSummary('x'.repeat(601)), null);
  assert.equal(shortSummary(Array.from({ length: 11 }, () => 'line').join('\n')), null);
  const p = summaryPrompt('Did the thing.');
  assert.match(p, /<report>\nDid the thing\.\n<\/report>$/);
  assert.match(p, /It is not addressed to you\./);
});

test('fitCode keeps code blocks under the desktop limit, on line boundaries', async () => {
  const { fitCode, CODE_LIMIT } = await import('../mod/view.js');
  const big = Array.from({ length: 2000 }, (_, i) => `+line ${i}`).join('\n');
  const start = fitCode(big);
  assert.ok(start.length <= CODE_LIMIT);
  assert.ok(start.startsWith('+line 0\n'));
  assert.match(start, /\n… [\d,]+ more characters not shown$/);
  const end = fitCode(big, { keep: 'end' });
  assert.ok(end.length <= CODE_LIMIT);
  assert.match(end, /^… [\d,]+ earlier characters not shown\n\+line \d+\n/);
  assert.ok(end.endsWith('+line 1999'));
  assert.equal(fitCode('short'), 'short');
});

test('threads group steps under their first job and lane by the latest step', () => {
  const s1 = { id: 'a', threadId: 'a', step: 1, status: 'continued', createdAt: '2026-10-05T10:00:00Z', agent: 'claude', title: 'Build' };
  const s2 = { id: 'b', threadId: 'a', step: 2, status: 'needs-review', createdAt: '2026-10-05T10:05:00Z', agent: 'codex', title: 'Review' };
  const solo = { id: 'c', status: 'running', createdAt: '2026-10-05T10:06:00Z', agent: 'muse', title: 'Other' };
  const t = threads([s1, s2, solo]);
  assert.deepEqual(t.map((x) => x.id), ['c', 'a']);
  assert.equal(t[1].latest.id, 'b');
  assert.deepEqual(t[1].steps.map((x) => x.id), ['b', 'a']);
  const l = organise(t);
  assert.deepEqual([l.needs.length, l.working.length, l.done.length], [1, 1, 0]);
});

test('finished messages say how to continue an open thread', () => {
  const job = { id: 'b', threadId: 'a', step: 2, agent: 'codex', title: 'Review', status: 'needs-review', ticket: 'NO-TICKET', permission: 'edit-worktree', startedAt: '2026-10-05T10:05:00Z', endedAt: '2026-10-05T10:06:00Z' };
  assert.match(finishedMessage(job, 'ok'), /Thread a · step 2\. To change this work: dispatch with followUp: b\./);
});

test('the finished headline is one line; the notes say where the changes are and how to reply', async () => {
  const { finishedHeadline } = await import('../mod/view.js');
  const done = job({ status: 'needs-review', permission: 'edit-worktree', worktree: 'C:/data/wt/j1' });
  const head = finishedHeadline(done);
  assert.equal(head, 'Podium: Codex finished "Review the branch": changes to review in the pane.');
  assert.doesNotMatch(head, /\n/);
  assert.equal(finishedHeadline(job({ status: 'failed' })), 'Podium: Codex stopped with an error on "Review the branch".');
  const notes = finishedMessage(done, 'ok');
  assert.match(notes, /separate copy at C:\/data\/wt\/j1, not in the person's folder/);
  assert.ok(notes.endsWith(REPLY_RULE));
});

// Local-time dates, so "today" is the machine's own day.
const local = (d, h, m = 0) => new Date(2026, 9, d, h, m).toISOString();
const NOON = new Date(2026, 9, 5, 12).getTime();
const fin = (id, ended, over = {}) => ({ id, agent: 'codex', title: id, status: 'done', createdAt: ended, endedAt: ended, origin: { session: 'me' }, ...over });

test('organise sorts threads by chat: mine, other chats active, other chats finished', () => {
  const list = threads([
    fin('a', local(5, 9)),
    fin('b', local(5, 9), { status: 'needs-review', origin: { session: 'other' } }),
    fin('c', local(5, 9), { status: 'running', endedAt: null, origin: null }),
    fin('d1', local(5, 8), { threadId: 'd1', step: 1, status: 'continued', origin: { session: 'other' } }),
    fin('d2', local(5, 10), { threadId: 'd1', step: 2 }),
    fin('e', local(5, 7), { origin: { session: 'other' } }),
  ]);
  const o = organise(list, { session: 'me', now: NOON });
  assert.deepEqual(o.needs.map((t) => [t.id, t.isMine]), [['b', false]]);
  assert.deepEqual(o.working.map((t) => [t.id, t.isMine]), [['c', false]]);
  assert.deepEqual(o.done.map((t) => t.id), ['d1', 'a']);
  assert.ok(o.done.every((t) => t.isMine));
  assert.deepEqual(o.others.map((t) => t.id), ['e']);
  const all = organise(list, { session: null, now: NOON });
  assert.deepEqual(all.others, []);
  assert.deepEqual(all.done.map((t) => t.id), ['d1', 'a', 'e']);
});

test('Done keeps today, topped up to the newest 5', () => {
  const few = threads(['9', '10', '11'].map((h) => fin(`t${h}`, local(5, Number(h)))).concat(
    [20, 21, 22, 23].map((h) => fin(`y${h}`, local(4, h, 30)))));
  const o = organise(few, { session: 'me', now: NOON });
  assert.deepEqual(o.done.map((t) => t.id), ['t11', 't10', 't9', 'y23', 'y22']);
  assert.equal(o.doneHidden, 2);
  const many = threads([0, 1, 2, 3, 4, 5].map((h) => fin(`t${h}`, local(5, h, 10))).concat([fin('y', local(4, 23, 50))]));
  const m = organise(many, { session: 'me', now: NOON });
  assert.equal(m.done.length, 6);
  assert.ok(m.done.some((t) => t.id === 't0'), 'ten past midnight counts as today');
  assert.equal(m.doneHidden, 1);
});

test('Clear hides what finished before it; Show more shows everything', () => {
  const list = threads(['9', '10', '11'].map((h) => fin(`t${h}`, local(5, Number(h)))).concat(
    [20, 21, 22, 23].map((h) => fin(`y${h}`, local(4, h, 30)))));
  const o = organise(list, { session: 'me', now: NOON, clearedAt: local(5, 10, 30) });
  assert.deepEqual(o.done.map((t) => t.id), ['t11']);
  assert.equal(o.doneHidden, 6);
  const all = organise(list, { session: 'me', now: NOON, clearedAt: local(5, 10, 30), showAll: true });
  assert.equal(all.done.length, 7);
  assert.equal(all.doneHidden, 0);
});

test("other chats' finished work is newest first, at most 30", () => {
  const list = threads(Array.from({ length: 35 }, (_, i) => fin(`o${i}`, new Date(NOON - i * 60_000).toISOString(), { origin: { session: 'other' } })));
  const o = organise(list, { session: 'me', now: NOON });
  assert.equal(o.others.length, 30);
  assert.equal(o.others[0].id, 'o0');
  assert.deepEqual(o.done, []);
  assert.equal(o.doneHidden, 0);
});

// Install path.
const REPORT = { node: { ok: true, version: '22.3.0' }, git: { ok: true, version: '2.45.1' }, gh: { installed: true, signedIn: true, version: '2.96.0' }, tellClaude: true, welcomed: false };

test('checkRows reads the doctor report and the agents in plain words', () => {
  const agentsFound = [{ name: 'codex', label: 'Codex', installed: true, version: '0.1' }, { name: 'gemini', label: 'Gemini', installed: false, version: null }];
  const rows = checkRows(REPORT, agentsFound);
  assert.deepEqual(rows.map((r) => r.ok), [true, true, true, null, true, true]);
  assert.match(rows[2].text, /Codex 0\.1/);
  assert.match(rows[3].text, /Gemini not installed/);
  const bad = checkRows({ ...REPORT, node: { ok: false, version: '20.1.0' }, gh: { installed: false, signedIn: false, version: null }, tellClaude: false }, []);
  assert.match(bad[0].text, /needs Node 22 or newer/);
  assert.equal(bad.find((r) => /GitHub CLI/.test(r.text)).ok, null);
  assert.match(bad.find((r) => /No agents found/.test(r.text)).text, /install/);
  assert.equal(bad.find((r) => /told when jobs finish/.test(r.text)).ok, false);
  assert.match(checkRows(REPORT, null)[2].text, /Looking for agents/);
});

test('sizeText and removalText', () => {
  assert.equal(sizeText(512), '512 bytes');
  assert.equal(sizeText(1536), '1.5 KB');
  assert.equal(sizeText(3 * 1024 * 1024), '3.0 MB');
  assert.equal(removalText({ bytes: 1048576, unkept: 2, running: 1, copies: 3 }), "This deletes 1.0 MB of Podium's data, including 3 copies. 2 jobs with unkept changes will be lost. 1 running job will be stopped.");
  assert.equal(removalText({ bytes: 100, unkept: 0, running: 0, copies: 0 }), "This deletes 100 bytes of Podium's data.");
});

// PR events.
test('PR events read as one line and carry the close-out hint', () => {
  const pr = { number: 12, url: 'https://github.com/o/r/pull/12', branch: 'feat/abc-12-x', base: 'main', attention: null, autoMerge: false };
  const opened = job({ status: 'in-review', delivered: false, ticket: 'ABC-12', pr });
  assert.equal(isPrEvent(opened), true);
  assert.equal(finishedHeadline(opened), 'Podium: PR #12 opened: "Review the branch".');
  assert.match(finishedMessage(opened, null), /PR #12 \(https:\/\/github\.com\/o\/r\/pull\/12\) is open on feat\/abc-12-x for ABC-12\./);
  assert.match(finishedMessage(opened, null), /close-out/);
  const merged = { ...opened, status: 'merged' };
  assert.equal(finishedHeadline(merged), 'Podium: PR #12 merged: "Review the branch".');
  assert.match(finishedMessage(merged, null), /merged into main/);
  assert.equal(finishedHeadline({ ...opened, status: 'closed' }), 'Podium: PR #12 was closed: "Review the branch".');
  // A later step (a CI fix) ends the PR: the message still names the PR.
  assert.equal(finishedHeadline({ ...merged, title: 'CI failed on PR #12 (test). Fix it', pr: { ...pr, title: 'Add a contact page' } }), 'Podium: PR #12 merged: "Add a contact page".');
  assert.equal(newlyFinished([opened, merged, { ...merged, delivered: true }]).length, 2);
  assert.equal(jobState(opened), 'done');
  assert.equal(jobState({ ...opened, pr: { ...pr, attention: 'ci-failed' } }), 'needs-you');
  const followUp = job({ status: 'needs-review', pr, worktree: 'C:/w' });
  assert.equal(isPrEvent(followUp), false);
  assert.match(finishedMessage(followUp, 'ok'), /Push to PR/);
  assert.doesNotMatch(finishedMessage(followUp, 'ok'), /Keep or throw/);
});

test('PR threads sit in In review until they need you, and reviews never become the step to continue', () => {
  const pr = { number: 12, state: 'OPEN', checks: { total: 3, passed: 2, failed: 0, running: 1, failing: [] }, review: null, attention: null };
  const work = { id: 'w', threadId: 'w', step: 1, status: 'in-review', createdAt: '2026-10-06T10:00:00Z', agent: 'codex', title: 'Build', pr, origin: { session: 'me' } };
  const rev = { id: 'r', threadId: 'w', step: null, kind: 'review', status: 'done', createdAt: '2026-10-06T10:05:00Z', agent: 'claude', title: 'Review PR #12', origin: { session: 'me' } };
  const t = threads([work, rev]);
  assert.equal(t[0].latest.id, 'w');
  assert.deepEqual(t[0].steps.map((s) => s.id), ['r', 'w']);
  assert.equal(organise(t, { session: 'me' }).review.length, 1);
  assert.equal(toneOf(work), 'neutral');
  const failing = threads([{ ...work, pr: { ...pr, attention: 'ci-failed' } }]);
  assert.equal(organise(failing, { session: 'me' }).needs.length, 1);
  assert.equal(laneOf({ status: 'merged' }), 'done');
});

test('the visible variant of the notes drops the line about what the person saw, and keeps the tool hints', () => {
  const done = job({ status: 'needs-review', permission: 'edit-worktree', worktree: 'C:/data/wt/j1', threadId: 'a' });
  const visible = finishedMessage(done, 'ok', true);
  assert.doesNotMatch(visible, /Do not repeat their line/);
  assert.doesNotMatch(visible, /saw only a one-line notice/);
  assert.match(visible, /dispatch with followUp/);
  assert.match(visible, /podium_result/);
  assert.match(finishedMessage(done, 'ok'), /Do not repeat their line\./);
  const pr = { number: 12, url: 'https://github.com/o/r/pull/12', branch: 'feat/x', base: 'main', title: 'X', autoMerge: false };
  const opened = job({ status: 'in-review', pr, ticket: 'ABC-12' });
  assert.doesNotMatch(finishedMessage(opened, null, true), /Do not repeat their line/);
  assert.match(finishedMessage(opened, null), /Do not repeat their line\./);
});

// ---- A sprint step's row says what the step did, not its step number ----

const SP = { id: 's1', ticket: 'SMK-4' };
const sj = (id, at, role, task, over = {}) => ({
  id, agent: role === 'reviewer' ? 'codex' : 'claude', title: `${role} ${task}`, status: 'done', createdAt: at, startedAt: at, endedAt: at, step: 1,
  sprint: { ...SP, task, role }, ...over,
});
// Task 1 written, reviewed and passed; task 2 written, failed review, fixed, reviewed again and passed.
const CHAIN = [
  sj('a1', '2026-10-05T01:00:00Z', 'author', 1, { agent: 'claude' }),
  sj('r1', '2026-10-05T01:05:00Z', 'reviewer', 1),
  sj('a2', '2026-10-05T01:10:00Z', 'author', 2, { agent: 'muse' }),
  sj('r2', '2026-10-05T01:15:00Z', 'reviewer', 2),
  sj('f2', '2026-10-05T01:20:00Z', 'author', 2, { title: 'SMK-4 task 2: fix what the reviewer found', step: 4, resumeFrom: 'x' }),
  sj('r3', '2026-10-05T01:25:00Z', 'reviewer', 2),
];
const at = (min) => Date.parse('2026-10-05T01:00:00Z') + min * 60_000;
const lineOf = (id, now = at(60), steps = CHAIN) => sprintStepLine(steps.find((s) => s.id === id), steps, now);

test('a sprint step row says who did what to which task, and when, with no step number', () => {
  assert.equal(lineOf('a1'), 'Claude wrote task 1 · 1h 00m ago');
  assert.equal(lineOf('a2'), 'Muse wrote task 2 · 50m 0s ago');
  assert.doesNotMatch(lineOf('f2'), /same conversation|^\d|· 4 ·/);
});

test('a sprint author step that follows a review of its task says it fixed the task', () => {
  assert.equal(lineOf('f2'), 'Claude fixed task 2 · 40m 0s ago');
  // by its title alone, with no review in the list
  const only = [sj('f', '2026-10-05T01:20:00Z', 'author', 3, { title: 'SMK-4 task 3: fix what the reviewer found' })];
  assert.equal(sprintStepLine(only[0], only, at(21)), 'Claude fixed task 3 · 1m 0s ago');
  // a write is never a fix just because a different task was reviewed
  const other = [sj('r', '2026-10-05T01:00:00Z', 'reviewer', 1), sj('w', '2026-10-05T01:10:00Z', 'author', 2)];
  assert.equal(sprintStepLine(other[1], other, at(11)), 'Claude wrote task 2 · 1m 0s ago');
});

test('a review row says passed or failed only when the steps after it show it', () => {
  assert.equal(lineOf('r1'), 'Codex reviewed task 1 · passed · 55m 0s ago');   // task 2's writer came next
  assert.equal(lineOf('r2'), 'Codex reviewed task 2 · failed · 45m 0s ago');   // a fix came next
  assert.equal(lineOf('r3'), 'Codex reviewed task 2 · 35m 0s ago');            // nothing after it: not known here
});

test('a review row names no outcome while a later step cannot say it, and never one for a review that did not finish', () => {
  const lone = [sj('r', '2026-10-05T01:00:00Z', 'reviewer', 1)];
  assert.equal(sprintStepLine(lone[0], lone, at(5)), 'Codex reviewed task 1 · 5m 0s ago');
  const failedRun = [sj('r', '2026-10-05T01:00:00Z', 'reviewer', 1, { status: 'failed' }), sj('a', '2026-10-05T01:10:00Z', 'author', 2)];
  assert.equal(sprintStepLine(failedRun[0], failedRun, at(20)), "Codex couldn't review task 1 · failed · 20m 0s ago");
});

test('a running sprint step keeps its live status word', () => {
  const run = sj('w', '2026-10-05T01:00:00Z', 'author', 2, { status: 'running', endedAt: null });
  assert.equal(sprintStepLine(run, [run], at(3)), 'Claude writing task 2 · working');
  const rev = sj('v', '2026-10-05T01:00:00Z', 'reviewer', 2, { status: 'running', endedAt: null });
  assert.equal(sprintStepLine(rev, [rev], at(3)), 'Codex reviewing task 2 · working');
  const fix = sj('x', '2026-10-05T01:05:00Z', 'author', 2, { status: 'running', endedAt: null, title: 'SMK-4 task 2: fix what the reviewer found' });
  assert.equal(sprintStepLine(fix, [rev, fix], at(6)), 'Claude fixing task 2 · working');
  assert.equal(sprintStepLine({ ...run, status: 'queued' }, [run], at(3)), 'Claude writing task 2 · queued');
});

test('a sprint author step that stopped says so instead of claiming the work', () => {
  const lost = sj('w', '2026-10-05T01:00:00Z', 'author', 2, { status: 'lost' });
  assert.equal(sprintStepLine(lost, [lost], at(2)), "Claude couldn't finish task 2 · stopped · 2m 0s ago");
  const cancelled = { ...lost, status: 'cancelled' };
  assert.equal(sprintStepLine(cancelled, [cancelled], at(2)), "Claude couldn't finish task 2 · cancelled · 2m 0s ago");
});

// A Retry follows up the step that failed, and the follow-up marks it `continued` (endStatus keeps how it
// ended). Its row must keep that outcome, never read as a write, fix or review because a later step exists.
test('a sprint step run again after it failed keeps its failed outcome', () => {
  const FIX = 'SMK-4 task 1: fix what the reviewer found';
  const retried = [
    sj('a1', '2026-10-05T01:00:00Z', 'author', 1, { title: 'SMK-4 task 1: Add a.txt', status: 'continued', endStatus: 'failed' }),
    sj('a2', '2026-10-05T01:10:00Z', 'author', 1, { title: 'SMK-4 task 1: Add a.txt', step: 2, followUpOf: 'a1', status: 'continued', endStatus: 'done' }),
    sj('r1', '2026-10-05T01:15:00Z', 'reviewer', 1, { status: 'failed' }),
    sj('r2', '2026-10-05T01:20:00Z', 'reviewer', 1),
    sj('f1', '2026-10-05T01:25:00Z', 'author', 1, { title: FIX, step: 3, followUpOf: 'a2', status: 'continued', endStatus: 'cancelled' }),
    sj('f2', '2026-10-05T01:30:00Z', 'author', 1, { title: FIX, step: 4, followUpOf: 'f1', status: 'continued', endStatus: 'lost' }),
    sj('f3', '2026-10-05T01:35:00Z', 'author', 1, { title: FIX, step: 5, followUpOf: 'f2', status: 'continued', endStatus: 'done' }),
    sj('r3', '2026-10-05T01:40:00Z', 'reviewer', 1),
    sj('b1', '2026-10-05T01:45:00Z', 'author', 2, { title: 'SMK-4 task 2: Add b.txt', step: 6, followUpOf: 'f3', status: 'running', endedAt: null }),
  ];
  const line = (id) => lineOf(id, at(60), retried).replace(/ · [^·]* ago$/, '');
  assert.equal(line('a1'), "Claude couldn't finish task 1 · failed");
  assert.equal(line('a2'), 'Claude wrote task 1', 'the retried write did write it');
  assert.equal(line('r1'), "Codex couldn't review task 1 · failed");
  assert.equal(line('r2'), 'Codex reviewed task 1 · failed');
  assert.equal(line('f1'), "Claude couldn't finish task 1 · cancelled");
  assert.equal(line('f2'), "Claude couldn't finish task 1 · stopped");
  assert.equal(line('f3'), 'Claude fixed task 1');
  assert.equal(line('r3'), 'Codex reviewed task 1 · passed');
  assert.equal(line('b1'), 'Claude writing task 2 · working');
});

test('a write is not a fix because a review of its task failed to run before it', () => {
  const steps = [
    sj('r', '2026-10-05T01:00:00Z', 'reviewer', 1, { status: 'failed' }),
    sj('w', '2026-10-05T01:10:00Z', 'author', 1, { title: 'SMK-4 task 1: Add a.txt' }),
  ];
  assert.equal(sprintStepLine(steps[1], steps, at(11)), 'Claude wrote task 1 · 1m 0s ago');
});

test('a sprint\'s planning step reads as writing or changing the plan', () => {
  const plan = sj('p', '2026-10-05T01:00:00Z', 'author', 0, { title: 'SMK-4: write the plan', sprint: { ...SP, task: 0, role: 'author', plan: true } });
  const change = sj('c', '2026-10-05T01:10:00Z', 'author', 0, { title: 'SMK-4: change the plan', step: 2, sprint: { ...SP, task: 0, role: 'author', plan: true } });
  const steps = [plan, change];
  assert.equal(sprintStepLine(plan, steps, at(20)), 'Claude wrote the plan · 20m 0s ago');
  assert.equal(sprintStepLine(change, steps, at(20)), 'Claude changed the plan · 10m 0s ago');
  assert.equal(sprintStepLine({ ...plan, status: 'running', endedAt: null }, steps, at(20)), 'Claude writing the plan · working');
  assert.equal(sprintStepLine({ ...plan, status: 'failed' }, steps, at(20)), "Claude couldn't finish the plan · failed · 20m 0s ago");
});

// A plan whose tasks are numbered from 0 read its first task as "the plan". Only a step marked as planning is.
test('a sprint\'s real task 0 reads as task 0, not as the plan', () => {
  const wrote = sj('t0', '2026-10-05T01:00:00Z', 'author', 0, { title: 'SMK-4 task 0: Set up' });
  const review = sj('r0', '2026-10-05T01:05:00Z', 'reviewer', 0);
  const next = sj('t1', '2026-10-05T01:10:00Z', 'author', 1);
  const steps = [wrote, review, next];
  assert.equal(sprintStepLine(wrote, steps, at(20)), 'Claude wrote task 0 · 20m 0s ago');
  assert.equal(sprintStepLine({ ...wrote, status: 'running', endedAt: null }, steps, at(20)), 'Claude writing task 0 · working');
  assert.equal(sprintStepLine(review, steps, at(20)), 'Codex reviewed task 0 · passed · 15m 0s ago');
});

test('a fold is open when its id is listed, unless it opens by default, when listing it closes it', () => {
  assert.equal(isFoldOpen([], 'job:j1:changes'), false);
  assert.equal(isFoldOpen(['job:j1:changes'], 'job:j1:changes'), true);
  assert.equal(isFoldOpen([], 'list:setup', true), true);
  assert.equal(isFoldOpen(['list:setup'], 'list:setup', true), false);
  assert.equal(isFoldOpen(undefined, 'x'), false);
});

test('leaving a screen that could not draw drops its own folds, and keeps every other', () => {
  const folds = ['list:done', 'job:j1:changes', 'job:j10:steps', 'board:s1:options', 'ticket:s1:ABC-12:who', 'ticket:s1:ABC-1:who', 'agent:codex:access'];
  assert.deepEqual(foldsLeaving(folds, { screen: 'detail', id: 'j1' }), folds.filter((f) => f !== 'job:j1:changes'));
  assert.deepEqual(foldsLeaving(folds, { screen: 'ticket', id: 's1', key: 'ABC-12' }), folds.filter((f) => f !== 'ticket:s1:ABC-12:who'));
  assert.deepEqual(foldsLeaving(folds, { screen: 'sprint', id: 's1' }), folds.filter((f) => f !== 'board:s1:options'));
  assert.deepEqual(foldsLeaving(folds, { screen: 'agent', id: 'codex' }), folds.filter((f) => f !== 'agent:codex:access'));
  assert.deepEqual(foldsLeaving(folds, { screen: 'list', id: null }), folds);
  assert.deepEqual(foldsLeaving(undefined, { screen: 'detail', id: 'j1' }), []);
});

// The wording tests below declare their own NOW (12:02) and j(); the block keeps them apart from this file's top-level NOW and j().
{
const AT = { createdAt: '2026-10-05T11:56:00Z', startedAt: '2026-10-05T11:56:00Z', endedAt: '2026-10-05T12:00:00Z' };
const NOW = Date.parse('2026-10-05T12:02:00Z');
const j = (over = {}) => ({ id: 'j1', agent: 'codex', title: 'Add tests', ticket: 'ABC-4', status: 'done', permission: 'edit-worktree', model: null, worktree: null, ...AT, ...over });
const CI_PR = { number: 12, url: 'https://github.com/o/r/pull/12', branch: 'feat/x', base: 'main', state: 'OPEN', checks: { total: 3, passed: 2, failed: 1, running: 0, failing: ['test (windows)'] }, review: null, mergeable: 'MERGEABLE', comments: 0, autoMerge: false, attention: 'ci-failed' };
const GREEN_PR = { ...CI_PR, checks: { total: 3, passed: 3, failed: 0, running: 0, failing: [] }, attention: null };

test('a job screen\'s status line says who, what happened and when, and what waits on the person', () => {
  assert.equal(jobStatusLine(j({ status: 'running', endedAt: null }), NOW), 'Codex · working 6m 0s · separate copy');
  assert.equal(jobStatusLine(j({ status: 'queued', permission: 'read-only', endedAt: null }), NOW), 'Codex · queued · read only');
  assert.equal(jobStatusLine(j({ status: 'needs-review' }), NOW), 'Codex finished 2m 0s ago · changes to review');
  assert.equal(jobStatusLine(j({ status: 'needs-review', pr: GREEN_PR }), NOW), 'Codex finished 2m 0s ago · new changes for PR #12');
  assert.equal(jobStatusLine(j({ status: 'in-review', pr: CI_PR }), NOW), 'PR #12 · checks failed: test (windows)');
  assert.equal(jobStatusLine(j({ status: 'in-review', pr: GREEN_PR }), NOW), 'PR #12 · 3 of 3 checks passed · review: none yet');
  assert.equal(jobStatusLine(j({ status: 'merged', pr: { ...GREEN_PR, state: 'MERGED' } }), NOW), 'PR #12 merged 2m 0s ago');
  assert.equal(jobStatusLine(j({ status: 'failed', error: 'boom' }), NOW), 'Codex stopped with an error 2m 0s ago');
  assert.equal(jobStatusLine(j({ status: 'lost' }), NOW), 'Codex stopped unexpectedly 2m 0s ago');
  assert.equal(jobStatusLine(j({ committed: { branch: 'feat/agent-work', head: 'abc', count: 2, commits: [] } }), NOW), 'Codex finished 2m 0s ago · 2 commits on feat/agent-work');
  assert.equal(jobStatusLine(j(), NOW), 'Codex finished 2m 0s ago');
  assert.equal(jobStatusLine(j({ status: 'kept' }), NOW), 'Kept 2m 0s ago');
  assert.equal(jobStatusLine(j({ status: 'discarded' }), NOW), 'Thrown away 2m 0s ago');
  assert.equal(jobStatusLine(j({ status: 'cancelled' }), NOW), 'Stopped 2m 0s ago');
});

test('PR wording: checks, review and what needs attention, each said once', () => {
  assert.equal(prChecks({ ...GREEN_PR, checks: { total: 0, passed: 0, failed: 0, running: 0, failing: [] } }), 'no checks');
  assert.equal(prChecks(CI_PR), '2 of 3 checks passed · 1 failed');
  assert.equal(prChecks({ ...GREEN_PR, checks: { total: 3, passed: 1, failed: 0, running: 2, failing: [] } }), '1 of 3 checks passed · 2 running');
  assert.equal(prSub(CI_PR), '2 of 3 checks passed · 1 failed · review: none yet');
  assert.equal(prSub({ ...GREEN_PR, review: 'APPROVED' }), '3 of 3 checks passed · review: approved');
  assert.equal(attentionLine(CI_PR), 'checks failed: test (windows)');
  assert.equal(attentionLine({ ...CI_PR, checks: { ...CI_PR.checks, failing: [] } }), 'checks failed');
  assert.equal(attentionLine({ ...GREEN_PR, attention: 'changes-requested' }), 'a reviewer asked for changes');
  assert.equal(attentionLine({ ...GREEN_PR, attention: 'conflict' }), 'it conflicts with the base branch');
  assert.equal(attentionLine({ ...GREEN_PR, attention: 'blocked', blocked: 'Required review missing' }), 'GitHub refused the merge: Required review missing');
});

test('list rows: a working job says who and how long, a finished one who and when', () => {
  assert.equal(workingRowLine(j({ status: 'running', endedAt: null }), NOW), 'Codex · 6m 0s');
  assert.equal(workingRowLine(j({ status: 'running', endedAt: null }), NOW, null, true), 'Codex · 6m 0s · from another chat');
  const quiet = { activity: 'x', lines: [], updatedAt: '2026-10-05T12:01:00Z' };
  assert.equal(workingRowLine(j({ status: 'running', endedAt: null }), NOW, quiet), 'Codex · 6m 0s · quiet for 1m 0s');
  assert.equal(doneRowLine(j(), NOW), 'Codex · finished 2m 0s ago');
  assert.equal(doneRowLine(j({ status: 'kept' }), NOW), 'Codex · kept 2m 0s ago');
  assert.equal(doneRowLine(j({ status: 'cancelled' }), NOW), 'Codex · stopped 2m 0s ago');
  assert.equal(doneRowLine(j({ status: 'merged', pr: GREEN_PR }), NOW), 'Codex · PR #12 merged 2m 0s ago');
  assert.equal(doneRowLine(j({ committed: { branch: 'feat/agent-work', head: 'abc', count: 2, commits: [] } }), NOW), 'Codex · committed to feat/agent-work 2m 0s ago');
});

test('Your turn: one item per thing waiting on the person, each with one button', () => {
  const thread = (latest, first = latest) => ({ id: latest.threadId ?? latest.id, latest, steps: first === latest ? [latest] : [latest, first], isMine: true });
  const review = thread(j({ id: 'n1', status: 'needs-review' }));
  const ci = thread(j({ id: 'p2', threadId: 'p1', title: 'Fix it', status: 'in-review', pr: CI_PR }), j({ id: 'p1', title: 'Fix rounding', status: 'continued' }));
  const comments = thread(j({ id: 'c1', status: 'in-review', pr: { ...GREEN_PR, attention: 'changes-requested', comments: 2 } }));
  const conflict = thread(j({ id: 'k1', status: 'in-review', pr: { ...GREEN_PR, attention: 'conflict' } }));
  const failed = thread(j({ id: 'f1', status: 'failed', title: 'Update the docs' }));
  const done = thread(j({ id: 'd1' }));
  const org = { needs: [review, ci, comments, conflict], working: [], review: [], done: [failed, done], doneHidden: 0, others: [] };
  const tickets = [
    { sprint: 's1', sprintName: 'Oct week 2', key: 'ABC-12', title: 'Payouts', state: 'parked', reason: 'Review failed twice on task 1' },
    { sprint: 's1', sprintName: 'Oct week 2', key: 'ABC-14', title: 'Export', state: 'plan-ready', reason: '' },
    { sprint: 's1', sprintName: 'Oct week 2', key: 'ABC-15', title: 'Import', state: 'no-tasks', reason: "Couldn't find tasks in this plan" },
  ];
  const items = turnItems(org, tickets);
  assert.deepEqual(items.map((x) => [x.id, x.title, x.reason, x.label]), [
    ['n1', 'Add tests', 'Codex finished · changes to review', 'Review'],
    ['p2', 'Fix rounding', 'PR #12 · checks failed: test (windows)', 'Send fix to Codex'],
    ['c1', 'Add tests', 'PR #12 · a reviewer asked for changes', 'Answer comments'],
    ['k1', 'Add tests', 'PR #12 · it conflicts with the base branch', 'Open'],
    ['f1', 'Update the docs', 'Codex stopped with an error', 'See what happened'],
    ['s1-ABC-12', 'ABC-12 Payouts', 'Oct week 2 · Review failed twice on task 1', 'See why'],
    ['s1-ABC-14', 'ABC-14 Export', 'Oct week 2 · plan ready', 'Review plan'],
    ['s1-ABC-15', 'ABC-15 Import', 'Oct week 2 · no tasks found in the plan', 'Review plan'],
  ]);
  assert.deepEqual(items[0].act, { name: 'openDetail', args: ['n1'] });
  assert.deepEqual(items[1].act, { name: 'fixOpen', args: ['p1', 'p2', 'codex', 'ci'] });
  assert.deepEqual(items[1].open, { name: 'openDetail', args: ['p2'] });
  assert.deepEqual(items[2].act, { name: 'fixOpen', args: ['c1', 'c1', 'codex', 'comments'] });
  assert.deepEqual(items[5].act, { name: 'openTicket', args: ['s1', 'ABC-12'] });
  assert.equal(isFailedTurn(failed), true);
  assert.equal(isFailedTurn(done), false);
  assert.deepEqual(turnItems({ needs: [], working: [], review: [], done: [], doneHidden: 0, others: [] }), []);
});

test('Your turn says when a thing waiting on the person was started in another chat', () => {
  const other = (latest) => ({ id: latest.id, latest, steps: [latest], isMine: false });
  const org = { needs: [other(j({ id: 'n1', status: 'needs-review' })), other(j({ id: 'k1', status: 'in-review', pr: { ...GREEN_PR, attention: 'conflict' } }))], working: [], review: [], done: [other(j({ id: 'f1', status: 'lost' }))], doneHidden: 0, others: [] };
  assert.deepEqual(turnItems(org).map((x) => x.reason), [
    'Codex finished · changes to review · from another chat',
    'PR #12 · it conflicts with the base branch · from another chat',
    'Codex stopped unexpectedly · from another chat',
  ]);
  // isMine missing (no chat id) is this chat's.
  assert.equal(turnItems({ ...org, needs: [{ ...org.needs[0], isMine: undefined }], done: [] })[0].reason, 'Codex finished · changes to review');
});

test('fromAnotherChat: a thread none of whose steps started in this chat; with no chat id, none is', () => {
  const steps = [j({ id: 'a', origin: { session: 'other' } }), j({ id: 'b', origin: { session: 'me' } })];
  assert.equal(fromAnotherChat(steps, 'me'), false);
  assert.equal(fromAnotherChat(steps.slice(0, 1), 'me'), true);
  assert.equal(fromAnotherChat([j({ id: 'c' })], 'me'), true);
  assert.equal(fromAnotherChat(steps.slice(0, 1), null), false);
});

test('a job\'s Details: ticket, access, agent and model, timing, branch, PR, its copy and its id', () => {
  assert.deepEqual(jobDetails(j({ model: 'gpt-5', worktree: 'C:\\podium\\j1', pr: GREEN_PR })), [
    'Ticket: ABC-4',
    'Access: Codex could edit files in a separate copy',
    'Agent: Codex (gpt-5)',
    'Started 2026-10-05 11:56 UTC · took 4m 0s',
    'Branch: feat/x',
    'PR: https://github.com/o/r/pull/12',
    "Podium's copy: C:\\podium\\j1",
    'Job id: j1',
  ]);
  assert.deepEqual(jobDetails(j({ ticket: 'NO-TICKET', startedAt: null, endedAt: null, base: 'feat/start' })), [
    'Ticket: none',
    'Access: Codex could edit files in a separate copy',
    'Agent: Codex',
    'Started 2026-10-05 11:56 UTC',
    'Started from: feat/start',
    'Job id: j1',
  ]);
  assert.deepEqual(jobDetails(j(), true), [
    'Ticket: ABC-4',
    'Access: Codex could edit files in a separate copy',
    'Agent: Codex',
    'Origin: another chat',
    'Started 2026-10-05 11:56 UTC · took 4m 0s',
    'Job id: j1',
  ]);
  assert.equal(andList(['A']), 'A');
  assert.equal(andList(['A', 'B']), 'A and B');
  assert.equal(andList(['A', 'B', 'C']), 'A, B and C');
  assert.equal(turnLabel('parked'), 'See why');
  assert.equal(turnLabel('plan-ready'), 'Review plan');
});
}

const tk = (over = {}) => ({ key: 'ABC-12', title: 'Payouts', state: 'pending', task: 1, of: 2, phase: null, agent: 'codex', reason: null, pr: null, reviews: 0, ...over });
const sp = (tickets, over = {}) => ({ id: 's1', name: 'Oct week 2', paused: false, finishedAt: null, autoMerge: false, maxParallel: 3, news: 0, tickets, ...over });

test('a sprint\'s status line counts what is done and says who is on what', () => {
  const running = tk({ key: 'ABC-11', state: 'running', task: 2, of: 3, phase: 'author', agent: 'muse' });
  assert.equal(sprintStatusLine(sp([running, tk({ state: 'parked' })])), '0 of 2 done · 1 of 3 running: ABC-11');
  assert.equal(sprintStatusLine(sp([{ ...running, phase: 'review', agent: 'claude' }, tk({ state: 'merged', pr: { number: 3 } })])), '1 of 2 done · 1 of 3 running: ABC-11');
  assert.equal(sprintStatusLine(sp([{ ...running, phase: 'plan' }])), '0 of 1 done · 1 of 3 running: ABC-11');
  assert.equal(sprintStatusLine(sp([tk(), tk({ key: 'ABC-13', state: 'stopped' })], { paused: true })), '0 of 2 done · 1 stopped · paused');
  assert.equal(sprintStatusLine(sp([tk(), tk()], { draft: true })), 'Draft · 2 tickets · not started');
  assert.equal(sprintStatusLine(sp([tk()], { draft: true })), 'Draft · 1 ticket · not started');
  assert.equal(sprintStatusLine({ id: 's9', name: null, unreadable: 'damaged', tickets: [] }), "Podium can't read this sprint's saved state");
  assert.equal(sprintStatusLine({ ...sp([]), status: '4 of 9 done' }), '4 of 9 done');
});

test('a board row says where its ticket stands in a few words', () => {
  assert.equal(ticketState(tk({ of: 2 }), true), '2 tasks');
  assert.equal(ticketState(tk({ of: 1, after: ['ABC-21'] }), true), '1 task · after ABC-21');
  assert.equal(ticketState(tk({ of: 0, tasks: [] }), true), 'no plan yet');
  assert.equal(ticketState(tk({ waitingOn: ['ABC-14'] })), 'starts after ABC-14');
  assert.equal(ticketState(tk()), 'waiting to start');
  assert.equal(ticketState(tk({ state: 'running', task: 4, of: 6, phase: 'author' })), 'task 4 of 6 · Codex working');
  assert.equal(ticketState(tk({ state: 'running', task: 4, of: 6, phase: 'fix-review' })), 'task 4 of 6 · Codex reviewing');
  assert.equal(ticketState(tk({ state: 'running', task: 4, of: 6, phase: 'fix' })), 'task 4 of 6 · Codex fixing');
  assert.equal(ticketState(tk({ state: 'running', phase: 'plan' })), 'Codex writing the plan');
  assert.equal(ticketState(tk({ state: 'running', phase: 'revise' })), 'Codex changing the plan');
  assert.equal(ticketState(tk({ state: 'parked', reason: 'x' })), 'needs you');
  assert.equal(ticketState(tk({ state: 'plan-ready' })), 'plan ready');
  assert.equal(ticketState(tk({ state: 'no-tasks' })), 'no tasks found in the plan');
  assert.equal(ticketState(tk({ state: 'pr-open', pr: { number: 20 } })), 'PR #20 open');
  assert.equal(ticketState(tk({ state: 'merged', pr: { number: 20 } })), 'PR #20 merged');
  assert.equal(ticketState(tk({ state: 'closed', pr: { number: 20 } })), 'PR #20 closed');
  assert.equal(ticketState(tk({ state: 'stopped' })), 'stopped');
  assert.equal(ticketState(tk({ state: 'waiting', reason: 'Codex hit its usage limit; trying again at 14:00' })), 'Codex hit its usage limit; trying again at 14:00');
});

test('a ticket screen\'s status line says what happens next', () => {
  assert.equal(ticketStatusLine(tk({ state: 'plan-ready' })), 'Plan ready · check it, then approve');
  assert.equal(ticketStatusLine(tk({ state: 'no-tasks' })), 'No tasks found in the plan · run it as one task, or ask for changes');
  assert.equal(ticketStatusLine(tk({ state: 'parked', reason: 'Review failed twice on task 1' })), 'Review failed twice on task 1');
  assert.equal(ticketStatusLine(tk({ state: 'parked' })), 'Stopped · needs you');
  assert.equal(ticketStatusLine(tk({ state: 'running', task: 4, of: 6, phase: 'author' })), 'Task 4 of 6 · Codex working');
  assert.equal(ticketStatusLine(tk({ state: 'running', phase: 'plan' })), 'Codex is writing the plan');
  assert.equal(ticketStatusLine(tk({ state: 'running', phase: 'revise' })), 'Codex is changing the plan');
  assert.equal(ticketStatusLine(tk({ waitingOn: ['ABC-14'] })), 'Starts when ABC-14 is merged on GitHub');
  assert.equal(ticketStatusLine(tk({ waitingOn: ['ABC-13', 'ABC-14'] })), 'Starts when ABC-13 and ABC-14 are merged on GitHub');
  assert.equal(ticketStatusLine(tk()), 'Waiting to start');
  assert.equal(ticketStatusLine(tk({ state: 'pr-open', pr: { number: 20 } })), 'PR #20 open');
  assert.equal(ticketStatusLine(tk({ state: 'closed', pr: { number: 20 } })), 'PR #20 closed without merging');
  assert.equal(ticketStatusLine(tk({ state: 'stopped' })), 'Stopped');
  assert.equal(ticketStatusLine(tk({ of: 0, tasks: [], writer: 'muse' }), true), 'No plan yet · Muse plans it first');
  assert.equal(ticketStatusLine(tk({ of: 2 }), true), '2 tasks · nothing runs until the sprint starts');
});

test('who works on a ticket, in one line', () => {
  const task = (agent, reviewer) => ({ n: 1, title: 't', agent, reviewer, status: 'to-do', canAssign: true });
  assert.equal(whoLine(tk({ of: 0, tasks: [], writer: 'codex', reviewer: 'claude' })), 'Codex writes, Claude reviews');
  assert.equal(whoLine(tk({ of: 0, tasks: [], writer: 'codex', reviewer: 'codex' })), 'Codex writes and reviews');
  assert.equal(whoLine(tk({ tasks: [task('muse', 'codex'), task('muse', 'codex')] })), 'Muse writes, Codex reviews');
  assert.equal(whoLine(tk({ tasks: [task('muse', 'codex'), task('claude', 'codex')] })), 'several agents');
  assert.equal(whoLine(tk({ writers: ['muse'], reviewers: ['codex'] })), 'Muse writes, Codex reviews');
  assert.equal(optionsLine(sp([])), '3 at once');
  assert.equal(optionsLine(sp([], { autoMerge: true, maxParallel: null })), '3 at once · merge when green');
});

test('agents, setup and settings say their state in their heading', () => {
  const a = (over) => ({ name: 'codex', label: 'Codex', installed: true, enabled: true, signedIn: true, ...over });
  assert.equal(agentLine(a({})), 'Codex · ready');
  assert.equal(agentState(a({ signedIn: false })), 'not signed in');
  assert.equal(agentLine(a({ signedIn: false })), 'Codex · not signed in');
  assert.equal(agentLine(a({ enabled: false })), 'Codex · switched off');
  assert.equal(agentLine(a({ installed: false })), 'Codex · not installed');
  assert.equal(agentNeedsFix(a({ signedIn: false })), true);
  assert.equal(agentNeedsFix(a({ signedIn: null })), false);
  assert.equal(agentNeedsFix(a({ enabled: false, signedIn: false })), false);
  assert.equal(setupSummary([{ ok: true, text: 'x' }, { ok: null, text: 'y' }]), 'all good');
  assert.equal(setupSummary([{ ok: false, text: 'x' }]), '1 thing to fix');
  assert.equal(setupSummary([{ ok: false, text: 'x' }, { ok: false, text: 'y' }]), '2 things to fix');
  const s = { instructions: '', repoInstructions: {}, retention: { compressDays: 30, deleteDays: 90 }, worktreeWarnMB: 500, longJobMinutes: 30 };
  assert.equal(instructionsSummary(s), 'none');
  assert.equal(instructionsSummary({ ...s, instructions: 'Follow AGENTS.md' }), 'set');
  assert.equal(instructionsSummary({ ...s, repoInstructions: { repo: 'Use pnpm' } }), 'set');
  assert.equal(storageSummary(s), '30 / 90 days');
  assert.equal(limitsSummary(s), '500 MB, 30 min');
});

test('New job says the access level in one line, and its More options heading sums up what is set', () => {
  assert.equal(accessLine('edit-worktree'), 'Works in a separate copy · you review before keeping');
  assert.equal(accessLine('read-only'), 'Only reads files · changes nothing');
  assert.equal(accessLine('own-config'), "Uses the agent's own settings · may edit your files directly");
  assert.equal(accessLine('full-access'), 'Full access · can change anything on this computer');
  const d = { agent: 'codex', task: '', permission: 'edit-worktree', includeUncommitted: false, model: '', ticket: '', base: '' };
  assert.equal(moreSummary(d), 'separate copy');
  assert.equal(moreSummary({ ...d, ticket: ' ABC-6 ', base: 'feat/x', model: 'gpt-5' }), 'separate copy · ABC-6 · from feat/x · gpt-5');
});

test('Podium\'s chat line says what happened and where to act, once', () => {
  const pr = { number: 12, url: 'https://github.com/o/r/pull/12', branch: 'feat/x', base: 'main', title: 'Add dark mode', autoMerge: false };
  const j2 = (over) => job({ title: 'Add dark mode', ...over });
  assert.equal(finishedHeadline(j2({ status: 'needs-review', pr })), 'Podium: Codex finished "Add dark mode": new changes for PR #12, to push in the pane.');
  assert.equal(finishedHeadline(j2({ committed: { branch: 'feat/x', head: 'a', count: 1, commits: [] } })), 'Podium: Codex finished "Add dark mode": committed to feat/x.');
  assert.equal(finishedHeadline(j2({})), 'Podium: Codex finished "Add dark mode".');
  assert.equal(finishedHeadline(j2({ status: 'lost' })), 'Podium: Codex stopped unexpectedly on "Add dark mode".');
  assert.equal(finishedHeadline(j2({ status: 'in-review', pr })), 'Podium: PR #12 opened: "Add dark mode".');
  assert.equal(finishedHeadline(j2({ status: 'merged', pr })), 'Podium: PR #12 merged: "Add dark mode".');
  assert.match(REPLY_RULE, /one or two short sentences/);
  assert.match(REPLY_RULE, /ending with the decision/);
  assert.match(REPLY_RULE, /Leave out paths, ids, branches, timings and how follow-ups work unless they ask\./);
  assert.ok(finishedMessage(j2({ status: 'in-review', pr }), null).endsWith(REPLY_RULE));
  assert.ok(!finishedMessage(j2({ status: 'in-review', pr }), null, true).includes(REPLY_RULE));
});

// ---- State colours ----

test('a sprint\'s tone: needs you first, then working, else neutral; an unreadable one failed', () => {
  const t = (state) => ({ key: 'A-1', title: 'T', state });
  assert.equal(sprintTone({ tickets: [t('pending'), t('parked')] }), 'needs');
  assert.equal(sprintTone({ tickets: [t('plan-ready'), t('running')] }), 'needs');
  assert.equal(sprintTone({ tickets: [t('no-tasks')] }), 'needs');
  assert.equal(sprintTone({ tickets: [t('pending'), t('running')] }), 'working');
  assert.equal(sprintTone({ tickets: [t('pending'), t('waiting')] }), 'neutral');
  assert.equal(sprintTone({ draft: true, tickets: [t('pending')] }), 'neutral');
  assert.equal(sprintTone({ tickets: [] }), 'neutral');
  assert.equal(sprintTone({ unreadable: 'damaged', tickets: [] }), 'failed');
  // A card sent with rows left out carries its tone, counted over every ticket.
  assert.equal(sprintTone({ tone: 'needs', tickets: [] }), 'needs');
});

test('a ticket\'s tone follows its state', () => {
  for (const s of ['parked', 'plan-ready', 'no-tasks']) assert.equal(ticketTone(s), 'needs');
  assert.equal(ticketTone('running'), 'working');
  for (const s of ['pr-open', 'merged']) assert.equal(ticketTone(s), 'done');
  for (const s of ['stopped', 'closed']) assert.equal(ticketTone(s), 'failed');
  for (const s of ['pending', 'waiting', 'whatever']) assert.equal(ticketTone(s), 'neutral');
});

test('a finished job is done, or failed when it failed, was lost or was cancelled', () => {
  for (const s of ['failed', 'lost', 'cancelled']) assert.equal(finishedTone(job({ status: s })), 'failed');
  for (const s of ['done', 'kept', 'discarded', 'merged', 'closed']) assert.equal(finishedTone(job({ status: s })), 'done');
});

test('a job screen\'s tone is toneOf, and a PR that needs attention is needs', () => {
  const pr = (over = {}) => ({ number: 12, state: 'OPEN', attention: null, ...over });
  assert.equal(jobTone(job({ status: 'running' })), 'working');
  assert.equal(jobTone(job({ status: 'needs-review' })), 'needs');
  assert.equal(jobTone(job({ status: 'failed' })), 'failed');
  assert.equal(jobTone(job({ status: 'done' })), 'done');
  assert.equal(jobTone(job({ status: 'in-review', pr: pr() })), 'neutral');
  assert.equal(jobTone(job({ status: 'in-review', pr: pr({ attention: 'ci-failed' }) })), 'needs');
  assert.equal(jobTone(job({ status: 'done', pr: pr({ attention: 'ci-failed' }) })), 'needs');
  assert.equal(jobTone(job({ status: 'merged', pr: pr({ state: 'MERGED', attention: 'ci-failed' }) })), 'done');
});

test('a waiting ticket says whether it waits for a free slot or is starting; the defaults are 3 at once', () => {
  assert.equal(ticketState(tk({ slot: 'full' })), 'waiting for a free slot');
  assert.equal(ticketState(tk({ slot: 'free' })), 'starting');
  assert.equal(ticketStatusLine(tk({ slot: 'full' })), 'Waiting for a free slot');
  assert.equal(ticketStatusLine(tk({ slot: 'free' })), 'Starting');
  assert.equal(ticketState(tk({ slot: 'full', waitingOn: ['ABC-14'] })), 'starts after ABC-14');
  assert.equal(optionsLine({}), '3 at once');
  const two = sp([tk({ key: 'ABC-11', state: 'running', phase: 'author', task: 1 }), tk({ key: 'ABC-13', state: 'running', phase: 'review', task: 2 })]);
  assert.equal(sprintStatusLine(two), '0 of 2 done · 2 of 3 running: ABC-11, ABC-13');
});

// A ticket waiting out a usage limit holds a slot, so "1 of 3 running" beside "waiting for a free slot"
// read as a contradiction. The count says how many wait too.
test('tickets waiting out a usage limit are counted beside the running ones, in the headline and the status line', async () => {
  const { sprintHeadline } = await import('../mod/view.js');
  const limit = { state: 'waiting', reason: 'Usage limit: trying again at 14:05' };
  const s = sp([
    tk({ key: 'ABC-11', state: 'running', phase: 'author', task: 1 }), tk({ key: 'ABC-12', ...limit }), tk({ key: 'ABC-13', ...limit }), tk({ key: 'ABC-14', slot: 'full' }),
  ]);
  assert.equal(sprintStatusLine(s), '0 of 4 done · 1 of 3 running, 2 waiting: ABC-11');
  assert.equal(sprintHeadline(s), 'Sprint · Oct week 2 · 0 of 4 tickets done · 1 of 3 running, 2 waiting: Codex working on ABC-11 task 1');
  const none = sp([tk({ key: 'ABC-12', ...limit }), tk({ key: 'ABC-14', slot: 'free' })]);
  assert.equal(sprintStatusLine(none), '0 of 2 done · 0 of 3 running, 1 waiting');
  assert.equal(sprintHeadline(none), 'Sprint · Oct week 2 · 0 of 2 tickets done · 0 of 3 running, 1 waiting');
});

// ---- Finished sprints in Done and Other chats, and other chats' sprints labelled ----
const fsTicket = (key, state) => ({ key, title: key, state, task: 1, of: 1, phase: null, agent: 'codex', reason: null, pr: ['merged', 'closed', 'pr-open'].includes(state) ? { number: 7 } : null, reviews: 0 });
const fsSprint = (over = {}) => ({ id: 's1', name: 'Oct week 2', draft: false, discarded: false, paused: false, finishedAt: '2026-10-05T11:50:00Z', autoMerge: false, news: 0, tickets: [fsTicket('A-1', 'merged'), fsTicket('A-2', 'merged')], ...over });

test('isFinishedSprint: every ticket ended, archived or not; never a draft, a discarded or an unreadable sprint', () => {
  assert.equal(isFinishedSprint(fsSprint({ draft: true })), false, 'a draft');
  assert.equal(isFinishedSprint(fsSprint({ draft: true, discarded: true })), false, 'a discarded draft');
  assert.equal(isFinishedSprint(fsSprint({ discarded: true })), false, 'discarded');
  // A sprint archived because it ended (its news delivered) is still finished; a thrown-away one never is.
  assert.equal(isFinishedSprint(fsSprint({ archived: true })), true, 'archived after it ended');
  assert.equal(isFinishedSprint(fsSprint({ archived: true, discarded: true })), false, 'archived because it was thrown away');
  assert.equal(isFinishedSprint(fsSprint({ unreadable: 'damaged', tickets: [] })), false, 'unreadable');
  assert.equal(isFinishedSprint(fsSprint({ finishedAt: null, tickets: [fsTicket('A-1', 'merged'), fsTicket('A-2', 'running')] })), false, 'open');
  assert.equal(isFinishedSprint(fsSprint({ tickets: [fsTicket('A-1', 'merged'), fsTicket('A-2', 'pr-open')] })), false, 'a PR still open');
  assert.equal(isFinishedSprint(fsSprint()), true, 'all merged');
  assert.equal(isFinishedSprint(fsSprint({ tickets: [fsTicket('A-1', 'merged'), fsTicket('A-2', 'stopped')] })), true, 'merged plus stopped');
  assert.equal(isFinishedSprint(fsSprint({ tickets: [] })), false, 'no tickets is not finished');
  // A finished sprint sent as its row (no tickets, `more` counted) is still finished, and not open.
  const row = { id: 's1', name: 'Oct week 2', finishedAt: '2026-10-05T11:50:00Z', brief: true, tickets: [], more: 2, ended: true, tone: 'done', status: '2 of 2 done' };
  assert.equal(isFinishedSprint(row), true);
  assert.equal(isOpenSprint(row), false);
});

test('finishedSprintTone: all merged is done; any stopped or closed is failed; a row carries it', () => {
  assert.equal(finishedSprintTone(fsSprint()), 'done');
  assert.equal(finishedSprintTone(fsSprint({ tickets: [fsTicket('A-1', 'merged'), fsTicket('A-2', 'stopped')] })), 'failed');
  assert.equal(finishedSprintTone(fsSprint({ tickets: [fsTicket('A-1', 'merged'), fsTicket('A-2', 'closed')] })), 'failed');
  assert.equal(finishedSprintTone({ tickets: [], more: 2, ended: true, tone: 'failed' }), 'failed');
});

test('a finished sprint\'s row line is its status line and how long ago it finished, as a Done job\'s', () => {
  assert.equal(finishedSprintLine(fsSprint(), NOW), '2 of 2 done · finished 10m 0s ago');
  assert.equal(finishedSprintLine(fsSprint({ tickets: [fsTicket('A-1', 'merged'), fsTicket('A-2', 'stopped')] }), NOW), '1 of 2 done · 1 stopped · finished 10m 0s ago');
  assert.equal(finishedSprintLine(fsSprint({ finishedAt: null, tickets: [fsTicket('A-1', 'stopped')] }), NOW), '0 of 1 done · 1 stopped', 'no time when none was recorded');
});

test('another chat\'s sprint says so in the same words as a job row', () => {
  assert.equal(FROM_OTHER_CHAT, 'from another chat');
  const running = fsSprint({ finishedAt: null, tickets: [{ ...fsTicket('A-1', 'running'), task: 1, of: 2, phase: 'author' }] });
  // The status line for a running sprint ("1 of 3 running: A-1"), with the label after it.
  assert.equal(sprintWorkingLine(running, true), '0 of 1 done · 1 of 3 running: A-1 · from another chat');
  assert.equal(sprintWorkingLine(running, false), '0 of 1 done · 1 of 3 running: A-1');
  assert.ok(workingRowLine(job(), NOW, null, true).endsWith(` · ${FROM_OTHER_CHAT}`));
});

test('a sprint is this chat\'s when its chat is this one, or no chat is known on either side', () => {
  assert.equal(isSprintMine({ chat: 'me' }, 'me'), true);
  assert.equal(isSprintMine({ chat: 'other' }, 'me'), false);
  assert.equal(isSprintMine({ chat: 'other' }, null), true, 'no session: everything is this chat\'s, as organise');
  assert.equal(isSprintMine({ chat: null }, 'me'), true, 'a sprint with no chat (its news goes to any chat) is not labelled');
  assert.equal(isSprintMine({}, 'me'), true);
});

test('finishedSprints splits finished sprints into this chat\'s and other chats\', newest first', () => {
  assert.equal(FINISHED_SPRINTS, 5);
  const at = (m) => `2026-10-05T${String(10 + Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00Z`;
  const list = [
    fsSprint({ id: 'a', chat: 'me', finishedAt: at(1) }),
    fsSprint({ id: 'b', chat: 'other', finishedAt: at(5) }),
    fsSprint({ id: 'c', chat: 'me', finishedAt: at(9) }),
    fsSprint({ id: 'd', chat: 'me', finishedAt: null, tickets: [fsTicket('A-1', 'running')] }),
    fsSprint({ id: 'e', chat: 'other', finishedAt: at(2) }),
  ];
  const out = finishedSprints(list, 'me');
  assert.deepEqual(out.mine.map((s) => s.id), ['c', 'a']);
  assert.deepEqual(out.others.map((s) => s.id), ['b', 'e']);
  assert.deepEqual(finishedSprints(list, null).mine.map((s) => s.id), ['c', 'b', 'e', 'a']);
  assert.deepEqual(finishedSprints(undefined, 'me'), { mine: [], others: [] });
});

test('the older finished sprints a fold leaves out are counted in one dim line', () => {
  assert.equal(olderSprintsLine(2), '2 older sprints are not shown here; ask Claude for them.');
  assert.equal(olderSprintsLine(1), '1 older sprint is not shown here; ask Claude for it.');
});
