import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { saveAdapter } from '../engine/adapters/registry.js';
import { createJob, updateJob, readJob } from '../engine/store.js';
import { dispatch } from '../engine/dispatch.js';
import { isAlive, reconcile, status, result } from '../engine/status.js';
import { cancel } from '../engine/cancel.js';
import { readOutput } from '../engine/retention.js';
import { tempRoot, fakeAdapter, waitFor } from './helpers.js';

const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;
const base = { project: 'demo', ticket: 'NO-TICKET', agent: 'fake', permission: 'read-only', cwd: '/w', prompt: 'x' };

test('isAlive', () => {
  assert.equal(isAlive(process.pid), true);
  assert.equal(isAlive(deadPid()), false);
  assert.equal(isAlive(null), false);
});

test('a running job whose runner vanished is marked lost', () => {
  const root = tempRoot();
  const { dir } = createJob(root, base);
  updateJob(root, dir, { status: 'running', startedAt: new Date().toISOString(), runnerPid: deadPid() });
  const job = reconcile(root, dir);
  assert.equal(job.status, 'lost');
  assert.equal(job.outcome, 'unknown');
  assert.match(job.error, /stopped unexpectedly/);
});

test('a queued job is lost only after the grace period', () => {
  const root = tempRoot();
  const { dir, job } = createJob(root, base);
  assert.equal(reconcile(root, dir).status, 'queued');
  assert.equal(reconcile(root, dir, { now: Date.parse(job.createdAt) + 61_000 }).status, 'lost');
});

test('long-running jobs are flagged, not killed', () => {
  const root = tempRoot();
  const { dir } = createJob(root, base);
  const startedAt = new Date().toISOString();
  updateJob(root, dir, { status: 'running', startedAt, runnerPid: process.pid });
  assert.equal(reconcile(root, dir).isLong, false);
  const later = reconcile(root, dir, { now: Date.parse(startedAt) + 31 * 60_000 });
  assert.equal(later.isLong, true);
  assert.equal(later.status, 'running');
});

test('status lists newest first and filters by id', () => {
  const root = tempRoot();
  const a = createJob(root, { ...base, now: new Date(Date.UTC(2026, 0, 1)) });
  const b = createJob(root, { ...base, now: new Date(Date.UTC(2026, 0, 2)) });
  assert.deepEqual(status(root).map((j) => j.id), [b.job.id, a.job.id]);
  assert.deepEqual(status(root, { id: a.job.id }).map((j) => j.id), [a.job.id]);
});

test('result returns the summary, and the full output on request (plain or compressed)', () => {
  const root = tempRoot();
  const { dir, job } = createJob(root, base);
  fs.writeFileSync(path.join(dir, 'summary.md'), 'short\n');
  fs.writeFileSync(path.join(dir, 'output.md.gz'), zlib.gzipSync('long output'));
  const r = result(root, job.id);
  assert.equal(r.summary, 'short\n');
  assert.equal(r.output, null);
  assert.equal(result(root, job.id, { full: true }).output, 'long output');
  assert.equal(readOutput(path.join(root, 'nowhere')), null);
});

test('cancel stops a running job', async () => {
  const root = tempRoot();
  saveAdapter(root, fakeAdapter('slow'));
  const res = await dispatch(root, { agent: 'fake', permission: 'read-only', cwd: tempRoot(), prompt: 'wait' });
  const running = await waitFor(() => { const j = readJob(res.dir); return j.status === 'running' && j; });
  const cancelled = await cancel(root, res.job.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.outcome, 'unknown');
  await waitFor(() => !isAlive(running.runnerPid), { timeoutMs: 15_000 });
  assert.equal(readJob(res.dir).status, 'cancelled');
  await assert.rejects(cancel(root, res.job.id), (e) => e.code === 'not-running');
});

test('running and queued jobs carry the path of their live file', () => {
  const root = tempRoot();
  const { dir } = createJob(root, base);
  updateJob(root, dir, { status: 'running', startedAt: new Date().toISOString(), runnerPid: process.pid });
  const [job] = status(root, {});
  assert.equal(job.liveFile, path.join(dir, 'live.json'));
  updateJob(root, dir, { status: 'done', endedAt: new Date().toISOString() });
  assert.equal(status(root, {})[0].liveFile, undefined);
});

test('result --full includes the tail of the agent activity log', () => {
  const root = tempRoot();
  const { job, dir } = createJob(root, base);
  fs.writeFileSync(path.join(dir, 'output.md'), 'Done.\n');
  fs.writeFileSync(path.join(dir, 'stderr.log'), 'exec seq 1 90\n1\n2\n');
  const r = result(root, job.id, { full: true });
  assert.equal(r.output, 'Done.\n');
  assert.equal(r.log, 'exec seq 1 90\n1\n2\n');
  assert.equal(result(root, job.id).log, null);
});
