import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { saveAdapter } from '../engine/adapters/registry.js';
import { dispatch } from '../engine/dispatch.js';
import { readJob, updateJob, findJobDir, createJob } from '../engine/store.js';
import { slugOf, branchName, prBody, openPr, pushPr, checksOf, attentionOf, mergeDecision, refreshPr, mergePr, setAutoMerge, fixPrompt, updateThread, browsePr, finishLocked, FINISH_LOCK, watchAgain } from '../engine/pr.js';
import { keep } from '../engine/review.js';
import { tempRoot, fakeAdapter, waitFor, ghWorld } from './helpers.js';
import { setSetting } from '../engine/settings.js';
import { projectKey } from '../engine/paths.js';

const CREATED = { match: ['pr', 'create'], stdout: 'https://github.com/o/r/pull/12\n' };

async function editJob(root, repo, over = {}) {
  const res = await dispatch(root, { agent: 'fake', permission: 'edit-worktree', cwd: repo, prompt: 'Add the fake file', ticket: 'ABC-12', ...over });
  return waitFor(() => { const j = readJob(res.dir); return ['needs-review', 'done', 'failed'].includes(j.status) && j; });
}

test('branch names follow the pattern, lower-cased, with a slug of the title', () => {
  assert.equal(slugOf('Add the CSV export (v2)!'), 'add-the-csv-export-v2');
  assert.equal(branchName('feat/{ticket}-{slug}', 'ABC-12', 'Add the CSV export'), 'feat/abc-12-add-the-csv-export');
  assert.equal(branchName('feat/{ticket}-{slug}', null, 'Add the CSV export'), 'podium/add-the-csv-export');
  assert.equal(branchName('feat/{ticket}-{slug}', 'NO-TICKET', 'Add it'), 'podium/add-it');
  assert.ok(slugOf('x'.repeat(100)).length <= 40);
});

test('the PR body has the summary and the steps, and no attribution', () => {
  const body = prBody([{ step: 1, agent: 'claude', title: 'Build it' }, { step: 2, agent: 'codex', title: 'Review it' }], 'Built and reviewed.');
  assert.match(body, /Built and reviewed\./);
  assert.match(body, /1\. claude: Build it\n2\. codex: Review it/);
  assert.doesNotMatch(body, /Co-Authored-By|Generated with/i);
});

test('Open PR commits in the copy on a ticket branch, pushes, creates the PR and marks the thread in review', async () => {
  const root = tempRoot();
  saveAdapter(root, fakeAdapter('edit'));
  const w = ghWorld([CREATED]);
  const job = await editJob(root, w.repo);
  const out = await openPr(root, job.id, { env: w.env });
  assert.equal(out.status, 'in-review');
  assert.equal(out.delivered, false);
  assert.equal(out.pr.number, 12);
  assert.equal(out.pr.branch, 'feat/abc-12-add-the-fake-file');
  assert.equal(out.pr.title, job.title, 'the PR keeps its own title for later messages');
  assert.equal(out.pr.state, 'OPEN');
  assert.equal(w.git(w.remote, 'log', '-1', '--format=%s', 'feat/abc-12-add-the-fake-file'), 'Add the fake file');
  assert.equal(fs.existsSync(path.join(w.repo, 'fake-edit.txt')), false, "the user's folder is untouched");
  const create = w.calls().find((c) => c[0] === 'pr' && c[1] === 'create');
  assert.deepEqual(create.slice(create.indexOf('--head'), create.indexOf('--head') + 2), ['--head', 'feat/abc-12-add-the-fake-file']);
  assert.deepEqual(create.slice(create.indexOf('--base'), create.indexOf('--base') + 2), ['--base', 'main']);
  await assert.rejects(keep(root, job.id), (e) => e.code === 'pr-open');
});

test('a follow-up on a PR thread starts from the PR commit, so its diff is only the new work', async () => {
  const root = tempRoot();
  saveAdapter(root, fakeAdapter('edit'));
  const w = ghWorld([CREATED]);
  const opened = await openPr(root, (await editJob(root, w.repo)).id, { env: w.env });
  saveAdapter(root, fakeAdapter('ok'));
  const res = await dispatch(root, { agent: 'fake', cwd: w.repo, prompt: 'Nothing to change', followUp: opened.id });
  const next = await waitFor(() => { const j = readJob(res.dir); return ['needs-review', 'done', 'failed'].includes(j.status) && j; });
  assert.equal(next.pr.number, 12);
  assert.equal(next.status, 'done', 'no new changes');
  assert.ok(fs.existsSync(next.worktree), 'the PR copy stays');
});

test('Open PR refuses work with no changes, and a repo with no remote', async () => {
  const root = tempRoot();
  saveAdapter(root, fakeAdapter('edit'));
  const w = ghWorld([CREATED]);
  w.git(w.repo, 'remote', 'remove', 'origin');
  const job = await editJob(root, w.repo);
  await assert.rejects(openPr(root, job.id, { env: w.env }), (e) => e.code === 'no-remote');
});

// Push, refresh, merge.
const ROLLUP = [
  { __typename: 'CheckRun', name: 'test (ubuntu)', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/o/r/actions/runs/101/job/1' },
  { __typename: 'CheckRun', name: 'test (windows)', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/o/r/actions/runs/102/job/2' },
  { __typename: 'CheckRun', name: 'test (macos)', status: 'IN_PROGRESS', conclusion: null, detailsUrl: 'https://github.com/o/r/actions/runs/103/job/3' },
  { __typename: 'StatusContext', context: 'ci/legacy', state: 'SUCCESS' },
];

test('checks, attention and the merge decision', () => {
  const c = checksOf(ROLLUP);
  assert.deepEqual(c, { total: 4, passed: 2, failed: 1, running: 1, failing: ['test (windows)'], failedRunId: '102' });
  const green = { state: 'OPEN', checks: checksOf([ROLLUP[0], ROLLUP[3]]), mergeable: 'MERGEABLE', review: null, blocked: null };
  assert.equal(mergeDecision(green), true);
  assert.equal(mergeDecision({ ...green, checks: c }), false);
  assert.equal(mergeDecision({ ...green, review: 'CHANGES_REQUESTED' }), false);
  assert.equal(mergeDecision({ ...green, mergeable: 'CONFLICTING' }), false);
  assert.equal(mergeDecision({ ...green, checks: checksOf([]) }), true, 'a repo with no CI is green');
  assert.equal(attentionOf({ ...green, checks: c }), 'ci-failed');
  assert.equal(attentionOf({ ...green, review: 'CHANGES_REQUESTED' }), 'changes-requested');
  assert.equal(attentionOf({ ...green, mergeable: 'CONFLICTING' }), 'conflict');
  assert.equal(attentionOf({ ...green, blocked: 'Protected branch' }), 'blocked');
  assert.equal(attentionOf(green), null);
});

test('refresh reads gh pr view into the thread', async () => {
  const root = tempRoot();
  saveAdapter(root, fakeAdapter('edit'));
  const w = ghWorld([CREATED, { match: ['pr', 'view'], stdout: { state: 'OPEN', mergeable: 'MERGEABLE', reviewDecision: 'CHANGES_REQUESTED', statusCheckRollup: ROLLUP, comments: [{}, {}], reviews: [{}] } }]);
  const job = await openPr(root, (await editJob(root, w.repo)).id, { env: w.env });
  const fresh = await refreshPr(root, job.id, { env: w.env });
  assert.equal(fresh.status, 'in-review');
  assert.equal(fresh.pr.checks.failed, 1);
  assert.equal(fresh.pr.review, 'CHANGES_REQUESTED');
  assert.equal(fresh.pr.attention, 'ci-failed');
  assert.equal(fresh.pr.comments, 3);
  assert.ok(fresh.pr.checkedAt);
});

test('a PR closed on GitHub ends the thread as closed and removes the copy', async () => {
  const root = tempRoot();
  saveAdapter(root, fakeAdapter('edit'));
  const w = ghWorld([CREATED, { match: ['pr', 'view'], stdout: { state: 'CLOSED', mergeable: 'UNKNOWN', reviewDecision: '', statusCheckRollup: [], comments: [], reviews: [] } }]);
  const job = await openPr(root, (await editJob(root, w.repo)).id, { env: w.env });
  const after = await refreshPr(root, job.id, { env: w.env });
  assert.equal(after.status, 'closed');
  assert.equal(after.delivered, false);
  assert.equal(fs.existsSync(job.worktree), false);
});

test('push commits a follow-up and pushes it to the PR branch', async () => {
  const root = tempRoot();
  saveAdapter(root, fakeAdapter('edit'));
  const w = ghWorld([CREATED]);
  const opened = await openPr(root, (await editJob(root, w.repo)).id, { env: w.env });
  fs.writeFileSync(path.join(opened.worktree, 'more.txt'), 'more\n');
  updateJob(root, findJobDir(root, opened.id), { status: 'needs-review' }, 'test');
  const pushed = await pushPr(root, opened.id);
  assert.equal(pushed.status, 'in-review');
  assert.equal(w.git(w.remote, 'show', `${opened.pr.branch}:more.txt`), 'more');
});

test('merge merges, removes the copy and the branch, and queues the merged message', async () => {
  const root = tempRoot();
  saveAdapter(root, fakeAdapter('edit'));
  const w = ghWorld([CREATED, { match: ['pr', 'merge'], stdout: '' }]);
  const opened = await openPr(root, (await editJob(root, w.repo)).id, { env: w.env });
  const merged = await mergePr(root, opened.id, { env: w.env });
  assert.equal(merged.status, 'merged');
  assert.equal(merged.pr.state, 'MERGED');
  assert.equal(merged.delivered, false);
  assert.equal(fs.existsSync(opened.worktree), false);
  assert.equal(w.git(w.remote, 'branch', '--list', opened.pr.branch), '');
  const call = w.calls().find((c) => c[0] === 'pr' && c[1] === 'merge');
  assert.deepEqual(call.slice(0, 4), ['pr', 'merge', '12', '--merge']);
});

test('a refused merge is recorded as blocked and nothing is removed', async () => {
  const root = tempRoot();
  saveAdapter(root, fakeAdapter('edit'));
  const w = ghWorld([CREATED, { match: ['pr', 'merge'], code: 1, stderr: 'Pull request is not mergeable: protected branch rules\n' }]);
  const opened = await openPr(root, (await editJob(root, w.repo)).id, { env: w.env });
  const after = await mergePr(root, opened.id, { env: w.env });
  assert.equal(after.status, 'in-review');
  assert.match(after.pr.blocked, /protected branch/);
  assert.equal(after.pr.attention, 'blocked');
  assert.ok(fs.existsSync(opened.worktree));
  assert.equal((await setAutoMerge(root, opened.id, true)).pr.autoMerge, true);
});

// Fix prompts.
test('fix prompts carry the failed log tail or the review comments', async () => {
  const root = tempRoot();
  saveAdapter(root, fakeAdapter('edit'));
  const log = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join('\n');
  const w = ghWorld([
    CREATED,
    { match: ['run', 'view', '102'], stdout: log },
    { match: ['repo', 'view'], stdout: { nameWithOwner: 'o/r' } },
    { match: ['api'], stdout: [{ path: 'src/a.js', line: 4, body: 'Handle null here.', user: { login: 'ana' } }] },
    { match: ['pr', 'view'], stdout: { reviews: [{ state: 'CHANGES_REQUESTED', body: 'Needs tests.', author: { login: 'ana' } }, { state: 'APPROVED', body: '', author: { login: 'bo' } }] } },
  ]);
  const opened = await openPr(root, (await editJob(root, w.repo)).id, { env: w.env });
  updateThread(root, opened, { pr: { ...opened.pr, checks: { ...opened.pr.checks, failed: 1, failing: ['test (windows)'], failedRunId: '102' } } });
  const ci = await fixPrompt(root, opened.id, 'ci', { env: w.env });
  assert.match(ci.text, /CI failed on PR #12 \(test \(windows\)\)/);
  assert.match(ci.text, /line 300/);
  assert.match(ci.text, /line 101\n/);
  assert.doesNotMatch(ci.text, /line 100\n/);
  const comments = await fixPrompt(root, opened.id, 'comments', { env: w.env });
  assert.match(comments.text, /src\/a\.js:4 \(ana\): Handle null here\./);
  assert.match(comments.text, /ana: Needs tests\./);
  assert.doesNotMatch(comments.text, /bo:/);
  await assert.rejects(fixPrompt(root, opened.id, 'other', { env: w.env }), (e) => e.code === 'bad-kind');
});

// Repeated presses must not break Open PR.
test('a second Open PR while one runs is refused, and the first still finishes', async () => {
  const root = tempRoot();
  saveAdapter(root, fakeAdapter('edit'));
  const w = ghWorld([CREATED]);
  const job = await editJob(root, w.repo);
  const [a, b] = await Promise.allSettled([openPr(root, job.id, { env: w.env }), openPr(root, job.id, { env: w.env })]);
  const ok = [a, b].filter((r) => r.status === 'fulfilled');
  const refused = [a, b].filter((r) => r.status === 'rejected');
  assert.equal(ok.length, 1);
  assert.equal(refused[0].reason.code, 'pr-busy');
  assert.equal(ok[0].value.pr.branch, 'feat/abc-12-add-the-fake-file');
  assert.equal(w.git(w.remote, 'log', '-1', '--format=%s', 'feat/abc-12-add-the-fake-file'), 'Add the fake file');
});

test('a retry after a failed PR create carries on: same branch, one commit', async () => {
  const root = tempRoot();
  saveAdapter(root, fakeAdapter('edit'));
  const w = ghWorld([{ match: ['pr', 'create'], code: 1, stderr: 'GraphQL: something went wrong\n' }]);
  const job = await editJob(root, w.repo);
  await assert.rejects(openPr(root, job.id, { env: w.env }), (e) => e.code === 'gh-failed' && /something went wrong/.test(e.message));
  const spec = JSON.parse(fs.readFileSync(w.env.PODIUM_FAKE_GH, 'utf8'));
  spec.responses = [CREATED];
  fs.writeFileSync(w.env.PODIUM_FAKE_GH, JSON.stringify(spec));
  const out = await openPr(root, job.id, { env: w.env });
  assert.equal(out.pr.branch, 'feat/abc-12-add-the-fake-file');
  assert.equal(w.git(job.worktree, 'rev-list', '--count', 'main..HEAD'), '1');
});

test('git failures say what git said', async () => {
  const { gitIn } = await import('../engine/worktree.js');
  await assert.rejects(gitIn(tempRoot(), ['log']), (e) => e.code === 'git-failed' && /not a git repository/i.test(e.message));
});

test('gh runs without prompts, and one that does not answer in time fails plainly', async () => {
  const { runGh } = await import('../engine/gh.js');
  const w = ghWorld([
    { match: ['env'], echoEnv: ['GH_PROMPT_DISABLED', 'GIT_TERMINAL_PROMPT', 'GCM_INTERACTIVE'] },
    { match: ['slow'], ms: 15_000, stdout: 'late\n' },
  ]);
  assert.deepEqual(JSON.parse(await runGh(['env'], { cwd: w.repo, env: w.env })), { GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' });
  const t0 = Date.now();
  await assert.rejects(runGh(['slow'], { cwd: w.repo, env: w.env, timeoutMs: 1000 }), (e) => e.code === 'gh-failed' && e.message === "GitHub's gh tool didn't answer within 1 second.");
  assert.ok(Date.now() - t0 < 10_000, 'it gave up on its own clock');
});

test('Open on GitHub asks gh to open the PR\'s page, and changes nothing', async () => {
  const root = tempRoot();
  saveAdapter(root, fakeAdapter('edit'));
  const w = ghWorld([CREATED, { match: ['pr', 'view', '12', '--web'], stdout: '' }]);
  const opened = await openPr(root, (await editJob(root, w.repo)).id, { env: w.env });
  const before = readJob(findJobDir(root, opened.id));
  const r = await browsePr(root, opened.id, { env: w.env });
  assert.equal(r.opened, 'https://github.com/o/r/pull/12');
  assert.ok(w.calls().some((c) => c.join(' ') === 'pr view 12 --web'));
  assert.deepEqual(readJob(findJobDir(root, opened.id)), before);
});

const REPO_VIEW = (over = {}) => ({ match: ['repo', 'view'], stdout: { viewerDefaultMergeMethod: 'SQUASH', mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: true, ...over } });
const mergeCall = (w) => w.calls().filter((c) => c[0] === 'pr' && c[1] === 'merge').at(-1).slice(0, 4);

test('merge uses the repo\'s default method, asked once per PR', async () => {
  const root = tempRoot();
  saveAdapter(root, fakeAdapter('edit'));
  const w = ghWorld([CREATED, REPO_VIEW(), { match: ['pr', 'merge'], code: 1, stderr: 'Base branch was modified\n' }]);
  const opened = await openPr(root, (await editJob(root, w.repo)).id, { env: w.env });
  const blocked = await mergePr(root, opened.id, { env: w.env });
  assert.deepEqual(mergeCall(w), ['pr', 'merge', '12', '--squash']);
  assert.equal(blocked.pr.methods.viewerDefaultMergeMethod, 'SQUASH', 'kept on the PR record');
  await mergePr(root, opened.id, { env: w.env });
  assert.equal(w.calls().filter((c) => c[0] === 'repo').length, 1, 'GitHub is asked once per PR');
});

test('a repo\'s own merge method in Podium wins over GitHub\'s default', async () => {
  const root = tempRoot();
  saveAdapter(root, fakeAdapter('edit'));
  const w = ghWorld([CREATED, REPO_VIEW(), { match: ['pr', 'merge'], stdout: '' }]);
  setSetting(root, 'repoMergeMethod', { [projectKey(w.repo)]: 'rebase' });
  const opened = await openPr(root, (await editJob(root, w.repo)).id, { env: w.env });
  await mergePr(root, opened.id, { env: w.env });
  assert.deepEqual(mergeCall(w), ['pr', 'merge', '12', '--rebase']);
});

test('a method the repo does not allow gives way to the first it does', async () => {
  const root = tempRoot();
  saveAdapter(root, fakeAdapter('edit'));
  const w = ghWorld([CREATED, REPO_VIEW({ viewerDefaultMergeMethod: 'MERGE', mergeCommitAllowed: false }), { match: ['pr', 'merge'], stdout: '' }]);
  const opened = await openPr(root, (await editJob(root, w.repo)).id, { env: w.env });
  await mergePr(root, opened.id, { env: w.env });
  assert.deepEqual(mergeCall(w), ['pr', 'merge', '12', '--squash']);
});

test('a PR event on plain work records when it happened, for its chat\'s grace', async () => {
  const root = tempRoot();
  saveAdapter(root, fakeAdapter('edit'));
  const w = ghWorld([CREATED, { match: ['pr', 'merge'], stdout: '' }]);
  const opened = await openPr(root, (await editJob(root, w.repo)).id, { env: w.env });
  assert.ok(Math.abs(Date.parse(opened.notifiedAt) - Date.now()) < 60_000);
  const merged = await mergePr(root, opened.id, { env: w.env });
  assert.ok(Date.parse(merged.notifiedAt) >= Date.parse(opened.notifiedAt));
});

test('a PR recorded closed, then reopened and merged, still records the merge', async () => {
  const root = tempRoot();
  saveAdapter(root, fakeAdapter('edit'));
  const view = (state, oid) => ({ match: ['pr', 'view'], stdout: { state, mergeable: 'UNKNOWN', reviewDecision: '', statusCheckRollup: [], comments: [], reviews: [], mergeCommit: oid ? { oid } : null } });
  const w = ghWorld([CREATED, view('CLOSED')]);
  const opened = await openPr(root, (await editJob(root, w.repo)).id, { env: w.env });
  const closed = await refreshPr(root, opened.id, { env: w.env });
  assert.equal(closed.status, 'closed');
  fs.writeFileSync(w.env.PODIUM_FAKE_GH, JSON.stringify({ log: null, responses: [view('MERGED', 'abc123')] }));
  const merged = await refreshPr(root, opened.id, { env: w.env });
  assert.equal(merged.status, 'merged');
  assert.equal(merged.pr.state, 'MERGED');
  assert.equal(merged.pr.mergeCommit, 'abc123');
  assert.equal(merged.delivered, false);
  const again = await refreshPr(root, opened.id, { env: w.env });
  assert.equal(again.status, 'merged');
  assert.equal(again.notifiedAt, merged.notifiedAt, 'the same outcome again changes nothing');
});

// A CLOSED answer that left GitHub before the merge but arrives after it must not undo the merge. A merged
// PR never changes again, so merged is final.
test('a late CLOSED answer after the merge was recorded changes nothing', async () => {
  const root = tempRoot();
  saveAdapter(root, fakeAdapter('edit'));
  const view = (state, oid) => ({ match: ['pr', 'view'], stdout: { state, mergeable: 'UNKNOWN', reviewDecision: '', statusCheckRollup: [], comments: [], reviews: [], mergeCommit: oid ? { oid } : null } });
  const w = ghWorld([CREATED, view('MERGED', 'abc123')]);
  const opened = await openPr(root, (await editJob(root, w.repo)).id, { env: w.env });
  const merged = await refreshPr(root, opened.id, { env: w.env });
  assert.equal(merged.status, 'merged');
  fs.writeFileSync(w.env.PODIUM_FAKE_GH, JSON.stringify({ log: null, responses: [view('CLOSED')] }));
  const late = await refreshPr(root, opened.id, { env: w.env });
  assert.equal(late.status, 'merged');
  assert.equal(late.pr.state, 'MERGED');
  assert.equal(late.notifiedAt, merged.notifiedAt, 'nothing new is announced');
});

// An OPEN answer sent before the merge but arriving after it, and a push that finishes after it, leave
// the merged record as it is, merge commit included (a dependant ticket starts only from a fetch that has it).
test('a late OPEN answer or a late push never undoes a recorded merge', async () => {
  const root = tempRoot();
  saveAdapter(root, fakeAdapter('edit'));
  const view = (state, oid) => ({ match: ['pr', 'view'], stdout: { state, mergeable: 'UNKNOWN', reviewDecision: '', statusCheckRollup: [], comments: [], reviews: [], mergeCommit: oid ? { oid } : null } });
  const w = ghWorld([CREATED, view('MERGED', 'abc123')]);
  const opened = await openPr(root, (await editJob(root, w.repo)).id, { env: w.env });
  const merged = await refreshPr(root, opened.id, { env: w.env });
  fs.writeFileSync(w.env.PODIUM_FAKE_GH, JSON.stringify({ log: null, responses: [view('OPEN')] }));
  const late = await refreshPr(root, opened.id, { env: w.env });
  assert.equal(late.status, 'merged');
  assert.equal(late.pr.state, 'MERGED');
  assert.equal(late.pr.mergeCommit, 'abc123');
  // What a push that began before the merge writes when it finishes.
  const pushed = updateThread(root, merged, {}, { status: 'in-review', hasChanges: false }, 'pr-pushed');
  assert.equal(pushed.status, 'merged');
  assert.equal(pushed.hasChanges, false);
});

// A holder that works past the stale time (removing a copy) keeps its lock fresh, so a second caller
// waits for it instead of taking the lock for stale and running alongside.
test('a PR lock held past the stale time by a live holder is never taken over', async () => {
  const root = tempRoot();
  saveAdapter(root, fakeAdapter('edit'));
  const w = ghWorld([CREATED]);
  const opened = await openPr(root, (await editJob(root, w.repo)).id, { env: w.env });
  const order = [];
  // The holder works twice the stale time; its beats (every staleMs/4) leave room for a busy machine's late timers.
  const opts = { staleMs: 2_000, waitMs: 20_000 };
  const first = finishLocked(root, opened, async () => {
    order.push('first in');
    await new Promise((r) => setTimeout(r, 4_000));
    order.push('first out');
  }, opts);
  await new Promise((r) => setTimeout(r, 50));
  const second = finishLocked(root, opened, async () => { order.push('second in'); }, opts);
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first in', 'first out', 'second in']);
});

// A sprint PR that merges when green asks for it in the PR's first write, not in a second write that
// could land over a merge the watcher recorded meanwhile.
test('a PR opened with auto-merge carries it from its first write', async () => {
  const root = tempRoot();
  saveAdapter(root, fakeAdapter('edit'));
  const w = ghWorld([CREATED]);
  const opened = await openPr(root, (await editJob(root, w.repo)).id, { env: w.env, autoMerge: true });
  assert.equal(opened.pr.autoMerge, true);
});

// A pane action (auto-merge, watch again) read before a merge and written after it must not write that
// old record back. It waits for the lock and builds its change from the record read there.
test('a PR action that overlaps a merge being recorded keeps the merge', async () => {
  const root = tempRoot();
  saveAdapter(root, fakeAdapter('edit'));
  const w = ghWorld([CREATED]);
  const opened = await openPr(root, (await editJob(root, w.repo)).id, { env: w.env });
  let release;
  const held = finishLocked(root, opened, () => new Promise((r) => { release = r; }));
  await new Promise((r) => setTimeout(r, 20));
  const auto = setAutoMerge(root, opened.id, true);
  const watch = watchAgain(root, opened.id);
  await new Promise((r) => setTimeout(r, 100));
  updateThread(root, opened, { pr: { ...opened.pr, state: 'MERGED', mergeCommit: 'abc123' }, worktree: null }, { status: 'merged' }, 'merged');
  release();
  await held;
  await Promise.all([auto, watch]);
  const after = readJob(findJobDir(root, opened.id));
  assert.equal(after.status, 'merged');
  assert.equal(after.pr.state, 'MERGED');
  assert.equal(after.pr.mergeCommit, 'abc123');
  assert.equal(after.pr.autoMerge, true);
  assert.equal(after.pr.watching, true);
});

// An empty or cut-short pr-finish.lock (a crash mid-write) was never reclaimed, so every later end of the
// PR answered pr-busy. It is aged by its file's time: refused while fresh, reclaimed once as old as a stale lock.
test('an empty or truncated PR-end lock is refused while fresh and reclaimed once old', async () => {
  const root = tempRoot();
  const { job, dir } = createJob(root, { project: 'demo', ticket: 'ABC-12', agent: 'fake', permission: 'edit-worktree', cwd: root, prompt: 'x' });
  const lock = path.join(dir, FINISH_LOCK);
  const opts = { waitMs: 300, staleMs: 60_000 };
  for (const [what, text] of [['empty', ''], ['truncated', '{"token":"123:4']]) {
    fs.writeFileSync(lock, text);
    let ran = false;
    await assert.rejects(finishLocked(root, job, async () => { ran = true; }, opts), { code: 'pr-busy' }, `a fresh ${what} lock is still refused`);
    assert.equal(ran, false);
    assert.equal(fs.readFileSync(lock, 'utf8'), text, `the fresh ${what} lock is left as it was`);
    const old = new Date(Date.now() - 5 * 60_000);
    fs.utimesSync(lock, old, old);
    assert.equal(await finishLocked(root, job, async () => { ran = true; return 'done'; }, opts), 'done', `an old ${what} lock is reclaimed`);
    assert.equal(ran, true);
    assert.equal(fs.existsSync(lock), false, 'and the new holder lets it go');
  }
});

// A lock whose age can't be read (stat fails with EPERM/EACCES) waits like a held lock and gives up at the deadline,
// never taken for stale.
test('a PR-end lock whose stat keeps failing with EPERM is waited for, and refused at the deadline with a bounded number of tries', async () => {
  const root = tempRoot();
  const { job, dir } = createJob(root, { project: 'demo', ticket: 'ABC-12', agent: 'fake', permission: 'edit-worktree', cwd: root, prompt: 'x' });
  const lock = path.join(dir, FINISH_LOCK);
  fs.writeFileSync(lock, '');
  const old = new Date(Date.now() - 5 * 60_000);
  fs.utimesSync(lock, old, old);
  let stats = 0;
  // Past 100 tries (a regression spinning without a deadline) the lock goes, so the test ends and fails instead of hanging.
  const statFn = () => { stats += 1; if (stats > 100) fs.rmSync(lock, { force: true }); throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }); };
  let ran = false;
  const started = Date.now();
  await assert.rejects(finishLocked(root, job, async () => { ran = true; }, { waitMs: 400, staleMs: 60_000, statFn }), { code: 'pr-busy' });
  const took = Date.now() - started;
  assert.equal(ran, false);
  assert.ok(took >= 400 && took < 3000, `gave up at about the deadline (${took} ms)`);
  assert.ok(stats >= 2 && stats <= 20, `a bounded number of tries (${stats})`);
  assert.equal(fs.existsSync(lock), true, 'a lock of unknown age is never taken for stale');
});
