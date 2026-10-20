// Per-repo settings: commands agents may run, the full check, one commit per
// sprint PR, and the merge method, keyed by project like repoInstructions.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { loadSettings, setSetting, repoSettings, setRepoSettings, repoInput, checkCommands, checkProdPatterns } from '../engine/settings.js';
import { main } from '../engine/cli.js';
import { pickMethod } from '../engine/pr.js';
import { tempRoot } from './helpers.js';

test('per-repo settings start empty, with one commit per sprint PR and a 30-minute check', () => {
  const s = loadSettings(tempRoot());
  assert.deepEqual([s.repoCommands, s.repoCheck, s.repoSquash, s.repoMergeMethod, s.repoPlanDir, s.repoKeepPlan, s.checkMinutes], [{}, {}, {}, {}, {}, {}, 30]);
  assert.deepEqual(repoSettings(s, 's1atlas'), { commands: [], check: null, taskTest: null, squash: true, mergeMethod: null, prodPatterns: [], planDir: 'docs/plans', keepPlan: false, public: null, privateTerms: [] });
});

test('each repo reads only its own values', () => {
  const root = tempRoot();
  setSetting(root, 'repoCommands', { s1atlas: ['dotnet'] });
  setSetting(root, 'repoCheck', { s1atlas: 'dotnet build && dotnet test' });
  setSetting(root, 'repoSquash', { s1atlas: false });
  setSetting(root, 'repoMergeMethod', { s1atlas: 'squash' });
  const s = loadSettings(root);
  assert.deepEqual(repoSettings(s, 's1atlas'), { commands: ['dotnet'], check: 'dotnet build && dotnet test', taskTest: null, squash: false, mergeMethod: 'squash', prodPatterns: [], planDir: 'docs/plans', keepPlan: false, public: null, privateTerms: [] });
  assert.deepEqual(repoSettings(s, 'other'), { commands: [], check: null, taskTest: null, squash: true, mergeMethod: null, prodPatterns: [], planDir: 'docs/plans', keepPlan: false, public: null, privateTerms: [] });
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
  assert.deepEqual(repoSettings(loadSettings(root), 's1atlas'), { commands: ['dotnet'], check: 'dotnet test', taskTest: null, squash: true, mergeMethod: null, prodPatterns: [], planDir: 'docs/plans', keepPlan: false, public: null, privateTerms: [] });
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
  // Plans folder: only a valid folder, else the default.
  assert.equal(read({ repoPlanDir: { r: 'docs/custom/plans' } }).planDir, 'docs/custom/plans');
  assert.equal(read({ repoPlanDir: { r: 'docs/custom/plans/' } }).planDir, 'docs/custom/plans');
  assert.equal(read({ repoPlanDir: { r: '/docs/plans' } }).planDir, 'docs/plans');
  assert.equal(read({ repoPlanDir: { r: 'C:/docs/plans' } }).planDir, 'docs/plans');
  assert.equal(read({ repoPlanDir: { r: 'docs/../plans' } }).planDir, 'docs/plans');
  assert.equal(read({ repoPlanDir: { r: 'docs\\plans' } }).planDir, 'docs/plans');
  assert.equal(read({ repoPlanDir: { r: 'a'.repeat(201) } }).planDir, 'docs/plans');
  assert.equal(read({ repoPlanDir: { r: 42 } }).planDir, 'docs/plans');
  assert.equal(read({ repoPlanDir: { r: '' } }).planDir, 'docs/plans');
  assert.equal(read({ repoPlanDir: 'docs/plans' }).planDir, 'docs/plans');
  assert.equal(read({}).planDir, 'docs/plans');
});

test('the plans folder starts as docs/plans, and a saved one reads for its repo only', () => {
  const root = tempRoot();
  assert.equal(repoSettings(loadSettings(root), 's1atlas').planDir, 'docs/plans');
  setSetting(root, 'repoPlanDir', { s1atlas: 'docs/custom/plans' });
  const s = loadSettings(root);
  assert.equal(repoSettings(s, 's1atlas').planDir, 'docs/custom/plans');
  assert.equal(repoSettings(s, 'other').planDir, 'docs/plans');
});

test('a plans folder must be a relative folder: absolute paths, .., backslashes and long ones are refused', () => {
  const root = tempRoot();
  for (const bad of ['/docs/plans', '\\docs\\plans', 'C:/docs/plans', 'C:\\docs\\plans', 'docs\\plans', '..', 'docs/../plans', '../plans', 'a'.repeat(201)]) {
    assert.throws(() => setSetting(root, 'repoPlanDir', { s1atlas: bad }), (e) => e.code === 'bad-setting', bad);
    assert.throws(() => repoInput({ planDir: bad }), (e) => e.code === 'bad-setting', bad);
  }
  assert.throws(() => setSetting(root, 'repoPlanDir', { s1atlas: 42 }), (e) => e.code === 'bad-setting');
  assert.throws(() => setSetting(root, 'repoPlanDir', 'docs/plans'), (e) => e.code === 'bad-setting');
  for (const empty of ['', '   ']) {
    assert.throws(() => setSetting(root, 'repoPlanDir', { s1atlas: empty }), (e) => e.code === 'bad-setting', JSON.stringify(empty));
  }
  assert.deepEqual(repoInput({ planDir: '' }), { planDir: '' }, 'a draft may still propose an empty folder: it removes the repo\'s own');
  assert.deepEqual(loadSettings(root).repoPlanDir, {}, 'nothing was saved');
});

test('a plans folder is trimmed, without its trailing slash; a draft\'s empty one removes it', () => {
  const root = tempRoot();
  assert.equal(repoInput({ planDir: 'docs/custom/plans/' }).planDir, 'docs/custom/plans');
  assert.equal(repoInput({ planDir: '  docs/custom  ' }).planDir, 'docs/custom');
  assert.equal(repoInput({ planDir: 'a'.repeat(200) }).planDir.length, 200);
  assert.deepEqual(setRepoSettings(root, 's1atlas', { planDir: 'docs/custom/plans/' }), { planDir: 'docs/custom/plans' });
  assert.equal(repoSettings(loadSettings(root), 's1atlas').planDir, 'docs/custom/plans');
  setRepoSettings(root, 's1atlas', { planDir: '' });
  assert.equal(repoSettings(loadSettings(root), 's1atlas').planDir, 'docs/plans');
  assert.deepEqual(loadSettings(root).repoPlanDir, {}, 'an empty folder removes it');
  setRepoSettings(root, 's1atlas', { planDir: 'docs/x' });
  setRepoSettings(root, 's1atlas', { planDir: '   ' });
  assert.deepEqual(loadSettings(root).repoPlanDir, {}, 'a blank folder removes it too');
});

test('keeping plans in PRs is off by default, and a saved true reads for its repo only', () => {
  const root = tempRoot();
  assert.equal(repoSettings(loadSettings(root), 's1atlas').keepPlan, false);
  setSetting(root, 'repoKeepPlan', { s1atlas: true });
  const s = loadSettings(root);
  assert.equal(repoSettings(s, 's1atlas').keepPlan, true);
  assert.equal(repoSettings(s, 'other').keepPlan, false);
});

test('keeping plans in PRs takes only true or false when saved, and nothing is written otherwise', () => {
  const root = tempRoot();
  assert.throws(() => setSetting(root, 'repoKeepPlan', { s1atlas: 'yes' }), (e) => e.code === 'bad-setting');
  assert.throws(() => setSetting(root, 'repoKeepPlan', true), (e) => e.code === 'bad-setting');
  assert.deepEqual(loadSettings(root).repoKeepPlan, {}, 'nothing was saved');
});

test('a hand-edited keep-plan value other than true reads as off', () => {
  for (const saved of [1, 'true', 'yes', null, {}]) {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ repoKeepPlan: { s1atlas: saved } }));
    assert.equal(repoSettings(loadSettings(root), 's1atlas').keepPlan, false, JSON.stringify(saved));
  }
});

test('a draft\'s keep-plan choice saves true for its repo, and false removes it', () => {
  const root = tempRoot();
  assert.deepEqual(setRepoSettings(root, 's1atlas', { keepPlan: true }), { keepPlan: true });
  assert.deepEqual(loadSettings(root).repoKeepPlan, { s1atlas: true });
  assert.equal(repoSettings(loadSettings(root), 's1atlas').keepPlan, true);
  assert.deepEqual(setRepoSettings(root, 's1atlas', { keepPlan: false }), { keepPlan: false });
  assert.deepEqual(loadSettings(root).repoKeepPlan, {});
  assert.equal(repoSettings(loadSettings(root), 's1atlas').keepPlan, false);
  for (const bad of ['no', 1, 'true', []]) assert.throws(() => repoInput({ keepPlan: bad }), (e) => e.code === 'bad-setting', JSON.stringify(bad));
  assert.equal('keepPlan' in repoInput({}), false);
  assert.equal('keepPlan' in repoInput({ keepPlan: null }), false);
});

test('a hand-edited merge method falls back to the repo\'s default, then Podium\'s', () => {
  const job = (methods) => ({ project: 'r', pr: { methods } });
  const github = { viewerDefaultMergeMethod: 'REBASE', mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: true };
  const settings = (m) => ({ ...loadSettings(tempRoot()), repoMergeMethod: { r: m } });
  assert.equal(pickMethod(settings('SQUASH'), job(github)), 'squash');
  assert.equal(pickMethod(settings('fast-forward'), job(github)), 'rebase', 'the repo\'s default on GitHub');
  assert.equal(pickMethod(settings(['merge']), job(null)), 'merge', 'Podium\'s mergeMethod');
});

test('a plans folder is kept as git names it, and "." or one that leaves the repo is refused', async () => {
  const { checkPlanDir } = await import('../engine/settings.js');
  assert.equal(checkPlanDir('./docs/plans'), 'docs/plans');
  assert.equal(checkPlanDir('docs//plans/'), 'docs/plans');
  assert.equal(checkPlanDir('docs/./plans'), 'docs/plans');
  for (const bad of ['.', './', 'docs/../x', '../plans']) assert.throws(() => checkPlanDir(bad), (e) => e.code === 'bad-setting', bad);
});

test('a repo\'s production patterns are plain phrases, checked before they are saved; a hand edit\'s bad ones are left out', () => {
  const root = tempRoot();
  setSetting(root, 'repoProdPatterns', { p: ['deploy-prod', 'make release', '(a+)+$'] });
  assert.deepEqual(repoSettings(loadSettings(root), 'p').prodPatterns, ['deploy-prod', 'make release', '(a+)+$'], 'text, never a pattern to run');
  assert.deepEqual(repoSettings(loadSettings(root), 'other').prodPatterns, []);
  assert.throws(() => setSetting(root, 'repoProdPatterns', { p: 'deploy-prod' }), (e) => e.code === 'bad-setting' && /list of phrases/.test(e.message));
  assert.throws(() => setSetting(root, 'repoProdPatterns', { p: [''] }), { code: 'bad-setting' });
  assert.throws(() => setSetting(root, 'repoProdPatterns', { p: ['x'.repeat(201)] }), { code: 'bad-setting' });
  assert.throws(() => setSetting(root, 'repoProdPatterns', { p: Array(21).fill('x') }), { code: 'bad-setting' });
  assert.deepEqual(checkProdPatterns(['a', 'b']), ['a', 'b']);
  assert.deepEqual(repoSettings({ repoProdPatterns: { p: ['ok', 7, '', ' '] } }, 'p').prodPatterns, ['ok']);
});

test('a repo can be marked public or private, and unset means ask GitHub', () => {
  const root = tempRoot();
  assert.equal(repoSettings(loadSettings(root), 'p').public, null);
  setSetting(root, 'repoPublic', { p: true, q: false });
  assert.equal(repoSettings(loadSettings(root), 'p').public, true);
  assert.equal(repoSettings(loadSettings(root), 'q').public, false);
  assert.throws(() => setSetting(root, 'repoPublic', { p: 'yes' }), (e) => e.code === 'bad-setting' && /repoPublic/.test(e.message));
  // A hand edit that left something else reads as unset.
  assert.equal(repoSettings({ repoPublic: { p: 'yes' } }, 'p').public, null);
});

test('a repo\'s private terms are plain phrases', () => {
  const root = tempRoot();
  setSetting(root, 'repoPrivateTerms', { p: ['Nightjar', 'implementation notes', '(a+)+$'] });
  assert.deepEqual(repoSettings(loadSettings(root), 'p').privateTerms, ['Nightjar', 'implementation notes', '(a+)+$']);
  assert.throws(() => setSetting(root, 'repoPrivateTerms', { p: 'Nightjar' }), (e) => e.code === 'bad-setting' && /list of phrases/.test(e.message));
  assert.throws(() => setSetting(root, 'repoPrivateTerms', { p: [' '] }), { code: 'bad-setting' });
  assert.throws(() => setSetting(root, 'repoPrivateTerms', { p: ['x'.repeat(201)] }), { code: 'bad-setting' });
  assert.throws(() => setSetting(root, 'repoPrivateTerms', { p: Array(21).fill('x') }), { code: 'bad-setting' });
  assert.deepEqual(repoSettings({ repoPrivateTerms: { p: ['ok', 7, '', ' '] } }, 'p').privateTerms, ['ok']);
  assert.deepEqual(repoSettings({}, 'p').privateTerms, []);
});
