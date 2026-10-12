import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createSprint, tick, loadSprint, saveSprint, wantsRunner, RETRY_MS, MAX_WAITS } from '../engine/sprint.js';
import { spawnSync } from 'node:child_process';
import { Writable } from 'node:stream';
import { main } from '../engine/cli.js';
import { listJobDirs, readJob, updateJob } from '../engine/store.js';
import { setSetting } from '../engine/settings.js';
import { projectKey } from '../engine/paths.js';
import { waitFor, scriptAgent, sprintWorld } from './helpers.js';

const draft = (tickets) => ({ name: 'Test sprint', tickets });
const T = (over = {}) => ({ key: 'ABC-11', title: 'Login form', type: 'feat', plan: 'docs/plan.md', agent: 'fa', reviewer: 'fr', ...over });
// Tick until `until(sprint)` holds; each tick re-reads the sprint's state, as a restarted runner would.
const run = (root, id, env, until, { now } = {}) => waitFor(async () => {
  const s = await tick(root, id, { env, now: now ? now() : Date.now() });
  return until(s) ? s : null;
}, { timeoutMs: 90_000, intervalMs: 150 });
const jobsBy = (root, role) => listJobDirs(root).map(readJob).filter((j) => j.sprint?.role === role).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
async function cli(root, argv) {
  let out = '';
  const stdout = new Writable({ write(c, _e, cb) { out += c; cb(); } });
  const code = await main(argv, { stdout, env: { ...process.env, PODIUM_DATA_DIR: root } });
  return { code, body: JSON.parse(out) };
}
const promptOf = (root, job) => fs.readFileSync(path.join(listJobDirs(root).find((d) => d.endsWith(job.id)), 'prompt.md'), 'utf8');

test('a ticket runs task by task with a review after each, then opens its PR', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ write: 'a.txt', say: 'did a' }, { write: 'b.txt', say: 'did b' }]);
  scriptAgent(root, 'fr', [{ say: 'Fine.\nVERDICT: pass' }, { say: 'Good.\nVERDICT: pass' }]);
  const s0 = await createSprint(root, draft([T()]), { cwd: w.repo, session: 'chat-1' });
  const s = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'pr-open');
  const t = s.tickets[0];
  assert.deepEqual(t.pr, { number: 12, url: 'https://github.com/o/r/pull/12' });
  assert.equal(t.reviews, 2);
  assert.equal(t.rounds, 2);
  const log = w.git(w.remote, 'log', '--format=%s', `${w.git(w.repo, 'rev-parse', 'main')}..feat/abc-11-login-form`).split('\n');
  assert.deepEqual(log, ['ABC-11: Login form'], 'one commit, named for the ticket');
  const create = w.calls().find((c) => c[0] === 'pr' && c[1] === 'create');
  assert.equal(create[create.indexOf('--title') + 1], 'ABC-11: Login form');
  const reviews = jobsBy(root, 'reviewer');
  assert.equal(reviews.length, 2);
  assert.equal(reviews[0].permission, 'read-only');
  assert.match(promptOf(root, reviews[0]), /a\.txt/);
  assert.doesNotMatch(promptOf(root, reviews[0]), /b\.txt/);
  assert.match(promptOf(root, reviews[1]), /b\.txt/);
  assert.doesNotMatch(promptOf(root, reviews[1]), /\+a\.txt/, 'task 2 is reviewed on its own diff');
  const authors = jobsBy(root, 'author');
  assert.equal(authors.length, 2);
  assert.equal(authors[0].branch, 'feat/abc-11-login-form');
  assert.equal(authors[1].followUpOf, authors[0].id);
  // Its work went into the checkpoint, so the earlier author step was done (nothing to Keep) before task 2 continued it.
  assert.equal(authors[0].endStatus, 'done');
  assert.equal(authors[0].hasChanges, false);
  assert.equal(readJob(listJobDirs(root).find((d) => d.endsWith(authors[1].id))).status, 'in-review');
  assert.ok(s.finishedAt);
  assert.match(s.messages.at(-1).text, /^Sprint "Test sprint" is done\./);
  assert.match(s.messages.at(-1).text, /ABC-11 Login form: PR #12/);
  assert.match(s.messages.at(-1).text, /2 tasks by Fa, reviewed by Fr · every review passed first time/);
  assert.equal(wantsRunner(root, s), false);
});

test('a failed review goes back to the author once, then the task passes', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ write: 'a.txt' }, { write: 'a-test.txt', say: 'added the test' }, { write: 'b.txt' }]);
  scriptAgent(root, 'fr', [{ say: 'Missing test for a.\nVERDICT: fail' }, { say: 'VERDICT: pass' }, { say: 'VERDICT: pass' }]);
  // The checkpoints stay on the branch only when the repo keeps them.
  setSetting(root, 'repoSquash', { [projectKey(w.repo)]: false });
  const s0 = await createSprint(root, draft([T()]), { cwd: w.repo });
  const s = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'pr-open');
  assert.equal(s.tickets[0].rounds, 3);
  assert.match(s.messages.at(-1).text, /2 tasks by Fa, reviewed by Fr · 1 review sent work back for fixes/);
  const fix = jobsBy(root, 'author')[1];
  assert.match(promptOf(root, fix), /fix what the reviewer found[\s\S]*Missing test for a\./);
  assert.ok(w.git(w.remote, 'log', '--format=%s', 'feat/abc-11-login-form').split('\n').includes('wip(ABC-11): task 1 review fixes'));
});

test('a second failed review parks the ticket with the findings and a message', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ write: 'a.txt' }, { write: 'a2.txt' }]);
  scriptAgent(root, 'fr', [{ say: 'Broken.\nVERDICT: fail' }, { say: 'Still broken.\nVERDICT: fail' }]);
  const s0 = await createSprint(root, draft([T()]), { cwd: w.repo });
  const s = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  const t = s.tickets[0];
  assert.equal(t.reason, 'Review failed twice on task 1');
  assert.match(t.findings, /Still broken\.$/);
  assert.equal(t.resume, 'fix', 'Retry sends the findings to the author');
  assert.match(s.messages.at(-1).text, /^ABC-11 \(Login form\) needs you: Review failed twice on task 1/);
  assert.equal(s.finishedAt, null);
  assert.equal(wantsRunner(root, s), false, 'nothing left to run until the person acts');
});

test('a reviewer with no verdict counts as a fail', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ write: 'a.txt' }, { write: 'a2.txt' }]);
  scriptAgent(root, 'fr', [{ say: 'I looked around.' }, { say: 'Hmm.' }]);
  const s0 = await createSprint(root, draft([T()]), { cwd: w.repo });
  const s = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  assert.equal(s.tickets[0].reason, "The reviewer didn't give a verdict on task 1, twice");
  assert.match(promptOf(root, jobsBy(root, 'author')[1]), /The reviewer didn't give a verdict\./);
});

test('an agent that stops with an error parks the ticket', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ err: 'boom', exit: 3 }]);
  scriptAgent(root, 'fr', []);
  const s0 = await createSprint(root, draft([T()]), { cwd: w.repo });
  const s = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  assert.equal(s.tickets[0].reason, 'Fa stopped on task 1: Fa exited with code 3.');
  assert.equal(s.tickets[0].resume, 'author');
});

test('a usage limit waits 15 minutes, then the step runs again', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ err: 'Error: You have hit your usage limit. Try again later.', exit: 1 }, { write: 'a.txt' }, { write: 'b.txt' }]);
  scriptAgent(root, 'fr', [{ say: 'VERDICT: pass' }, { say: 'VERDICT: pass' }]);
  const s0 = await createSprint(root, draft([T()]), { cwd: w.repo });
  const start = Date.now();
  const waiting = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'waiting');
  const t = waiting.tickets[0];
  assert.match(t.reason, /^Fa hit a usage limit; trying again at \d\d:\d\d$/);
  assert.ok(Date.parse(t.retryAt) >= start + RETRY_MS);
  assert.equal(wantsRunner(root, waiting), true);
  const still = await tick(root, s0.id, { env: w.env });
  assert.equal(still.tickets[0].state, 'waiting', 'not before the retry time');
  const later = () => Date.now() + RETRY_MS + 1000;
  const s = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'pr-open', { now: later });
  assert.equal(jobsBy(root, 'author').length, 3);
});

test('a step run again keeps the task\'s starting point, so the review sees all the task\'s work', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ write: 'a.txt', err: 'You have hit your usage limit.', exit: 1 }, { write: 'b.txt' }]);
  scriptAgent(root, 'fr', [{ say: 'VERDICT: pass' }]);
  const s0 = await createSprint(root, draft([T()]), { cwd: w.repo });
  const waiting = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'waiting');
  // The agent committed its first piece of work itself before it hit the limit.
  const copy = readJob(listJobDirs(root).find((d) => d.endsWith(waiting.tickets[0].latest))).worktree;
  w.git(copy, 'add', '-A');
  w.git(copy, 'commit', '-q', '-m', 'agent: a');
  const later = () => Date.now() + RETRY_MS + 1000;
  await run(root, s0.id, w.env, (x) => x.tickets[0].phase === 'review', { now: later });
  const review = jobsBy(root, 'reviewer')[0];
  // The task text names a.txt too: look for the files in the diff.
  assert.match(promptOf(root, review), /diff --git a\/a\.txt/, 'the work committed before the retry is reviewed too');
  assert.match(promptOf(root, review), /diff --git a\/b\.txt/);
});

// Steps and diff read diff.patch, which is empty when the agent committed its own work.
test('an author step that commits its own work shows its changed files and hunks through changes --id', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ write: 'a.txt', content: 'one\ntwo\n', commit: 'agent: a' }, { write: 'b.txt', commit: 'agent: b' }]);
  scriptAgent(root, 'fr', [{ say: 'VERDICT: pass' }, { say: 'VERDICT: pass' }]);
  const s0 = await createSprint(root, draft([T()]), { cwd: w.repo });
  await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'pr-open');
  const [first, second] = jobsBy(root, 'author');
  assert.ok(first.committed, 'the agent committed the work itself');
  const shown = await cli(root, ['changes', '--id', first.id]);
  assert.equal(shown.code, 0);
  assert.deepEqual(shown.body.files.map((f) => f.path), ['a.txt']);
  assert.equal(shown.body.files[0].added, 2);
  assert.match(shown.body.files[0].patch, /^@@ .* @@\n\+one\n\+two$/);
  // Each step shows only its own work: task 2's step has b.txt, not a.txt.
  const next = await cli(root, ['changes', '--id', second.id]);
  assert.deepEqual(next.body.files.map((f) => f.path), ['b.txt']);
});

test('a usage limit that lasts hours parks the ticket after MAX_WAITS waits, and a retry counts again', async () => {
  const { root, w } = sprintWorld();
  const limit = { err: 'You have hit your usage limit.', exit: 1 };
  scriptAgent(root, 'fa', [limit, limit]);
  scriptAgent(root, 'fr', []);
  const s0 = await createSprint(root, draft([T()]), { cwd: w.repo });
  const waiting = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'waiting');
  assert.equal(waiting.tickets[0].waits, 1);
  const stored = loadSprint(root, s0.id);
  stored.tickets[0].waits = MAX_WAITS;
  stored.tickets[0].retryAt = new Date(Date.now() - 1000).toISOString();
  saveSprint(root, stored);
  const s = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  assert.equal(s.tickets[0].reason, 'Fa has hit a usage limit for 6 hours on task 1');
  assert.equal(s.tickets[0].waits, 0);
  assert.equal(s.tickets[0].resume, 'author');
});

test('an unexpected error parks the ticket with a plain sentence and the first line of the detail', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ write: 'a.txt' }]);
  scriptAgent(root, 'fr', []);
  const s0 = await createSprint(root, draft([T()]), { cwd: w.repo });
  const started = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'running' && x.tickets[0].phase === 'author');
  const dir = () => listJobDirs(root).find((d) => d.endsWith(started.tickets[0].job));
  await waitFor(() => !['queued', 'running'].includes(readJob(dir()).status) || null, { timeoutMs: 60_000, intervalMs: 100 });
  fs.rmSync(readJob(dir()).worktree, { recursive: true, force: true });
  const s = await tick(root, s0.id, { env: w.env });
  assert.equal(s.tickets[0].state, 'parked');
  assert.ok(s.tickets[0].reason.startsWith("Podium couldn't save task 1's work and start its review: "), s.tickets[0].reason);
  assert.equal(s.tickets[0].resume, 'review');
});

test('a copy that cannot be made parks the ticket with git\'s reason, not a command line', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', []);
  scriptAgent(root, 'fr', []);
  const s0 = await createSprint(root, draft([T()]), { cwd: w.repo });
  // Taken after the sprint was made, so only the copy itself can fail.
  w.git(w.repo, 'branch', 'feat/abc-11-login-form');
  const s = await tick(root, s0.id, { env: w.env });
  const { state, reason } = s.tickets[0];
  assert.equal(state, 'parked');
  assert.ok(reason.startsWith("Podium couldn't start task 1: git worktree: "), reason);
  assert.match(reason, /feat\/abc-11-login-form/);
  assert.doesNotMatch(reason, /Command failed/);
});

test('a step whose runner died parks the ticket, naming the agent', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ write: 'a.txt' }]);
  scriptAgent(root, 'fr', []);
  const s0 = await createSprint(root, draft([T()]), { cwd: w.repo });
  const s1 = await tick(root, s0.id, { env: w.env });
  const dir = listJobDirs(root).find((d) => d.endsWith(s1.tickets[0].job));
  await waitFor(() => !['queued', 'running'].includes(readJob(dir).status) || null, { timeoutMs: 60_000 });
  // As if its runner had been killed mid-run.
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  updateJob(root, dir, { status: 'running', runnerPid: dead });
  const s = await tick(root, s0.id, { env: w.env });
  assert.equal(s.tickets[0].state, 'parked');
  assert.equal(s.tickets[0].reason, 'Fa stopped on task 1: The job stopped unexpectedly (its background process is gone).');
  assert.equal(wantsRunner(root, s), false);
});

test('a tick that dies between starting a step and saving it adopts that step next time', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ write: 'a.txt' }, { write: 'b.txt' }]);
  scriptAgent(root, 'fr', [{ say: 'VERDICT: pass' }, { say: 'VERDICT: pass' }]);
  const s0 = await createSprint(root, draft([T()]), { cwd: w.repo });
  // The save after the dispatch fails once, as if the runner had been killed there.
  let crashed = false;
  const saveFn = (r, s, lock) => {
    if (!crashed && s.tickets[0].job) { crashed = true; throw new Error('killed'); }
    return saveSprint(r, s, lock);
  };
  await assert.rejects(tick(root, s0.id, { env: w.env, saveFn }), /killed/);
  assert.equal(jobsBy(root, 'author').length, 1, 'the step did start');
  assert.equal(loadSprint(root, s0.id).tickets[0].job, null, 'but the sprint never recorded it');
  const s = await run(root, s0.id, w.env, (x) => ['pr-open', 'parked'].includes(x.tickets[0].state));
  assert.equal(s.tickets[0].state, 'pr-open', s.tickets[0].reason);
  const authors = jobsBy(root, 'author');
  assert.equal(authors.length, 2, 'one author step per task: the first was adopted, not started twice');
  assert.equal(s.tickets[0].thread, authors[0].id);
  assert.equal(s.tickets[0].dispatching, null);
});

test('no more tickets run at once than sprintParallel', async () => {
  const { root, w } = sprintWorld();
  setSetting(root, 'sprintParallel', 1);
  scriptAgent(root, 'fa', [{ write: 'a.txt', ms: 2000 }]);
  scriptAgent(root, 'fr', []);
  const s0 = await createSprint(root, draft([T(), T({ key: 'ABC-12', title: 'Payouts' })]), { cwd: w.repo });
  const s = await tick(root, s0.id, { env: w.env });
  assert.deepEqual(s.tickets.map((t) => t.state), ['running', 'pending']);
  assert.equal(loadSprint(root, s0.id).tickets[0].state, 'running', 'saved after the step');
});
