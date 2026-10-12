import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestAdapter, testAdapter } from '../engine/adapters/admin.js';
import { fakeAdapter } from './helpers.js';

test('suggestAdapter returns an unverified draft for any command with --help', async () => {
  const { adapter, guessed, help } = await suggestAdapter(process.execPath);
  assert.equal(adapter.verified, false);
  assert.equal(adapter.promptVia, 'stdin');
  assert.ok(Array.isArray(guessed));
  assert.ok(help.length > 0);
});

test('suggestAdapter picks up exec, --model and --prompt-file', async () => {
  // helpArgs lets the test read the fake agent's help text: node <fake-agent.js> --help
  const { adapter, guessed } = await suggestAdapter(process.execPath, { helpArgs: [fakeAdapter().baseArgs[0], '--help'] });
  assert.deepEqual(adapter.baseArgs, ['exec']);
  assert.equal(adapter.promptVia, 'file');
  assert.equal(adapter.promptFileFlag, '--prompt-file');
  assert.equal(adapter.modelFlag, '--model');
  assert.deepEqual(guessed.sort(), ['baseArgs', 'modelFlag', 'promptVia']);
});

test('suggestAdapter reports a missing command', async () => {
  await assert.rejects(suggestAdapter('definitely-not-a-real-command-xyz'), (e) => e.code === 'not-installed');
});

test('testAdapter passes a working agent and fails a broken one', async () => {
  const good = await testAdapter(fakeAdapter('ok'));
  assert.equal(good.ok, true);
  assert.equal(good.exitCode, 0);
  const bad = await testAdapter(fakeAdapter('fail'));
  assert.equal(bad.ok, false);
  assert.equal(bad.exitCode, 3);
  const invalid = await testAdapter({ name: 'x' });
  assert.equal(invalid.ok, false);
  assert.ok(invalid.errors.length > 0);
});
