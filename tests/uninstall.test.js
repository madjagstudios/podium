import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { saveAdapter } from '../engine/adapters/registry.js';
import { dispatch } from '../engine/dispatch.js';
import { readJob } from '../engine/store.js';
import { removalPlan, uninstall, dataSize } from '../engine/uninstall.js';
import { setSetting } from '../engine/settings.js';
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

test('the removal plan counts copies kept in a copies folder of their own, and uninstall removes them', async () => {
  const root = tempRoot();
  const copies = tempRoot();
  saveAdapter(root, fakeAdapter('edit'));
  const repo = tempRepo();
  const inside = removalPlan(root).bytes;
  setSetting(root, 'worktreeRoot', copies);
  const job = await editJob(root, repo);
  assert.ok(job.worktree.startsWith(copies));
  const plan = removalPlan(root);
  assert.ok(plan.bytes >= inside + dataSize(job.worktree), 'the copy outside the data folder is counted');
  // A follow-up works in the same copy: the copy still counts once.
  const next = await dispatch(root, { agent: 'fake', cwd: repo, prompt: 'Edit again', followUp: job.id });
  await waitFor(() => { const j = readJob(next.dir); return ['needs-review', 'done', 'failed'].includes(j.status) && j; });
  assert.equal(readJob(next.dir).worktree, job.worktree);
  assert.equal(removalPlan(root).bytes, dataSize(root) + dataSize(job.worktree), 'the shared copy counts once');
  const out = await uninstall(root);
  assert.equal(out.removed, true);
  assert.equal(fs.existsSync(job.worktree), false);
});

test('a copies folder inside the data folder whose name starts with two dots is counted once, as part of the data folder', async () => {
  const root = tempRoot();
  saveAdapter(root, fakeAdapter('edit'));
  setSetting(root, 'worktreeRoot', path.join(root, '..copies'));
  const job = await editJob(root, tempRepo());
  assert.ok(job.worktree.startsWith(path.join(root, '..copies')));
  assert.equal(removalPlan(root).bytes, dataSize(root));
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
