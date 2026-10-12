import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { saveAdapter } from '../engine/adapters/registry.js';
import { dispatch } from '../engine/dispatch.js';
import { readJob, findJobDir, updateJob } from '../engine/store.js';
import { threadSteps, contextBrief } from '../engine/thread.js';
import { keep } from '../engine/review.js';
import { tempRoot, tempRepo, fakeAdapter, waitFor } from './helpers.js';

const finished = (dir) => waitFor(() => { const j = readJob(dir); return ['needs-review', 'done', 'failed'].includes(j.status) && j; });

async function firstEdit(mode = 'edit') {
  const root = tempRoot();
  saveAdapter(root, fakeAdapter(mode));
  saveAdapter(root, { ...fakeAdapter('edit2'), name: 'fake2', label: 'Fake2' });
  const repo = tempRepo();
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: repo });
  const res = await dispatch(root, { agent: 'fake', permission: 'edit-worktree', cwd: repo, prompt: 'Make the first file' });
  return { root, repo, first: await finished(res.dir) };
}

test('contextBrief lists earlier steps, the last summary and the new request', () => {
  const brief = contextBrief([{ step: 1, agent: 'claude', title: 'Create calculator.html' }], 'Built it.', 'Add CSS');
  assert.match(brief, /^You are continuing work that is already in this folder \(step 2 of a task\)\./);
  assert.match(brief, /1\. claude: Create calculator\.html/);
  assert.match(brief, /Result of the last step: Built it\./);
  assert.match(brief, /Its changes are already in the files here\. Now:\nAdd CSS$/);
});

test('a follow-up runs in the same copy, sees step 1, and its diff holds both steps', async () => {
  const { root, repo, first } = await firstEdit();
  assert.equal(first.threadId, first.id);
  assert.equal(first.step, 1);
  const res = await dispatch(root, { agent: 'fake2', cwd: repo, prompt: 'Add a second file', followUp: first.id });
  const second = await finished(res.dir);
  assert.equal(second.threadId, first.id);
  assert.equal(second.step, 2);
  assert.equal(second.followUpOf, first.id);
  assert.equal(second.worktree, first.worktree);
  assert.equal(second.baseCommit, first.baseCommit);
  const patch = fs.readFileSync(path.join(res.dir, 'diff.patch'), 'utf8');
  assert.match(patch, /fake-edit\.txt/);
  assert.match(patch, /fake-edit2\.txt/);
  const was = readJob(findJobDir(root, first.id));
  assert.equal(was.status, 'continued');
  assert.equal(was.endStatus, 'needs-review');
  assert.equal(was.continuedBy, second.id);
  assert.deepEqual(threadSteps(root, second).map((j) => j.step), [1, 2]);
  assert.match(fs.readFileSync(path.join(res.dir, 'prompt.md'), 'utf8'), /^You are continuing work/);
  await keep(root, second.id);
  assert.equal(fs.readFileSync(path.join(repo, 'fake-edit2.txt'), 'utf8'), 'edited by fake2\n');
  assert.equal(fs.existsSync(path.join(repo, 'fake-edit.txt')), true);
});

test('follow-ups are refused while busy, when closed, when not latest, or with another permission', async () => {
  const { root, repo, first } = await firstEdit();
  await assert.rejects(dispatch(root, { agent: 'fake', cwd: repo, prompt: 'x', followUp: first.id, permission: 'full-access' }), (e) => e.code === 'permission-locked');
  const res = await dispatch(root, { agent: 'fake', cwd: repo, prompt: 'Again', followUp: first.id });
  await finished(res.dir); // let its background run finish before the test edits its status
  await assert.rejects(dispatch(root, { agent: 'fake', cwd: repo, prompt: 'x', followUp: first.id }), (e) => e.code === 'not-latest');
  updateJob(root, res.dir, { status: 'running' });
  await assert.rejects(dispatch(root, { agent: 'fake', cwd: repo, prompt: 'x', followUp: readJob(res.dir).id }), (e) => e.code === 'thread-busy');
  updateJob(root, res.dir, { status: 'kept' });
  await assert.rejects(dispatch(root, { agent: 'fake', cwd: repo, prompt: 'x', followUp: readJob(res.dir).id }), (e) => e.code === 'thread-closed');
});

test('the same agent with a session continues it; the job records resumeFrom instead of a brief', async () => {
  const { root, repo, first } = await firstEdit();
  updateJob(root, findJobDir(root, first.id), { agentSession: { agent: 'fake', id: 'sess-123' } });
  const res = await dispatch(root, { agent: 'fake', cwd: repo, prompt: 'Tweak it', followUp: first.id });
  const step2 = readJob(res.dir);
  assert.equal(step2.resumeFrom, 'sess-123');
  assert.equal(fs.readFileSync(path.join(res.dir, 'prompt.md'), 'utf8'), 'Tweak it');
  assert.match(fs.readFileSync(path.join(res.dir, 'prompt-brief.md'), 'utf8'), /^You are continuing work/);
});

test('a follow-up inherits the ticket and briefs from the last output when there is no summary', async () => {
  const root = tempRoot();
  saveAdapter(root, fakeAdapter('edit'));
  saveAdapter(root, { ...fakeAdapter('edit2'), name: 'fake2', label: 'Fake2' });
  const repo = tempRepo();
  const res1 = await dispatch(root, { agent: 'fake', permission: 'edit-worktree', cwd: repo, prompt: 'First', ticket: 'ABC-9' });
  const first = await finished(res1.dir);
  assert.equal(first.ticket, 'ABC-9');
  const res2 = await dispatch(root, { agent: 'fake2', cwd: repo, prompt: 'Second', followUp: first.id });
  const second = readJob(res2.dir);
  assert.equal(second.ticket, 'ABC-9');
  const brief = fs.readFileSync(path.join(res2.dir, 'prompt-brief.md'), 'utf8');
  assert.match(brief, /Result of the last step: \(its final output\) [\s\S]*edited/);
  await finished(res2.dir);
});
