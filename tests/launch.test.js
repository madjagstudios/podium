import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { assertArg, commandLine, resolveCommand, runCaptured, spawnDetachedNode, killTree, killGroup, safeArgText } from '../engine/launch.js';
import { fileURLToPath } from 'node:url';
import { FAKE_AGENT, tempRoot, waitFor } from './helpers.js';

test('assertArg rejects shell metacharacters and empty strings', () => {
  for (const bad of ['a"b', '100%', 'x!y', 'a^b', 'a&b', 'a|b', 'a<b', 'a>b', 'a\nb', '']) {
    assert.throws(() => assertArg(bad), (e) => e.code === 'unsafe-arg', bad);
  }
  assert.equal(assertArg('C:\\Program Files\\nodejs\\node.exe'), 'C:\\Program Files\\nodejs\\node.exe');
  assert.equal(assertArg('--sandbox=read-only'), '--sandbox=read-only');
});

test('commandLine quotes every part on Windows and passes through elsewhere', () => {
  const win = commandLine('codex', ['exec', '-m', 'o3'], 'win32', { PATH: '' });
  assert.deepEqual(win.argv.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(win.argv[3], '""codex" "exec" "-m" "o3""');
  assert.equal(win.verbatim, true);
  const nix = commandLine('codex', ['exec'], 'linux');
  assert.deepEqual(nix, { file: 'codex', argv: ['exec'], verbatim: false });
});

test('resolveCommand finds Windows shims on PATH by PATHEXT', () => {
  const dir = tempRoot();
  fs.writeFileSync(path.join(dir, 'tool.cmd'), '@echo off\r\n');
  const env = { PATH: `${tempRoot()}${path.delimiter}${dir}`, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
  assert.equal(resolveCommand('tool', 'win32', env), path.join(dir, 'tool.cmd'));
  assert.equal(resolveCommand('missing-tool', 'win32', env), 'missing-tool');
  assert.equal(resolveCommand('C:\\x\\tool.cmd', 'win32', env), 'C:\\x\\tool.cmd');
  assert.equal(resolveCommand('tool', 'linux', env), 'tool');
  assert.equal(commandLine('tool', ['-v'], 'win32', env).argv[3], `""${path.join(dir, 'tool.cmd')}" "-v""`);
});

// Shims like muse.cmd find their own files through %~dp0, which cmd.exe gets wrong
// when the shim is started by a quoted bare name. Launching by full path fixes it.
test('a .cmd shim launched by bare name can find files beside it', { skip: process.platform !== 'win32' }, async () => {
  const dir = tempRoot();
  fs.writeFileSync(path.join(dir, 'shimtest.cmd'), '@echo off\r\ntype "%~dp0payload.txt"\r\n');
  fs.writeFileSync(path.join(dir, 'payload.txt'), 'hello-shim');
  const r = await runCaptured('shimtest', [], { cwd: tempRoot(), env: { PATH: `${dir}${path.delimiter}${process.env.PATH}` } });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /hello-shim/);
});

test('runCaptured runs a command with stdin and captures output', async () => {
  const r = await runCaptured(process.execPath, [FAKE_AGENT, '--mode', 'ok', '--ro'], { input: 'do it' });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /PROMPT: do it/);
  assert.match(r.stdout, /ARGS: --ro/);
});

test('runCaptured reports failure codes and missing commands without throwing', async () => {
  const fail = await runCaptured(process.execPath, [FAKE_AGENT, '--mode', 'fail'], { input: '' });
  assert.equal(fail.code, 3);
  assert.match(fail.stderr, /boom/);
  const missing = await runCaptured('definitely-not-a-real-command-xyz', ['--version']);
  assert.notEqual(missing.code, 0);
});

test('runCaptured times out and kills the child', async () => {
  const r = await runCaptured(process.execPath, [FAKE_AGENT, '--mode', 'slow'], { input: '', timeoutMs: 500 });
  assert.equal(r.timedOut, true);
});

test('spawnDetachedNode returns a live pid and killTree stops it', async () => {
  const pid = spawnDetachedNode(FAKE_AGENT, ['--mode', 'slow', '--prompt-file', FAKE_AGENT]);
  assert.ok(pid > 0);
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  assert.equal(alive(), true);
  killTree(pid);
  await waitFor(() => !alive(), { timeoutMs: 10_000 });
});

// A timed-out command's helpers kept running on macOS and Linux (the group kill found no group). The command leads
// its own group there and the group is killed outright; Windows stops the tree with taskkill /T.
test('killGroup kills the whole process group on macOS and Linux, and falls back to the process', () => {
  const calls = [];
  killGroup(123, { platform: 'linux', kill: (pid, sig) => calls.push([pid, sig]) });
  assert.deepEqual(calls, [[-123, 'SIGKILL']]);
  calls.length = 0;
  killGroup(123, { platform: 'darwin', kill: (pid, sig) => { calls.push([pid, sig]); if (pid < 0) throw new Error('ESRCH'); } });
  assert.deepEqual(calls, [[-123, 'SIGKILL'], [123, 'SIGKILL']]);
});

test('runCaptured past its time limit stops the helpers the command started too', async () => {
  const pidFile = path.join(tempRoot(), 'pid');
  const r = await runCaptured(process.execPath, [fileURLToPath(new URL('./sleeper.js', import.meta.url)), pidFile], { input: '', timeoutMs: 1500 });
  assert.equal(r.timedOut, true);
  const pid = Number(await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim(), { timeoutMs: 5000 }));
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    await waitFor(() => !alive(), { timeoutMs: 10_000 });
  } finally {
    try { process.kill(pid); } catch { /* gone */ }
  }
});

test('safeArgText keeps a title\'s words and passes assertArg', () => {
  const text = safeArgText('A-1: says "hi" & 100%');
  assert.equal(text, "A-1: says 'hi' 100");
  assert.doesNotThrow(() => assertArg(text));
  assert.equal(safeArgText('A-2: one\r\ntwo <three>'), 'A-2: one two three');
  assert.equal(safeArgText('&&'), '-');
});
