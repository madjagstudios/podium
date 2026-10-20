import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { createJob, updateJob, readJob } from '../engine/store.js';
import { claimDelivery, releaseDelivery, refreshDelivery, OTHER_CHATS_MS } from '../engine/delivery.js';
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

// A backlog of notices nobody claimed (their chats closed, or couldn't see them) must not arrive in the next chat
// that looks, one turn each: past the hour, a notice is its own chat's alone.
test('another chat takes a notice only within the hour; its own chat takes it at any age', () => {
  const DAY = 86_400_000;
  const old = finished({ session: 'A' }, DAY);
  assert.deepEqual(claimDelivery(old.root, old.id, 'B', { now: T }), { claimed: false, reason: 'too-old' });
  assert.equal(fs.existsSync(path.join(old.dir, 'delivery.lock')), false, 'a refusal takes no lock');
  assert.equal(readJob(old.dir).delivered, false, 'it stays undelivered for its own chat');
  assert.deepEqual(claimDelivery(old.root, old.id, 'A', { now: T }), { claimed: true });
  // Fresh, as before: its own chat first, then any chat of the project.
  const fresh = finished({ session: 'A' }, 10 * 60_000);
  assert.deepEqual(claimDelivery(fresh.root, fresh.id, 'B', { now: T }), { claimed: true });
  const edge = finished({ session: 'A' }, OTHER_CHATS_MS);
  assert.deepEqual(claimDelivery(edge.root, edge.id, 'B', { now: T }), { claimed: true });
  const past = finished({ session: 'A' }, OTHER_CHATS_MS + 1000);
  assert.deepEqual(claimDelivery(past.root, past.id, 'B', { now: T }), { claimed: false, reason: 'too-old' });
  // A job started outside any chat is every chat's other.
  const orphan = finished(null, DAY);
  assert.deepEqual(claimDelivery(orphan.root, orphan.id, 'B', { now: T }), { claimed: false, reason: 'too-old' });
  // A PR that opened just now on day-old work is news again, timed from the event.
  const pr = finished({ session: 'A' }, DAY);
  updateJob(pr.root, pr.dir, { status: 'in-review', notifiedAt: new Date(T - 10 * 60_000).toISOString() });
  assert.deepEqual(claimDelivery(pr.root, pr.id, 'B', { now: T }), { claimed: true });
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
  // The CLI claims at the real time, long after T: the job's own chat may claim it at any age.
  const { root, id } = finished({ session: 'A' });
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
