// Remove Podium's data cleanly: stop jobs, remove every copy the way
// git expects (so no stale worktree entries stay in people's repos), then
// delete the data folder. Branches agents committed to are left alone.
import fs from 'node:fs';
import path from 'node:path';
import { listJobDirs, readJob } from './store.js';
import { cancel } from './cancel.js';
import { removeWorktree, pruneWorktrees } from './worktree.js';
import { readJson } from './fsutil.js';
import { killTree } from './launch.js';

const RUNNING = new Set(['queued', 'running']);

export function dataSize(dir) {
  let total = 0;
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(full);
      else total += fs.statSync(full).size;
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return total;
}

const jobsIn = (root) => listJobDirs(root).map((dir) => readJob(dir));

export function removalPlan(root) {
  const jobs = jobsIn(root);
  return {
    bytes: dataSize(root),
    unkept: jobs.filter((j) => j.status === 'needs-review').length,
    running: jobs.filter((j) => RUNNING.has(j.status)).length,
    copies: jobs.filter((j) => j.worktree && fs.existsSync(j.worktree)).length,
  };
}

export async function uninstall(root) {
  const bytes = dataSize(root);
  const left = [];
  const watcher = readJson(path.join(root, 'pr-watch.json'), null);
  if (watcher?.pid) killTree(watcher.pid);
  for (const job of jobsIn(root).filter((j) => RUNNING.has(j.status))) {
    await cancel(root, job.id).catch((e) => left.push(`job ${job.id}: ${e.message}`));
  }
  const repos = new Set();
  for (const job of jobsIn(root)) {
    if (!job.worktree || !job.repoRoot || !fs.existsSync(job.worktree)) continue;
    // Podium's scratch branch goes with its copy; a branch the agent committed to stays.
    await removeWorktree(job.repoRoot, job.worktree, job.committed ? null : job.branch).catch((e) => left.push(`${job.worktree}: ${e.message}`));
    repos.add(job.repoRoot);
  }
  for (const repo of repos) await pruneWorktrees(repo);
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch (e) {
    left.push(`${root}: ${e.message}`);
  }
  return { removed: !fs.existsSync(root) && left.length === 0, bytes, left };
}
