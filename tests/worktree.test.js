import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isGitRepo, repoRoot, resolveBase, createWorktree, committedWork, hasLeftovers, diffWorktree, applyPatch, removeWorktree, gitIn, gitOptions, runInGroup, NETWORK_TIMEOUT_MS } from '../engine/worktree.js';
import { pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { tempRoot, tempRepo, waitFor } from './helpers.js';

test('isGitRepo and repoRoot', async () => {
  const repo = tempRepo();
  fs.mkdirSync(path.join(repo, 'sub'));
  assert.equal(await isGitRepo(path.join(repo, 'sub')), true);
  assert.equal(await isGitRepo(tempRoot()), false);
  // .native expands Windows 8.3 short names (CI temp is C:\Users\RUNNER~1\...); git reports the long form.
  assert.equal(fs.realpathSync.native(await repoRoot(path.join(repo, 'sub'))), fs.realpathSync.native(repo));
});

test('a worktree change becomes a patch that applies to the main tree', async () => {
  const repo = tempRepo();
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: repo });
  const wt = path.join(tempRoot(), 'wt');
  const base = await createWorktree(repo, wt, 'podium/test-1');
  assert.match(base, /^[0-9a-f]{40}$/);
  fs.writeFileSync(path.join(wt, 'new.txt'), 'new file\n');
  fs.writeFileSync(path.join(wt, 'README.md'), 'changed\n');
  const patch = await diffWorktree(wt, base);
  assert.match(patch, /new\.txt/);
  const patchFile = path.join(tempRoot(), 'diff.patch');
  fs.writeFileSync(patchFile, patch);
  assert.deepEqual(await applyPatch(repo, patchFile), { applied: true });
  assert.equal(fs.readFileSync(path.join(repo, 'new.txt'), 'utf8'), 'new file\n');
  assert.equal(fs.readFileSync(path.join(repo, 'README.md'), 'utf8').replace(/\r\n/g, '\n'), 'changed\n');
  await removeWorktree(repo, wt, 'podium/test-1');
  assert.equal(fs.existsSync(wt), false);
  assert.doesNotMatch(execFileSync('git', ['branch'], { cwd: repo, encoding: 'utf8' }), /podium\/test-1/);
});

test('an empty worktree yields an empty patch', async () => {
  const repo = tempRepo();
  const wt = path.join(tempRoot(), 'wt');
  const base = await createWorktree(repo, wt, 'podium/test-2');
  assert.equal((await diffWorktree(wt, base)).trim(), '');
  await removeWorktree(repo, wt, 'podium/test-2');
});

test('a conflicting patch is refused and the tree is left untouched', async () => {
  const repo = tempRepo();
  const wt = path.join(tempRoot(), 'wt');
  const base = await createWorktree(repo, wt, 'podium/test-3');
  fs.writeFileSync(path.join(wt, 'clash.txt'), 'agent version\n');
  const patchFile = path.join(tempRoot(), 'diff.patch');
  fs.writeFileSync(patchFile, await diffWorktree(wt, base));
  fs.writeFileSync(path.join(repo, 'clash.txt'), 'my version\n');
  const r = await applyPatch(repo, patchFile);
  assert.equal(r.applied, false);
  assert.match(r.error, /clash\.txt/);
  assert.equal(fs.readFileSync(path.join(repo, 'clash.txt'), 'utf8'), 'my version\n');
  await removeWorktree(repo, wt, 'podium/test-3');
});

const g = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const OLD = { GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z' };
function commitIn(cwd, file, msg, env = {}) {
  fs.writeFileSync(path.join(cwd, file), `${msg}\n`);
  g(cwd, 'add', '-A');
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qm', msg], { cwd, stdio: 'pipe', env: { ...process.env, ...env } });
}

test('resolveBase finds branches and commits, and refuses unknown or option-like refs', async () => {
  const repo = tempRepo();
  g(repo, 'branch', 'feat/x');
  assert.equal(await resolveBase(repo, 'feat/x'), g(repo, 'rev-parse', 'HEAD'));
  assert.equal(await resolveBase(repo, 'nope'), null);
  assert.equal(await resolveBase(repo, '--all'), null);
  assert.equal(await resolveBase(repo, ''), null);
});

test('a worktree can start from another branch', async () => {
  const repo = tempRepo();
  g(repo, 'checkout', '-q', '-b', 'feat/x');
  commitIn(repo, 'x.txt', 'on x');
  const xHead = g(repo, 'rev-parse', 'HEAD');
  g(repo, 'checkout', '-q', 'main');
  const wt = path.join(tempRoot(), 'wt');
  const start = await createWorktree(repo, wt, 'podium/t1', await resolveBase(repo, 'feat/x'));
  assert.equal(start, xHead);
  assert.equal(fs.existsSync(path.join(wt, 'x.txt')), true);
});

test('committedWork sees a branch switch with new commits and ignores the branch\'s older commits', async () => {
  const repo = tempRepo();
  g(repo, 'checkout', '-q', '-b', 'feat/base');
  commitIn(repo, 'old.txt', 'old work', OLD);
  g(repo, 'checkout', '-q', 'main');
  const wt = path.join(tempRoot(), 'wt');
  const baseCommit = await createWorktree(repo, wt, 'podium/t2');
  assert.equal(await committedWork(wt, { baseCommit, branch: 'podium/t2' }), null);
  const since = new Date(Date.now() - 2000).toISOString();
  g(wt, 'checkout', '-q', '-b', 'feat/agent', 'feat/base');
  commitIn(wt, 'new.txt', 'agent work');
  const work = await committedWork(wt, { baseCommit, branch: 'podium/t2', since });
  assert.equal(work.branch, 'feat/agent');
  assert.equal(work.count, 1);
  assert.equal(work.commits[0].subject, 'agent work');
  assert.match(work.commits[0].sha, /^[0-9a-f]{7,}$/);
  assert.equal(work.head, g(wt, 'rev-parse', 'HEAD'));
  assert.equal(await hasLeftovers(wt), false);
  fs.writeFileSync(path.join(wt, 'loose.txt'), 'x\n');
  assert.equal(await hasLeftovers(wt), true);
});

test('committedWork also sees commits made on Podium\'s own branch', async () => {
  const repo = tempRepo();
  const wt = path.join(tempRoot(), 'wt');
  const baseCommit = await createWorktree(repo, wt, 'podium/t3');
  commitIn(wt, 'a.txt', 'here');
  const work = await committedWork(wt, { baseCommit, branch: 'podium/t3' });
  assert.equal(work.branch, 'podium/t3');
  assert.equal(work.count, 1);
});

// Podium runs git with no one to answer it, often while it holds a sprint's lock. git never asks
// for a login, and a command that talks to a remote has a time limit.
test('git never asks for a login, and only commands that talk to a remote get a time limit', () => {
  for (const cmd of ['fetch', 'push', 'ls-remote', 'pull', 'clone']) {
    const o = gitOptions('C:/x', [cmd, 'origin']);
    assert.equal(o.env.GIT_TERMINAL_PROMPT, '0', cmd);
    assert.equal(o.env.GCM_INTERACTIVE, 'never', cmd);
    assert.equal(o.env.PATH ?? o.env.Path, process.env.PATH ?? process.env.Path, `${cmd} keeps the rest of the environment`);
    assert.equal(o.timeoutMs, NETWORK_TIMEOUT_MS, cmd);
    assert.equal(o.cwd, 'C:/x');
  }
  assert.equal(NETWORK_TIMEOUT_MS, 120_000);
  assert.equal(gitOptions('C:/x', ['fetch'], { timeoutMs: 500 }).timeoutMs, 500);
  const local = gitOptions('C:/x', ['status', '--porcelain']);
  assert.equal(local.env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(local.env.GCM_INTERACTIVE, 'never');
  assert.equal(local.timeoutMs, null);
});

test('a fetch from a remote that is not there fails at once with git\'s reason', async () => {
  const repo = tempRepo();
  const gone = pathToFileURL(path.join(tempRoot(), 'gone.git')).href;
  const t0 = Date.now();
  await assert.rejects(gitIn(repo, ['fetch', '-q', gone, 'main']), (e) => e.code === 'git-failed' && /^git fetch: /.test(e.message));
  assert.ok(Date.now() - t0 < 15_000, 'it does not wait');
});

// A remote that never answers (an ext:: helper that just sleeps) stands in for one waiting on a login.
test('a fetch from a remote that never answers gives up at its time limit, as a plain failure', async () => {
  const repo = tempRepo();
  execFileSync('git', ['config', 'protocol.ext.allow', 'always'], { cwd: repo });
  const t0 = Date.now();
  await assert.rejects(
    gitIn(repo, ['fetch', '-q', 'ext::node -e setTimeout(()=>{},20000)', 'main'], { timeoutMs: 2000 }),
    (e) => e.code === 'git-failed' && e.message === "git fetch: the remote didn't answer within 2 seconds",
  );
  assert.ok(Date.now() - t0 < 10_000, `gave up in ${Date.now() - t0} ms`);
});

// Past the time limit only git itself was stopped on macOS and Linux (it had no process group of its own, so the
// group kill missed), and its helpers ran on. A network command leads its own group there, and the whole group is killed.
const SLEEPER = new URL('./sleeper.js', import.meta.url);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('network git runs in its own process group on macOS and Linux, and other git does not', () => {
  assert.equal(gitOptions('C:/x', ['fetch', 'origin'], { platform: 'linux' }).detached, true);
  assert.equal(gitOptions('C:/x', ['push', 'origin'], { platform: 'darwin' }).detached, true);
  assert.equal(gitOptions('C:/x', ['fetch', 'origin'], { platform: 'win32' }).detached, undefined, 'Windows stops a tree with taskkill /T');
  assert.equal(gitOptions('C:/x', ['status'], { platform: 'linux' }).detached, undefined);
});

test('a network git command past its time limit stops the helpers it started too', async () => {
  const repo = tempRepo();
  execFileSync('git', ['config', 'protocol.ext.allow', 'always'], { cwd: repo });
  const dir = tempRoot();
  const script = path.join(dir, 'sleeper.mjs');
  fs.copyFileSync(SLEEPER, script);
  const pidFile = path.join(dir, 'pid');
  const fwd = (p) => p.split(path.sep).join('/');
  await assert.rejects(gitIn(repo, ['fetch', '-q', `ext::node ${fwd(script)} ${fwd(pidFile)}`, 'main'], { timeoutMs: 3000 }), (e) => e.code === 'git-failed' && /didn't answer/.test(e.message));
  const pid = Number(await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim(), { timeoutMs: 5000 }));
  try {
    await waitFor(() => !alive(pid), { timeoutMs: 10_000 });
  } finally {
    try { process.kill(pid); } catch { /* gone */ }
  }
});

// execFile builds its own spawn options and drops `detached`, so git never led a group and the group kill
// above missed its helpers on macOS and Linux (CI). A network command is started with spawn itself. The test above is
// the real check there: only a kill of git's whole group reaches the sleeper's child (killGroup's fallback kills git alone).
function fakeChild(pid = 4242) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

test('network git is spawned leading its own group on macOS and Linux (not on Windows), and its output is read', async () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    const calls = [];
    const spawn = (file, args, options) => {
      calls.push({ file, args, options });
      const child = fakeChild();
      setImmediate(() => { child.stdout.end('abc123\n'); child.stderr.end(); child.emit('close', 0, null); });
      return child;
    };
    assert.equal(await gitIn('C:/x', ['fetch', '-q', 'origin', 'main'], { platform, spawn }), 'abc123', platform);
    assert.equal(calls.length, 1);
    const { file, args, options } = calls[0];
    assert.equal(file, 'git');
    assert.deepEqual(args, ['fetch', '-q', 'origin', 'main']);
    assert.equal(options.detached, platform === 'win32' ? undefined : true, platform);
    assert.equal(options.cwd, 'C:/x');
    assert.equal(options.windowsHide, true);
    assert.equal(options.env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(options.env.GCM_INTERACTIVE, 'never');
    assert.equal('maxBuffer' in options, false, 'maxBuffer is enforced here, not handed to spawn');
  }
});

test('network git past its time limit kills its whole group and fails as a time-out', async () => {
  const kills = [];
  const spawn = () => fakeChild(4242); // never answers
  await assert.rejects(
    gitIn('C:/x', ['fetch', 'origin'], { platform: 'linux', timeoutMs: 50, spawn, kill: (pid, sig) => kills.push([pid, sig]) }),
    (e) => e.code === 'git-failed' && /^git fetch: the remote didn't answer within/.test(e.message),
  );
  assert.deepEqual(kills, [[-4242, 'SIGKILL']]);
  const gone = [];
  await assert.rejects(gitIn('C:/x', ['push', 'origin'], { platform: 'darwin', timeoutMs: 50, spawn, kill: (pid, sig) => { gone.push([pid, sig]); if (pid < 0) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' }); } }), /didn't answer/);
  assert.deepEqual(gone, [[-4242, 'SIGKILL'], [4242, 'SIGKILL']], 'a group already gone is not an error');
});

test('network git that fails keeps execFile\'s error shape and git\'s reason', async () => {
  const spawn = () => {
    const child = fakeChild();
    setImmediate(() => { child.stdout.end(); child.stderr.end('fatal: could not read from remote repository\n'); child.emit('close', 128, null); });
    return child;
  };
  await assert.rejects(gitIn('C:/x', ['fetch', 'origin'], { platform: 'linux', spawn }), (e) => e.code === 'git-failed' && e.message === 'git fetch: could not read from remote repository');
  await assert.rejects(runInGroup('git', ['fetch', 'origin'], { cwd: 'C:/x' }, { timeoutMs: 5000, platform: 'linux', spawn }), (e) => {
    assert.equal(e.code, 128);
    assert.equal(e.killed, false);
    assert.equal(e.signal, null);
    assert.equal(e.cmd, 'git fetch origin');
    assert.match(e.message, /^Command failed: git fetch origin\nfatal: could not read from remote repository/);
    assert.equal(e.stderr, 'fatal: could not read from remote repository\n');
    assert.equal(e.stdout, '');
    return true;
  });
});

test('a grouped command that writes past maxBuffer is stopped and fails plainly; a missing command fails as spawn reports it', async () => {
  const big = ['-e', "process.stdout.write('x'.repeat(5000)); setTimeout(() => {}, 20000)"];
  const t0 = Date.now();
  await assert.rejects(runInGroup(process.execPath, big, { maxBuffer: 1000, windowsHide: true }, { timeoutMs: 15_000 }), (e) => {
    assert.equal(e.code, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
    assert.equal(e.message, 'stdout maxBuffer length exceeded');
    assert.equal(e.stdout.length, 1000);
    assert.equal(e.killed, true);
    return true;
  });
  assert.ok(Date.now() - t0 < 10_000, 'it does not wait for the time limit');
  const ok = await runInGroup(process.execPath, ['-e', "process.stdout.write('h\u00e9llo'); process.stderr.write('w')"], { windowsHide: true }, { timeoutMs: 15_000 });
  assert.deepEqual(ok, { stdout: 'h\u00e9llo', stderr: 'w' });
  await assert.rejects(runInGroup('definitely-not-a-real-command-xyz', ['fetch'], { windowsHide: true }, { timeoutMs: 15_000 }), (e) => e.code === 'ENOENT');
});
