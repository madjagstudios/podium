import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { PodiumError } from './errors.js';
import { killGroup, ownGroup } from './launch.js';

const run = promisify(execFile);

// Commands that talk to a remote.
const NETWORK = new Set(['fetch', 'push', 'pull', 'ls-remote', 'clone']);
export const NETWORK_TIMEOUT_MS = 120_000;

// How Podium runs git. No one is there to answer a login prompt (a detached runner, often holding a sprint's lock), so
// git never asks: GIT_TERMINAL_PROMPT=0 and GCM_INTERACTIVE=never make a missing login a plain failure. A command that
// talks to a remote also gets a time limit (timeoutMs; null for the rest); past it, it fails like any other. It also
// leads its own process group on macOS and Linux (ownGroup), so the time limit stops its helpers too. platform: tests.
export function gitOptions(cwd, args, { timeoutMs = NETWORK_TIMEOUT_MS, platform = process.platform } = {}) {
  const network = NETWORK.has(args[0]);
  return {
    cwd,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    timeoutMs: network ? timeoutMs : null,
    ...(network ? ownGroup(platform) : {}),
  };
}

// opts: timeoutMs and platform (see gitOptions); spawn and kill are test seams for a network command.
function git(cwd, args, opts = {}) {
  const { timeoutMs, ...options } = gitOptions(cwd, args, opts);
  if (!timeoutMs) return run('git', args, options);
  return runInGroup('git', args, options, { timeoutMs, platform: opts.platform, spawn: opts.spawn, kill: opts.kill });
}

// Runs a command that may be stopped at a time limit, as execFile would, but through spawn: execFile builds its own
// spawn options and drops `detached`, so the command never led a process group and the group kill missed its helpers.
// What execFile gave is kept: output collected as text (options.encoding, utf8) up to options.maxBuffer per stream
// (past it the command is stopped and fails plainly), and its error shape (code = exit code or a spawn error's code,
// killed, signal, cmd, stdout, stderr, "Command failed: <cmd>" plus stderr). Past timeoutMs the whole group is killed
// (killGroup: SIGKILL to -pid on macOS and Linux, taskkill /T /F on Windows) and it fails with timedOutMs; the parent
// waits for it, so it is never unref'd. Helpers may hold the output open a moment longer after a kill, so a kill
// settles at once on its own clock rather than waiting for them to let go. spawn and kill: test seams.
export function runInGroup(file, args, options, { timeoutMs, platform = process.platform, spawn: start = spawn, kill } = {}) {
  const { maxBuffer = 1024 * 1024, encoding = 'utf8', ...spawnOptions } = options;
  const cmd = [file, ...args].join(' ');
  return new Promise((resolve, reject) => {
    const chunks = { stdout: [], stderr: [] };
    const sizes = { stdout: 0, stderr: 0 };
    let done = false;
    let timer = null;
    let child;
    const text = (name) => Buffer.concat(chunks[name]).toString(encoding);
    const settle = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const stdout = text('stdout');
      const stderr = text('stderr');
      if (err) reject(Object.assign(err, { cmd, stdout, stderr }));
      else resolve({ stdout, stderr });
    };
    const stop = (err) => {
      if (done) return;
      killGroup(child.pid, { platform, ...(kill ? { kill } : {}) });
      child.stdout?.destroy();
      child.stderr?.destroy();
      settle(Object.assign(err, { killed: true, signal: 'SIGKILL', code: err.code ?? null }));
    };
    try {
      child = start(file, args, { ...spawnOptions, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      settle(e);
      return;
    }
    for (const name of ['stdout', 'stderr']) {
      child[name].on('data', (d) => {
        if (done) return;
        const chunk = Buffer.isBuffer(d) ? d : Buffer.from(d);
        sizes[name] += chunk.length;
        if (sizes[name] > maxBuffer) {
          chunks[name].push(chunk.subarray(0, chunk.length - (sizes[name] - maxBuffer)));
          stop(Object.assign(new RangeError(`${name} maxBuffer length exceeded`), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', maxBuffer }));
          return;
        }
        chunks[name].push(chunk);
      });
    }
    child.on('error', (e) => settle(e));
    child.on('close', (code, signal) => {
      if (code === 0) return settle(null);
      const stderr = text('stderr');
      settle(Object.assign(new Error(`Command failed: ${cmd}${stderr ? `\n${stderr}` : ''}`), { code, killed: false, signal }));
    });
    timer = setTimeout(() => stop(Object.assign(new Error(`${file} ${args[0]} timed out`), { timedOutMs: timeoutMs })), timeoutMs);
  });
}

const within = (ms) => (ms >= 60_000 && ms % 60_000 === 0 ? `${ms / 60_000} minute${ms === 60_000 ? '' : 's'}` : `${Math.round(ms / 1000)} seconds`);

// Why git failed, in git's words: its first "fatal:" or "error:" line, else its first line.
function gitReason(e) {
  if (e.timedOutMs) return `the remote didn't answer within ${within(e.timedOutMs)}`;
  if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return `it wrote more output than Podium reads (${Math.round(e.maxBuffer / 1024 / 1024)} MB)`;
  const lines = String(e.stderr || e.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const said = lines.find((l) => /^(fatal|error):/.test(l)) ?? lines[0];
  return said ? said.replace(/^(fatal|error):\s*/, '') : e.message;
}

// For callers that show errors to people: git's own message, not the command line. opts.timeoutMs: a network
// command's time limit (tests).
export async function gitIn(cwd, args, opts) {
  try {
    return (await git(cwd, args, opts)).stdout.trim();
  } catch (e) {
    throw new PodiumError('git-failed', `git ${args[0]}: ${gitReason(e)}`);
  }
}

export async function isGitRepo(cwd) {
  try {
    await git(cwd, ['rev-parse', '--is-inside-work-tree']);
    return true;
  } catch {
    return false;
  }
}

export async function repoRoot(cwd) {
  const { stdout } = await git(cwd, ['rev-parse', '--show-toplevel']);
  return path.resolve(stdout.trim());
}

// A ref the user named as a job's starting point, resolved to a commit, or null.
export async function resolveBase(repo, ref) {
  if (!ref || String(ref).startsWith('-')) return null;
  try {
    const { stdout } = await git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function createWorktree(repo, wtPath, branch, start = null) {
  const base = start ?? (await gitIn(repo, ['rev-parse', 'HEAD']));
  // Failures read "git worktree: <git's reason>", not a command line.
  await gitIn(repo, ['worktree', 'add', '-q', '-b', branch, wtPath, base]);
  return base;
}

// Did the agent commit, or switch branches, in its copy? Commits are counted from
// `since` so a branch the agent checked out does not bring its older history along.
export async function committedWork(wtPath, { baseCommit, branch, since = null }) {
  const head = (await git(wtPath, ['rev-parse', 'HEAD'])).stdout.trim();
  const name = (await git(wtPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  // A detached copy (a PR review) has no branch: HEAD unmoved means no commits.
  if (head === baseCommit && (name === branch || (!branch && name === 'HEAD'))) return null;
  const args = ['log', '--format=%h%x09%s', head, `^${baseCommit}`, ...(since ? [`--since=${since}`] : [])];
  const lines = (await git(wtPath, args)).stdout.split('\n').filter(Boolean);
  const commits = lines.map((l) => {
    const tab = l.indexOf('\t');
    return { sha: l.slice(0, tab), subject: l.slice(tab + 1) };
  });
  return { branch: name === 'HEAD' ? null : name, head, count: commits.length, commits: commits.slice(0, 50) };
}

export async function hasLeftovers(wtPath) {
  const { stdout } = await git(wtPath, ['status', '--porcelain']);
  return stdout.trim().length > 0;
}

// Stage everything in Podium's own worktree (new files included) and diff against the base.
// No commit, so the user's commit hooks never run on Podium's internal work.
export async function diffWorktree(wtPath, base) {
  await git(wtPath, ['add', '-A']);
  const { stdout } = await git(wtPath, ['diff', '--cached', '--binary', base]);
  return stdout;
}

// Copy the user's uncommitted work (tracked changes and untracked, non-ignored files) into
// the worktree and record it as the job's starting point, so the agent sees it but the
// job's patch contains only the agent's own changes. Plumbing commands only: no hooks run.
export async function seedUncommitted(repo, wtPath) {
  const { stdout: diff } = await git(repo, ['diff', 'HEAD', '--binary']);
  const { stdout: untracked } = await git(repo, ['ls-files', '--others', '--exclude-standard', '-z']);
  const files = untracked.split('\0').filter(Boolean);
  if (!diff.trim() && files.length === 0) return null;
  if (diff.trim()) {
    const patchFile = path.join(os.tmpdir(), `podium-seed-${process.pid}-${Date.now()}.patch`);
    fs.writeFileSync(patchFile, diff);
    try { await git(wtPath, ['apply', '--binary', patchFile]); } finally { fs.rmSync(patchFile, { force: true }); }
  }
  for (const file of files) {
    const dest = path.join(wtPath, file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(repo, file), dest);
  }
  await git(wtPath, ['add', '-A']);
  const { stdout: tree } = await git(wtPath, ['write-tree']);
  const { stdout: sha } = await git(wtPath, ['-c', 'user.name=Podium', '-c', 'user.email=podium@localhost', 'commit-tree', tree.trim(), '-p', 'HEAD', '-m', 'podium: your uncommitted changes']);
  await git(wtPath, ['reset', '-q', '--soft', sha.trim()]);
  return sha.trim();
}

// Rough size of a full checkout (sum of tracked blob sizes at HEAD) and whether Git LFS is in use,
// so the user can be warned before every edit job copies a big repo.
export async function checkoutSize(cwd) {
  try {
    const top = await repoRoot(cwd);
    const { stdout } = await git(top, ['ls-tree', '-r', '-l', 'HEAD']);
    let bytes = 0;
    for (const line of stdout.split('\n')) {
      const m = line.match(/^\S+ blob \S+\s+(\d+)\t/);
      if (m) bytes += Number(m[1]);
    }
    let lfs = false;
    try { lfs = /filter=lfs/.test(fs.readFileSync(path.join(top, '.gitattributes'), 'utf8')); } catch { /* no attributes file */ }
    return { bytes, lfs };
  } catch {
    return { bytes: 0, lfs: false };
  }
}

export async function applyPatch(repo, patchFile) {
  try {
    await git(repo, ['apply', '--check', '--binary', patchFile]);
  } catch (e) {
    return { applied: false, error: String(e.stderr || e.message).trim() };
  }
  await git(repo, ['apply', '--binary', patchFile]);
  return { applied: true };
}

export async function removeWorktree(repo, wtPath, branch) {
  try {
    await git(repo, ['worktree', 'remove', '--force', wtPath]);
  } catch {
    fs.rmSync(wtPath, { recursive: true, force: true });
    await git(repo, ['worktree', 'prune']).catch(() => {});
  }
  if (branch) await git(repo, ['branch', '-D', branch]).catch(() => {});
}

export async function pruneWorktrees(repo) {
  await git(repo, ['worktree', 'prune']).catch(() => {});
}

// A detached copy of a pull request's head, for a read-only review.
export async function createReviewCopy(repo, wtPath, number) {
  await git(repo, ['fetch', '-q', 'origin', `pull/${number}/head`]);
  const head = (await git(repo, ['rev-parse', 'FETCH_HEAD'])).stdout.trim();
  await git(repo, ['worktree', 'add', '-q', '--detach', wtPath, head]);
  return head;
}

// Where the base comes from: its upstream (branch.<base>.remote) when that is a remote this repo has, else origin,
// else nowhere (null). An upstream of "." is a local branch: nowhere too.
async function baseRemote(repo, base) {
  const upstream = await gitIn(repo, ['config', '--get', `branch.${base}.remote`]).catch(() => '');
  if (upstream === '.') return null;
  const remotes = (await gitIn(repo, ['remote'])).split(/\r?\n/).filter(Boolean);
  if (upstream && remotes.includes(upstream)) return upstream;
  return remotes.includes('origin') ? 'origin' : null;
}

// The base as the remote has it now ("after"): fetch it into its remote-tracking ref and return that
// ref to start a copy from. With no remote to fetch from (baseRemote), the local base. The local branch is never
// moved or checked out: the fetch names its target ref, whatever the remote's fetch settings are. A failed fetch
// throws git-failed with the remote it tried as e.remote.
export async function fetchBase(repo, base) {
  const remote = await baseRemote(repo, base);
  if (!remote) return `refs/heads/${base}`;
  try {
    await gitIn(repo, ['fetch', '-q', remote, `+refs/heads/${base}:refs/remotes/${remote}/${base}`]);
  } catch (e) {
    throw Object.assign(e, { remote });
  }
  return `refs/remotes/${remote}/${base}`;
}
