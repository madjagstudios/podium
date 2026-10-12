import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { saveAdapter } from '../engine/adapters/registry.js';
import { dispatch } from '../engine/dispatch.js';
import { readJob } from '../engine/store.js';
import { openPr, setAutoMerge, watchAgain } from '../engine/pr.js';
import { watchOnce, openPrThreads, ensureWatch } from '../engine/pr-watch.js';
import { tempRoot, fakeAdapter, waitFor, ghWorld } from './helpers.js';

const CREATED = { match: ['pr', 'create'], stdout: 'https://github.com/o/r/pull/12\n' };
// Tests never start a sprint runner: a pass in which a PR merges would ask for one (ensureSprints), so they pass this.
const noEnsure = () => {};
const GREEN = { state: 'OPEN', mergeable: 'MERGEABLE', reviewDecision: '', statusCheckRollup: [{ __typename: 'CheckRun', name: 't', status: 'COMPLETED', conclusion: 'SUCCESS' }], comments: [], reviews: [] };

async function prJob(root, w) {
  const res = await dispatch(root, { agent: 'fake', permission: 'edit-worktree', cwd: w.repo, prompt: 'Add the fake file', ticket: 'ABC-12' });
  const job = await waitFor(() => { const j = readJob(res.dir); return ['needs-review', 'done', 'failed'].includes(j.status) && j; });
  // Keep the test's own watcher out of the way: openPr would start one.
  return openPr(root, job.id, { env: w.env, watch: false });
}

test('one pass refreshes open PRs and merges green ones that asked for it', async () => {
  const root = tempRoot();
  saveAdapter(root, fakeAdapter('edit'));
  const w = ghWorld([CREATED, { match: ['pr', 'view'], stdout: GREEN }, { match: ['pr', 'merge'], stdout: '' }]);
  const opened = await prJob(root, w);
  let out = await watchOnce(root, { env: w.env, ensure: noEnsure });
  assert.deepEqual(out, { checked: 1, merged: 0, stopped: 0 });
  await setAutoMerge(root, opened.id, true);
  out = await watchOnce(root, { env: w.env, ensure: noEnsure });
  assert.equal(out.merged, 1);
  assert.deepEqual(openPrThreads(root), []);
});

test('watching stops after seven days, says so, and Watch again restarts it', async () => {
  const root = tempRoot();
  saveAdapter(root, fakeAdapter('edit'));
  const w = ghWorld([CREATED, { match: ['pr', 'view'], stdout: GREEN }]);
  const opened = await prJob(root, w);
  const later = Date.parse(opened.pr.watchUntil) + 1000;
  const out = await watchOnce(root, { env: w.env, now: later, ensure: noEnsure });
  assert.equal(out.stopped, 1);
  assert.equal(openPrThreads(root)[0].pr.watching, false);
  assert.equal((await watchOnce(root, { env: w.env, now: later, ensure: noEnsure })).checked, 0);
  assert.equal((await watchAgain(root, opened.id)).pr.watching, true);
});

test('ensureWatch starts nothing while a fresh heartbeat exists, or when no PR is open', () => {
  const root = tempRoot();
  fs.writeFileSync(path.join(root, 'pr-watch.json'), JSON.stringify({ pid: process.pid, at: Date.now() }));
  assert.equal(ensureWatch(root).started, false);
  fs.rmSync(path.join(root, 'pr-watch.json'));
  assert.equal(ensureWatch(root).started, false, 'no open PRs');
});

// A sprint ticket may wait for this PR to merge; the watcher asks for its runner, pane open or not.
test('a pass in which a PR merges asks for sprint runners once; an open PR asks nothing', async () => {
  const root = tempRoot();
  saveAdapter(root, fakeAdapter('edit'));
  const w = ghWorld([CREATED, { match: ['pr', 'view'], stdout: { ...GREEN, state: 'MERGED' } }]);
  await prJob(root, w);
  let asked = 0;
  await watchOnce(root, { env: w.env, ensure: () => { asked += 1; } });
  assert.equal(asked, 1);
  await watchOnce(root, { env: w.env, ensure: () => { asked += 1; } });
  assert.equal(asked, 1, 'nothing is left to watch');
  const root2 = tempRoot();
  saveAdapter(root2, fakeAdapter('edit'));
  const w2 = ghWorld([CREATED, { match: ['pr', 'view'], stdout: GREEN }]);
  await prJob(root2, w2);
  await watchOnce(root2, { env: w2.env, ensure: () => { asked += 1; } });
  assert.equal(asked, 1);
});
