import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { saveAdapter } from '../engine/adapters/registry.js';
import { dispatch } from '../engine/dispatch.js';
import { readJob } from '../engine/store.js';
import { removalPlan, uninstall } from '../engine/uninstall.js';
import { tempRoot, tempRepo, fakeAdapter, waitFor } from './helpers.js';

async function editJob(root, repo) {
  const res = await dispatch(root, { agent: 'fake', permission: 'edit-worktree', cwd: repo, prompt: 'Edit' });
  return waitFor(() => { const j = readJob(res.dir); return ['needs-review', 'done', 'failed'].includes(j.status) && j; });
}

test('the removal plan counts data, unkept changes and copies without changing anything', async () => {
  const root = tempRoot();
  saveAdapter(root, fakeAdapter('edit'));
  const repo = tempRepo();
  const job = await editJob(root, repo);
  const plan = removalPlan(root);
  assert.ok(plan.bytes > 0);
  assert.equal(plan.unkept, 1);
  assert.equal(plan.running, 0);
  assert.equal(plan.copies, 1);
  assert.ok(fs.existsSync(job.worktree));
});

test('uninstall removes copies, their scratch branches and the data folder, and leaves the repo clean', async () => {
  const root = tempRoot();
  saveAdapter(root, fakeAdapter('edit'));
  const repo = tempRepo();
  const job = await editJob(root, repo);
  assert.ok(job.branch, 'the copy has a scratch branch');
  const out = await uninstall(root);
  assert.equal(out.removed, true);
  assert.deepEqual(out.left, []);
  assert.equal(fs.existsSync(root), false);
  assert.equal(fs.existsSync(job.worktree), false);
  const list = execFileSync('git', ['worktree', 'list'], { cwd: repo, encoding: 'utf8' }).trim().split(/\r?\n/);
  assert.equal(list.length, 1);
  assert.equal(execFileSync('git', ['branch', '--list', job.branch], { cwd: repo, encoding: 'utf8' }).trim(), '');
});
