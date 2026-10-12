// A sprint ticket's full check: the repo's own command line (repoCheck), run by Podium in the ticket's copy
// before its PR opens. It runs in a detached process (run-check.js), as an agent step does, so the tick that starts it
// returns at once and the sprint is never locked while it runs; later ticks read its record (checkState).
// The command line is a repo setting (repoCheck), set by the person in Settings or by Claude through the sprint draft, and
// run by the shell as typed. It runs the repo's own scripts in the copy, which the sprint's writers may have edited, so it
// gets no more trust than the writers' work: it runs only in the ticket's copy, and its output never reaches the PR.
// The runner beats (beatAt in the record) while the check runs. Podium never kills a check, nor its runner, by any pid
// (after a shutdown, a long sleep, or a runner that died a moment ago, a recorded pid may belong to another
// program, and a fresh heartbeat does not prove the pid is still the runner). To stop one it writes a stop request
// (STOP) in the check's folder: the runner, which owns its check, looks for it every STOP_POLL_MS and on each beat, and
// stops its own check (its process group) and records it as timed out (stopped). A runner that is dead or not beating
// reads no request and nothing is killed: that check is lost and left alone.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { spawnDetachedNode, ownGroup, killGroup } from './launch.js';
import { isAlive } from './status.js';
import { readJson, writeJsonAtomic } from './fsutil.js';

const RUN_CHECK = fileURLToPath(new URL('./run-check.js', import.meta.url));
const RECORD = 'check.json';
const LOG = 'check.log';
// Podium's stop request: a file in the check's folder that only its own runner acts on.
export const STOP = 'stop.request';
// How often the runner looks for a stop request (it also looks on each beat).
export const STOP_POLL_MS = 2000;
// The end of the log a parked ticket shows and the writer's fix gets.
export const LOG_TAIL = 4000;
// A runner that has not written its pid this long after the check started never started.
export const LATE_MS = 60_000;
// The runner beats this often while its check runs. One silent for STALE_MS may be gone, hung, or only asleep with the
// machine: it is never stopped then, and counts as gone only once its check is also past its limit (checkState).
export const BEAT_MS = 15_000;
export const STALE_MS = 45_000;

const recordOf = (dir) => readJson(path.join(dir, RECORD), null);
const write = (dir, patch) => writeJsonAtomic(path.join(dir, RECORD), { ...recordOf(dir), ...patch });

// Only the end of the log is read: a check may print a great deal. Up to 4 bytes a character, so LOG_TAIL characters fit.
function logTail(dir) {
  let fd;
  try {
    fd = fs.openSync(path.join(dir, LOG), 'r');
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, LOG_TAIL * 4);
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, size - length);
    return buf.toString('utf8').trim().slice(-LOG_TAIL);
  } catch {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// When this machine last started. A pid recorded before then may belong to anything now. (With Windows Fast Startup a
// shutdown does not reset it: the heartbeat is what proves a runner is still the one Podium started.)
// Tests only: a fixed boot time (setBootTime), so a test can backdate a check on a machine that started minutes ago (a
// fresh CI runner) without it reading as "recorded before the machine started".
let bootOverride = null;
export function setBootTime(at = null) { bootOverride = at; }
export const bootTime = () => bootOverride ?? Date.now() - os.uptime() * 1000;

// The record first, then the detached runner, which adds its pid and heartbeat and, at the end, the result. beatMs is a
// test seam.
export function startCheck(dir, { command, cwd, limitMs, now = Date.now(), beatMs = BEAT_MS }) {
  fs.mkdirSync(dir, { recursive: true });
  writeJsonAtomic(path.join(dir, RECORD), { command, cwd, limitMs, beatMs, startedAt: new Date(now).toISOString(), runnerPid: null, beatAt: null, checkPid: null, exitCode: null, timedOut: false, endedAt: null });
  spawnDetachedNode(RUN_CHECK, [dir]);
}

// Run by run-check.js: the command through the shell, in the copy, its output to check.log, stopped (with everything it
// started) at its time limit or on a stop request. A beat that can't be written is skipped, so the time limit always
// holds. The result is written, or tried once more; if that fails too the log says so and it returns false, and Podium
// reads the check as lost. writeRecord and retryMs are test seams.
export async function runCheck(dir, { writeRecord = write, retryMs = 500 } = {}) {
  const rec = recordOf(dir);
  writeRecord(dir, { runnerPid: process.pid, beatAt: new Date().toISOString() });
  let askedToStop = () => {};
  const asked = () => { try { if (fs.existsSync(path.join(dir, STOP))) askedToStop(); } catch { /* looked again next time */ } };
  const beat = setInterval(() => {
    try { writeRecord(dir, { beatAt: new Date().toISOString() }); } catch { /* a missed beat: the next one may land */ }
    asked();
  }, rec.beatMs || BEAT_MS);
  const poll = setInterval(asked, STOP_POLL_MS);
  const logFile = path.join(dir, LOG);
  const out = fs.openSync(logFile, 'a');
  let timedOut = false;
  let stopped = false;
  let onTerm = null;
  const code = await new Promise((resolve) => {
    let child;
    try {
      child = spawn(rec.command, { cwd: rec.cwd, shell: true, stdio: ['ignore', out, out], windowsHide: true, ...ownGroup() });
    } catch (e) {
      fs.appendFileSync(logFile, `\n${e.message}\n`);
      resolve(-1);
      return;
    }
    // The check's pid is only informational: a failed write must not leave the check without its limit.
    try { writeRecord(dir, { checkPid: child.pid ?? null }); } catch { /* not needed */ }
    let killed = false;
    const stop = () => { if (killed) return; killed = true; timedOut = true; killGroup(child.pid); };
    const timer = setTimeout(stop, rec.limitMs);
    askedToStop = () => { stopped = true; stop(); };
    asked();
    onTerm = stop;
    process.on('SIGTERM', onTerm);
    child.on('error', (e) => { clearTimeout(timer); fs.appendFileSync(logFile, `\n${e.message}\n`); resolve(-1); });
    child.on('close', (c) => { clearTimeout(timer); resolve(c ?? -1); });
  });
  clearInterval(beat);
  clearInterval(poll);
  if (onTerm) process.off('SIGTERM', onTerm);
  fs.closeSync(out);
  const result = { exitCode: code, timedOut, stopped, endedAt: new Date().toISOString() };
  let failure = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt) await new Promise((r) => setTimeout(r, retryMs));
    try {
      writeRecord(dir, result);
      return true;
    } catch (e) {
      failure = e;
    }
  }
  try { fs.appendFileSync(logFile, `\nPodium couldn't record how the check ended (exit code ${code}): ${failure?.message ?? failure}\n`); } catch { /* nothing more to do */ }
  return false;
}

// Is the check's runner the live one Podium started: its pid recorded since the machine started, alive, and beating?
function runnerBeating(rec, now, bootAt) {
  if (!rec.runnerPid || !(Date.parse(rec.startedAt) >= bootAt)) return false;
  const beat = Date.parse(rec.beatAt ?? rec.startedAt);
  return now - beat <= STALE_MS && isAlive(rec.runnerPid);
}

// How the check stands, with the end of its log. Only reads: the pane and the tool ask too, without the sprint's lock.
// A runner still beating far past the limit reads as timed out and overdue, for the tick to stop.
export function checkState(dir, { now = Date.now(), bootAt = bootTime() } = {}) {
  const rec = dir ? recordOf(dir) : null;
  if (!rec) return { state: 'lost', log: '' };
  if (rec.endedAt) {
    if (rec.timedOut) return { state: 'timed-out', log: logTail(dir) };
    return rec.exitCode === 0 ? { state: 'passed', log: '' } : { state: 'failed', exitCode: rec.exitCode, log: logTail(dir) };
  }
  const started = Date.parse(rec.startedAt);
  const age = now - started;
  const overdue = age > rec.limitMs + LATE_MS;
  // A runner that has not written its pid yet gets LATE_MS to start. One that has is gone when it is dead (or was recorded
  // before the machine started); a stale heartbeat alone (the machine slept) is gone only once the check is also overdue.
  const gone = !rec.runnerPid ? age > LATE_MS
    : !(started >= bootAt) || !isAlive(rec.runnerPid) || (overdue && !runnerBeating(rec, now, bootAt));
  if (gone) {
    // Its result may have landed since the record was read.
    return recordOf(dir)?.endedAt ? checkState(dir, { now, bootAt }) : { state: 'lost', log: logTail(dir) };
  }
  if (overdue) return { state: 'timed-out', overdue: true, log: logTail(dir) };
  return { state: 'running' };
}

export const checkRunning = (dir) => Boolean(dir) && checkState(dir).state === 'running';

// Ask an overdue check's beating runner to stop it (see the header). Only the tick calls it, under the sprint lock;
// returns whether the request was written.
export function stopCheck(dir, { now = Date.now(), bootAt = bootTime() } = {}) {
  const rec = dir ? recordOf(dir) : null;
  if (!rec || rec.endedAt || !runnerBeating(rec, now, bootAt)) return false;
  try {
    fs.writeFileSync(path.join(dir, STOP), new Date(now).toISOString());
  } catch {
    return false;
  }
  return true;
}
