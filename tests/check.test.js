// A ticket's full check runs in a process of its own and is read from its record.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { startCheck, runCheck, checkState, stopCheck, LOG_TAIL, STALE_MS, STOP } from '../engine/check.js';
import { isAlive } from '../engine/status.js';
import { tempRoot, waitFor } from './helpers.js';

const node = `"${process.execPath}"`;
const ended = (dir) => waitFor(() => { const r = checkState(dir); return r.state !== 'running' ? r : null; }, { timeoutMs: 30_000 });

test('a check that exits 0 passes', async () => {
  const dir = path.join(tempRoot(), 'check');
  startCheck(dir, { command: `${node} -e "process.exit(0)"`, cwd: tempRoot(), limitMs: 60_000 });
  assert.equal((await ended(dir)).state, 'passed');
});

test('a failing check fails, with its exit code and the end of its log', async () => {
  const dir = path.join(tempRoot(), 'check');
  startCheck(dir, { command: `${node} -e "console.log('build broke at a.cs:3'); process.exit(2)"`, cwd: tempRoot(), limitMs: 60_000 });
  const r = await ended(dir);
  assert.equal(r.state, 'failed');
  assert.equal(r.exitCode, 2);
  assert.match(r.log, /build broke at a\.cs:3/);
});

test('a check past its time limit is stopped and times out', async () => {
  const dir = path.join(tempRoot(), 'check');
  startCheck(dir, { command: `${node} -e "setInterval(Date.now, 1000)"`, cwd: tempRoot(), limitMs: 1000 });
  assert.equal((await ended(dir)).state, 'timed-out');
});

const readRecord = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'check.json'), 'utf8')); } catch { return null; } };
const record = (dir, over) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'check.json'), JSON.stringify({ command: 'x', cwd: '.', limitMs: 60_000, startedAt: new Date().toISOString(), runnerPid: null, checkPid: null, exitCode: null, timedOut: false, endedAt: null, ...over }));
};

// The lowest level any stop could reach: process.kill (a signal, or what a kill of a pid comes down to in Node). Every
// call made while `fn` runs is recorded, and none is made; signal 0 (isAlive's "is it there?", which sends nothing) goes
// through. Podium's side has no taskkill at all (checked below).
function noKills(fn) {
  const calls = [];
  const real = process.kill;
  process.kill = (pid, sig) => { if (sig === 0) return real.call(process, pid, 0); calls.push([pid, sig]); return true; };
  try { fn(); } finally { process.kill = real; }
  return calls;
}
const stopAsked = (dir) => fs.existsSync(path.join(dir, STOP));
const sleeper = () => spawn(process.execPath, ['-e', 'setInterval(Date.now, 1000)'], { stdio: 'ignore' });
const NOT_THE_RUNNER = 424242;

test('Podium\'s side of a check has no way to kill a process: no taskkill, no signal', () => {
  const source = fs.readFileSync(new URL('../engine/check.js', import.meta.url), 'utf8');
  const stopper = source.slice(source.indexOf('export function stopCheck'));
  assert.doesNotMatch(source, /taskkill/);
  assert.doesNotMatch(stopper, /process\.kill|killGroup|killTree|spawn/);
});

test('a check recorded before the machine started is lost, and nothing is ever stopped for it', () => {
  const dir = path.join(tempRoot(), 'check');
  const child = sleeper();
  try {
    const now = Date.now();
    record(dir, { startedAt: new Date(now - 3_600_000).toISOString(), limitMs: 1000, runnerPid: child.pid, checkPid: NOT_THE_RUNNER, beatAt: new Date(now).toISOString() });
    assert.equal(checkState(dir, { now, bootAt: now - 60_000 }).state, 'lost');
    const calls = noKills(() => assert.equal(stopCheck(dir, { now, bootAt: now - 60_000 }), false));
    assert.deepEqual(calls, []);
    assert.equal(stopAsked(dir), false);
  } finally {
    child.kill();
  }
});

test('a stale heartbeat is never safe to stop: within the time limit the check still runs (the machine slept), past it it is lost', () => {
  // Windows Fast Startup keeps the boot time across a shutdown, and a pid may be reused: an alive pid proves nothing.
  const dir = path.join(tempRoot(), 'check');
  const child = sleeper();
  try {
    const now = Date.now();
    const stale = new Date(now - STALE_MS - 1000).toISOString();
    for (const [startedAgo, limitMs, state] of [[10_000, 60_000, 'running'], [10 * 60_000, 1000, 'lost']]) {
      record(dir, { startedAt: new Date(now - startedAgo).toISOString(), limitMs, runnerPid: child.pid, checkPid: NOT_THE_RUNNER, beatAt: stale });
      assert.equal(checkState(dir, { now, bootAt: 0 }).state, state);
      const calls = noKills(() => assert.equal(stopCheck(dir, { now, bootAt: 0 }), false));
      assert.deepEqual(calls, [], state);
      assert.equal(stopAsked(dir), false, state);
    }
    assert.ok(isAlive(child.pid), 'the stale runner\'s pid was left alone');
  } finally {
    child.kill();
  }
});

// runCheck in this process, its record writes failing as `fails` says (the rest go through).
async function runFailing(fails) {
  const dir = path.join(tempRoot(), 'check');
  record(dir, { command: `${node} -e "setTimeout(Date.now, 400)"`, cwd: tempRoot(), beatMs: 20 });
  const seen = { beats: 0, results: 0 };
  const writeRecord = (d, patch) => {
    if (patch.endedAt) seen.results += 1;
    else if (patch.beatAt && !patch.runnerPid) seen.beats += 1;
    if (fails(patch, seen)) throw new Error('EBUSY: the file is held');
    const file = path.join(d, 'check.json');
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...patch }));
  };
  const ok = await runCheck(dir, { writeRecord, retryMs: 10 });
  return { dir, ok, seen };
}

test('a heartbeat that cannot be written is skipped: the runner carries on and records the result', async () => {
  const { dir, ok, seen } = await runFailing((patch) => Boolean(patch.beatAt && !patch.runnerPid));
  assert.equal(ok, true);
  assert.ok(seen.beats > 0, 'it tried to beat');
  assert.equal(checkState(dir).state, 'passed');
});

test('a result that cannot be written is tried once more; failing again, the log says so and the runner says it failed', async () => {
  const once = await runFailing((patch, seen) => Boolean(patch.endedAt) && seen.results === 1);
  assert.equal(once.ok, true);
  assert.equal(checkState(once.dir).state, 'passed');
  const never = await runFailing((patch) => Boolean(patch.endedAt));
  assert.equal(never.ok, false);
  assert.equal(never.seen.results, 2);
  assert.match(fs.readFileSync(path.join(never.dir, 'check.log'), 'utf8'), /Podium couldn't record how the check ended \(exit code 0\): EBUSY: the file is held/);
});

test('reading a check never stops it; an overdue one with a beating runner gets a stop request, and no pid is killed', async () => {
  const dir = path.join(tempRoot(), 'check');
  const child = sleeper();
  try {
    const now = Date.now();
    record(dir, { startedAt: new Date(now - 10 * 60_000).toISOString(), limitMs: 1000, runnerPid: child.pid, checkPid: NOT_THE_RUNNER, beatAt: new Date(now).toISOString() });
    const r = checkState(dir, { now, bootAt: 0 });
    assert.equal(r.state, 'timed-out');
    assert.equal(r.overdue, true);
    await new Promise((res) => setTimeout(res, 500));
    assert.ok(isAlive(child.pid), 'checkState stopped nothing');
    const calls = noKills(() => assert.equal(stopCheck(dir, { now, bootAt: 0 }), true));
    assert.deepEqual(calls, [], 'Podium kills nothing: the runner stops its own check');
    assert.equal(stopAsked(dir), true);
    await new Promise((res) => setTimeout(res, 500));
    assert.ok(isAlive(child.pid), 'the pid recorded as the runner is never killed by Podium');
  } finally {
    child.kill();
  }
});

test('the runner beats while its check runs; a stop request makes the real runner end its own check, recorded as stopped', async () => {
  const dir = path.join(tempRoot(), 'check');
  startCheck(dir, { command: `${node} -e "setInterval(Date.now, 1000)"`, cwd: tempRoot(), limitMs: 10 * 60_000, beatMs: 60_000 });
  const first = await waitFor(() => { const r = readRecord(dir); return r?.checkPid && r.beatAt ? r : null; });
  assert.equal(checkState(dir).state, 'running');
  // Far past its limit, as after a long sleep of the machine. (Its beats are a minute apart here, so it is the ~2 s look
  // for a request that finds it.)
  fs.writeFileSync(path.join(dir, 'check.json'), JSON.stringify({ ...first, startedAt: new Date(Date.now() - 20 * 60_000).toISOString() }));
  // bootAt 0: a CI machine may have started after the backdated start (it would read as lost).
  assert.equal(checkState(dir, { bootAt: 0 }).overdue, true);
  const calls = noKills(() => assert.equal(stopCheck(dir, { bootAt: 0 }), true));
  assert.deepEqual(calls, []);
  await waitFor(() => !isAlive(first.checkPid) && !isAlive(first.runnerPid), { timeoutMs: 30_000 });
  const rec = readRecord(dir);
  assert.equal(rec.stopped, true);
  assert.equal(rec.timedOut, true);
  assert.equal(checkState(dir).state, 'timed-out');
});

test('a long log is read from its end only', async () => {
  const dir = path.join(tempRoot(), 'check');
  record(dir, { exitCode: 1, endedAt: new Date().toISOString() });
  fs.writeFileSync(path.join(dir, 'check.log'), `${'x'.repeat(LOG_TAIL * 3)}\nthe last line`);
  const r = checkState(dir);
  assert.equal(r.state, 'failed');
  assert.ok(r.log.length <= LOG_TAIL);
  assert.match(r.log, /x+\nthe last line$/);
});

test('a check whose runner died without a result is lost', () => {
  const dir = path.join(tempRoot(), 'check');
  fs.mkdirSync(dir, { recursive: true });
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  fs.writeFileSync(path.join(dir, 'check.json'), JSON.stringify({ command: 'x', cwd: '.', limitMs: 60_000, startedAt: new Date().toISOString(), runnerPid: dead, checkPid: null, exitCode: null, timedOut: false, endedAt: null }));
  assert.equal(checkState(dir).state, 'lost');
  assert.equal(checkState(path.join(tempRoot(), 'none')).state, 'lost', 'no record at all');
});
