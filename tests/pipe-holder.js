#!/usr/bin/env node
// A command whose helper holds its output open: the helper shares this process's stdout and stderr, writes its pid to
// argv[2], and lives 20 seconds; this process sleeps too. Stands for what a refused tree stop leaves running.
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const helper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
fs.writeFileSync(process.argv[2], String(helper.pid));
setTimeout(() => {}, 20000);
