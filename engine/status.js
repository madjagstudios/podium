import fs from 'node:fs';
import path from 'node:path';
import { readJob, updateJob, listJobDirs, findJobDir } from './store.js';
import { loadSettings } from './settings.js';
import { outcomePatch } from './outcome.js';
import { readOutput } from './retention.js';
import { PodiumError } from './errors.js';
import { LIVE_FILE } from './live.js';

const QUEUE_GRACE_MS = 60_000;

export function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

export function reconcile(root, dir, { now = Date.now(), settings = loadSettings(root) } = {}) {
  let job = readJob(dir);
  const runnerGone = job.status === 'running' && !isAlive(job.runnerPid);
  const neverStarted = job.status === 'queued' && now - Date.parse(job.createdAt) > QUEUE_GRACE_MS;
  if (runnerGone || neverStarted) {
    // Re-read: the runner may have written its final status between our read and the liveness check.
    const latest = readJob(dir);
    if (latest.status === job.status) {
      job = updateJob(root, dir, {
        status: 'lost',
        endedAt: new Date(now).toISOString(),
        error: 'The job stopped unexpectedly (its background process is gone).',
        ...(outcomePatch(latest, 'unknown', 'auto') ?? {}),
      }, 'lost');
    } else {
      job = latest;
    }
  }
  const isLong = job.status === 'running' && Boolean(job.startedAt) && now - Date.parse(job.startedAt) > settings.longJobMinutes * 60_000;
  return { ...job, isLong };
}

export function status(root, { project, ticket, id } = {}) {
  const settings = loadSettings(root);
  const dirs = id ? [findJobDir(root, id)] : listJobDirs(root, { project, ticket });
  return dirs.map((d) => {
    const job = reconcile(root, d, { settings });
    return job.status === 'queued' || job.status === 'running' ? { ...job, liveFile: path.join(d, LIVE_FILE) } : job;
  });
}

const LOG_TAIL = 20_000;

// The agent's activity log (its stderr): commands it ran and their output. Codex, for one,
// prints its work there and only its final reply on stdout.
function readLogTail(dir) {
  const file = path.join(dir, 'stderr.log');
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  return text.length > LOG_TAIL ? text.slice(-LOG_TAIL) : text;
}

export function result(root, id, { full = false } = {}) {
  const dir = findJobDir(root, id);
  const job = reconcile(root, dir);
  const summaryFile = path.join(dir, 'summary.md');
  return {
    job,
    summary: fs.existsSync(summaryFile) ? fs.readFileSync(summaryFile, 'utf8') : null,
    output: full ? readOutput(dir) : null,
    log: full ? readLogTail(dir) : null,
    hasDiff: fs.existsSync(path.join(dir, 'diff.patch')),
  };
}

export function saveSummary(root, id, text) {
  const clean = String(text ?? '').trim();
  if (!clean) throw new PodiumError('empty-summary', 'The summary is empty.');
  const dir = findJobDir(root, id);
  fs.writeFileSync(path.join(dir, 'summary.md'), `${clean}\n`);
  return updateJob(root, dir, {}, 'summary');
}
