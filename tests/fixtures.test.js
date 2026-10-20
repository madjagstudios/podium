import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { tempRepo } from './helpers.js';

test('seed creation suppresses detached maintenance without changing fixture Git configuration', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'podium-seed-maintenance-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const trace = path.join(dir, 'git-trace.ndjson');
  const helper = new URL('./helpers.js', import.meta.url).href;
  const source = `import fs from 'node:fs'; import assert from 'node:assert/strict'; import {spawnSync} from 'node:child_process'; import {tempRepo} from ${JSON.stringify(helper)};
const repo = tempRepo(); const config = spawnSync('git', ['config','--local','--get','maintenance.auto'], {cwd:repo}); assert.equal(config.status, 1, 'the returned real repo keeps normal maintenance configuration'); fs.rmSync(repo,{recursive:true,force:true});`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', source], { env: { ...process.env, GIT_TRACE2_EVENT: trace }, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
  const rows = fs.readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse);
  const maintenance = rows.filter(row => row.event === 'child_start' && row.argv?.includes('maintenance'));
  assert.deepEqual(maintenance, [], 'seed commit must return with no detached writer that can race its physical copy');
});

test('a real copy failure captures both trees and preserves the original error', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'podium-copy-failure-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const helper = new URL('./helpers.js', import.meta.url).href;
  const source = `import fs from 'node:fs'; import assert from 'node:assert/strict'; import {tempRepo} from ${JSON.stringify(helper)};
const copy = fs.cpSync; let originalError, destination;
fs.cpSync = (src, dest, opts) => { destination = dest; fs.rmSync(dest, {recursive:true, force:true}); fs.writeFileSync(dest, 'destination obstruction'); try { return copy(src, dest, opts); } catch (error) { originalError = error; throw error; } };
try { tempRepo(); assert.fail('copy must fail'); } catch (error) { assert.equal(error, originalError); assert.equal(error.code, 'ERR_FS_CP_DIR_TO_NON_DIR'); } finally { fs.rmSync(destination, {force:true}); }
console.log('original copy failure preserved');`;
  // This isolated probe still captures stderr evidence, but never writes into real profile metrics.
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', source], { env: { ...process.env, PODIUM_TEST_PROFILE_DIR: '' }, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /original copy failure preserved/);
  const line = r.stderr.split(/\r?\n/).find(line => line.startsWith('PODIUM_FIXTURE_COPY_FAILURE '));
  assert.ok(line, 'both-tree evidence must be emitted before process exit cleanup');
  const evidence = JSON.parse(line.slice('PODIUM_FIXTURE_COPY_FAILURE '.length));
  assert.equal(evidence.error.code, 'ERR_FS_CP_DIR_TO_NON_DIR');
  assert.notEqual(evidence.source.root, evidence.destination.root);
  assert.equal(evidence.source.entries['.git/objects'].type, 'directory');
  assert.equal(evidence.source.entries['.git/config'].type, 'file');
  assert.equal(evidence.destination.entries['.'].type, 'file');
  if (process.env.PODIUM_TEST_PROFILE_DIR) {
    const file = path.join(process.env.PODIUM_TEST_PROFILE_DIR, `process-${r.pid}.ndjson`);
    const rows = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
    assert.deepEqual(rows.filter(row => row.kind === 'fixture.copy.failure' && row.destination?.root === evidence.destination.root), [], 'the deliberate probe is excluded even when a PID has been reused');
  }
});

test('repository fixtures isolate Git state, configuration, hooks and worktree edits', (t) => {
  const a = tempRepo(), b = tempRepo();
  let c;
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const original = git(b, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(a, 'README.md'), 'changed\n');
  git(a, 'config', 'user.name', 'Changed'); git(a, 'add', '-A'); git(a, 'commit', '-qm', 'change');
  fs.writeFileSync(path.join(a, '.git', 'hooks', 'pre-commit'), '# changed');
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'podium-fixture-copy-'));
  git(a, 'worktree', 'add', '--detach', copy);
  t.after(() => { git(a, 'worktree', 'remove', '--force', copy); for (const repo of [a, b, c].filter(Boolean)) fs.rmSync(repo, { recursive: true, force: true }); });
  c = tempRepo(); // A fresh copy after another returned fixture has mutated refs/index/config/hooks/worktrees.
  assert.equal(git(b, 'rev-parse', 'HEAD'), original);
  assert.equal(fs.readFileSync(path.join(b, 'README.md'), 'utf8').replace(/\r\n/g, '\n'), 'hello\n');
  assert.equal(git(b, 'config', 'user.name'), 'Test');
  assert.equal(git(b, 'status', '--porcelain'), '');
  assert.equal(fs.existsSync(path.join(b, '.git', 'hooks', 'pre-commit')), false);
  assert.equal(fs.existsSync(path.join(b, '.git', 'objects', 'info', 'alternates')), false);
  assert.equal(git(b, 'worktree', 'list', '--porcelain').split('worktree ').length - 1, 1);
  assert.equal(git(c, 'rev-parse', 'HEAD'), original);
  assert.equal(fs.readFileSync(path.join(c, 'README.md'), 'utf8').replace(/\r\n/g, '\n'), 'hello\n');
  assert.equal(git(c, 'config', 'user.name'), 'Test');
  assert.equal(git(c, 'status', '--porcelain'), '');
  assert.equal(fs.existsSync(path.join(c, '.git', 'hooks', 'pre-commit')), false);
  assert.equal(fs.existsSync(path.join(c, '.git', 'objects', 'info', 'alternates')), false);
  assert.equal(git(c, 'worktree', 'list', '--porcelain').split('worktree ').length - 1, 1);
  const blob = git(b, 'rev-parse', 'HEAD:README.md');
  for (const file of ['README.md', '.git/config', '.git/index', '.git/refs/heads/main', `.git/objects/${blob.slice(0, 2)}/${blob.slice(2)}`]) {
    const left = fs.statSync(path.join(b, file), { bigint: true }), fresh = fs.statSync(path.join(c, file), { bigint: true });
    assert.equal(left.nlink, 1n, file); assert.equal(fresh.nlink, 1n, file);
    if (left.ino !== 0n && fresh.ino !== 0n && left.dev === fresh.dev) assert.notEqual(left.ino, fresh.ino, file);
  }
  fs.writeFileSync(path.join(b, 'independent.txt'), 'new'); git(b, 'add', '-A'); git(b, 'commit', '-qm', 'independent');
  assert.notEqual(git(a, 'rev-parse', 'HEAD'), git(b, 'rev-parse', 'HEAD'));
  assert.equal(git(c, 'rev-parse', 'HEAD'), original, 'later commits in B cannot change the fresh C copy');
});
test('repeated committed repository fixtures avoid repeated initialization processes', (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'podium-fixture-profile-'));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  const preload = new URL('./profile-processes.js', import.meta.url).href;
  const helper = new URL('./helpers.js', import.meta.url).href;
  const source = `import {tempRepo} from ${JSON.stringify(helper)}; import fs from 'node:fs'; const repos = [tempRepo(),tempRepo(),tempRepo()]; for (const repo of repos) fs.rmSync(repo, {recursive:true,force:true});`;
  const r = spawnSync(process.execPath, ['--import', preload, '--input-type=module', '-e', source], { env: { ...process.env, PODIUM_TEST_PROFILE_DIR: profile }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const rows = fs.readdirSync(profile).flatMap((f) => fs.readFileSync(path.join(profile, f), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));
  assert.equal(rows.filter((r) => r.kind === 'process.git' && r.command === 'init').length, 1);
});
