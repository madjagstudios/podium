// Entry point for the detached background process that runs one job.
import { runJob, recordCrash } from './runner.js';

const [root, dir] = process.argv.slice(2);
runJob(root, dir).catch((e) => {
  recordCrash(root, dir, e);
  process.exitCode = 1;
});
