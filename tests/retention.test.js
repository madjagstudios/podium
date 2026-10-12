import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createJob, updateJob } from '../engine/store.js';
import { setSetting } from '../engine/settings.js';
import { prune, readOutput } from '../engine/retention.js';
import { tempRoot } from './helpers.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 4);

function finishedJob(root, daysAgo, extra = {}) {
  const { dir } = createJob(root, { project: 'demo', ticket: 'ABC-2', agent: 'codex', permission: 'read-only', cwd: '/w', prompt: 'p', ...extra });
  updateJob(root, dir, { status: 'done', endedAt: new Date(NOW - daysAgo * DAY).toISOString() });
  for (const f of ['output.md', 'stderr.log', 'summary.md']) fs.writeFileSync(path.join(dir, f), `${f} body`);
  return dir;
}

test('recent jobs are untouched', () => {
  const root = tempRoot();
  const dir = finishedJob(root, 5);
  assert.deepEqual(prune(root, { now: NOW }), { compressed: 0, deleted: 0 });
  assert.ok(fs.existsSync(path.join(dir, 'output.md')));
});

test('jobs older than 30 days are compressed but still readable', () => {
  const root = tempRoot();
  const dir = finishedJob(root, 31);
  assert.deepEqual(prune(root, { now: NOW }), { compressed: 1, deleted: 0 });
  assert.equal(fs.existsSync(path.join(dir, 'output.md')), false);
  assert.equal(readOutput(dir), 'output.md body');
});

test('jobs older than 90 days lose heavy files but keep summary and record', () => {
  const root = tempRoot();
  const dir = finishedJob(root, 91);
  assert.deepEqual(prune(root, { now: NOW }), { compressed: 0, deleted: 1 });
  assert.deepEqual(fs.readdirSync(dir).sort(), ['job.json', 'prompt.md', 'summary.md']);
});

test('pinned tickets, unfinished and review-pending jobs are skipped; settings are honoured', () => {
  const root = tempRoot();
  const pinned = finishedJob(root, 200);
  setSetting(root, 'pinned', ['demo/ABC-2']);
  const { dir: running } = createJob(root, { project: 'other', ticket: 'X-1', agent: 'codex', permission: 'read-only', cwd: '/w', prompt: 'p' });
  const review = finishedJob(root, 200, { project: 'third' });
  updateJob(root, review, { status: 'needs-review' });
  assert.deepEqual(prune(root, { now: NOW }), { compressed: 0, deleted: 0 });
  assert.ok(fs.existsSync(path.join(pinned, 'output.md')));
  assert.ok(fs.existsSync(path.join(running, 'job.json')));
  setSetting(root, 'retention.compressDays', 1);
  const fresh = finishedJob(root, 2, { project: 'fourth' });
  prune(root, { now: NOW });
  assert.ok(fs.existsSync(path.join(fresh, 'output.md.gz')));
});
