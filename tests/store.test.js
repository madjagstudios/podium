import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { TERMINAL, createJob, readJob, updateJob, findJobDir, listJobDirs } from '../engine/store.js';
import { outcomePatch, setOutcome, markDelivered } from '../engine/outcome.js';
import { extractSummary } from '../engine/summary.js';
import { tempRoot } from './helpers.js';

const base = { project: 'demo', ticket: 'ABC-2', agent: 'codex', permission: 'read-only', cwd: '/w', prompt: 'Review it' };

test('createJob writes job.json, prompt.md and a log line', () => {
  const root = tempRoot();
  const { job, dir } = createJob(root, base);
  assert.equal(job.status, 'queued');
  assert.equal(job.outcome, null);
  assert.equal(dir, path.join(root, 'jobs', 'demo', 'ABC-2', job.id));
  assert.equal(fs.readFileSync(path.join(dir, 'prompt.md'), 'utf8'), 'Review it');
  assert.deepEqual(readJob(dir), job);
  const log = fs.readFileSync(path.join(root, 'jobs', 'demo', 'log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(log[0].event, 'created');
  assert.equal(log[0].jobId, job.id);
});

test('updateJob merges and logs; findJobDir and listJobDirs locate jobs', () => {
  const root = tempRoot();
  const a = createJob(root, { ...base, now: new Date(Date.UTC(2026, 0, 1)) });
  const b = createJob(root, { ...base, ticket: 'NO-TICKET', now: new Date(Date.UTC(2026, 0, 2)) });
  const updated = updateJob(root, a.dir, { status: 'done', exitCode: 0 }, 'finished');
  assert.equal(updated.status, 'done');
  assert.equal(updated.exitCode, 0);
  assert.equal(findJobDir(root, b.job.id), b.dir);
  assert.throws(() => findJobDir(root, 'nope'), (e) => e.code === 'job-not-found');
  assert.deepEqual(listJobDirs(root), [b.dir, a.dir]);
  assert.deepEqual(listJobDirs(root, { ticket: 'ABC-2' }), [a.dir]);
  assert.deepEqual(listJobDirs(tempRoot()), []);
  assert.ok(TERMINAL.has('done') && !TERMINAL.has('running'));
  const log = fs.readFileSync(path.join(root, 'jobs', 'demo', 'log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(log.map((l) => l.event), ['created', 'created', 'finished']);
  assert.equal(log[2].status, 'done');
});

test('outcomes: user ratings always win over automatic guesses', () => {
  const root = tempRoot();
  const { job } = createJob(root, base);
  assert.deepEqual(outcomePatch(job, 'used', 'auto'), { outcome: 'used', outcomeSource: 'auto' });
  const rated = setOutcome(root, job.id, 'discarded', 'user');
  assert.equal(outcomePatch(rated, 'used', 'auto'), null);
  assert.equal(setOutcome(root, job.id, 'used', 'auto').outcome, 'discarded');
  assert.equal(setOutcome(root, job.id, 'used', 'user').outcome, 'used');
  assert.throws(() => outcomePatch(job, 'great', 'user'), (e) => e.code === 'bad-outcome');
  assert.throws(() => outcomePatch(job, 'used', 'robot'), (e) => e.code === 'bad-outcome-source');
});

test('markDelivered guesses "used" only for finished read jobs', () => {
  const root = tempRoot();
  const done = createJob(root, base);
  updateJob(root, done.dir, { status: 'done' });
  assert.equal(markDelivered(root, done.job.id).outcome, 'used');
  const failed = createJob(root, base);
  updateJob(root, failed.dir, { status: 'failed' });
  const f = markDelivered(root, failed.job.id);
  assert.equal(f.delivered, true);
  assert.equal(f.outcome, null);
});

test('extractSummary finds a summary heading or line', () => {
  assert.equal(extractSummary('intro\n## Summary\nDid the thing.\nAll good.\n\n## Details\nx'), 'Did the thing.\nAll good.');
  assert.equal(extractSummary('Summary: one line answer\nmore'), 'one line answer\nmore');
  assert.equal(extractSummary('no summary heading here'), null);
  assert.equal(extractSummary('## Summary\n' + Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n')).split('\n').length, 10);
});

test('jobs get a short title from the first line of the prompt', () => {
  const root = tempRoot();
  const { job } = createJob(root, { ...base, prompt: '\n  Review the payout code\nthen more detail' });
  assert.equal(job.title, 'Review the payout code');
  const long = createJob(root, { ...base, prompt: 'x'.repeat(100) }).job;
  assert.equal(long.title.length, 80);
  assert.ok(long.title.endsWith('…'));
});
