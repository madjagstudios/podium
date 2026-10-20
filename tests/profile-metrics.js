import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const dir = process.env.PODIUM_TEST_PROFILE_DIR;
const rows = [];
let enabled = false;
export function profileWarning(error) {
  try { fs.writeSync(2, `Test profile could not be written (${error.code || 'unavailable'}).\n`); }
  catch { /* Optional diagnostics cannot change the process outcome. */ }
}
if (dir) {
  try { fs.mkdirSync(dir, { recursive: true }); enabled = true; }
  catch (error) { profileWarning(error); }
}
export const profileEnabled = enabled;
if (enabled) {
  // One write at normal exit avoids adding synchronous file I/O to every measured operation.
  process.once('exit', () => {
    try { if (rows.length) fs.appendFileSync(path.join(dir, `process-${process.pid}.ndjson`), rows.join('')); }
    catch (error) { profileWarning(error); }
  });
}
export function record(kind, ms, extra = {}) {
  if (enabled) {
    try { rows.push(JSON.stringify({ kind, ms, pid: process.pid, file: process.argv[1], ...extra }) + '\n'); }
    catch (error) { enabled = false; profileWarning(error); }
  }
}
export function measure(kind, fn) {
  if (!enabled) return fn();
  const start = performance.now();
  try { return fn(); } finally { record(kind, performance.now() - start); }
}
