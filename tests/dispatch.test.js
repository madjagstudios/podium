import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { saveAdapter } from '../engine/adapters/registry.js';
import { detectAgent, listAgents } from '../engine/discover.js';
import { preflight, dispatch } from '../engine/dispatch.js';
import { setSetting } from '../engine/settings.js';
import { readJob } from '../engine/store.js';
import { tempRoot, tempRepo, fakeAdapter, waitFor } from './helpers.js';

test('detectAgent finds installed agents and reports missing ones', async () => {
  const found = await detectAgent(fakeAdapter());
  assert.equal(found.installed, true);
  assert.match(found.version, /fake-agent 1\.2\.3/);
  const missing = await detectAgent({ ...fakeAdapter(), command: 'definitely-not-a-real-command-xyz', versionArgs: ['--version'] });
  assert.equal(missing.installed, false);
});

test('listAgents includes built-ins and user adapters with settings', async () => {
  const root = tempRoot();
  saveAdapter(root, fakeAdapter());
  setSetting(root, 'disabledAgents', ['gemini']);
  setSetting(root, 'defaultPermission.fake', 'read-only');
  const { agents } = await listAgents(root);
  const fake = agents.find((a) => a.name === 'fake');
  assert.equal(fake.installed, true);
  assert.equal(fake.source, 'user');
  assert.equal(fake.defaultPermission, 'read-only');
  assert.equal(agents.find((a) => a.name === 'gemini').enabled, false);
});

test('preflight explains problems in plain English', async () => {
  const root = tempRoot();
  saveAdapter(root, fakeAdapter());
  saveAdapter(root, { ...fakeAdapter(), name: 'ghost', label: 'Ghost', command: 'definitely-not-a-real-command-xyz', versionArgs: ['--version'] });
  const ok = await preflight(root, { agent: 'fake', permission: 'read-only', cwd: tempRoot() });
  assert.equal(ok.ok, true);
  assert.equal(ok.permissionText, 'Fake will only read files');

  const unknown = await preflight(root, { agent: 'nobody', cwd: tempRoot() });
  assert.equal(unknown.problems[0].code, 'unknown-agent');

  const ghost = await preflight(root, { agent: 'ghost', cwd: tempRoot() });
  assert.equal(ghost.problems[0].code, 'not-installed');

  const noRepo = await preflight(root, { agent: 'fake', permission: 'edit-worktree', cwd: tempRoot() });
  assert.ok(noRepo.problems.some((p) => p.code === 'not-a-git-repo'));

  const full = await preflight(root, { agent: 'fake', permission: 'full-access', cwd: tempRoot() });
  assert.ok(full.warnings.some((w) => w.code === 'full-access'));

  setSetting(root, 'defaultPermission.fake', 'read-only');
  assert.equal((await preflight(root, { agent: 'fake', cwd: tempRoot() })).permission, 'read-only');
});

test('dispatch runs a job in the background to completion', async () => {
  const root = tempRoot();
  saveAdapter(root, fakeAdapter('summary'));
  const cwd = tempRepo();
  const res = await dispatch(root, { agent: 'fake', permission: 'read-only', ticket: 'abc-9', cwd, prompt: 'Summarise' });
  assert.equal(res.job.status, 'queued');
  assert.equal(res.job.ticket, 'ABC-9');
  assert.equal(res.permissionText, 'Fake will only read files');
  const done = await waitFor(() => { const j = readJob(res.dir); return j.status === 'done' && j; });
  assert.notEqual(done.runnerPid, process.pid);
  assert.ok(fs.existsSync(path.join(res.dir, 'summary.md')));
});

test('dispatch warns when the task is only a ticket key or link, and starts the job anyway', async () => {
  const root = tempRoot();
  saveAdapter(root, fakeAdapter('summary'));
  const cwd = tempRepo();
  const warning = { code: 'ticket-pointer-only', message: "The task is only a ticket key or link. Most agents can't open a tracker, so paste the ticket's text into the task." };
  for (const [prompt, warns] of [['XYZ-60', true], ['https://example.atlassian.net/browse/XYZ-60', true], ['Fix the login form: XYZ-60 says a wrong password must say so.', false]]) {
    const res = await dispatch(root, { agent: 'fake', permission: 'read-only', cwd, prompt });
    assert.equal(res.job.status, 'queued', prompt);
    assert.equal(fs.readFileSync(path.join(res.dir, 'prompt.md'), 'utf8'), prompt, 'the job was created with that task');
    const found = res.warnings.filter((w) => w.code === 'ticket-pointer-only');
    assert.deepEqual(found, warns ? [warning] : [], prompt);
    await waitFor(() => readJob(res.dir).status === 'done');
  }
});

test('dispatch of an edit job creates a worktree and waits for review', async () => {
  const root = tempRoot();
  saveAdapter(root, fakeAdapter('edit'));
  const repo = tempRepo();
  const res = await dispatch(root, { agent: 'fake', permission: 'edit-worktree', cwd: repo, prompt: 'Edit' });
  assert.ok(res.job.worktree.startsWith(path.join(root, 'worktrees')));
  assert.equal(res.job.branch, `podium/${res.job.id}`);
  const job = await waitFor(() => { const j = readJob(res.dir); return j.status === 'needs-review' && j; });
  assert.equal(job.hasChanges, true);
  assert.equal(fs.existsSync(path.join(repo, 'fake-edit.txt')), false);
});

test('dispatch puts an edit job copy in the chosen copies folder', async () => {
  const root = tempRoot();
  const copies = tempRoot();
  saveAdapter(root, fakeAdapter('edit'));
  setSetting(root, 'worktreeRoot', copies);
  const repo = tempRepo();
  const res = await dispatch(root, { agent: 'fake', permission: 'edit-worktree', cwd: repo, prompt: 'Edit' });
  const got = fs.realpathSync.native(res.job.worktree);
  const want = fs.realpathSync.native(copies);
  assert.ok(got.startsWith(want + path.sep), `${got} is under ${want}`);
  assert.equal(fs.existsSync(res.job.worktree), true);
  const job = await waitFor(() => { const j = readJob(res.dir); return j.status === 'needs-review' && j; });
  assert.equal(job.hasChanges, true);
});

test('dispatch refuses empty prompts and failed preflight', async () => {
  const root = tempRoot();
  await assert.rejects(dispatch(root, { agent: 'codex', cwd: tempRoot(), prompt: '  ' }), (e) => e.code === 'empty-prompt');
  await assert.rejects(dispatch(root, { agent: 'nobody', cwd: tempRoot(), prompt: 'x' }), (e) => e.code === 'preflight-failed' && e.details.problems[0].code === 'unknown-agent');
});

test('with no permission given, jobs default to a separate copy; outside a repo they fall back to read only', async () => {
  const root = tempRoot();
  saveAdapter(root, fakeAdapter());
  const inRepo = await preflight(root, { agent: 'fake', cwd: tempRepo() });
  assert.equal(inRepo.ok, true);
  assert.equal(inRepo.permission, 'edit-worktree');
  assert.equal(inRepo.permissionText, 'Fake can edit files in a separate copy of your repo');
  const plain = await preflight(root, { agent: 'fake', cwd: tempRoot() });
  assert.equal(plain.ok, true);
  assert.equal(plain.permission, 'read-only');
  assert.ok(plain.warnings.some((w) => w.code === 'fallback-read-only'));
  const { agents } = await listAgents(root);
  assert.equal(agents.find((a) => a.name === 'fake').defaultPermission, 'edit-worktree');
});

test('edit jobs in large or Git LFS repos get a size warning; read-only jobs do not', async () => {
  const root = tempRoot();
  saveAdapter(root, fakeAdapter());
  const repo = tempRepo();
  const large = async (permission = 'edit-worktree') => (await preflight(root, { agent: 'fake', permission, cwd: repo })).warnings.find((w) => w.code === 'large-repo');
  assert.equal(await large(), undefined);
  setSetting(root, 'worktreeWarnMB', 0);
  assert.match((await large()).message, /full copy of this repo/);
  setSetting(root, 'worktreeWarnMB', 500);
  fs.writeFileSync(path.join(repo, '.gitattributes'), '*.fbx filter=lfs diff=lfs merge=lfs -text\n');
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-q', '-m', 'lfs'], { cwd: repo });
  assert.match((await large()).message, /Git LFS/);
  assert.equal(await large('read-only'), undefined);
});

test('dispatch with a base: unknown refs and uncommitted changes are refused; a read-only job gets a copy at the base', async () => {
  const root = tempRoot();
  saveAdapter(root, fakeAdapter('ok'));
  const repo = tempRepo();
  await assert.rejects(dispatch(root, { agent: 'fake', permission: 'read-only', cwd: repo, prompt: 'x', base: 'nope' }), (e) => e.code === 'unknown-base');
  await assert.rejects(dispatch(root, { agent: 'fake', permission: 'read-only', cwd: repo, prompt: 'x', base: '--all' }), (e) => e.code === 'bad-base');
  await assert.rejects(dispatch(root, { agent: 'fake', permission: 'edit-worktree', cwd: repo, prompt: 'x', base: 'main', includeUncommitted: true }), (e) => e.code === 'base-with-uncommitted');
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('checkout', '-q', '-b', 'feat/x');
  fs.writeFileSync(path.join(repo, 'x.txt'), 'x\n');
  git('add', '-A');
  git('-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qm', 'x');
  const xHead = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main');
  const res = await dispatch(root, { agent: 'fake', permission: 'read-only', cwd: repo, prompt: 'Look', base: 'feat/x' });
  const started = readJob(res.dir);
  assert.equal(started.base, 'feat/x');
  assert.equal(started.baseCommit, xHead);
  assert.ok(started.worktree);
  const done = await waitFor(() => { const j = readJob(res.dir); return j.status === 'done' && j; });
  assert.equal(done.permission, 'read-only');
});

test('dispatch records the session that asked for the job', async () => {
  const root = tempRoot();
  saveAdapter(root, fakeAdapter('ok'));
  const res = await dispatch(root, { agent: 'fake', permission: 'read-only', cwd: tempRoot(), prompt: 'x', session: 'sess-1' });
  assert.deepEqual(readJob(res.dir).origin, { session: 'sess-1' });
});
