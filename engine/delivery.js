// Who delivers a finished job's message, and only once. The session that
// dispatched the job goes first; any session may after ORIGIN_GRACE_MS. A
// delivery.lock file (created exclusively) stops two sessions delivering at once;
// a lock older than LOCK_STALE_MS belonged to a session that died or reloaded.
import fs from 'node:fs';
import path from 'node:path';
import { findJobDir, readJob } from './store.js';
import { writeJsonAtomic } from './fsutil.js';
import { loadSprint, sprintFolderGone } from './sprint.js';
import { sprintNewsOf } from './pr.js';

const DELIVERABLE = new Set(['done', 'needs-review', 'failed', 'lost', 'in-review', 'merged', 'closed']);
export const ORIGIN_GRACE_MS = 120_000;
export const LOCK_STALE_MS = 60_000;
export const LOCK_FILE = 'delivery.lock';

function takeLock(file, session, now) {
  try {
    fs.writeFileSync(file, JSON.stringify({ session, at: now }), { flag: 'wx' });
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let held = null;
    try { held = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* unreadable: treat as stale */ }
    if (held && now - held.at < LOCK_STALE_MS) return false;
    fs.rmSync(file, { force: true });
    return takeLock(file, session, now);
  }
}

// The origin's grace counts from the event: a PR opened or merged on old work sets notifiedAt with delivered false,
// so another chat waits two minutes from then, not from when the work's step ended.
export function claimDelivery(root, id, session, { now = Date.now() } = {}) {
  const dir = findJobDir(root, id);
  const job = readJob(dir);
  if (job.delivered) return { claimed: false, reason: 'delivered' };
  if (!DELIVERABLE.has(job.status)) return { claimed: false, reason: 'not-finished' };
  const origin = job.origin?.session ?? null;
  const since = Date.parse(job.notifiedAt ?? job.endedAt ?? job.createdAt);
  // A sprint step's news is its sprint's chat's alone, however long it waits: the chat the sprint has now (Take them
  // here moves it), not the one the step started in.
  if (job.sprint) {
    // PR-end news goes through the sprint's messages (pr.js finishPr), never this channel.
    if (job.status === 'merged' || job.status === 'closed' || sprintNewsOf(job).length) return { claimed: false, reason: 'sprint-news' };
    const owner = sprintChat(root, job.sprint.id, origin);
    // A sprint that can't be read just now (busy, damaged) may have moved to another chat: nobody takes it until it reads.
    if (owner === UNKNOWN) return { claimed: false, reason: 'not-yours-yet' };
    if (owner && owner !== session) return { claimed: false, reason: 'not-yours-yet' };
  } else if (origin && origin !== session && now - since <= ORIGIN_GRACE_MS) return { claimed: false, reason: 'not-yours-yet' };
  return takeLock(path.join(dir, LOCK_FILE), session, now) ? { claimed: true } : { claimed: false, reason: 'claimed-elsewhere' };
}

// The chat a sprint's news goes to (null: any chat of its project). Only a sprint confirmed gone, its folder itself absent
// (sprintFolderGone), leaves the step's own origin to decide. One that can't be read just now answers UNKNOWN: it may
// have been taken into another chat ("Take them here"), so falling back to the step's origin could send its news to the
// chat it left.
const UNKNOWN = Symbol('unknown');
function sprintChat(root, id, fallback) {
  try {
    return loadSprint(root, id).session ?? null;
  } catch {
    return sprintFolderGone(root, id) ? fallback : UNKNOWN;
  }
}

// The lock's holder keeps it fresh while its submit waits behind a busy turn, so it never goes stale and passes to
// another chat meanwhile. Only the holder refreshes.
export function refreshDelivery(root, id, session, { now = Date.now() } = {}) {
  const file = path.join(findJobDir(root, id), LOCK_FILE);
  let held = null;
  try { held = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { refreshed: false }; }
  if (held?.session !== session) return { refreshed: false };
  // Atomic (temp file + rename), so a reader never sees a truncated lock and takes it for stale.
  writeJsonAtomic(file, { session, at: now });
  return { refreshed: true };
}

export function releaseDelivery(root, id) {
  const file = path.join(findJobDir(root, id), LOCK_FILE);
  const existed = fs.existsSync(file);
  fs.rmSync(file, { force: true });
  return { released: existed };
}
