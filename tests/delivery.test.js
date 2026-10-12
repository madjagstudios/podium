import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { createJob, updateJob, readJob } from '../engine/store.js';
import { claimDelivery, releaseDelivery, refreshDelivery } from '../engine/delivery.js';
import { markDelivered } from '../engine/outcome.js';
import { main } from '../engine/cli.js';
import { tempRoot } from './helpers.js';

const T = Date.parse('2026-10-05T12:00:00Z');
function finished(origin, endedAgoMs = 1000) {
  const root = tempRoot();
  const { job, dir } = createJob(root, { project: 'demo', ticket: 'NO-TICKET', agent: 'fake', permission: 'read-only', cwd: '/w', prompt: 'x' });
  updateJob(root, dir, { status: 'done', endedAt: new Date(T - endedAgoMs).toISOString(), origin });
  return { root, id: job.id, dir };
}

test('the dispatching session can claim at once; others wait two minutes', () => {
  const { root, id } = finished({ session: 'A' });
  assert.deepEqual(claimDelivery(root, id, 'B', { now: T }), { claimed: false, reason: 'not-yours-yet' });
  assert.deepEqual(claimDelivery(root, id, 'A', { now: T }), { claimed: true });
  const late = finished({ session: 'A' }, 121_000);
  assert.deepEqual(claimDelivery(late.root, late.id, 'B', { now: T }), { claimed: true });
  const noOrigin = finished(null);
  assert.deepEqual(claimDelivery(noOrigin.root, noOrigin.id, 'B', { now: T }), { claimed: true });
});

test('a live claim blocks others; a stale one does not; release and delivery clear it', () => {
  const { root, id, dir } = finished(null);
  assert.equal(claimDelivery(root, id, 'A', { now: T }).claimed, true);
  assert.deepEqual(claimDelivery(root, id, 'B', { now: T + 1000 }), { claimed: false, reason: 'claimed-elsewhere' });
  assert.equal(claimDelivery(root, id, 'B', { now: T + 61_000 }).claimed, true);
  assert.deepEqual(releaseDelivery(root, id), { released: true });
  assert.equal(fs.existsSync(path.join(dir, 'delivery.lock')), false);
  assert.equal(claimDelivery(root, id, 'A', { now: T }).claimed, true);
  markDelivered(root, id);
  assert.equal(fs.existsSync(path.join(dir, 'delivery.lock')), false);
  assert.deepEqual(claimDelivery(root, id, 'A', { now: T }), { claimed: false, reason: 'delivered' });
});

test('a running job cannot be claimed', () => {
  const root = tempRoot();
  const { job, dir } = createJob(root, { project: 'demo', ticket: 'NO-TICKET', agent: 'fake', permission: 'read-only', cwd: '/w', prompt: 'x' });
  updateJob(root, dir, { status: 'running' });
  assert.deepEqual(claimDelivery(root, job.id, 'A'), { claimed: false, reason: 'not-finished' });
  assert.equal(readJob(dir).delivered, false);
});

test('a PR that opened or merged can be claimed for its chat message', () => {
  for (const status of ['in-review', 'merged', 'closed']) {
    const { root, id, dir } = finished(null);
    updateJob(root, dir, { status });
    assert.deepEqual(claimDelivery(root, id, 'A', { now: T }), { claimed: true });
  }
});

test('another chat never claims a sprint step, however long it waits', () => {
  const { root, id, dir } = finished({ session: 'A' }, 3_600_000);
  updateJob(root, dir, { sprint: { id: 's1', ticket: 'ABC-1', task: 1, role: 'author' } });
  assert.deepEqual(claimDelivery(root, id, 'B', { now: T }), { claimed: false, reason: 'not-yours-yet' });
  assert.deepEqual(claimDelivery(root, id, 'A', { now: T }), { claimed: true });
});

test('a plain job whose PR opened just now waits two minutes for its own chat, timed from the event', () => {
  const { root, id, dir } = finished({ session: 'A' }, 3_600_000);
  updateJob(root, dir, { status: 'in-review', notifiedAt: new Date(T).toISOString() });
  assert.deepEqual(claimDelivery(root, id, 'B', { now: T + 1000 }), { claimed: false, reason: 'not-yours-yet' });
  assert.deepEqual(claimDelivery(root, id, 'B', { now: T + 121_000 }), { claimed: true });
});

test('a lock its holder refreshes is not taken; one it stops refreshing is', () => {
  const { root, id } = finished(null);
  assert.equal(claimDelivery(root, id, 'A', { now: T }).claimed, true);
  assert.deepEqual(refreshDelivery(root, id, 'A', { now: T + 50_000 }), { refreshed: true });
  assert.deepEqual(refreshDelivery(root, id, 'B', { now: T + 50_000 }), { refreshed: false }, 'only the holder refreshes');
  assert.deepEqual(claimDelivery(root, id, 'B', { now: T + 70_000 }), { claimed: false, reason: 'claimed-elsewhere' });
  assert.equal(claimDelivery(root, id, 'B', { now: T + 111_000 }).claimed, true);
});

test('claim --refresh keeps the holder\'s lock fresh from the CLI', async () => {
  const { root, id } = finished(null);
  const cli = async (argv) => {
    let out = '';
    const stdout = new Writable({ write(c, _e, cb) { out += c; cb(); } });
    await main(argv, { stdout, env: { ...process.env, PODIUM_DATA_DIR: root } });
    return JSON.parse(out);
  };
  assert.equal((await cli(['claim', '--id', id, '--session', 'A'])).claimed, true);
  assert.deepEqual(await cli(['claim', '--id', id, '--session', 'A', '--refresh']), { refreshed: true });
  assert.deepEqual(await cli(['claim', '--id', id, '--session', 'B', '--refresh']), { refreshed: false });
});

test('a refreshed lock is whole on disk, with no temp file left behind', () => {
  const { root, id, dir } = finished(null);
  assert.equal(claimDelivery(root, id, 'A', { now: T }).claimed, true);
  assert.deepEqual(refreshDelivery(root, id, 'A', { now: T + 5000 }), { refreshed: true });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'delivery.lock'), 'utf8')).at, T + 5000);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
  assert.deepEqual(refreshDelivery(root, id, 'A', { now: T }), { refreshed: true });
  releaseDelivery(root, id);
  assert.deepEqual(refreshDelivery(root, id, 'A', { now: T }), { refreshed: false }, 'a released lock is not recreated');
});
