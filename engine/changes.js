// Reads a job's changes (diff.patch, or a sprint step's commit range) into per-file counts and hunks for the pane's review screen.
import fs from 'node:fs';
import path from 'node:path';
import { findJobDir, readJob } from './store.js';
import { gitIn } from './worktree.js';

export const PATCH_LINE_LIMIT = 400;

export function parsePatch(text, { limit = PATCH_LINE_LIMIT } = {}) {
  const files = [];
  let cur = null;
  for (const line of String(text ?? '').split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      cur = { path: m ? m[2] : line.slice('diff --git '.length), added: 0, removed: 0, binary: false, inHunk: false, body: [] };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (!cur.inHunk && (line.startsWith('Binary files ') || line === 'GIT binary patch')) cur.binary = true;
    if (line.startsWith('@@')) cur.inHunk = true;
    if (!cur.inHunk) continue;
    cur.body.push(line);
    if (line.startsWith('+')) cur.added++;
    else if (line.startsWith('-')) cur.removed++;
  }
  const out = files.map((f) => {
    while (f.body.length && f.body[f.body.length - 1] === '') f.body.pop();
    const isTruncated = f.body.length > limit;
    return {
      path: f.path,
      added: f.binary ? null : f.added,
      removed: f.binary ? null : f.removed,
      patch: f.binary ? '' : f.body.slice(0, limit).join('\n'),
      isTruncated,
    };
  });
  return {
    files: out,
    added: out.reduce((n, f) => n + (f.added ?? 0), 0),
    removed: out.reduce((n, f) => n + (f.removed ?? 0), 0),
  };
}

export function changeSummary(text) {
  const r = parsePatch(text, { limit: 0 });
  return { files: r.files.length, added: r.added, removed: r.removed };
}

// A sprint step's changes are the commits from its base to where its work ends: the checkpoint the sprint
// recorded, or else the agent's own commit (an agent that committed leaves diff.patch empty). The
// range never moves, so the step shows what its reviewer saw. Anything else, or a range git no longer has,
// reads diff.patch.
async function stepPatch(job) {
  const to = job.sprint && job.baseCommit ? (job.checkpoint ?? job.committed?.head ?? null) : null;
  if (!to) return null;
  const where = [job.worktree, job.repoRoot].filter((d) => d && fs.existsSync(d));
  for (const cwd of where) {
    try {
      return await gitIn(cwd, ['diff', '--no-color', '--no-ext-diff', job.baseCommit, to]);
    } catch { /* try the next folder, then diff.patch */ }
  }
  return null;
}

export async function changes(root, id, { full = false } = {}) {
  const dir = findJobDir(root, id);
  const limit = full ? Infinity : PATCH_LINE_LIMIT;
  const fromRange = await stepPatch(readJob(dir));
  if (fromRange !== null) return parsePatch(fromRange, { limit });
  const file = path.join(dir, 'diff.patch');
  if (!fs.existsSync(file)) return { files: [], added: 0, removed: 0 };
  return parsePatch(fs.readFileSync(file, 'utf8'), { limit });
}
