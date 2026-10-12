// Entry point for the detached process that runs one sprint ticket's full check.
// A crash, or a result it couldn't write (runCheck returns false, and says so in check.log), leaves the record without a
// result: the next tick reads it as lost and parks the ticket. Either way it exits non-zero.
import { runCheck } from './check.js';

const [dir] = process.argv.slice(2);
runCheck(dir).then((ok) => { if (!ok) process.exitCode = 1; }, () => { process.exitCode = 1; });
