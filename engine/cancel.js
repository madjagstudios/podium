import { findJobDir, readJob, updateJob } from './store.js';
import { outcomePatch } from './outcome.js';
import { killTree } from './launch.js';
import { PodiumError } from './errors.js';

export async function cancel(root, id) {
  const dir = findJobDir(root, id);
  const job = readJob(dir);
  if (!['queued', 'running'].includes(job.status)) {
    throw new PodiumError('not-running', `Job ${id} is not running (it is ${job.status}).`);
  }
  // Record the cancel first so the runner, if it finishes meanwhile, leaves it alone.
  const updated = updateJob(root, dir, { status: 'cancelled', endedAt: new Date().toISOString(), ...(outcomePatch(job, 'unknown', 'auto') ?? {}) }, 'cancelled');
  killTree(job.agentPid);
  killTree(job.runnerPid);
  return updated;
}
