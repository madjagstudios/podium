import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { saveAdapter } from '../engine/adapters/registry.js';

export const FAKE_AGENT = fileURLToPath(new URL('./fake-agent.js', import.meta.url));

export function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'podium-test-'));
}

export function tempRepo() {
  const dir = tempRoot();
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
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

// An agent whose runs follow a script: steps are { write, content, say, err, ms, exit }.
export function scriptAgent(root, name, steps) {
  const file = path.join(tempRoot(), `${name}-script.json`);
  fs.writeFileSync(file, JSON.stringify(steps));
  saveAdapter(root, { ...fakeAdapter('script'), name, label: name.charAt(0).toUpperCase() + name.slice(1), baseArgs: [FAKE_AGENT, '--mode', 'script', '--script', file] });
  return file;
}

export async function waitFor(fn, { timeoutMs = 20_000, intervalMs = 100 } = {}) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor timed out');
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
