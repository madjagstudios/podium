import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parsePatch, changeSummary, changes } from '../engine/changes.js';
import { agentStats } from '../engine/discover.js';
import { createJob, updateJob } from '../engine/store.js';
import { tempRoot } from './helpers.js';

const PATCH = [
  'diff --git a/src/round.ts b/src/round.ts',
  'index 111..222 100644',
  '--- a/src/round.ts',
  '+++ b/src/round.ts',
  '@@ -1,3 +1,3 @@',
  ' keep',
  '-old line',
  '+new line',
  '+another',
  'diff --git a/logo.png b/logo.png',
  'new file mode 100644',
  'Binary files /dev/null and b/logo.png differ',
  '',
].join('\n');

test('parsePatch counts lines per file and marks binary files', () => {
  const r = parsePatch(PATCH);
  assert.equal(r.files.length, 2);
  assert.deepEqual(
    { path: r.files[0].path, added: r.files[0].added, removed: r.files[0].removed, isTruncated: r.files[0].isTruncated },
    { path: 'src/round.ts', added: 2, removed: 1, isTruncated: false },
  );
  assert.match(r.files[0].patch, /^@@ -1,3 \+1,3 @@/);
  assert.doesNotMatch(r.files[0].patch, /\+\+\+ b\//);
  assert.deepEqual({ path: r.files[1].path, added: r.files[1].added, removed: r.files[1].removed }, { path: 'logo.png', added: null, removed: null });
  assert.equal(r.added, 2);
  assert.equal(r.removed, 1);
  assert.deepEqual(changeSummary(PATCH), { files: 2, added: 2, removed: 1 });
});

test('a long file patch is cut at 400 lines unless full', () => {
  const body = Array.from({ length: 500 }, (_, i) => `+line ${i}`);
  const text = ['diff --git a/big.txt b/big.txt', '--- /dev/null', '+++ b/big.txt', '@@ -0,0 +1,500 @@', ...body, ''].join('\n');
  const cut = parsePatch(text).files[0];
  assert.equal(cut.patch.split('\n').length, 400);
  assert.equal(cut.isTruncated, true);
  assert.equal(cut.added, 500);
  const whole = parsePatch(text, { limit: Infinity }).files[0];
  assert.equal(whole.isTruncated, false);
  assert.equal(whole.patch.split('\n').length, 501);
});

test('changes reads the job patch, or returns nothing when there is none', async () => {
  const root = tempRoot();
  const { job, dir } = createJob(root, { project: 'demo', ticket: 'NO-TICKET', agent: 'fake', permission: 'edit-worktree', cwd: '/w', prompt: 'x' });
  assert.deepEqual(await changes(root, job.id), { files: [], added: 0, removed: 0 });
  fs.writeFileSync(path.join(dir, 'diff.patch'), PATCH);
  assert.equal((await changes(root, job.id)).files.length, 2);
});

test('agentStats counts jobs and thumbs-up per agent across projects', () => {
  const root = tempRoot();
  const mk = (project, agent, outcome) => {
    const { dir } = createJob(root, { project, ticket: 'NO-TICKET', agent, permission: 'read-only', cwd: '/w', prompt: 'x' });
    if (outcome) updateJob(root, dir, { outcome, outcomeSource: 'user' });
  };
  mk('a', 'codex', 'used'); mk('b', 'codex', 'discarded'); mk('a', 'codex', 'used'); mk('a', 'muse', null);
  assert.deepEqual(agentStats(root), { codex: { jobs: 3, used: 2 }, muse: { jobs: 1, used: 0 } });
});
