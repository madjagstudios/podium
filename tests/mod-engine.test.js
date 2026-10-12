import test from 'node:test';
import assert from 'node:assert/strict';
import { engineArgv, callEngine } from '../mod/engine.js';

const ok = (stdout) => async () => ({ exitCode: 0, stdout, stderr: '' });

test('engineArgv runs the bundled CLI with node', () => {
  assert.deepEqual(engineArgv('C:\\p', ['status', '--here']), ['node', 'C:\\p/bin/podium.js', 'status', '--here']);
});

test('callEngine parses the last JSON line and passes stdin through', async () => {
  let seen;
  const run = async (argv, init) => { seen = { argv, init }; return { exitCode: 0, stdout: 'noise\n{"jobs":[]}\n', stderr: '' }; };
  assert.deepEqual(await callEngine(run, '/p', ['status'], { stdin: 'hi' }), { ok: true, value: { jobs: [] } });
  assert.equal(seen.init.stdin, 'hi');
  assert.equal(seen.init.timeoutMs, 120000);
});

test('callEngine reports engine errors, unreadable output and a missing node', async () => {
  const err = await callEngine(ok('{"error":{"code":"job-not-found","message":"No job."}}'), '/p', []);
  assert.deepEqual(err, { ok: false, error: { code: 'job-not-found', message: 'No job.' } });
  const garbage = await callEngine(async () => ({ exitCode: 1, stdout: 'oops', stderr: 'trace' }), '/p', []);
  assert.equal(garbage.error.code, 'engine-unreadable');
  assert.match(garbage.error.message, /exit 1/);
  const missing = await callEngine(async () => { throw new Error('spawn node ENOENT'); }, '/p', []);
  assert.equal(missing.error.code, 'node-missing');
  assert.match(missing.error.message, /Node\.js 22/);
});
