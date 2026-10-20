// A ticket's full check runs in a process of its own and is read from its record.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { startCheck, runCheck, checkState, checkSettled, stopCheck, checkCommand, LOG_TAIL, STALE_MS, STOP, LATE_MS } from '../engine/check.js';
import { isAlive } from '../engine/status.js';
import { tempRoot, waitFor, stuckCheck, endProcesses } from './helpers.js';

const node = `"${process.execPath}"`;
const ended = (dir) => waitFor(() => { const r = checkState(dir); return r.state !== 'running' ? r : null; }, { timeoutMs: 30_000 });

test('a check that exits 0 passes', async () => {
  const dir = path.join(tempRoot(), 'check');
  startCheck(dir, { command: `${node} -e "process.exit(0)"`, cwd: tempRoot(), limitMs: 60_000 });
  assert.equal((await ended(dir)).state, 'passed');
});

test('a host check receives safe build defaults while keeping its command, cwd and other environment values', async () => {
  const dir = path.join(tempRoot(), 'check');
  const cwd = tempRoot();
  const inherited = {
    UseSharedCompilation: 'true', DOTNET_CLI_USE_MSBUILD_SERVER: '1', MSBUILDDISABLENODEREUSE: '0',
    TMPDIR: cwd, TEMP: cwd, TMP: cwd, PODIUM_JOB_ID: 'host-parent',
  };
  const names = [...Object.keys(inherited), 'PATH'];
  fs.writeFileSync(path.join(cwd, 'env.cjs'), `console.log(JSON.stringify({ cwd: process.cwd(), env: Object.fromEntries(${JSON.stringify(names)}.map(name => [name, process.env[name]])) }));`);
  const command = `${node} env.cjs`;
  const before = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    Object.assign(process.env, inherited);
    startCheck(dir, { command, cwd, limitMs: 60_000 });
  } finally {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
  assert.equal((await ended(dir)).state, 'passed');
  assert.equal(checkCommand(dir), command);
  const seen = JSON.parse(fs.readFileSync(path.join(dir, 'check.log'), 'utf8'));
  // The check's own cwd is the real path (macOS reports /private/var for /var).
  assert.equal(fs.realpathSync.native(seen.cwd), fs.realpathSync.native(cwd));
  assert.deepEqual({ ...seen, cwd }, {
    cwd,
    env:{ ...inherited, PATH: before.PATH, UseSharedCompilation: 'false', DOTNET_CLI_USE_MSBUILD_SERVER: '0', MSBUILDDISABLENODEREUSE: '1' },
  });
});

test('a failing check fails, with its exit code and the end of its log', async () => {
  const dir = path.join(tempRoot(), 'check');
  startCheck(dir, { command: `${node} -e "console.log('build broke at a.cs:3'); process.exit(2)"`, cwd: tempRoot(), limitMs: 60_000 });
  const r = await ended(dir);
  assert.equal(r.state, 'failed');
  assert.equal(r.exitCode, 2);
  assert.match(r.log, /build broke at a\.cs:3/);
});

test('a check past its time limit is stopped and times out', async (t) => {
  const dir = path.join(tempRoot(), 'check');
  startCheck(dir, { command: stuckCheck(t, { checks: () => [dir] }), cwd: tempRoot(), limitMs: 1000 });
  assert.equal((await ended(dir)).state, 'timed-out');
});

test('a check whose whole tree can\'t be stopped still ends: its shell is stopped, the log says so, and the stop is recorded', async (t) => {
  // As in a sandbox that refuses taskkill: the runner used to wait for its check for ever.
  const dir = path.join(tempRoot(), 'check');
  record(dir, { command: stuckCheck(t), cwd: tempRoot(), limitMs: 1000, beatMs: 60_000 });
  const asked = [];
  const stopTree = (pid, { refused }) => { asked.push(pid); refused(pid, 'ERROR: Access denied'); };
  const ok = await Promise.race([runCheck(dir, { stopTree }), new Promise((r) => setTimeout(() => r('still waiting'), 30_000))]);
  assert.equal(ok, true);
  const rec = readRecord(dir);
  assert.deepEqual([asked, rec.timedOut, rec.exitCode === 0], [[rec.checkPid], true, false]);
  assert.equal(checkState(dir).state, 'timed-out');
  assert.match(fs.readFileSync(path.join(dir, 'check.log'), 'utf8'), /Podium couldn't stop everything the check started \(ERROR: Access denied\)\. It stopped the check's shell; what that started may still be running\./);
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

test('the runner beats while its check runs; a stop request makes the real runner end its own check, recorded as stopped', async (t) => {
  const dir = path.join(tempRoot(), 'check');
  startCheck(dir, { command: stuckCheck(t, { checks: () => [dir] }), cwd: tempRoot(), limitMs: 10 * 60_000, beatMs: 60_000 });
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

test('a test\'s end stops nothing: a pid seen gone is never looked at again, and one still running fails it, named', async () => {
  // As if the pid ended and Windows gave it to another program at once: after its first "gone" it reads alive again.
  const real = process.kill;
  const looks = [];
  const signals = [];
  process.kill = (pid, sig) => {
    if (sig !== 0) { signals.push([pid, sig]); return true; }
    looks.push(pid);
    if (pid === NOT_THE_RUNNER && looks.filter((p) => p === NOT_THE_RUNNER).length === 1) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    return real.call(process, pid, 0);
  };
  try {
    await endProcesses([{ pid: NOT_THE_RUNNER, what: 'the check runner' }], { waitMs: 2000 });
    await assert.rejects(endProcesses([{ pid: process.pid, what: 'the stuck check' }], { waitMs: 300 }), /still running: the stuck check \(pid \d+\)/);
  } finally {
    process.kill = real;
  }
  assert.deepEqual(looks.filter((p) => p === NOT_THE_RUNNER), [NOT_THE_RUNNER], 'retired after one look');
  assert.deepEqual(signals, [], 'nothing stopped');
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

test('a run is settled only when nothing of it can still write: ended, never started, or its runner and check both gone', () => {
  const dir = tempRoot();
  const write = (rec) => fs.writeFileSync(path.join(dir, 'check.json'), JSON.stringify({ command: 'x', cwd: dir, limitMs: 1000, startedAt: new Date().toISOString(), runnerPid: null, beatAt: null, checkPid: null, endedAt: null, ...rec }));
  const boot = Date.now() - 60 * 60_000;
  assert.equal(checkSettled(path.join(dir, 'none')), true, 'no record: nothing ran there');
  write({ endedAt: new Date().toISOString() });
  assert.equal(checkSettled(dir, { bootAt: boot }), true);
  write({});
  assert.equal(checkSettled(dir, { bootAt: boot }), false, 'its runner may still start');
  assert.equal(checkSettled(dir, { bootAt: boot, now: Date.now() + LATE_MS + 1000 }), true, 'it never started');
  // Alive but silent long past its limit (a lost run by checkState): still able to write.
  write({ runnerPid: process.pid, beatAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(), startedAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString() });
  assert.equal(checkState(dir, { bootAt: boot - 4 * 60 * 60_000 }).state, 'lost');
  assert.equal(checkSettled(dir, { bootAt: boot - 4 * 60 * 60_000 }), false);
  // Its runner gone, but its check still alive: not settled either.
  const gone = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
  write({ runnerPid: gone, checkPid: process.pid });
  assert.equal(checkSettled(dir, { bootAt: boot }), false);
  write({ runnerPid: gone, checkPid: gone });
  assert.equal(checkSettled(dir, { bootAt: boot }), true);
  // Recorded before this machine started: whatever has its pid now is not that run.
  write({ runnerPid: process.pid, startedAt: new Date(boot - 1000).toISOString() });
  assert.equal(checkSettled(dir, { bootAt: boot }), true);
});

test('a record that can\'t be read reads as a lost run that is never settled, and nothing throws', () => {
  const dir = path.join(tempRoot(), 'check');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'check.json'), '{ not json');
  fs.writeFileSync(path.join(dir, 'check.log'), 'the end of its log\n');
  const r = checkState(dir);
  assert.deepEqual([r.state, r.log], ['lost', 'the end of its log']);
  assert.equal(checkSettled(dir), false, 'nothing proves its runner stopped');
  assert.equal(checkCommand(dir), null);
  assert.equal(stopCheck(dir), false);
  assert.equal(fs.existsSync(path.join(dir, STOP)), false);
});

test('a record that can\'t be read is settled only if it has not changed since before the machine started, however old it is', () => {
  const dir = path.join(tempRoot(), 'check');
  fs.mkdirSync(dir, { recursive: true });
  const record = path.join(dir, 'check.json');
  fs.writeFileSync(record, '{ not json');
  const now = Date.now();
  const old = new Date(now - 2 * 24 * 60 * 60_000);
  fs.utimesSync(record, old, old);
  // Two days old, on a machine up for three days: a hung runner's check may still be going.
  assert.equal(checkSettled(dir, { now, bootAt: now - 3 * 24 * 60 * 60_000 }), false);
  // The machine started a minute ago: nothing of that run can still be going.
  assert.equal(checkSettled(dir, { now, bootAt: now - 60_000 }), true);
});
