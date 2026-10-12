// Threads: a follow-up continues an earlier job in the same copy.
import { listJobDirs, readJob } from './store.js';

export function threadIdOf(job) {
  return job.threadId ?? job.id;
}

export function threadSteps(root, job) {
  const id = threadIdOf(job);
  return listJobDirs(root, { project: job.project })
    .map(readJob)
    .filter((j) => threadIdOf(j) === id && j.kind !== 'review')
    .sort((a, b) => (a.step ?? 1) - (b.step ?? 1));
}

export function contextBrief(steps, lastSummary, request) {
  const n = steps.length + 1;
  return [
    `You are continuing work that is already in this folder (step ${n} of a task).`,
    'Earlier steps:',
    ...steps.map((s) => `${s.step ?? 1}. ${s.agent}: ${s.title}`),
    `Result of the last step: ${lastSummary && lastSummary.trim() ? lastSummary.trim() : 'no summary'}`,
    'Its changes are already in the files here. Now:',
    request,
  ].join('\n');
}
