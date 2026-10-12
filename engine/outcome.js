import fs from 'node:fs';
import path from 'node:path';
import { findJobDir, readJob, updateJob } from './store.js';
import { PodiumError } from './errors.js';

export const OUTCOMES = ['used', 'discarded', 'unknown'];

export function outcomePatch(job, value, source) {
  if (!OUTCOMES.includes(value)) throw new PodiumError('bad-outcome', `Outcome must be one of: ${OUTCOMES.join(', ')}.`);
  if (!['auto', 'user'].includes(source)) throw new PodiumError('bad-outcome-source', 'Outcome source must be "auto" or "user".');
  if (source === 'auto' && job.outcomeSource === 'user') return null;
  return { outcome: value, outcomeSource: source };
}

export function setOutcome(root, id, value, source) {
  const dir = findJobDir(root, id);
  const patch = outcomePatch(readJob(dir), value, source);
  return patch ? updateJob(root, dir, patch, 'outcome') : readJob(dir);
}

export function markDelivered(root, id) {
  const dir = findJobDir(root, id);
  const job = readJob(dir);
  const guess = job.status === 'done' ? outcomePatch(job, 'used', 'auto') : null;
  const updated = updateJob(root, dir, { delivered: true, ...(guess ?? {}) }, 'delivered');
  fs.rmSync(path.join(dir, 'delivery.lock'), { force: true });
  return updated;
}
