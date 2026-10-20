#!/usr/bin/env node
// A check that never ends on its own, for the time-limit and stop tests (stuckCheck in helpers.js). It writes its pid
// into the folder it is given (pid-<pid>) and runs until the test removes that folder's `life` file, or for five minutes
// at most: a stop that failed must never leave it running for good.
import fs from 'node:fs';
import path from 'node:path';

const [dir] = process.argv.slice(2);
const life = path.join(dir, 'life');
const LONGEST_MS = 5 * 60_000;
const started = Date.now();
const over = () => !fs.existsSync(life) || Date.now() - started > LONGEST_MS;
if (over()) process.exit(0);
fs.writeFileSync(path.join(dir, `pid-${process.pid}`), String(process.pid));
setInterval(() => { if (over()) process.exit(0); }, 250);
