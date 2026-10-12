import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PERMISSIONS, BUILTIN_ADAPTERS } from '../engine/adapters/builtin.js';
import { validateAdapter, loadAdapters, getAdapter, saveAdapter } from '../engine/adapters/registry.js';
import { buildInvocation, permissionText, unattendedWarning } from '../engine/adapters/build.js';
import { tempRoot, fakeAdapter } from './helpers.js';

test('every built-in adapter is valid and maps all permission levels', () => {
  for (const a of BUILTIN_ADAPTERS) assert.deepEqual(validateAdapter(a), [], a.name);
  assert.deepEqual(BUILTIN_ADAPTERS.map((a) => a.name).sort(), ['claude', 'codex', 'gemini', 'muse']);
  assert.deepEqual(PERMISSIONS, ['read-only', 'edit-worktree', 'own-config', 'full-access']);
});

test('validateAdapter explains what is wrong', () => {
  const errs = validateAdapter({ name: 'Bad Name', label: '', command: '', baseArgs: 'x', promptVia: 'arg', permissions: {} });
  assert.ok(errs.some((e) => e.includes('name')));
  assert.ok(errs.some((e) => e.includes('promptVia')));
  assert.ok(errs.some((e) => e.includes('permissions')));
  const unsafe = validateAdapter({ ...fakeAdapter(), baseArgs: ['a&b'] });
  assert.ok(unsafe.some((e) => e.includes('Refusing')));
});

test('user adapters override built-ins and invalid files are reported, not loaded', () => {
  const root = tempRoot();
  saveAdapter(root, { ...fakeAdapter(), name: 'codex', label: 'My Codex' });
  fs.writeFileSync(path.join(root, 'adapters', 'broken.json'), '{"name":"broken"}');
  const { adapters, errors } = loadAdapters(root);
  assert.equal(adapters.get('codex').label, 'My Codex');
  assert.equal(adapters.get('codex').source, 'user');
  assert.equal(adapters.get('muse').source, 'builtin');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].file, 'broken.json');
  assert.throws(() => getAdapter(root, 'nope'), (e) => e.code === 'unknown-agent');
  assert.throws(() => saveAdapter(root, { name: 'x' }), (e) => e.code === 'invalid-adapter');
});

test('buildInvocation maps permissions, model and prompt delivery', () => {
  const codex = BUILTIN_ADAPTERS.find((a) => a.name === 'codex');
  const inv = buildInvocation(codex, { permission: 'read-only', model: 'gpt-5', promptFile: '/p.md' });
  assert.deepEqual(inv, { command: 'codex', args: ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '-m', 'gpt-5', '-'], stdin: true });

  const muse = BUILTIN_ADAPTERS.find((a) => a.name === 'muse');
  const m = buildInvocation(muse, { permission: 'own-config', promptFile: '/tmp/p.md' });
  assert.equal(m.stdin, false);
  assert.deepEqual(m.args.slice(-2), ['--prompt-file', '/tmp/p.md']);

  assert.throws(() => buildInvocation(codex, { permission: 'god-mode', promptFile: '/p' }), (e) => e.code === 'bad-permission');
  assert.throws(() => buildInvocation({ ...codex, modelFlag: null }, { permission: 'own-config', model: 'x', promptFile: '/p' }), (e) => e.code === 'no-model-flag');
  assert.throws(() => buildInvocation(codex, { permission: 'own-config', model: 'a&b', promptFile: '/p' }), (e) => e.code === 'unsafe-arg');
});

test('permission text is plain English; unattended warnings come from the adapter', () => {
  const codex = BUILTIN_ADAPTERS.find((a) => a.name === 'codex');
  const muse = BUILTIN_ADAPTERS.find((a) => a.name === 'muse');
  assert.equal(permissionText(codex, 'read-only'), 'Codex will only read files');
  assert.equal(permissionText(codex, 'edit-worktree'), 'Codex can edit files in a separate copy of your repo');
  assert.equal(unattendedWarning(muse, 'own-config').code, 'unattended-direct-edit');
  assert.match(unattendedWarning(muse, 'own-config').message, /directly in this folder/);
  assert.equal(unattendedWarning(muse, 'read-only'), null);
});

const claude = BUILTIN_ADAPTERS.find((a) => a.name === 'claude');
const codex = BUILTIN_ADAPTERS.find((a) => a.name === 'codex');
const ID = '0f3c9d4e-1111-4222-8333-944455556666';

test('claude starts a named conversation and resumes it', () => {
  const start = buildInvocation(claude, { permission: 'edit-worktree', session: { mode: 'start', id: ID } });
  assert.deepEqual(start.args, ['-p', '--session-id', ID, '--permission-mode', 'acceptEdits']);
  const cont = buildInvocation(claude, { permission: 'edit-worktree', session: { mode: 'continue', id: ID } });
  assert.deepEqual(cont.args, ['-p', '--resume', ID, '--permission-mode', 'acceptEdits']);
});

test('codex resumes with its own command and config-style permissions', () => {
  const first = buildInvocation(codex, { permission: 'edit-worktree', session: { mode: 'start', id: ID } });
  assert.deepEqual(first.args, ['exec', '--skip-git-repo-check', '--sandbox', 'workspace-write', '-']);
  const cont = buildInvocation(codex, { permission: 'edit-worktree', model: 'gpt-6', session: { mode: 'continue', id: ID } });
  assert.deepEqual(cont.args, ['exec', 'resume', '--skip-git-repo-check', '-c', 'sandbox_mode=workspace-write', '-m', 'gpt-6', ID, '-']);
  assert.match('session id: ' + ID, new RegExp(codex.resume.capture));
});

test('an adapter without resume ignores the session', () => {
  const plain = { ...claude, resume: undefined };
  assert.deepEqual(buildInvocation(plain, { permission: 'read-only', session: { mode: 'continue', id: ID } }).args, ['-p', '--permission-mode', 'plan']);
});

test('Claude may run the repo\'s commands at edit-worktree only', () => {
  const claude = BUILTIN_ADAPTERS.find((a) => a.name === 'claude');
  const codex = BUILTIN_ADAPTERS.find((a) => a.name === 'codex');
  const ID = '123e4567-e89b-42d3-a456-426614174000';
  const edit = buildInvocation(claude, { permission: 'edit-worktree', allow: ['dotnet', 'npm'] });
  assert.deepEqual(edit.args, ['-p', '--permission-mode', 'acceptEdits', '--allowedTools', 'Bash(dotnet:*)', 'PowerShell(dotnet:*)', 'Bash(npm:*)', 'PowerShell(npm:*)']);
  const resumed = buildInvocation(claude, { permission: 'edit-worktree', allow: ['dotnet'], session: { mode: 'continue', id: ID } });
  assert.deepEqual(resumed.args, ['-p', '--resume', ID, '--permission-mode', 'acceptEdits', '--allowedTools', 'Bash(dotnet:*)', 'PowerShell(dotnet:*)']);
  assert.doesNotMatch(buildInvocation(claude, { permission: 'read-only', allow: ['dotnet'] }).args.join(' '), /allowedTools/);
  assert.doesNotMatch(buildInvocation(claude, { permission: 'full-access', allow: ['dotnet'] }).args.join(' '), /allowedTools/);
  assert.doesNotMatch(buildInvocation(codex, { permission: 'edit-worktree', allow: ['dotnet'] }).args.join(' '), /allowedTools|dotnet/);
  assert.deepEqual(buildInvocation(claude, { permission: 'edit-worktree' }).args, ['-p', '--permission-mode', 'acceptEdits']);
});

test('a stored command name that is not a plain word never reaches the arguments', () => {
  const claude = BUILTIN_ADAPTERS.find((a) => a.name === 'claude');
  const bad = ['-rf', '..', 'a b', 'x&y', 'dot"net', '', 42, null];
  assert.deepEqual(
    buildInvocation(claude, { permission: 'edit-worktree', allow: [...bad, 'dotnet'] }).args,
    ['-p', '--permission-mode', 'acceptEdits', '--allowedTools', 'Bash(dotnet:*)', 'PowerShell(dotnet:*)'],
  );
  assert.deepEqual(buildInvocation(claude, { permission: 'edit-worktree', allow: bad }).args, ['-p', '--permission-mode', 'acceptEdits']);
});

test('an adapter\'s allow rule is checked like its other arguments', () => {
  assert.ok(validateAdapter({ ...fakeAdapter(), allow: { flag: '--allow', rule: 'Run({cmd})&' } }).some((e) => e.includes('Refusing')));
  assert.ok(validateAdapter({ ...fakeAdapter(), allow: { flag: '--allow' } }).some((e) => e.includes('allow')));
  assert.deepEqual(validateAdapter({ ...fakeAdapter(), allow: { flag: '--allow', rule: 'Bash({cmd}:*)' } }), []);
  assert.deepEqual(validateAdapter({ ...fakeAdapter(), allow: { flag: '--allow', rules: ['Bash({cmd}:*)', 'PowerShell({cmd}:*)'] } }), []);
  assert.ok(validateAdapter({ ...fakeAdapter(), allow: { flag: '--allow', rules: [] } }).some((e) => e.includes('allow')));
  assert.ok(validateAdapter({ ...fakeAdapter(), allow: { flag: '--allow', rules: ['Bash({cmd}:*)', 'PowerShell'] } }).some((e) => e.includes('allow')));
  assert.ok(validateAdapter({ ...fakeAdapter(), allow: { flag: '--allow', rules: ['Bash({cmd}:*)', 'Run({cmd})&'] } }).some((e) => e.includes('Refusing')));
});

test('a stored command list that is not a list is ignored, and a single-rule adapter still works', () => {
  const claude = BUILTIN_ADAPTERS.find((a) => a.name === 'claude');
  for (const bad of ['dotnet', { 0: 'dotnet' }, null, 7]) {
    assert.deepEqual(buildInvocation(claude, { permission: 'edit-worktree', allow: bad }).args, ['-p', '--permission-mode', 'acceptEdits']);
  }
  const single = { ...fakeAdapter(), allow: { flag: '--allow', rule: 'Bash({cmd}:*)' } };
  assert.deepEqual(buildInvocation(single, { permission: 'edit-worktree', allow: ['npm'] }).args.slice(-2), ['--allow', 'Bash(npm:*)']);
});
