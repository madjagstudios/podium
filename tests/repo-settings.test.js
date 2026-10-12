// Per-repo settings: commands agents may run, the full check, one commit per
// sprint PR, and the merge method, keyed by project like repoInstructions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { loadSettings, setSetting, repoSettings, setRepoSettings, repoInput, checkCommands } from '../engine/settings.js';
import { main } from '../engine/cli.js';
import { pickMethod } from '../engine/pr.js';
import { tempRoot } from './helpers.js';

test('per-repo settings start empty, with one commit per sprint PR and a 30-minute check', () => {
  const s = loadSettings(tempRoot());
  assert.deepEqual([s.repoCommands, s.repoCheck, s.repoSquash, s.repoMergeMethod, s.checkMinutes], [{}, {}, {}, {}, 30]);
  assert.deepEqual(repoSettings(s, 's1atlas'), { commands: [], check: null, squash: true, mergeMethod: null });
});

test('each repo reads only its own values', () => {
  const root = tempRoot();
  setSetting(root, 'repoCommands', { s1atlas: ['dotnet'] });
  setSetting(root, 'repoCheck', { s1atlas: 'dotnet build && dotnet test' });
  setSetting(root, 'repoSquash', { s1atlas: false });
  setSetting(root, 'repoMergeMethod', { s1atlas: 'squash' });
  const s = loadSettings(root);
  assert.deepEqual(repoSettings(s, 's1atlas'), { commands: ['dotnet'], check: 'dotnet build && dotnet test', squash: false, mergeMethod: 'squash' });
  assert.deepEqual(repoSettings(s, 'other'), { commands: [], check: null, squash: true, mergeMethod: null });
});

test('a command name with a space or a quote is refused when saved, and nothing is written', () => {
  const root = tempRoot();
  for (const bad of ['dot net', 'dotnet"', 'a&b', '']) {
    assert.throws(() => setSetting(root, 'repoCommands', { s1atlas: [bad] }), (e) => e.code === 'bad-setting', bad);
  }
  assert.throws(() => setSetting(root, 'repoCommands.s1atlas', ['ok', 'not ok']), (e) => e.code === 'bad-setting');
  assert.throws(() => setSetting(root, 'repoMergeMethod', { s1atlas: 'fast-forward' }), (e) => e.code === 'bad-setting');
  assert.throws(() => setSetting(root, 'repoSquash', { s1atlas: 'no' }), (e) => e.code === 'bad-setting');
  assert.throws(() => setSetting(root, 'checkMinutes', 0), (e) => e.code === 'bad-setting');
  assert.deepEqual(loadSettings(root).repoCommands, {}, 'nothing was saved');
});

test('a draft\'s commands and check save to its repo; an empty check removes it', () => {
  const root = tempRoot();
  assert.deepEqual(setRepoSettings(root, 's1atlas', { commands: ['dotnet', 'dotnet'], check: '  dotnet test  ' }), { commands: ['dotnet'], check: 'dotnet test' });
  assert.deepEqual(repoSettings(loadSettings(root), 's1atlas'), { commands: ['dotnet'], check: 'dotnet test', squash: true, mergeMethod: null });
  assert.deepEqual(setRepoSettings(root, 's1atlas', {}), {});
  setRepoSettings(root, 's1atlas', { check: '' });
  assert.equal(repoSettings(loadSettings(root), 's1atlas').check, null);
  assert.throws(() => repoInput({ commands: ['two words'] }), (e) => e.code === 'bad-setting');
});

test('the CLI refuses a bad command name with a plain message', async () => {
  const root = tempRoot();
  let out = '';
  const stdout = new Writable({ write(c, _e, cb) { out += c; cb(); } });
  const code = await main(['settings', 'set', '--key', 'repoCommands', '--value', JSON.stringify({ s1atlas: ['dot net'] })], { stdout, env: { ...process.env, PODIUM_DATA_DIR: root } });
  assert.equal(code, 1);
  assert.equal(JSON.parse(out).error.code, 'bad-setting');
  assert.match(JSON.parse(out).error.message, /is not a plain command name/);
});

test('a command name must start with a letter or digit', () => {
  for (const ok of ['dotnet', 'npm', 'a', '7z', 'node.exe', 'my_tool-2']) assert.deepEqual(checkCommands([ok]), [ok]);
  for (const bad of ['-rf', '..', '.hidden', '_x', 'a'.repeat(65), '']) {
    assert.throws(() => checkCommands([bad]), (e) => e.code === 'bad-setting', bad);
  }
});

test('checkMinutes must be a finite number above 0', () => {
  const root = tempRoot();
  for (const bad of ['5', true, Infinity, -Infinity, NaN, null, 0, -1, 1441, 40_000]) {
    assert.throws(() => setSetting(root, 'checkMinutes', bad), (e) => e.code === 'bad-setting', String(bad));
  }
  assert.equal(setSetting(root, 'checkMinutes', 1440).checkMinutes, 1440, 'a day at most');
  assert.equal(setSetting(root, 'checkMinutes', 45).checkMinutes, 45);
  assert.equal(setSetting(root, 'checkMinutes', 0.5).checkMinutes, 0.5);
});

test('a shell is never an allowed command, in any case, with or without .exe', () => {
  const root = tempRoot();
  for (const shell of ['bash', 'sh', 'zsh', 'fish', 'pwsh', 'powershell', 'cmd', 'BASH', 'PowerShell.exe', 'cmd.EXE', 'pwsh.exe']) {
    assert.throws(() => checkCommands([shell]), (e) => e.code === 'bad-setting' && /is a shell/.test(e.message), shell);
    assert.throws(() => setSetting(root, 'repoCommands', { s1atlas: ['dotnet', shell] }), (e) => e.code === 'bad-setting', shell);
  }
  for (const ok of ['dotnet', 'bash2', 'shx', 'cmdlet', 'npm']) assert.deepEqual(checkCommands([ok]), [ok]);
  assert.deepEqual(loadSettings(root).repoCommands, {}, 'nothing was saved');
});

test('hand-edited per-repo values read as what they can safely mean', () => {
  const read = (saved) => repoSettings({ ...loadSettings(tempRoot()), ...saved }, 'r');
  // Commands: not a list, or names that are not plain or are shells.
  assert.deepEqual(read({ repoCommands: { r: 'dotnet' } }).commands, []);
  assert.deepEqual(read({ repoCommands: { r: { dotnet: true } } }).commands, []);
  assert.deepEqual(read({ repoCommands: { r: ['dotnet', 'two words', 7, null, 'bash', 'PWSH.exe', 'npm', 'dotnet'] } }).commands, ['dotnet', 'npm']);
  assert.deepEqual(read({ repoCommands: 'dotnet' }).commands, []);
  // Merge method: any case of a known one, else none.
  assert.equal(read({ repoMergeMethod: { r: 'Squash' } }).mergeMethod, 'squash');
  assert.equal(read({ repoMergeMethod: { r: 'fast-forward' } }).mergeMethod, null);
  assert.equal(read({ repoMergeMethod: { r: 3 } }).mergeMethod, null);
  // Check: only a non-empty line.
  assert.equal(read({ repoCheck: { r: ['dotnet test'] } }).check, null);
  assert.equal(read({ repoCheck: { r: 42 } }).check, null);
  assert.equal(read({ repoCheck: { r: '   ' } }).check, null);
  assert.equal(read({ repoCheck: { r: ' dotnet test ' } }).check, 'dotnet test');
});

test('a hand-edited merge method falls back to the repo\'s default, then Podium\'s', () => {
  const job = (methods) => ({ project: 'r', pr: { methods } });
  const github = { viewerDefaultMergeMethod: 'REBASE', mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: true };
  const settings = (m) => ({ ...loadSettings(tempRoot()), repoMergeMethod: { r: m } });
  assert.equal(pickMethod(settings('SQUASH'), job(github)), 'squash');
  assert.equal(pickMethod(settings('fast-forward'), job(github)), 'rebase', 'the repo\'s default on GitHub');
  assert.equal(pickMethod(settings(['merge']), job(null)), 'merge', 'Podium\'s mergeMethod');
});
