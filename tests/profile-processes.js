// Optional measurements; record durations without changing subprocess behavior.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { record, profileEnabled } from './profile-metrics.js';

if (profileEnabled) {
  const start = performance.now();
  if (!process.execArgv.includes('--test')) process.prependOnceListener('exit', () => record('file.wall', performance.now() - start));
  const isGit = (file) => path.basename(String(file)).replace(/\.exe$/i, '').toLowerCase() === 'git';
  function observe(api, file, args, start, child) {
    const extra = { api, command: isGit(file) && Array.isArray(args[0]) ? args[0][0] : undefined };
    const launchMs = performance.now() - start;
    record('process.launch', launchMs, extra);
    if (isGit(file)) record('process.git.async.launch', launchMs, extra);
    child.once('close', () => {
      const ms = performance.now() - start;
      record('process.lifetime', ms, extra);
      if (isGit(file)) record('process.git.async.lifetime', ms, extra);
    });
    return child;
  }
  // assert.ok derives its message from the caller's source expression; leave it native.
  for (const name of ['equal', 'notEqual', 'deepEqual', 'notDeepEqual', 'deepStrictEqual', 'notDeepStrictEqual', 'strictEqual', 'notStrictEqual', 'throws', 'doesNotThrow', 'match', 'doesNotMatch', 'ifError', 'fail', 'rejects', 'doesNotReject']) {
    const original = assert[name];
    assert[name] = function (...args) {
      const start = performance.now();
      let result;
      try { result = original.apply(this, args); }
      catch (error) { record('assertion', performance.now() - start); throw error; }
      if (result?.then) {
        // Return the measured rejection too: an unawaited failed assertion must still fail.
        return result.then((value) => { record('assertion', performance.now() - start); return value; }, (error) => { record('assertion', performance.now() - start); throw error; });
      } else record('assertion', performance.now() - start);
      return result;
    };
  }
  for (const name of ['execFileSync', 'spawnSync']) {
    const original = childProcess[name];
    childProcess[name] = function (file, ...args) {
      const start = performance.now();
      try { return original.call(this, file, ...args); }
      finally { record(isGit(file) ? 'process.git' : 'process.sync', performance.now() - start, { api: name, command: Array.isArray(args[0]) ? args[0][0] : undefined }); }
    };
  }
  const original = childProcess.spawn;
  childProcess.spawn = function (file, ...args) {
    const start = performance.now();
    const child = original.call(this, file, ...args);
    return observe('spawn', file, args, start, child);
  };
  const execFile = childProcess.execFile;
  childProcess.execFile = function (file, ...args) {
    const start = performance.now();
    const child = execFile.call(this, file, ...args);
    return observe('execFile', file, args, start, child);
  };
  // Node's custom Promise carries both output streams and the child handle.
  childProcess.execFile[promisify.custom] = function (...args) {
    const start = performance.now();
    const result = execFile[promisify.custom].apply(this, args);
    // Observe the native child, leaving the original Promise's handling unchanged.
    observe('execFile', args[0], args.slice(1), start, result.child);
    return result;
  };
  const fork = childProcess.fork;
  childProcess.fork = function (file, ...args) {
    const start = performance.now();
    return observe('fork', file, args, start, fork.call(this, file, ...args));
  };
  syncBuiltinESMExports();
}
