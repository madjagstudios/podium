// End a ticket the person has given up on.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Writable } from 'node:stream';
import { createSprint, tick, loadSprint, saveSprint, setPaused, stopTicket, retryTicket, wantsRunner, sprintSummary, markMessages, archiveEnded } from '../engine/sprint.js';
import { listJobDirs, readJob } from '../engine/store.js';
import { main } from '../engine/cli.js';
import { waitFor, scriptAgent, sprintWorld } from './helpers.js';

const T = (over = {}) => ({ key: 'ABC-11', title: 'Login form', type: 'feat', plan: 'docs/plan.md', agent: 'fa', reviewer: 'fr', ...over });
const run = (root, id, env, until) => waitFor(async () => { const s = await tick(root, id, { env }); return until(s) ? s : null; }, { timeoutMs: 90_000, intervalMs: 150 });
// sprint stop asks for a runner, so a test never lets it start one: spawned records what it would start.
const cli = async (root, argv, spawned = []) => {
  let out = '';
  const stdout = new Writable({ write(c, _e, cb) { out += c; cb(); } });
  await main(argv, { stdout, env: { ...process.env, PODIUM_DATA_DIR: root }, spawn: (_f, args) => spawned.push(args) });
  return JSON.parse(out);
};

async function parkedWorld() {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ write: 'a.txt' }, { write: 'a2.txt' }]);
  scriptAgent(root, 'fr', [{ say: 'Broken.\nVERDICT: fail' }, { say: 'Still broken.\nVERDICT: fail' }]);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  const parked = await run(root, s0.id, w.env, (s) => s.tickets[0].state === 'parked');
  return { root, w, s0, parked };
}

test('stopping a parked ticket removes its copy, keeps its branch, says so, and finishes the sprint', async () => {
  const { root, w, s0, parked } = await parkedWorld();
  const copy = readJob(listJobDirs(root).find((d) => d.endsWith(parked.tickets[0].latest))).worktree;
  assert.ok(fs.existsSync(copy), 'the ticket has a copy before it is stopped');
  const s = await stopTicket(root, s0.id, 'abc-11');
  const t = s.tickets[0];
  assert.equal(t.state, 'stopped');
  assert.deepEqual([t.job, t.retryAt, t.resume], [null, null, null]);
  assert.ok(t.endedAt);
  assert.equal(fs.existsSync(copy), false, 'its copy is gone');
  assert.match(w.git(w.repo, 'branch', '--list', 'feat/abc-11-login-form'), /feat\/abc-11-login-form/, 'its branch is kept');
  const texts = s.messages.map((m) => m.text);
  assert.ok(texts.includes('ABC-11 (Login form) was stopped. Its branch feat/abc-11-login-form is kept.'));
  assert.ok(s.finishedAt, 'every ticket is shipped or stopped, so the sprint is done');
  assert.match(texts.at(-1), /^Sprint "x" is done\./);
  assert.match(texts.at(-1), /^- ABC-11 Login form: stopped$/m);
  assert.equal(wantsRunner(root, loadSprint(root, s0.id)), false);
  assert.equal(sprintSummary(root, s).tickets[0].state, 'stopped');
});

test('stopping saves unfinished work in the copy to the branch before the copy goes', async () => {
  const { root, w, s0, parked } = await parkedWorld();
  const copy = readJob(listJobDirs(root).find((d) => d.endsWith(parked.tickets[0].latest))).worktree;
  fs.writeFileSync(`${copy}/left-behind.txt`, 'unfinished\n');
  const s = await stopTicket(root, s0.id, 'ABC-11');
  assert.equal(s.tickets[0].state, 'stopped');
  assert.equal(fs.existsSync(copy), false, 'its copy is gone');
  assert.equal(w.git(w.repo, 'show', 'feat/abc-11-login-form:left-behind.txt'), 'unfinished');
  assert.equal(w.git(w.repo, 'log', '-1', '--format=%s', 'feat/abc-11-login-form'), 'wip(ABC-11): unfinished work saved when the ticket was stopped');
  assert.ok(s.messages.some((m) => m.text === 'ABC-11 (Login form) was stopped. Its branch feat/abc-11-login-form is kept.'));
});

test('a copy whose work cannot be saved is kept, and the message says where and why', async () => {
  const { root, w, s0, parked } = await parkedWorld();
  const copy = readJob(listJobDirs(root).find((d) => d.endsWith(parked.tickets[0].latest))).worktree;
  fs.writeFileSync(`${copy}/left-behind.txt`, 'unfinished\n');
  // A pre-commit hook that refuses every commit: the save fails.
  const hooks = w.git(copy, 'rev-parse', '--git-path', 'hooks');
  const hookDir = hooks.startsWith('/') || /^[A-Za-z]:/.test(hooks) ? hooks : `${copy}/${hooks}`;
  fs.mkdirSync(hookDir, { recursive: true });
  fs.writeFileSync(`${hookDir}/pre-commit`, '#!/bin/sh\necho "no commits today" >&2\nexit 1\n', { mode: 0o755 });
  const s = await stopTicket(root, s0.id, 'ABC-11');
  assert.equal(s.tickets[0].state, 'stopped');
  assert.ok(fs.existsSync(`${copy}/left-behind.txt`), 'the copy and its work are kept');
  const text = s.messages.find((m) => m.text.startsWith('ABC-11 (Login form) was stopped.')).text;
  assert.ok(text.startsWith(`ABC-11 (Login form) was stopped. Its copy is kept at ${copy} because Podium couldn't save its unfinished changes: `), text);
});

test('a stopped sprint is archived once its news is delivered', async () => {
  const { root, s0 } = await parkedWorld();
  const s = await stopTicket(root, s0.id, 'ABC-11');
  await archiveEnded(root, [sprintSummary(root, s)]);
  assert.equal(loadSprint(root, s0.id).archived, undefined, 'news not delivered yet');
  await markMessages(root, s.messages.map((m) => `${s0.id}:${m.id}`));
  await archiveEnded(root, [sprintSummary(root, loadSprint(root, s0.id))]);
  assert.equal(loadSprint(root, s0.id).archived, true);
});

test('a stopped ticket is not retried or started again', async () => {
  const { root, w, s0 } = await parkedWorld();
  await stopTicket(root, s0.id, 'ABC-11');
  await assert.rejects(retryTicket(root, s0.id, 'ABC-11'), (e) => e.code === 'not-stuck');
  await assert.rejects(stopTicket(root, s0.id, 'ABC-11'), (e) => e.code === 'not-stoppable' && /already stopped/.test(e.message));
  const before = listJobDirs(root).length;
  await tick(root, s0.id, { env: w.env });
  assert.equal(listJobDirs(root).length, before, 'no new step starts');
  assert.equal(loadSprint(root, s0.id).tickets[0].state, 'stopped');
});

test('a ticket working right now cannot be stopped', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ write: 'a.txt', ms: 1500 }]);
  scriptAgent(root, 'fr', []);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  const s1 = await tick(root, s0.id, { env: w.env });
  assert.equal(s1.tickets[0].state, 'running');
  await assert.rejects(stopTicket(root, s0.id, 'ABC-11'), (e) => e.code === 'ticket-busy' && e.message === 'ABC-11 is working right now. Pause the sprint, wait for the step to finish, then stop it.');
  assert.equal(loadSprint(root, s0.id).tickets[0].state, 'running');
  await waitFor(() => readJob(listJobDirs(root).find((d) => d.endsWith(s1.tickets[0].job))).status !== 'running');
});

test('a paused ticket whose step has finished can be stopped, and the step\'s work is saved', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ write: 'a.txt', ms: 500 }]);
  scriptAgent(root, 'fr', []);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  const s1 = await tick(root, s0.id, { env: w.env });
  await setPaused(root, s0.id, true);
  const dir = listJobDirs(root).find((d) => d.endsWith(s1.tickets[0].job));
  await waitFor(() => !['queued', 'running'].includes(readJob(dir).status) || null);
  const copy = readJob(dir).worktree;
  assert.equal(loadSprint(root, s0.id).tickets[0].state, 'running', 'still running on paper: nothing ticked it on');
  const s = await stopTicket(root, s0.id, 'ABC-11');
  assert.equal(s.tickets[0].state, 'stopped');
  assert.equal(fs.existsSync(copy), false);
  assert.equal(w.git(w.repo, 'show', 'feat/abc-11-login-form:a.txt'), 'a.txt');
});

test('a ticket with its PR cannot be stopped; a pending one can, with no branch to mention', async () => {
  const { root, w } = sprintWorld({ plans: { 'docs/plan.md': '### Task 1: Add a.txt\nDo it.\n' } });
  scriptAgent(root, 'fa', []);
  scriptAgent(root, 'fr', []);
  const s0 = await createSprint(root, { name: 'x', tickets: [T(), T({ key: 'ABC-12', title: 'Signup' })] }, { cwd: w.repo });
  const raw = loadSprint(root, s0.id);
  Object.assign(raw.tickets[0], { state: 'pr-open', pr: { number: 7, url: 'https://github.com/o/r/pull/7' }, task: 1 });
  saveSprint(root, raw);
  await assert.rejects(stopTicket(root, s0.id, 'ABC-11'), (e) => e.code === 'not-stoppable' && /already has its PR/.test(e.message));
  const s = await stopTicket(root, s0.id, 'ABC-12');
  assert.equal(s.tickets[1].state, 'stopped');
  assert.ok(s.messages.some((m) => m.text === 'ABC-12 (Signup) was stopped.'));
  assert.ok(s.finishedAt, 'one PR and one stopped ticket finish the sprint');
  assert.match(s.messages.at(-1).text, /^- ABC-12 Signup: stopped$/m);
  assert.match(s.messages.at(-1).text, /^- ABC-11 Login form: PR #7 /m);
  assert.equal(s.archived, undefined, 'the PR is still open');
});

test('stopping one ticket leaves the sprint going while another still has work', async () => {
  const { root, w } = sprintWorld({ plans: { 'docs/plan.md': '### Task 1: Add a.txt\nDo it.\n' } });
  scriptAgent(root, 'fa', []);
  scriptAgent(root, 'fr', []);
  const s0 = await createSprint(root, { name: 'x', tickets: [T(), T({ key: 'ABC-12', title: 'Signup' })] }, { cwd: w.repo });
  const s = await stopTicket(root, s0.id, 'ABC-11');
  assert.equal(s.finishedAt, null);
  assert.equal(s.tickets[1].state, 'pending');
  assert.equal(wantsRunner(root, s), true);
});

test('podium sprint stop ends a ticket and answers with the summary', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', []);
  scriptAgent(root, 'fr', []);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  const spawned = [];
  const out = await cli(root, ['sprint', 'stop', '--id', s0.id, '--ticket', 'abc-11'], spawned);
  assert.equal(out.sprint.id, s0.id);
  assert.equal(out.sprint.tickets[0].state, 'stopped');
  assert.ok(out.sprint.finishedAt);
  assert.equal((await cli(root, ['sprint', 'stop', '--id', s0.id])).error.code, 'missing-option');
  assert.equal((await cli(root, ['sprint', 'stop', '--id', s0.id, '--ticket', 'abc-11'])).error.code, 'not-stoppable');
  assert.equal(fs.existsSync(`${root}/sprints/${s0.id}/runner.json`), false, 'stopping starts no runner');
  assert.deepEqual(spawned, [], 'the sprint is finished, so no runner is asked for');
});

test('a paused ticket whose dispatch crashed before it made a job can be stopped, and its work is saved', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ write: 'a.txt', ms: 500 }]);
  scriptAgent(root, 'fr', []);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  const s1 = await tick(root, s0.id, { env: w.env });
  await setPaused(root, s0.id, true);
  const dir = listJobDirs(root).find((d) => d.endsWith(s1.tickets[0].job));
  await waitFor(() => !['queued', 'running'].includes(readJob(dir).status) || null);
  const copy = readJob(dir).worktree;
  // The next step's intent was saved, then the runner died before the job existed.
  const raw = loadSprint(root, s0.id);
  raw.tickets[0].dispatching = { role: 'reviewer', task: 0, phase: 'review', at: new Date().toISOString() };
  saveSprint(root, raw);
  const s = await stopTicket(root, s0.id, 'ABC-11');
  assert.equal(s.tickets[0].state, 'stopped');
  assert.equal(s.tickets[0].dispatching, null);
  assert.equal(fs.existsSync(copy), false, 'its copy is gone');
  assert.equal(w.git(w.repo, 'show', 'feat/abc-11-login-form:a.txt'), 'a.txt', 'the work was saved first');
});
