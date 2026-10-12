// Entry point for the detached PR watcher.
import { watchLoop } from './pr-watch.js';

watchLoop(process.argv[2]).catch(() => { process.exitCode = 1; });
