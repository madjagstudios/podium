import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { saveAdapter } from '../engine/adapters/registry.js';
import { dispatch } from '../engine/dispatch.js';
import { readJob } from '../engine/store.js';
import { openPr, postReview, reviewPrompt } from '../engine/pr.js';
import { threadSteps } from '../engine/thread.js';
import { tempRoot, fakeAdapter, waitFor, ghWorld } from './helpers.js';

const VIEW = { title: 'Add export', body: 'Adds CSV export.', baseRefName: 'main', url: 'https://github.com/o/r/pull/7' };
const finished = (dir) => waitFor(() => { const j = readJob(dir); return ['needs-review', 'done', 'failed'].includes(j.status) && j; });

test('the review prompt names the PR, the diff command, the asks, and the extra focus', () => {
  const p = reviewPrompt({ number: 7, ...VIEW }, 'Focus on error handling');
  assert.match(p, /^Review PR #7: Add export/);
  assert.match(p, /git diff origin\/main\.\.\.HEAD/);
  assert.match(p, /Do not change any files/);
  assert.match(p, /file:line/);
  assert.match(p, /Focus on error handling/);
  assert.doesNotMatch(reviewPrompt({ number: 7, ...VIEW }, ''), /also:/);
});

test('a review runs read-only on the PR head in its own copy and can be posted as one comment', async () => {
  const root = tempRoot();
  saveAdapter(root, fakeAdapter('ok'));
  const w = ghWorld([{ match: ['pr', 'view'], stdout: VIEW }, { match: ['pr', 'review'], stdout: '' }]);
  w.git(w.repo, 'push', '-q', 'origin', 'HEAD:refs/pull/7/head');
  const res = await dispatch(root, { agent: 'fake', cwd: w.repo, prompt: 'Focus on error handling', review: 7, env: w.env });
  const job = await finished(res.dir);
  assert.equal(job.status, 'done');
  assert.equal(job.kind, 'review');
  assert.equal(job.permission, 'read-only');
  assert.equal(job.reviewOf.number, 7);
  assert.equal(job.committed ?? null, null);
  assert.equal(job.title, 'Review PR #7: Add export');
  assert.match(fs.readFileSync(path.join(res.dir, 'prompt.md'), 'utf8'), /Focus on error handling/);
  assert.equal(job.worktree, null, 'the review copy is removed when it finishes');
  const posted = await postReview(root, job.id, { env: w.env });
  assert.equal(posted.posted, true);
  const call = w.calls().find((c) => c[0] === 'pr' && c[1] === 'review');
  assert.deepEqual(call.slice(0, 4), ['pr', 'review', '7', '--comment']);
  await assert.rejects(postReview(root, job.id, { env: w.env }), (e) => e.code === 'already-posted');
});

test('a review of a Podium PR joins its thread without becoming the step to continue', async () => {
  const root = tempRoot();
  saveAdapter(root, fakeAdapter('edit'));
  const w = ghWorld([{ match: ['pr', 'create'], stdout: 'https://github.com/o/r/pull/12\n' }, { match: ['pr', 'view'], stdout: { ...VIEW, url: 'https://github.com/o/r/pull/12' } }]);
  const first = await dispatch(root, { agent: 'fake', permission: 'edit-worktree', cwd: w.repo, prompt: 'Add the fake file', ticket: 'ABC-12' });
  const opened = await openPr(root, (await finished(first.dir)).id, { env: w.env });
  w.git(w.repo, 'push', '-q', 'origin', `${opened.pr.branch}:refs/pull/12/head`);
  saveAdapter(root, fakeAdapter('ok'));
  const res = await dispatch(root, { agent: 'fake', cwd: w.repo, prompt: '', review: 12, env: w.env });
  const review = await finished(res.dir);
  assert.equal(review.threadId, opened.threadId);
  assert.equal(threadSteps(root, opened).some((s) => s.id === review.id), false);
  assert.ok(fs.existsSync(opened.worktree), "the PR's own copy is untouched");
});
