import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJsonAtomic } from './fsutil.js';
import { newJobId } from './ids.js';
import { PodiumError } from './errors.js';

export const TERMINAL = new Set(['done', 'needs-review', 'failed', 'cancelled', 'lost', 'kept', 'discarded', 'continued', 'in-review', 'merged', 'closed']);

const jobsRoot = (root) => path.join(root, 'jobs');
const isDir = (p) => fs.existsSync(p) && fs.statSync(p).isDirectory();

export function jobDir(root, job) {
  return path.join(jobsRoot(root), job.project, job.ticket, job.id);
}

export function appendLog(root, project, entry) {
  const file = path.join(jobsRoot(root), project, 'log.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
}

function titleOf(prompt) {
  const line = String(prompt).split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? 'Untitled job';
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

export function createJob(root, { project, ticket, agent, model = null, permission, cwd, prompt, now = new Date() }) {
  const job = {
    id: newJobId(now), title: titleOf(prompt), project, ticket, agent, model, permission, cwd,
    status: 'queued', createdAt: now.toISOString(), startedAt: null, endedAt: null, exitCode: null,
    runnerPid: null, agentPid: null, repoRoot: null, worktree: null, branch: null, baseCommit: null,
    hasChanges: false, includedUncommitted: false, delivered: false, outcome: null, outcomeSource: null, error: null,
    threadId: null, step: 1, followUpOf: null, agentSession: null, resumeFrom: null,
  };
  job.threadId = job.id;
  const dir = jobDir(root, job);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'prompt.md'), prompt);
  writeJsonAtomic(path.join(dir, 'job.json'), job);
  appendLog(root, project, { jobId: job.id, event: 'created', agent, ticket, permission, model });
  return { job, dir };
}

export function readJob(dir) {
  return readJson(path.join(dir, 'job.json'));
}

const LOGGED = ['status', 'exitCode', 'outcome', 'outcomeSource', 'error', 'hasChanges'];

export function updateJob(root, dir, patch, event) {
  const job = { ...readJob(dir), ...patch };
  writeJsonAtomic(path.join(dir, 'job.json'), job);
  if (event) {
    const fields = Object.fromEntries(LOGGED.filter((k) => k in patch).map((k) => [k, patch[k]]));
    appendLog(root, job.project, { jobId: job.id, event, ...fields });
  }
  return job;
}

export function listJobDirs(root, { project, ticket } = {}) {
  const base = jobsRoot(root);
  if (!isDir(base)) return [];
  const dirs = [];
  for (const p of project ? [project] : fs.readdirSync(base)) {
    const pdir = path.join(base, p);
    if (!isDir(pdir)) continue;
    for (const t of ticket ? [ticket] : fs.readdirSync(pdir)) {
      const tdir = path.join(pdir, t);
      if (!isDir(tdir)) continue;
      for (const id of fs.readdirSync(tdir)) {
        const d = path.join(tdir, id);
        if (fs.existsSync(path.join(d, 'job.json'))) dirs.push(d);
      }
    }
  }
  return dirs.sort((a, b) => path.basename(b).localeCompare(path.basename(a)));
}

export function findJobDir(root, id) {
  const found = listJobDirs(root).find((d) => path.basename(d) === id);
  if (!found) throw new PodiumError('job-not-found', `No job with id "${id}".`);
  return found;
}
