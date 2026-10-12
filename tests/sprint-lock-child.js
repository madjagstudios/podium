// A process contending for a sprint's lock (tests/sprint-lock.test.js). On each { go, round } from its
// parent it waits until `go`, takes the lock, proves no one else is inside, adds one to the count, and
// answers with what happened.
import fs from 'node:fs';
import path from 'node:path';

const [modUrl, root, id, timings] = process.argv.slice(2);
const { locked, loadSprint, saveSprint, setLockTimings } = await import(modUrl);
// Optional JSON { staleMs, heartbeatMs }: short lock timings for a test, the same as its parent's.
if (timings) setLockTimings(JSON.parse(timings));
const inside = path.join(root, 'inside');

process.on('message', async ({ go, round, quit }) => {
  if (quit) process.exit(0);
  while (Date.now() < go) { /* start together, so both meet the stale lock at once */ }
  let entered = false;
  let twoHolders = false;
  let error = null;
  try {
    await locked(root, id, async (lock) => {
      try {
        fs.writeFileSync(inside, String(process.pid), { flag: 'wx' });
      } catch {
        twoHolders = true;
        return;
      }
      try {
        const s = loadSprint(root, id);
        s.count += 1;
        await new Promise((r) => setTimeout(r, 20));
        saveSprint(root, s, lock);
        entered = true;
      } finally {
        fs.rmSync(inside, { force: true });
      }
    }, { waitMs: 5000 });
  } catch (e) {
    error = e.code ?? e.message;
  }
  process.send({ round, entered, twoHolders, error });
});
process.send({ ready: true });
