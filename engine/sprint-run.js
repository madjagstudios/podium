// The sprint runner: a detached process per sprint, like the job runner, that
// ticks the sprint every few seconds until nothing is left for it. Its heartbeat lets
// the pane (through `podium sprint ensure`) start a new one if it dies.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSprints, loadSprint, tick, wantsRunner } from './sprint.js';
import { isAlive } from './status.js';
import { spawnDetachedNode } from './launch.js';
import { readJson, writeJsonAtomic } from './fsutil.js';

export const TICK_MS = 5000;
export const STALE_MS = 5 * 60_000;
const RUN = fileURLToPath(new URL('./run-sprint.js', import.meta.url));
export const beatOf = (root, id) => path.join(root, 'sprints', id, 'runner.json');

export function ensureSprints(root, { now = Date.now(), spawn = spawnDetachedNode } = {}) {
  const started = [];
  for (const s of listSprints(root)) {
    if (!wantsRunner(root, s)) continue;
    const beat = readJson(beatOf(root, s.id), null);
    if (beat && isAlive(beat.pid) && now - beat.at < STALE_MS) continue;
    spawn(RUN, [root, s.id]);
    started.push(s.id);
  }
  return { started };
}

// tickFn and released are for tests (released runs right after the heartbeat is cleared). A whole tick that throws (a
// busy lock, a full disk) is recorded in runner.json as lastError and the loop carries on; the record stays after the
// loop ends.
export async function sprintLoop(root, id, { env = process.env, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), tickFn = tick, released = async () => {} } = {}) {
  let trace = null;
  for (;;) {
    for (;;) {
      writeJsonAtomic(beatOf(root, id), { pid: process.pid, at: Date.now(), ...trace });
      try {
        await tickFn(root, id, { env, watch: true });
      } catch (e) {
        trace = { lastError: String(e?.message ?? e), errorAt: new Date().toISOString() };
        writeJsonAtomic(beatOf(root, id), { pid: process.pid, at: Date.now(), ...trace });
      }
      // A state that cannot be read just now (sprint-busy) is not a reason to stop: try again next tick.
      let wanted = true;
      try { wanted = wantsRunner(root, loadSprint(root, id)); } catch (e) { if (e?.code !== 'sprint-busy') throw e; }
      if (!wanted) break;
      await sleep(TICK_MS);
    }
    // No pid once ended, so ensureSprints starts a new runner whenever one is needed.
    if (trace) writeJsonAtomic(beatOf(root, id), { pid: null, at: Date.now(), endedAt: new Date().toISOString(), ...trace });
    else fs.rmSync(beatOf(root, id), { force: true });
    await released();
    // A wake-up (ensureSprints after a merge or a retry) that read the heartbeat before it was cleared started no
    // runner. So look once more: work wanted again, and no other live runner, means this one carries on. (One that
    // asked after the heartbeat went started its own; two runners at once only take turns at the sprint's lock.)
    let again = false;
    try { again = wantsRunner(root, loadSprint(root, id)); } catch { /* unreadable now: the next ensure decides */ }
    if (!again) return;
    const beat = readJson(beatOf(root, id), null);
    if (beat?.pid && beat.pid !== process.pid && isAlive(beat.pid)) return;
  }
}
