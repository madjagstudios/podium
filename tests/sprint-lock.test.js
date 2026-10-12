// The sprint lock never has two holders, even when several processes
// find a stale lock at once.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fork, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { locked, saveSprint, loadSprint, setLockTimings, LOCK_STALE_MS, LOCK_HEARTBEAT_MS } from '../engine/sprint.js';
import { tempRoot } from './helpers.js';

const CHILD = fileURLToPath(new URL('./sprint-lock-child.js', import.meta.url));
const CAS_CHILD = fileURLToPath(new URL('./sprint-cas-child.js', import.meta.url));
const MOD = pathToFileURL(fileURLToPath(new URL('../engine/sprint.js', import.meta.url))).href;
const ROUNDS = 25;

function world() {
  const root = tempRoot();
  const id = 'lock-test';
  saveSprint(root, { id, count: 0 });
  return { root, id, lock: path.join(root, 'sprints', id, 'sprint.lock') };
}

async function until(cond, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

// The race: A passes the ownership check, is suspended past its lock's stale time, B reclaims the
// lock and saves; when A resumes, its write must be refused and B's state must stand.
test('a writer suspended after its ownership check cannot commit over the new owner\'s save', { timeout: 20_000 }, async () => {
  const { root, id } = world();
  const timings = { staleMs: 500, heartbeatMs: 50 };
  const checked = path.join(root, 'a-checked');
  const resume = path.join(root, 'a-resume');
  const a = fork(CAS_CHILD, [MOD, root, id, JSON.stringify(timings), checked, resume], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  const done = new Promise((resolve) => a.once('message', resolve));
  setLockTimings(timings);
  try {
    await until(() => fs.existsSync(checked)); // A is inside its save, past the check, and frozen
    await new Promise((r) => setTimeout(r, timings.staleMs + 200)); // A's lock is now stale: no heartbeat ran
    await locked(root, id, async (held) => {
      const s = loadSprint(root, id);
      s.by = 'B';
      saveSprint(root, s, held);
    }, { waitMs: 3000 });
    fs.writeFileSync(resume, '');
    const { result } = await done;
    assert.equal(result, 'sprint-busy', 'A\'s write was refused');
    assert.equal(loadSprint(root, id).by, 'B', 'B\'s update survives');
  } finally {
    setLockTimings({ staleMs: LOCK_STALE_MS, heartbeatMs: LOCK_HEARTBEAT_MS });
    fs.writeFileSync(resume, '');
    a.kill();
  }
});

test('processes that find a stale lock at the same moment never hold it together', { timeout: 60_000 }, async () => {
  const { root, id, lock } = world();
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  const kids = [0, 1, 2].map(() => fork(CHILD, [MOD, root, id], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] }));
  const next = (kid) => new Promise((resolve) => kid.once('message', resolve));
  try {
    await Promise.all(kids.map(next)); // ready
    let entries = 0;
    for (let round = 0; round < ROUNDS; round++) {
      // A lock left by a holder that died.
      fs.writeFileSync(lock, JSON.stringify({ pid: dead, token: `dead-${round}` }));
      const go = Date.now() + 40;
      const answers = Promise.all(kids.map(next));
      for (const kid of kids) kid.send({ go, round });
      for (const a of await answers) {
        assert.equal(a.twoHolders, false, `round ${round}: two processes held the lock at once`);
        if (a.entered) entries++;
      }
    }
    assert.equal(entries, ROUNDS * kids.length, 'every process got its turn each round');
    assert.equal(loadSprint(root, id).count, entries, 'every entry saved its count, and no save was lost');
  } finally {
    for (const kid of kids) { try { kid.send({ quit: true }); } catch { /* gone */ } }
  }
});

test('a holder whose lock was taken over cannot save the sprint', async () => {
  const { root, id, lock } = world();
  await assert.rejects(locked(root, id, async (held) => {
    // As if another process had reclaimed the lock while this one ran long.
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'someone-else' }));
    saveSprint(root, { id, count: 99 }, held);
  }), (e) => e.code === 'sprint-busy');
  assert.equal(loadSprint(root, id).count, 0);
  assert.deepEqual(fs.readdirSync(path.join(path.dirname(lock), 'state')).filter((f) => f.endsWith('.tmp')), [], 'the refused save left no temp file');
});

test('a live holder that runs longer than the stale time keeps its lock: its heartbeat refreshes it', { timeout: 60_000 }, async () => {
  const { root, id } = world();
  const timings = { staleMs: 500, heartbeatMs: 50 };
  setLockTimings(timings);
  const kid = fork(CHILD, [MOD, root, id, JSON.stringify(timings)], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  const next = () => new Promise((resolve) => kid.once('message', resolve));
  try {
    await next(); // ready
    let answer;
    await locked(root, id, async (held) => {
      // A slow tick: four times the stale time. The other process tries the lock all the while.
      answer = next();
      kid.send({ go: Date.now(), round: 0 });
      await new Promise((r) => setTimeout(r, 2000));
      const s = loadSprint(root, id);
      s.log = [...(s.log ?? []), 'slow holder'];
      saveSprint(root, s, held);
    });
    const a = await answer;
    assert.equal(a.error, null, 'the other process got the lock once the slow holder let go');
    assert.equal(a.entered, true);
    const s = loadSprint(root, id);
    assert.deepEqual(s.log, ['slow holder'], 'the slow holder saved first');
    assert.equal(s.count, 1, 'and the other process saved after it, on top of its work');
  } finally {
    setLockTimings({ staleMs: LOCK_STALE_MS, heartbeatMs: LOCK_HEARTBEAT_MS });
    try { kid.send({ quit: true }); } catch { /* gone */ }
  }
});

test('a lock whose holder is alive but has not refreshed it for the stale time is reclaimed', async () => {
  const { root, id, lock } = world();
  // A live pid (this process) whose heartbeat stopped: hung or suspended for longer than LOCK_STALE_MS.
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'hung' }));
  const old = new Date(Date.now() - LOCK_STALE_MS - 60_000);
  fs.utimesSync(lock, old, old);
  const got = await locked(root, id, async () => 'in', { waitMs: 3000 });
  assert.equal(got, 'in');
});

test('a fresh lock held by a live process is not reclaimed', async () => {
  const { root, id, lock } = world();
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'alive' }));
  await assert.rejects(locked(root, id, async () => 'in', { waitMs: 300 }), (e) => e.code === 'sprint-busy');
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).token, 'alive');
});

test('a stale reclaim mutex left by a dead process does not block the lock', async () => {
  const { root, id, lock } = world();
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  fs.writeFileSync(lock, JSON.stringify({ pid: dead, token: 'dead' }));
  fs.writeFileSync(`${lock}.reclaim`, JSON.stringify({ pid: dead, token: 'dead-mutex', at: Date.now() }));
  const got = await locked(root, id, async () => 'in', { waitMs: 3000 });
  assert.equal(got, 'in');
});
