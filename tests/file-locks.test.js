import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { diagnoseStashFailure, checkpointLockMessage } from '../engine/file-locks.js';
import { PodiumError } from '../engine/errors.js';
import { tempRoot } from './helpers.js';

const failure = (stderr, stdout = '') => new PodiumError('git-failed', 'git stash: Could not remove untracked files from working tree', { stderr, stdout });
const put = (copy, file) => { const at = path.join(copy, file); fs.mkdirSync(path.dirname(at), { recursive: true }); fs.writeFileSync(at, 'saved work'); return at; };

for (const [file, line] of [
  ['.review-tmp/VBCSCompiler/AnalyzerAssemblyLoader/x/Microsoft.Interop.ComInterfaceGenerator.dll', f => `warning: failed to remove ${f}: Invalid argument`],
  ['ordinary file.txt', f => `error: unable to unlink old '${f}': Permission denied`],
  ['雪 café.txt', f => `warning: failed to remove ${f}: Permission denied`],
  ['quoted café.txt', () => 'warning: failed to remove "quoted caf\\303\\251.txt": Invalid argument'],
  ...(process.platform === 'win32' ? [] : [['a: b:雪.txt', f => `error: unable to unlink '${f}': Permission denied`]]),
]) test(`diagnoses the full Git removal output: ${file}`, async () => {
  const copy = tempRoot(); put(copy, file);
  const d = await diagnoseStashFailure(copy, failure(`warning: another warning\n${line(file)}\nerror: Could not remove untracked files from working tree`));
  assert.deepEqual(d, { file, hint: file.includes('VBCSCompiler') ? 'dotnet' : null });
});

test('a removal failure on stdout is diagnosed too', async () => {
  const copy = tempRoot(); put(copy, 'held.txt');
  assert.deepEqual(
    await diagnoseStashFailure(copy, failure('', 'warning: failed to remove held.txt: Permission denied')),
    { file: 'held.txt', hint: null },
  );
});

test('first validated path wins; unrelated failures return null', async () => {
  const copy = tempRoot(); put(copy, 'one.txt'); put(copy, 'two.txt');
  const d = await diagnoseStashFailure(copy, failure('warning: failed to remove ../escape: Invalid argument\nwarning: failed to remove one.txt: Permission denied\nwarning: failed to remove two.txt: Permission denied'));
  assert.equal(d.file, 'one.txt');
  for (const text of ['fatal: Unable to create index.lock: File exists', 'error: index write failed: No space left on device', 'fatal: Invalid argument', 'error: unable to create file one.txt: Permission denied']) {
    assert.equal(await diagnoseStashFailure(copy, failure(text)), null);
  }
  assert.equal(await diagnoseStashFailure(copy, new Error('warning: failed to remove one.txt: Permission denied')), null);
});

test('literal single quotes in removal warnings are not mistaken for unlink delimiters', async () => {
  const copy = tempRoot();
  put(copy, 'held.txt');
  put(copy, "'held.txt'");
  const d = await diagnoseStashFailure(copy, failure("warning: failed to remove 'held.txt': Invalid argument"));
  assert.equal(d.file, "'held.txt'");
});

test('unsafe, missing, malformed and oversized paths are reported as unidentified', async () => {
  const copy = tempRoot(); const outside = tempRoot(); put(outside, 'secret.txt'); put(copy, 'safe.txt');
  fs.symlinkSync(outside, path.join(copy, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const file of ['../secret.txt', 'a/../safe.txt', path.join(outside, 'secret.txt'), 'escape/secret.txt', 'missing.txt', '"bad\\q.txt"', '"bad\\377.txt"', 'x'.repeat(3000)]) {
    assert.deepEqual(await diagnoseStashFailure(copy, failure(`warning: failed to remove ${file}: Invalid argument`)), { file: 'an unidentified file', hint: null });
  }
});

test('the stop message names the file and suggests the .NET remedy only for compiler paths', () => {
  const plain = checkpointLockMessage({ file: 'ordinary held.txt', hint: null });
  assert.match(plain, /ordinary held\.txt is still open in a program/);
  assert.match(plain, /Close the program holding the file, then Retry/);
  assert.match(plain, /The ticket's copy and any stash Git made have been kept/);
  assert.doesNotMatch(plain, /dotnet build-server shutdown/);
  const dotnet = checkpointLockMessage({ file: '.review-tmp/VBCSCompiler/x.dll', hint: 'dotnet' });
  assert.match(dotnet, /For a \.NET compiler server, run dotnet build-server shutdown in this ticket's copy, then Retry/);
});
