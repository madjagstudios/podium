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

// A result of several lines goes in a fence longer than any it holds: cut from the end of an output, it may open a code
// block it never closes, and everything after it (the new request) would read as code.
function quoted(text) {
  if (!text.includes('\n')) return text;
  const fence = '`'.repeat([...text.matchAll(/`+/g)].reduce((n, m) => Math.max(n, m[0].length + 1), 3));
  return `\n${fence}\n${text}\n${fence}`;
}

export function contextBrief(steps, lastSummary, request) {
  const n = steps.length + 1;
  return [
    `You are continuing work that is already in this folder (step ${n} of a task).`,
    'Earlier steps:',
    ...steps.map((s) => `${s.step ?? 1}. ${s.agent}: ${s.title}`),
    `Result of the last step: ${lastSummary && lastSummary.trim() ? quoted(lastSummary.trim()) : 'no summary'}`,
    'Its changes are already in the files here. Now:',
    request,
  ].join('\n');
}
