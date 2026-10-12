// Writer A in the race (tests/sprint-lock.test.js): it takes the sprint lock, loads the sprint,
// passes the ownership check in saveSprint, and is then suspended (its event loop blocked, so its lock's
// heartbeat stops too) until the parent creates the `resume` file. It reports how its save ended.
import fs from 'node:fs';

const [modUrl, root, id, timings, checked, resume] = process.argv.slice(2);
const { locked, loadSprint, saveSprint, setLockTimings, setCommitHook } = await import(modUrl);
setLockTimings(JSON.parse(timings));
setCommitHook(() => {
  fs.writeFileSync(checked, String(process.pid));
  const cell = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(resume)) Atomics.wait(cell, 0, 0, 20);
});
let result;
try {
  await locked(root, id, async (held) => {
    const s = loadSprint(root, id);
    s.by = 'A';
    saveSprint(root, s, held);
    result = 'saved';
  }, { waitMs: 5000 });
} catch (e) {
  result = e.code ?? e.message;
}
process.send({ result }, () => process.exit(0));
