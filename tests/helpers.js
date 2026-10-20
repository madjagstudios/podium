import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { saveAdapter } from '../engine/adapters/registry.js';
import { measure, record } from './profile-metrics.js';
import { performance } from 'node:perf_hooks';

export const FAKE_AGENT = fileURLToPath(new URL('./fake-agent.js', import.meta.url));

export function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'podium-test-'));
}

let repoSeed;
function treeSnapshot(root) {
  const entries = {};
  const visit = (relative) => {
    const file = relative === '.' ? root : path.join(root, relative);
    try {
      const stat = fs.lstatSync(file);
      const type = stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
      entries[relative.replaceAll('\\', '/')] = { type, mode: stat.mode, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
      if (type === 'directory') {
        for (const name of fs.readdirSync(file).sort()) visit(relative === '.' ? name : path.join(relative, name));
      }
    } catch (error) {
      entries[relative.replaceAll('\\', '/')] = { error: error.code, syscall: error.syscall };
    }
  };
  visit('.');
  return { root, entries };
}

export function tempRepo() {
  return measure('fixture.repo', () => {
    if (!repoSeed) {
      repoSeed = measure('fixture.seed', () => makeRepo());
      process.prependOnceListener('exit', () => {
        // Only this process's private seed; returned repositories stay independent.
        try { measure('fixture.teardown', () => fs.rmSync(repoSeed, { recursive: true, force: true, maxRetries: 2 })); }
        catch { /* A busy temporary file can be reclaimed by normal temp cleanup. */ }
      });
    }
    const dir = tempRoot();
    // Physical copies, including objects/index/config/refs: no alternates or shared Git state.
    measure('fixture.copy', () => {
      try { fs.cpSync(repoSeed, dir, { recursive: true }); }
      catch (error) {
        // Native copy errors may name a destination parent, not the vanished source.
        // Capture both trees now, before normal exit cleanup, without changing failure semantics.
        try {
          const evidence = { pid: process.pid, node: process.version, platform: process.platform,
            error: { code: error.code, path: error.path, dest: error.dest, syscall: error.syscall, message: error.message },
            source: treeSnapshot(repoSeed), destination: treeSnapshot(dir) };
          console.error(`PODIUM_FIXTURE_COPY_FAILURE ${JSON.stringify(evidence)}`);
          record('fixture.copy.failure', 0, evidence);
        } catch { /* Diagnostic failures must never replace the original copy error. */ }
        throw error;
      }
    });
    return dir;
  });
}

function makeRepo() {
  const dir = tempRoot();
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n');
  git('add', '-A');
  // A synchronous commit can leave detached auto-maintenance mutating objects.
  // Suppress it only for seed creation; copied fixtures keep normal Git configuration.
  git('-c', 'maintenance.auto=false', 'commit', '-q', '-m', 'init');
  return dir;
}

export function fakeAdapter(mode = 'ok', extra = {}) {
  return {
    name: 'fake',
    label: 'Fake',
    command: process.execPath,
    baseArgs: [FAKE_AGENT, '--mode', mode],
    promptVia: 'stdin',
    modelFlag: '--model',
    versionArgs: [FAKE_AGENT, '--version'],
    permissions: { 'read-only': ['--ro'], 'edit-worktree': ['--rw'], 'own-config': [], 'full-access': ['--yolo'] },
    ...extra,
  };
}

// An agent whose runs follow a script: steps are { write, content, say, err, ms, exit }. extra: adapter fields to add.
export function scriptAgent(root, name, steps, extra = {}) {
  const file = path.join(tempRoot(), `${name}-script.json`);
  fs.writeFileSync(file, JSON.stringify(steps));
  saveAdapter(root, { ...fakeAdapter('script'), name, label: name.charAt(0).toUpperCase() + name.slice(1), baseArgs: [FAKE_AGENT, '--mode', 'script', '--script', file], ...extra });
  return file;
}

// A scripted agent's conversation resumes from step to step, as Claude's does (the fake agent ignores the flags).
export const RESUMES = { resume: { start: ['--session-id', '{id}'], continue: { args: ['--resume', '{id}'] } } };

export async function waitFor(fn, { timeoutMs = 20_000, intervalMs = 100 } = {}) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const start = performance.now();
    const value = await fn();
    record('poll.callback', performance.now() - start);
    if (value) return value;
    const sleep = performance.now();
    await new Promise((r) => setTimeout(r, intervalMs));
    record('poll.sleep', performance.now() - sleep);
  }
  throw new Error('waitFor timed out');
}

const STUCK = fileURLToPath(new URL('./stuck-check.js', import.meta.url));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const readCheck = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'check.json'), 'utf8')); } catch { return null; } };

// A check command line that never ends on its own (tests/stuck-check.js). When the test ends it is told to end (its
// `life` file goes), which also ends the shell and runner of a check it was running, and the test waits for it and for
// the runner and shell of each check folder `checks()` names (read then) to exit; any still running fails the test,
// named (endProcesses). Nothing is ever stopped by pid or by name.
export function stuckCheck(t, { checks = () => [] } = {}) {
  const dir = tempRoot();
  fs.writeFileSync(path.join(dir, 'life'), '');
  t.after(async () => {
    fs.rmSync(path.join(dir, 'life'), { force: true });
    const procs = fs.readdirSync(dir).filter((f) => /^pid-\d+$/.test(f)).map((f) => ({ pid: Number(f.slice(4)), what: 'the stuck check' }));
    for (const c of checks()) {
      const rec = readCheck(c);
      if (rec?.runnerPid) procs.push({ pid: rec.runnerPid, what: `the check runner of ${c}` });
      if (rec?.checkPid) procs.push({ pid: rec.checkPid, what: `the check's shell in ${c}` });
    }
    await endProcesses(procs);
  });
  return `"${process.execPath}" "${STUCK}" "${dir}"`;
}

// Wait for each { pid, what } to exit. Nothing is stopped here: Windows reuses a pid within seconds, so a pid seen gone is
// retired at once (by the next look it may name another program), and one still running when the wait ends fails the
// test, named. A stuck check ends itself within five minutes, and its shell and runner with it.
export async function endProcesses(procs, { waitMs = 60_000 } = {}) {
  let left = procs;
  const allGone = () => (left = left.filter((p) => alive(p.pid))).length === 0;
  if (await waitFor(allGone, { timeoutMs: waitMs }).then(() => true, () => false)) return;
  throw new Error(`Processes this test started are still running: ${left.map((p) => `${p.what} (pid ${p.pid})`).join(', ')}. The stuck check ends itself within five minutes; if they outlive that, stop them by pid.`);
}

export const FAKE_GH = fileURLToPath(new URL('./fake-gh.js', import.meta.url));

// A repo with a bare "origin" and a fake gh answering from `responses`.
export function ghWorld(responses) {
  const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const repo = tempRepo();
  const remote = tempRoot();
  git(remote, 'init', '-q', '--bare', '-b', 'main');
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  const dir = tempRoot();
  const log = path.join(dir, 'gh.log');
  const specFile = path.join(dir, 'gh.json');
  fs.writeFileSync(specFile, JSON.stringify({ log, responses }));
  const env = { ...process.env, PODIUM_GH: JSON.stringify([process.execPath, FAKE_GH]), PODIUM_FAKE_GH: specFile };
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { repo, remote, env, calls, git };
}

export const PLAN = '# Plan\n\n### Task 1: Add a.txt\nWrite a.txt.\n\n### Task 2: Add b.txt\nWrite b.txt.\n\n## Done\n';

// A repo with origin, a fake gh that answers "pr create" with PR #12 (and any answers in `gh`), and plans
// committed on main.
export function sprintWorld({ plans = { 'docs/plan.md': PLAN }, gh = [] } = {}) {
  const root = tempRoot();
  const w = ghWorld([{ match: ['pr', 'create'], stdout: 'https://github.com/o/r/pull/12\n' }, ...gh]);
  w.git(w.repo, 'config', 'core.autocrlf', 'false');
  for (const [file, text] of Object.entries(plans)) {
    fs.mkdirSync(path.dirname(path.join(w.repo, file)), { recursive: true });
    fs.writeFileSync(path.join(w.repo, file), text);
  }
  w.git(w.repo, 'add', '-A');
  w.git(w.repo, 'commit', '-q', '-m', 'plans');
  return { root, w };
}
