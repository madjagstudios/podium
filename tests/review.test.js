import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { saveAdapter } from '../engine/adapters/registry.js';
import { dispatch } from '../engine/dispatch.js';
import { readJob, findJobDir, updateJob } from '../engine/store.js';
import { setOutcome } from '../engine/outcome.js';
import { keep, discard } from '../engine/review.js';
import { tempRoot, tempRepo, fakeAdapter, waitFor } from './helpers.js';

async function editJob(mode = 'edit') {
  const root = tempRoot();
  saveAdapter(root, fakeAdapter(mode));
  const repo = tempRepo();
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: repo });
  const res = await dispatch(root, { agent: 'fake', permission: 'edit-worktree', cwd: repo, prompt: 'Edit' });
  const job = await waitFor(() => { const j = readJob(res.dir); return ['needs-review', 'done', 'failed'].includes(j.status) && j; });
  return { root, repo, job };
}

test('keep applies the changes, removes the worktree and records "used"', async () => {
  const { root, repo, job } = await editJob();
  const kept = await keep(root, job.id);
  assert.equal(kept.status, 'kept');
  assert.equal(kept.outcome, 'used');
  assert.equal(fs.readFileSync(path.join(repo, 'fake-edit.txt'), 'utf8'), 'edited by fake\n');
  assert.equal(fs.existsSync(job.worktree), false);
});

test('keep refuses a conflicting change and leaves everything in place', async () => {
  const { root, repo, job } = await editJob();
  fs.writeFileSync(path.join(repo, 'fake-edit.txt'), 'mine\n');
  await assert.rejects(keep(root, job.id), (e) => e.code === 'merge-conflict' && e.message.includes(job.worktree));
  assert.equal(fs.readFileSync(path.join(repo, 'fake-edit.txt'), 'utf8'), 'mine\n');
  assert.equal(fs.existsSync(job.worktree), true);
  assert.equal(readJob(findJobDir(root, job.id)).status, 'needs-review');
});

test('discard removes the worktree and records "discarded" unless the user rated it', async () => {
  const { root, repo, job } = await editJob();
  setOutcome(root, job.id, 'used', 'user');
  const gone = await discard(root, job.id);
  assert.equal(gone.status, 'discarded');
  assert.equal(gone.outcome, 'used');
  assert.equal(fs.existsSync(job.worktree), false);
  assert.equal(fs.existsSync(path.join(repo, 'fake-edit.txt')), false);
});

test('keep and discard refuse jobs with nothing to review', async () => {
  const { root, job } = await editJob('ok');
  assert.equal(job.status, 'done');
  assert.equal(job.worktree, null);
  await assert.rejects(keep(root, job.id), (e) => e.code === 'nothing-to-keep');
  await assert.rejects(discard(root, job.id), (e) => e.code === 'nothing-to-discard');
});

test('include my uncommitted changes: the agent sees them, the patch holds only its own work, keep applies cleanly', async () => {
  const root = tempRoot();
  saveAdapter(root, fakeAdapter('edit'));
  const repo = tempRepo();
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'README.md'), 'my edit\n');
  fs.mkdirSync(path.join(repo, 'drafts'));
  fs.writeFileSync(path.join(repo, 'drafts', 'idea.txt'), 'untracked\n');

  const res = await dispatch(root, { agent: 'fake', permission: 'edit-worktree', cwd: repo, prompt: 'Edit', includeUncommitted: true });
  assert.equal(res.job.includedUncommitted, true);
  assert.equal(fs.readFileSync(path.join(res.job.worktree, 'README.md'), 'utf8'), 'my edit\n');
  assert.equal(fs.readFileSync(path.join(res.job.worktree, 'drafts', 'idea.txt'), 'utf8'), 'untracked\n');

  const job = await waitFor(() => { const j = readJob(res.dir); return j.status === 'needs-review' && j; });
  const patch = fs.readFileSync(path.join(res.dir, 'diff.patch'), 'utf8');
  assert.match(patch, /fake-edit\.txt/);
  assert.doesNotMatch(patch, /README\.md|idea\.txt/);

  const kept = await keep(root, job.id);
  assert.equal(kept.status, 'kept');
  assert.equal(fs.readFileSync(path.join(repo, 'README.md'), 'utf8'), 'my edit\n');
  assert.equal(fs.readFileSync(path.join(repo, 'fake-edit.txt'), 'utf8'), 'edited by fake\n');
});

test('without the option, a clean worktree is used and nothing is marked as included', async () => {
  const { job } = await editJob();
  assert.equal(job.includedUncommitted, false);
});

test('keep refuses committed work; discard leaves the agent\'s branch alone', async () => {
  const { root, repo, job } = await editJob('commit-dirty');
  assert.equal(job.status, 'done');
  assert.equal(job.committed.branch, 'feat/agent-work');
  await assert.rejects(keep(root, job.id), (e) => e.code === 'committed-work' && /feat\/agent-work/.test(e.message));
  await discard(root, job.id);
  execFileSync('git', ['rev-parse', '--verify', '--quiet', 'refs/heads/feat/agent-work'], { cwd: repo, stdio: 'pipe' });
});

test('keep also refuses an older job whose copy has commits, found live', async () => {
  const { root, job } = await editJob('commit-dirty');
  updateJob(root, findJobDir(root, job.id), { committed: undefined, status: 'needs-review' });
  await assert.rejects(keep(root, job.id), (e) => e.code === 'committed-work');
});
