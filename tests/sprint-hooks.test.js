import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dispatch } from '../engine/dispatch.js';
import { readJob } from '../engine/store.js';
import { openPr } from '../engine/pr.js';
import { loadSettings } from '../engine/settings.js';
import { gitIn } from '../engine/worktree.js';
import { saveAdapter } from '../engine/adapters/registry.js';
import { tempRoot, waitFor, ghWorld, scriptAgent, fakeAdapter } from './helpers.js';

const finished = (dir) => waitFor(() => { const j = readJob(dir); return ['needs-review', 'done', 'failed'].includes(j.status) && j; });
const CREATED = { match: ['pr', 'create'], stdout: 'https://github.com/o/r/pull/7\n' };

test('sprintParallel defaults to 3', () => {
  assert.equal(loadSettings(tempRoot()).sprintParallel, 3);
});

test('a scripted fake agent takes its steps in order', async () => {
  const root = tempRoot();
  const w = ghWorld([]);
  scriptAgent(root, 'sa', [{ say: 'first' }, { say: 'second', exit: 4 }]);
  const one = await finished((await dispatch(root, { agent: 'sa', permission: 'read-only', cwd: w.repo, prompt: 'x' })).dir);
  const two = await finished((await dispatch(root, { agent: 'sa', permission: 'read-only', cwd: w.repo, prompt: 'y' })).dir);
  assert.equal(one.status, 'done');
  assert.equal(two.status, 'failed');
  assert.equal(two.exitCode, 4);
});

test('a sprint job gets its branch and meta, keeps its copy, and its follow-up starts from HEAD', async () => {
  const root = tempRoot();
  const w = ghWorld([CREATED]);
  scriptAgent(root, 'sa', [{ say: 'no changes' }, { write: 'b.txt' }]);
  const meta = { sprint: { id: 's1', ticket: 'ABC-11', task: 1, role: 'author' }, delivered: true };
  const first = await finished((await dispatch(root, { agent: 'sa', permission: 'edit-worktree', cwd: w.repo, prompt: 'ABC-11 task 1: nothing', ticket: 'ABC-11', branch: 'feat/abc-11-login', meta })).dir);
  assert.equal(first.branch, 'feat/abc-11-login');
  assert.deepEqual(first.sprint, meta.sprint);
  assert.equal(first.delivered, true);
  assert.ok(first.worktree && fs.existsSync(first.worktree), 'a sprint copy stays even when step 1 changed nothing');
  // A checkpoint commit (as the sprint runner makes), then the next task.
  fs.writeFileSync(`${first.worktree}/a.txt`, 'a\n');
  await gitIn(first.worktree, ['add', '-A']);
  await gitIn(first.worktree, ['commit', '-q', '-m', 'wip(ABC-11): task 1 A']);
  const head = await gitIn(first.worktree, ['rev-parse', 'HEAD']);
  const second = await finished((await dispatch(root, { agent: 'sa', cwd: w.repo, prompt: 'ABC-11 task 2: B', followUp: first.id, meta })).dir);
  assert.equal(second.baseCommit, head, 'only this task\'s changes count');
  assert.equal(second.status, 'needs-review');
  assert.equal(second.changes.files, 1);
  // Open PR keeps the ticket branch and uses the given title.
  const opened = await openPr(root, second.id, { env: w.env, title: 'ABC-11: Login form', fromSprint: true });
  assert.equal(opened.pr.branch, 'feat/abc-11-login');
  assert.equal(opened.pr.title, 'ABC-11: Login form');
  const create = w.calls().find((c) => c[0] === 'pr' && c[1] === 'create');
  assert.equal(create[create.indexOf('--title') + 1], 'ABC-11: Login form');
  assert.equal(w.git(w.remote, 'log', '--format=%s', 'feat/abc-11-login').split('\n')[1], 'wip(ABC-11): task 1 A');
});

test('a sprint step whose agent commits keeps its copy for the next step', async () => {
  const root = tempRoot();
  const w = ghWorld([]);
  saveAdapter(root, { ...fakeAdapter('commit-here'), name: 'committer', label: 'Committer' });
  const meta = { sprint: { id: 's1', ticket: 'ABC-13', task: 1, role: 'author' }, delivered: true };
  const job = await finished((await dispatch(root, { agent: 'committer', permission: 'edit-worktree', cwd: w.repo, prompt: 'ABC-13 task 1: A', ticket: 'ABC-13', branch: 'feat/abc-13-a', meta })).dir);
  assert.equal(job.committed?.count, 1);
  assert.equal(job.committed.branch, 'feat/abc-13-a');
  assert.ok(job.worktree && fs.existsSync(job.worktree), "a sprint's copy stays after the agent commits");
});

test('Open PR accepts a finished sprint step with nothing left to commit', async () => {
  const root = tempRoot();
  const w = ghWorld([CREATED]);
  scriptAgent(root, 'sa', [{ write: 'a.txt' }]);
  const meta = { sprint: { id: 's1', ticket: 'ABC-12', task: 1, role: 'author' }, delivered: true };
  const job = await finished((await dispatch(root, { agent: 'sa', permission: 'edit-worktree', cwd: w.repo, prompt: 'ABC-12 task 1: A', ticket: 'ABC-12', branch: 'fix/abc-12-a', meta })).dir);
  await gitIn(job.worktree, ['add', '-A']);
  await gitIn(job.worktree, ['commit', '-q', '-m', 'wip(ABC-12): task 1 A']);
  const { updateJob, findJobDir } = await import('../engine/store.js');
  updateJob(root, findJobDir(root, job.id), { status: 'done', hasChanges: false });
  const opened = await openPr(root, job.id, { env: w.env, title: 'ABC-12: A', fromSprint: true });
  assert.equal(opened.status, 'in-review');
  assert.equal(opened.delivered, true, 'a sprint step\'s PR news goes through its sprint');
});
