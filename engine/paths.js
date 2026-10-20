import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function dataDir(env = process.env, platform = process.platform) {
  if (env.PODIUM_DATA_DIR) return env.PODIUM_DATA_DIR;
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Podium');
  if (platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Podium');
  return path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'podium');
}

// A full path on this platform. On Windows it names a drive (C:\…): "\copies" is relative to whichever drive a process
// happens to be on, and a network share (\\server\…) can't be a working folder for agents started through cmd.exe.
export function isFullPath(value, platform = process.platform) {
  if (typeof value !== 'string' || !value) return false;
  if (platform === 'win32') return /^[a-zA-Z]:[\\/]/.test(value);
  return path.posix.isAbsolute(value);
}

// Where copies live: the chosen folder (worktreeRoot), else under the data folder. macOS's own data folder has a space
// (Application Support), which breaks repo tests that build paths from file URLs, so with it copies go to a folder under
// home instead. Any other data folder (PODIUM_DATA_DIR, a test's) keeps them; the doctor warns about one with a space.
export function worktreeDir(root, settings, platform = process.platform) {
  const chosen = settings?.worktreeRoot;
  if (isFullPath(chosen, platform)) return chosen;
  if (platform === 'darwin' && root === dataDir({}, 'darwin')) return path.join(os.homedir(), '.podium', 'worktrees');
  return path.join(root, 'worktrees');
}

export function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unnamed';
}

// The project jobs, sprints and per-repo settings are filed under: the repo's name, the same from its main checkout and
// from every linked worktree (a session's own under .claude/worktrees, or one of Podium's copies).
export function projectKey(cwd) {
  return checkoutKeys(cwd).key;
}

// What the "here" lookups cover: the checkout's project and, in a linked worktree, the work it filed under its own
// folder name before worktrees were keyed by their repo. That name could be another repo's key too, so only work made
// inside this worktree counts under it. A plain key when there is no older one.
export function projectHere(cwd) {
  const { key, own, top } = checkoutKeys(cwd);
  return own && own !== key ? { key, older: own, top } : key;
}

// project: a key, a projectHere, or none for every project. folder: where the work was made (a job's cwd, a sprint's
// repo), read only under a worktree's older key.
export function inProject(project, key, folder) {
  if (!project) return true;
  if (typeof project !== 'object') return key === project;
  return key === project.key || (key === project.older && within(folder, project.top));
}

// The project folders a lookup reads.
export function projectFolders(project) {
  return typeof project === 'object' ? [project.key, project.older] : [project];
}

// A path that no longer exists (a job's deleted subfolder) is resolved through its nearest existing parent.
const realOr = (p) => {
  const full = path.resolve(p);
  try { return fs.realpathSync.native(full); } catch {
    const parent = path.dirname(full);
    return parent === full ? full : path.join(realOr(parent), path.basename(full));
  }
};

// Compared as real paths (8.3 names on Windows, /var → /private/var on macOS, links).
const sameFolder = (a, b) => realOr(a) === realOr(b);

function within(folder, top) {
  if (typeof folder !== 'string' || !folder || !top) return false;
  const rel = path.relative(realOr(top), realOr(folder));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function checkoutKeys(cwd) {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel', '--git-dir', '--git-common-dir'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    // git prints the git folders relative to cwd when it can (.git, ../.git in a main checkout).
    const [top, gitDir, shared] = out.trim().split(/\r?\n/);
    const common = path.resolve(cwd ?? '', shared);
    const linked = !sameFolder(path.resolve(cwd ?? '', gitDir), common);
    return { key: slug(repoName(common, linked ? null : top)), own: slug(path.basename(top)), top };
  } catch {
    return { key: slug(path.basename(path.resolve(cwd))) };
  }
}

// The repo's name from its shared git folder, so a main checkout and its linked worktrees agree. A main checkout (top)
// keeps its own folder's name where the shared folder leads back to it, as it always did.
function repoName(common, top) {
  // Where the shared folder leads back to: the folder holding it as .git, or a submodule's checkout (core.worktree,
  // relative to its <super>/.git/modules/<name>).
  const back = path.basename(common) === '.git' ? path.dirname(common) : gitConfig(path.join(common, 'config'), 'core.worktree');
  if (back) {
    const home = path.resolve(common, back);
    return top && sameFolder(home, top) ? path.basename(top) : path.basename(home);
  }
  // A bare repo or a --separate-git-dir checkout: nothing leads back from the shared folder to a checkout, so every
  // checkout, main or linked, takes its name (shop.git → shop).
  return path.basename(common).replace(/\.git$/i, '');
}

function gitConfig(file, key) {
  try {
    return execFileSync('git', ['config', '--file', file, '--get', key], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

export function ticketKey(ticket) {
  return ticket ? slug(ticket).toUpperCase() : 'NO-TICKET';
}
