// The PR watcher: a detached process, like the job runner, that checks
// open PRs every minute and merges green ones that asked for it. It writes a
// heartbeat so the pane can restart it if it dies.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listJobDirs, readJob } from './store.js';
import { refreshPr, mergePr, mergeDecision, lockedThread } from './pr.js';
import { isAlive } from './status.js';
import { spawnDetachedNode } from './launch.js';
import { readJson, writeJsonAtomic } from './fsutil.js';
import { ensureSprints } from './sprint-run.js';

export const INTERVAL_MS = 60_000;
export const STALE_MS = 5 * 60_000;
const RUN = fileURLToPath(new URL('./run-pr-watch.js', import.meta.url));
export const beatFile = (root) => path.join(root, 'pr-watch.json');

export function openPrThreads(root) {
  return listJobDirs(root).map(readJob).filter((j) => j.status === 'in-review' && j.pr?.state === 'OPEN');
}

const watched = (root) => openPrThreads(root).filter((j) => j.pr.watching !== false);

// ensure: a PR that merged or closed in this pass asks for sprint runners: a sprint ticket may wait for
// it ("after"), and its runner had stopped while it waited. Tests pass their own.
export async function watchOnce(root, { env = process.env, now = Date.now(), ensure = ensureSprints } = {}) {
  const out = { checked: 0, merged: 0, stopped: 0 };
  let ended = false;
  for (const job of watched(root)) {
    if (now > Date.parse(job.pr.watchUntil)) {
      await lockedThread(root, job, (now) => ({ pr: { ...now.pr, watching: false } })).catch(() => {});
      out.stopped++;
      continue;
    }
    const fresh = await refreshPr(root, job.id, { env }).catch(() => null);
    if (!fresh) continue;
    out.checked++;
    if (['merged', 'closed'].includes(fresh.status)) ended = true;
    if (fresh.status === 'in-review' && fresh.pr.autoMerge && mergeDecision(fresh.pr)) {
      const merged = await mergePr(root, fresh.id, { env });
      if (merged.status === 'merged') {
        out.merged++;
        ended = true;
      }
    }
  }
  if (ended) {
    try { ensure(root); } catch { /* the pane's next check starts it */ }
  }
  return out;
}

export function ensureWatch(root, { now = Date.now() } = {}) {
  const beat = readJson(beatFile(root), null);
  if (beat && isAlive(beat.pid) && now - beat.at < STALE_MS) return { started: false };
  if (!watched(root).length) return { started: false };
  spawnDetachedNode(RUN, [root]);
  return { started: true };
}

export async function watchLoop(root) {
  for (;;) {
    writeJsonAtomic(beatFile(root), { pid: process.pid, at: Date.now() });
    await watchOnce(root).catch(() => {});
    if (!watched(root).length) break;
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
  fs.rmSync(beatFile(root), { force: true });
}
