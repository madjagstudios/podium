import path from 'node:path';
import { findJobDir, readJob, updateJob } from './store.js';
import { applyPatch, removeWorktree, committedWork } from './worktree.js';
import { outcomePatch } from './outcome.js';
import { PodiumError, sprintJobError } from './errors.js';

async function agentCommits(job) {
  if (job.committed) return job.committed;
  if (!job.worktree || !job.baseCommit || !job.branch) return null;
  return committedWork(job.worktree, { baseCommit: job.baseCommit, branch: job.branch }).catch(() => null);
}

export async function keep(root, id) {
  const dir = findJobDir(root, id);
  const job = readJob(dir);
  if (job.sprint) throw sprintJobError();
  if (job.pr && job.pr.state === 'OPEN') throw new PodiumError('pr-open', `This work is PR #${job.pr.number}: push follow-ups to it, or close the PR on GitHub.`);
  const work = await agentCommits(job);
  if (work) {
    throw new PodiumError('committed-work', `The agent committed its work to ${work.branch ?? 'a detached HEAD'}. There is nothing to keep: the commits are already there.${job.worktree ? " Throw away Podium's copy when you're done." : ''}`);
  }
  if (job.status !== 'needs-review') throw new PodiumError('nothing-to-keep', `Job ${id} has no changes waiting for review.`);
  const applied = await applyPatch(job.repoRoot, path.join(dir, 'diff.patch'));
  if (!applied.applied) {
    updateJob(root, dir, { error: `Can't merge cleanly: ${applied.error}` }, 'keep-failed');
    throw new PodiumError('merge-conflict', `Can't merge cleanly. Your files are untouched, and the agent's copy is kept at ${job.worktree}.`, { gitError: applied.error });
  }
  await removeWorktree(job.repoRoot, job.worktree, job.branch);
  return updateJob(root, dir, { status: 'kept', error: null, ...(outcomePatch(job, 'used', 'auto') ?? {}) }, 'kept');
}

export async function discard(root, id) {
  const dir = findJobDir(root, id);
  const job = readJob(dir);
  if (job.sprint) throw sprintJobError();
  if (job.pr && job.pr.state === 'OPEN') throw new PodiumError('pr-open', `This work is PR #${job.pr.number}: push follow-ups to it, or close the PR on GitHub.`);
  if (!job.worktree) throw new PodiumError('nothing-to-discard', `Job ${id} has no separate copy to throw away.`);
  if (['queued', 'running'].includes(job.status)) throw new PodiumError('still-running', 'Cancel the job before throwing its changes away.');
  const work = await agentCommits(job);
  await removeWorktree(job.repoRoot, job.worktree, work && work.branch === job.branch ? null : job.branch);
  return updateJob(root, dir, { status: 'discarded', worktree: null, ...(outcomePatch(job, 'discarded', 'auto') ?? {}) }, 'discarded');
}
