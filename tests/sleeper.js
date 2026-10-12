#!/usr/bin/env node
// A command whose helper outlives it: starts a child that sleeps, writes the child's pid to argv[2], then sleeps itself.
// Stands for git's transport or credential helper, or gh's git, in the network time-limit tests.
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true });
fs.writeFileSync(process.argv[2], String(child.pid));
setTimeout(() => {}, 60000);
