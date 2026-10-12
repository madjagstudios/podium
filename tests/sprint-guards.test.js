// Sprint steps are the sprint's: ordinary job actions refuse them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createJob, updateJob } from '../engine/store.js';
import { keep, discard } from '../engine/review.js';
import { openPr } from '../engine/pr.js';
import { dispatch } from '../engine/dispatch.js';
import { createSprint, loadSprint, saveSprint, tick } from '../engine/sprint.js';
import { tempRoot, sprintWorld, scriptAgent } from './helpers.js';

const SAYS = 'This is part of a sprint. Use the sprint tool to pause, retry or reassign it.';
const refused = (e) => e.code === 'sprint-job' && e.message === SAYS;

function sprintJob(patch = {}) {
  const root = tempRoot();
  const { job, dir } = createJob(root, { project: 'demo', ticket: 'ABC-11', agent: 'fa', permission: 'edit-worktree', cwd: tempRoot(), prompt: 'ABC-11 task 1: A' });
  updateJob(root, dir, { status: 'needs-review', hasChanges: true, worktree: tempRoot(), sprint: { id: 's1', ticket: 'ABC-11', task: 1, role: 'author' }, ...patch });
  return { root, id: job.id };
}

test('Keep and Throw away refuse a sprint step, with or without a PR', async () => {
  const plain = sprintJob();
  await assert.rejects(keep(plain.root, plain.id), refused);
  await assert.rejects(discard(plain.root, plain.id), refused);
  const withPr = sprintJob({ status: 'in-review', pr: { number: 12, state: 'OPEN' } });
  await assert.rejects(keep(withPr.root, withPr.id), refused);
  await assert.rejects(discard(withPr.root, withPr.id), refused);
});

test('Open PR refuses a sprint step unless the sprint opens it', async () => {
  const { root, id } = sprintJob();
  await assert.rejects(openPr(root, id), refused);
  // From the sprint it gets past the guard (and fails later: this copy has no git repo).
  await assert.rejects(openPr(root, id, { fromSprint: true }), (e) => e.code !== 'sprint-job');
});

test('a ticket whose PR is already open adopts it instead of opening another', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', []);
  scriptAgent(root, 'fr', []);
  const s0 = await createSprint(root, { name: 'x', tickets: [{ key: 'ABC-11', title: 'Login form', plan: 'docs/plan.md', agent: 'fa', reviewer: 'fr' }] }, { cwd: w.repo });
  const { job, dir } = createJob(root, { project: s0.project, ticket: 'ABC-11', agent: 'fa', permission: 'edit-worktree', cwd: w.repo, prompt: 'ABC-11 task 2: B' });
  updateJob(root, dir, { status: 'in-review', sprint: { id: s0.id, ticket: 'ABC-11', task: 2, role: 'author' }, pr: { number: 5, url: 'https://github.com/o/r/pull/5', state: 'OPEN', autoMerge: false } });
  const stored = loadSprint(root, s0.id);
  Object.assign(stored.tickets[0], { state: 'waiting', resume: 'pr', retryAt: new Date(0).toISOString(), task: 2, thread: job.id, latest: job.id });
  saveSprint(root, stored);
  const s = await tick(root, s0.id, { env: w.env });
  assert.equal(s.tickets[0].state, 'pr-open');
  assert.deepEqual(s.tickets[0].pr, { number: 5, url: 'https://github.com/o/r/pull/5' });
  assert.equal(w.calls().length, 0, 'gh was not asked to open a PR');
});

test('a follow-up of a sprint step is refused unless it carries sprint meta', async () => {
  const { root, id } = sprintJob();
  await assert.rejects(dispatch(root, { agent: 'fa', cwd: tempRoot(), prompt: 'more', followUp: id }), refused);
  await assert.rejects(
    dispatch(root, { agent: 'fa', cwd: tempRoot(), prompt: 'more', followUp: id, meta: { sprint: { id: 's1', ticket: 'ABC-11', task: 2, role: 'author' } } }),
    (e) => e.code !== 'sprint-job',
  );
});
