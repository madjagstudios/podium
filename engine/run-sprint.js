// Entry point for the detached sprint runner.
import { sprintLoop } from './sprint-run.js';

const [root, id] = process.argv.slice(2);
sprintLoop(root, id).catch(() => { process.exitCode = 1; });
