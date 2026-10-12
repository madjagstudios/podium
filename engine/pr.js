// PRs for threads. The engine commits and pushes in Podium's copy; gh does the rest.
// A thread's PR lives as job.pr on each of its work steps; the latest step's status
// becomes in-review, then merged or closed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findJobDir, readJob, updateJob, listJobDirs } from './store.js';
import { threadSteps } from './thread.js';
import { loadSettings, repoSettings } from './settings.js';
import { gitIn, removeWorktree } from './worktree.js';
import { runGh, ghJson } from './gh.js';
import { PodiumError, sprintJobError } from './errors.js';

export const WATCH_DAYS = 7;

export function slugOf(title) {
  return String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'work';
}

export function branchName(pattern, ticket, title) {
  if (!ticket || ticket === 'NO-TICKET') return `podium/${slugOf(title)}`;
  return pattern.replace('{ticket}', String(ticket).toLowerCase()).replace('{slug}', slugOf(title));
}

export function prBody(steps, summary) {
  return [
    summary && summary.trim() ? summary.trim() : 'No summary.',
    '',
    '## Steps',
    ...steps.map((s) => `${s.step ?? 1}. ${s.agent}: ${s.title}`),
  ].join('\n');
}

// The thread's work steps (reviews excluded), oldest first, and its latest step.
export function threadOf(root, job) {
  const steps = threadSteps(root, job).filter((s) => s.kind !== 'review');
  return { steps, latest: steps[steps.length - 1] };
}

// Merged is final: GitHub never changes a merged PR again, so no write, however late its answer arrives (a push that
// finishes after the merge, an OPEN or CLOSED answer sent before it), moves a merged step's status, its PR's state or
// its merge commit away. Each step is read again right before its write.
function keepMerged(dir, p) {
  let now;
  try { now = readJob(dir); } catch { return p; }
  const out = { ...p };
  if (now.status === 'merged' && 'status' in out && out.status !== 'merged') delete out.status;
  if (now.pr?.state === 'MERGED' && out.pr && out.pr.state !== 'MERGED') {
    out.pr = { ...out.pr, state: 'MERGED', mergeCommit: now.pr.mergeCommit ?? out.pr.mergeCommit ?? null };
  }
  return out;
}

// Every PR write outside a terminal transition: under the thread's lock, its patch made from the latest
// step read there (make(now)), so nothing read before the lock is written back over a merge recorded meanwhile.
export function lockedThread(root, job, make, event = 'pr', lockOpts = {}) {
  return finishLocked(root, job, async () => {
    const now = threadOf(root, readJob(findJobDir(root, job.id))).latest;
    return updateThread(root, now, make(now), {}, event);
  }, lockOpts);
}

// Write `patch` into every work step of the thread (through keepMerged); the latest also gets `latestPatch`.
export function updateThread(root, job, patch, latestPatch = {}, event = 'pr') {
  const { steps, latest } = threadOf(root, job);
  for (const s of steps) {
    const dir = findJobDir(root, s.id);
    updateJob(root, dir, keepMerged(dir, s.id === latest.id ? { ...patch, ...latestPatch } : patch), event);
  }
  return readJob(findJobDir(root, latest.id));
}

async function defaultBranch(repo) {
  const ref = await gitIn(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).catch(() => '');
  return ref ? ref.replace(/^origin\//, '') : 'main';
}

async function freeBranch(wt, wanted) {
  for (let n = 1; ; n++) {
    const name = n === 1 ? wanted : `${wanted}-${n}`;
    const taken = await gitIn(wt, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]).then(() => true, () => false);
    if (!taken) return name;
  }
}

// watch: start the detached PR watcher (the CLI does; tests don't, so no stray process runs).
// fromSprint: only the sprint runner opens a sprint ticket's PR.
// body: a sprint ticket's own PR body; without it the body is the work's summary and steps. forcePush: null pushes
// as usual; a string replaces the remote branch only if it is still at that commit ("" = it must not exist yet), through
// --force-with-lease=<branch>:<commit>, so a branch Podium did not push is refused (a sprint ticket's squashed branch).
export async function openPr(root, id, { env = process.env, watch = false, title = null, fromSprint = false, body = null, forcePush = null, autoMerge = false } = {}) {
  // One Open PR at a time per piece of work: a second press while it runs is refused.
  const lock = path.join(findJobDir(root, id), 'pr-open.lock');
  try {
    fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const age = Date.now() - fs.statSync(lock).mtimeMs;
    if (age < 5 * 60_000) throw new PodiumError('pr-busy', 'This PR is already being opened. Give it a moment.');
    fs.writeFileSync(lock, String(process.pid));
  }
  try {
    return await openPrOnce(root, id, { env, watch, title, fromSprint, body, forcePush, autoMerge });
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

async function openPrOnce(root, id, { env, watch, title, fromSprint, body, forcePush, autoMerge }) {
  const job = readJob(findJobDir(root, id));
  const { steps, latest } = threadOf(root, job);
  if (latest.sprint && !fromSprint) throw sprintJobError();
  if (latest.pr && latest.pr.state === 'OPEN') throw new PodiumError('pr-exists', `This work already has PR #${latest.pr.number}.`);
  // A sprint's last step may be done with nothing left to commit: its checkpoints hold the work.
  const ready = latest.status === 'needs-review' || (latest.sprint && latest.status === 'done');
  if (!ready || !latest.worktree || !fs.existsSync(latest.worktree)) {
    throw new PodiumError('nothing-to-ship', 'Only work with changes waiting for review can become a PR.');
  }
  const wt = latest.worktree;
  const remote = await gitIn(wt, ['remote', 'get-url', 'origin']).catch(() => null);
  if (!remote) throw new PodiumError('no-remote', 'This repo has no "origin" remote on GitHub, so there is nowhere to open a PR.');
  const settings = loadSettings(root);
  const prTitle = title ?? steps[0].title;
  const base = latest.base ?? (await defaultBranch(latest.repoRoot));
  // A retry keeps the name it already gave the branch; a named branch (a sprint ticket's) stays as it is.
  const current = await gitIn(wt, ['branch', '--show-current']);
  const keepName = current && (current !== latest.branch || !current.startsWith('podium/'));
  const branch = keepName ? current : await freeBranch(wt, branchName(settings.branchPattern, latest.ticket, steps[0].title));
  if (branch !== current) await gitIn(wt, ['branch', '-m', branch]);
  await gitIn(wt, ['add', '-A']);
  const dirty = await gitIn(wt, ['status', '--porcelain']);
  const summaryFile = path.join(findJobDir(root, latest.id), 'summary.md');
  const summary = fs.existsSync(summaryFile) ? fs.readFileSync(summaryFile, 'utf8') : null;
  if (dirty) await gitIn(wt, ['commit', '-q', '-m', prTitle, ...(summary ? ['-m', summary.trim()] : [])]);
  await gitIn(wt, ['push', '-q', ...(forcePush === null ? [] : [`--force-with-lease=${branch}:${forcePush}`]), '-u', 'origin', branch]);
  const bodyFile = path.join(os.tmpdir(), `podium-pr-${latest.id}.md`);
  fs.writeFileSync(bodyFile, body ?? prBody(steps, summary));
  let url;
  try {
    url = (await runGh(['pr', 'create', '--title', prTitle, '--body-file', bodyFile, '--head', branch, '--base', base], { cwd: wt, env })).trim().split(/\r?\n/).pop();
  } finally {
    fs.rmSync(bodyFile, { force: true });
  }
  const number = Number(url.match(/\/pull\/(\d+)/)?.[1]);
  if (!number) throw new PodiumError('gh-failed', `gh did not return a PR link (${url}).`);
  const now = new Date();
  const pr = {
    // title: what the PR is called on GitHub (its first step), for messages about it later.
    number, url, title: prTitle, branch, base, repoRoot: latest.repoRoot, state: 'OPEN',
    checks: { total: 0, passed: 0, failed: 0, running: 0, failing: [], failedRunId: null },
    review: null, mergeable: 'UNKNOWN', comments: 0, autoMerge: Boolean(autoMerge), blocked: null, attention: null,
    openedAt: now.toISOString(), checkedAt: null, watchUntil: new Date(now.getTime() + WATCH_DAYS * 86_400_000).toISOString(),
  };
  // A sprint ticket's step stays delivered (see finishPr). Other work's grace for its own chat counts from now
  // (notifiedAt), not from when its step ended.
  const told = latest.sprint ? { delivered: true } : { delivered: false, notifiedAt: now.toISOString() };
  const opened = updateThread(root, latest, { pr, branch }, { status: 'in-review', ...told }, 'pr-opened');
  if (watch) (await import('./pr-watch.js')).ensureWatch(root);
  return opened;
}

// ---- After the PR is open: checks, merge, push ----

const PASSED = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

export function checksOf(rollup = []) {
  const c = { total: 0, passed: 0, failed: 0, running: 0, failing: [], failedRunId: null };
  for (const item of rollup) {
    c.total++;
    const name = item.name ?? item.context ?? 'check';
    const isStatus = item.__typename === 'StatusContext';
    const done = isStatus ? !['PENDING', 'EXPECTED'].includes(item.state) : item.status === 'COMPLETED';
    const ok = isStatus ? item.state === 'SUCCESS' : PASSED.has(item.conclusion);
    if (!done) c.running++;
    else if (ok) c.passed++;
    else {
      c.failed++;
      c.failing.push(name);
      c.failedRunId ??= String(item.detailsUrl ?? '').match(/\/runs\/(\d+)/)?.[1] ?? null;
    }
  }
  return c;
}

export function attentionOf(pr) {
  if (pr.blocked) return 'blocked';
  if (pr.checks.failed > 0) return 'ci-failed';
  if (pr.review === 'CHANGES_REQUESTED') return 'changes-requested';
  if (pr.mergeable === 'CONFLICTING') return 'conflict';
  return null;
}

// Safe to merge: every check passed, GitHub says mergeable, no one asked for changes.
export function mergeDecision(pr) {
  return pr.state === 'OPEN' && pr.checks.failed === 0 && pr.checks.running === 0
    && pr.mergeable === 'MERGEABLE' && pr.review !== 'CHANGES_REQUESTED' && !pr.blocked;
}

function latestOf(root, id) {
  const { latest } = threadOf(root, readJob(findJobDir(root, id)));
  if (!latest?.pr) throw new PodiumError('no-pr', 'This work has no PR.');
  return latest;
}

export async function pushPr(root, id) {
  const latest = latestOf(root, id);
  if (!latest.worktree || !fs.existsSync(latest.worktree)) throw new PodiumError('no-copy', "Podium's copy for this PR is gone.");
  await gitIn(latest.worktree, ['add', '-A']);
  if (await gitIn(latest.worktree, ['status', '--porcelain'])) await gitIn(latest.worktree, ['commit', '-q', '-m', latest.title]);
  await gitIn(latest.worktree, ['push', '-q', 'origin', latest.pr.branch]);
  // Under the thread's lock, so a push that finishes after the merge can't bring it back to in-review (keepMerged).
  return finishLocked(root, latest, async () => updateThread(root, latest, {}, { status: 'in-review', hasChanges: false }, 'pr-pushed'));
}

// Say a sprint ticket's PR news in its sprint's messages, once per key (e.g. "pr:12:merged"). sprint.js imports this
// file, so it is loaded here when needed. True when the news is done with: said, said already, or dropped because the
// sprint is gone or archived. False when it should be told again later: the sprint is busy for waitMs, its state can't be
// read, or any other error; an unexpected error goes to the step's stderr.log (or stderr without a dir). `say` is
// injectable.
const TELL_WAIT_MS = 5000;
export async function tellSprint(root, id, text, { dir = null, waitMs = TELL_WAIT_MS, say = null, key = null } = {}) {
  try {
    const sayTo = say ?? (await import('./sprint.js')).sayTo;
    await sayTo(root, id, text, { waitMs, key });
    return true;
  } catch (e) {
    // Not found with the sprint's folder itself absent: gone, so the news is dropped. With the folder there (state files
    // missing, being written or moved aside), it is kept for later.
    if (e?.code === 'sprint-not-found' && (await import('./sprint.js')).sprintFolderGone(root, id)) return true;
    if (e?.code !== 'sprint-busy' && e?.code !== 'sprint-not-found') {
      const line = `\nPodium couldn't tell sprint ${id} its news (${text}): ${e?.message ?? e}\n`;
      try {
        if (dir) fs.appendFileSync(path.join(dir, 'stderr.log'), line);
        else process.stderr.write(line);
      } catch { /* nowhere left to record it */ }
    }
    return false;
  }
}

// One terminal transition at a time per thread: the watcher and the pane (or the CLI) may both find a PR merged,
// each from a snapshot read before it asked GitHub. A short lock file in the thread's first step's folder serialises them;
// inside it the latest step is read again, so only the first records the outcome and tells the sprint. A lock older than
// FINISH_STALE_MS belonged to a process that died; one held longer than FINISH_WAIT_MS is a busy PR (try again). A lock
// that can't be read as one (empty, or cut short by a crash mid-write) is aged by its file's time instead, so it is
// reclaimed once that is as old as a stale lock (else it is never reclaimed, and every later end is pr-busy).
// Exported for tests (waitMs, staleMs).
export const FINISH_LOCK = 'pr-finish.lock';
let FINISH_STALE_MS = 120_000;
let FINISH_WAIT_MS = 30_000;
// Tests only: shorter lock timings, so a test can make two finishers overlap (a holder whose lock is taken for stale).
export function setFinishTimings({ staleMs = 120_000, waitMs = 30_000 } = {}) {
  FINISH_STALE_MS = staleMs;
  FINISH_WAIT_MS = waitMs;
}
// A stat that fails for any reason but "gone" (EACCES, EPERM: a scanner or permission blip) leaves the lock's age unknown:
// it is never taken for stale, and the wait goes on as for a held lock, sleeping and keeping to the deadline.
// statFn is a test seam.
export async function finishLocked(root, job, fn, { waitMs = FINISH_WAIT_MS, staleMs = FINISH_STALE_MS, statFn = fs.statSync } = {}) {
  const file = path.join(findJobDir(root, threadOf(root, job).steps[0].id), FINISH_LOCK);
  const token = `${process.pid}:${Date.now()}:${Math.random()}`;
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      fs.writeFileSync(file, JSON.stringify({ token, at: Date.now() }), { flag: 'wx' });
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // When it was taken: its own "at", else (unreadable) its file's time. Gone meanwhile: try again at once.
      let at = null;
      try {
        const held = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (Number.isFinite(held?.at)) at = held.at;
      } catch { /* empty or cut short: aged by its file's time below */ }
      if (at === null) {
        try {
          at = statFn(file).mtimeMs;
        } catch (err) {
          // Gone meanwhile: take it at once. Any other failure: its age is unknown, so wait like a held lock.
          if (err?.code === 'ENOENT') continue;
        }
      }
      if (at !== null && Date.now() - at > staleMs) { fs.rmSync(file, { force: true }); continue; }
      if (Date.now() > until) throw new PodiumError('pr-busy', 'This PR is being updated. Try again in a moment.');
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  // The holder keeps its lock fresh while it works (a finisher held up past the stale time, removing a copy,
  // could lose its lock to another and then tell stale news). Only a holder that died lets its lock go stale. A refresh that fails
  // is tried again on the next beat.
  const beat = setInterval(() => {
    try {
      if (JSON.parse(fs.readFileSync(file, 'utf8')).token === token) fs.writeFileSync(file, JSON.stringify({ token, at: Date.now() }));
    } catch { /* next beat */ }
  }, Math.max(10, Math.floor(staleMs / 4)));
  beat.unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(beat);
    try { if (JSON.parse(fs.readFileSync(file, 'utf8')).token === token) fs.rmSync(file, { force: true }); } catch { /* gone already */ }
  }
}

// A sprint step's PR-end news: its text and its key in the sprint's messages (pr:<n>:merged|closed).
export function prEndNews(job, pr = job.pr, status = job.status) {
  return { key: `pr:${pr.number}:${status}`, text: `${pr.title ?? job.title} (PR #${pr.number}) ${status === 'merged' ? 'merged' : 'was closed without merging'}.` };
}

// A sprint step's outbox: the PR-end events its sprint couldn't take yet, oldest first, each key once, as
// `sprintNews: [{ key, text }]` (null when empty). Two shapes written by earlier versions are read too: a single
// { key, text } and { [key]: text }. Anything else is no news.
export function sprintNewsOf(job) {
  const n = job?.sprintNews;
  if (!n || typeof n !== 'object') return [];
  const list = Array.isArray(n) ? n : typeof n.key === 'string' ? [n] : Object.entries(n).map(([key, text]) => ({ key, text }));
  const seen = new Set();
  return list
    .filter((x) => x && typeof x.key === 'string' && typeof x.text === 'string' && !seen.has(x.key) && seen.add(x.key))
    .map(({ key, text }) => ({ key, text }));
}
const outbox = (list) => ({ sprintNews: list.length ? list : null });

// Merged or closed: the copy goes and the outcome is recorded. A plain job's latest step carries the notice for its chat.
// A sprint step's PR-end news has one channel, its sprint's messages (tellSprint, once per key pr:<n>:<status>), so its
// outcome is always recorded `delivered: true`. News the sprint can't take now (busy, unreadable) is added to the step's
// outbox beside any other key there, for flushSprintNews; news for a sprint that is gone or archived is dropped.
async function finishPr(root, snapshot, pr) {
  const status = pr.state === 'MERGED' ? 'merged' : 'closed';
  return finishLocked(root, snapshot, async () => {
    // Read again under the lock: another caller may have recorded it since this one's snapshot.
    const latest = latestOf(root, snapshot.id);
    // Same outcome already recorded (the watcher and the pane both found it merged): nothing more is said or changed. A
    // different outcome (closed, then reopened and merged) is still recorded, but a merged step stays merged: a CLOSED answer
    // that arrives late is ignored.
    if (latest.status === status || latest.status === 'merged') return latest;
    if (latest.worktree && fs.existsSync(latest.worktree)) {
      await removeWorktree(pr.repoRoot, latest.worktree, pr.branch).catch(() => {});
      // Removing a copy can take a while: the outcome is checked again before any news is told.
      const now = readJob(findJobDir(root, latest.id));
      if (now.status === status || now.status === 'merged') return now;
    }
    // The sprint is told before the thread records the outcome, on purpose: a crash between the two tells it again on the
    // next refresh rather than losing it, and the event's key (pr:<n>:<status>) keeps the sprint from saying it twice.
    // Keys still in the step's outbox are older events (closed, before this merge): they are told first, in order, so this
    // one never overtakes them, and the pass stops at the first the sprint can't take.
    const news = latest.sprint ? prEndNews(latest, pr, status) : null;
    const done = [];
    if (news) {
      const dir = findJobDir(root, latest.id);
      for (const n of [...sprintNewsOf(latest).filter((x) => x.key !== news.key), news]) {
        if (!(await tellSprint(root, latest.sprint.id, n.text, { dir, key: n.key }))) break;
        done.push(n.key);
      }
    }
    // Right before the write: another finisher (an overlapping holder) may have recorded it meanwhile; its write stands.
    const fresh = readJob(findJobDir(root, latest.id));
    if (fresh.status === status || fresh.status === 'merged') return fresh;
    if (!news) return updateThread(root, latest, { pr, worktree: null }, { status, delivered: false, notifiedAt: new Date().toISOString() }, status);
    // The outbox as it is now, under the lock: this event is added after the keys already there, and only the keys told or
    // dropped just now are removed.
    const left = [...sprintNewsOf(fresh).filter((n) => n.key !== news.key), news].filter((n) => !done.includes(n.key));
    return updateThread(root, latest, { pr, worktree: null }, { status, delivered: true, ...outbox(left) }, status);
  });
}

// Hands the news steps kept in their outboxes (see finishPr) to their sprints, oldest first. A sprint that can't take one
// now stops that step's pass there, so later keys never overtake it. Only the keys handed over or dropped are removed,
// under the thread's lock from job.json read again there, so an overlapping flush or finisher never loses or brings back
// a key. Best effort, with short waits. Looks through the project's jobs (all, without one); answers how many it handed
// over or dropped.
export async function flushSprintNews(root, { project, waitMs = 500, lockWaitMs = 6000 } = {}) {
  const pending = listJobDirs(root, { project }).map((d) => { try { return readJob(d); } catch { return null; } })
    .filter((j) => j?.sprint && sprintNewsOf(j).length);
  let handed = 0;
  for (const j of pending) {
    const dir = findJobDir(root, j.id);
    const done = [];
    for (const n of sprintNewsOf(j)) {
      if (!(await tellSprint(root, j.sprint.id, n.text, { dir, waitMs, key: n.key }))) break;
      done.push(n.key);
    }
    if (!done.length) continue;
    try {
      await finishLocked(root, j, async () => {
        const now = readJob(dir);
        const before = sprintNewsOf(now);
        const left = before.filter((n) => !done.includes(n.key));
        // Written when a key goes, or to store an earlier version's shape as a list.
        if (left.length !== before.length || (now.sprintNews && !Array.isArray(now.sprintNews))) updateJob(root, dir, outbox(left), 'sprint-news');
      }, { waitMs: lockWaitMs });
      handed += done.length;
    } catch { /* the PR is busy: these keys are said already, so the next flush finds them said and removes them */ }
  }
  return handed;
}

export async function refreshPr(root, id, { env = process.env } = {}) {
  const latest = latestOf(root, id);
  const v = JSON.parse(await runGh(['pr', 'view', String(latest.pr.number), '--json', 'state,mergeable,reviewDecision,statusCheckRollup,comments,reviews,mergeCommit'], { cwd: latest.pr.repoRoot, env }));
  const pr = {
    ...latest.pr,
    state: v.state,
    mergeable: v.mergeable ?? 'UNKNOWN',
    review: v.reviewDecision || null,
    checks: checksOf(v.statusCheckRollup ?? []),
    comments: (v.comments?.length ?? 0) + (v.reviews?.length ?? 0),
    checkedAt: new Date().toISOString(),
    // The commit the merge made on the base: a dependant starts only from a fetch that has it.
    mergeCommit: v.mergeCommit?.oid ?? latest.pr.mergeCommit ?? null,
  };
  pr.attention = attentionOf(pr);
  if (pr.state === 'MERGED' || pr.state === 'CLOSED') return finishPr(root, latest, pr);
  // Under the thread's lock, so a late OPEN answer can't land in the middle of a merge being recorded.
  const { state, mergeable, review, checks, comments, checkedAt, mergeCommit } = pr;
  return lockedThread(root, latest, (now) => {
    const next = { ...now.pr, state, mergeable, review, checks, comments, checkedAt, mergeCommit: mergeCommit ?? now.pr.mergeCommit ?? null };
    next.attention = attentionOf(next);
    return { pr: next };
  });
}

const METHOD_ORDER = ['squash', 'merge', 'rebase'];
const ALLOWED_FIELD = { squash: 'squashMergeAllowed', merge: 'mergeCommitAllowed', rebase: 'rebaseMergeAllowed' };

// How a PR merges: the repo's own method in Podium (repoMergeMethod), else the repo's default on GitHub, else
// Podium's mergeMethod. One the repo does not allow gives way to the first it does, in the order squash, merge, rebase.
export function pickMethod(settings, job) {
  const methods = job.pr?.methods ?? null;
  const fromRepo = String(methods?.viewerDefaultMergeMethod ?? '').toLowerCase();
  const wanted = repoSettings(settings, job.project).mergeMethod ?? (METHOD_ORDER.includes(fromRepo) ? fromRepo : settings.mergeMethod);
  const allowed = methods ? METHOD_ORDER.filter((m) => methods[ALLOWED_FIELD[m]] === true) : [];
  return !allowed.length || allowed.includes(wanted) ? wanted : allowed[0];
}

// GitHub's merge settings for the PR's repo, or null when it can't say.
async function repoMethods(latest, env) {
  try {
    return await ghJson(['repo', 'view', '--json', 'viewerDefaultMergeMethod,mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed'], { cwd: latest.pr.repoRoot, env });
  } catch {
    return null;
  }
}

export async function mergePr(root, id, { env = process.env } = {}) {
  let latest = latestOf(root, id);
  // Asked once per PR and kept on its record.
  if (!latest.pr.methods) {
    const methods = await repoMethods(latest, env);
    if (methods) latest = await lockedThread(root, latest, (now) => ({ pr: { ...now.pr, methods } }));
  }
  const method = pickMethod(loadSettings(root), latest);
  try {
    await runGh(['pr', 'merge', String(latest.pr.number), `--${method}`], { cwd: latest.pr.repoRoot, env });
  } catch (e) {
    // Never forced: GitHub's reason goes on the card, and the PR waits.
    return lockedThread(root, latest, (now) => {
      const pr = { ...now.pr, blocked: e.message };
      pr.attention = attentionOf(pr);
      return { pr };
    });
  }
  await gitIn(latest.pr.repoRoot, ['push', '-q', 'origin', '--delete', latest.pr.branch]).catch(() => {});
  return finishPr(root, latest, { ...latest.pr, state: 'MERGED', blocked: null, attention: null });
}

function autoMergePatch(now, on) {
  const pr = { ...now.pr, autoMerge: Boolean(on), blocked: on ? null : now.pr.blocked };
  pr.attention = attentionOf(pr);
  return { pr };
}

// waitMs: how long to wait for the PR's lock (a sprint tick, holding its sprint's lock, waits briefly).
export function setAutoMerge(root, id, on, { waitMs } = {}) {
  const latest = latestOf(root, id);
  return lockedThread(root, latest, (now) => autoMergePatch(now, on), 'pr', waitMs === undefined ? {} : { waitMs });
}

export function watchAgain(root, id) {
  const latest = latestOf(root, id);
  return lockedThread(root, latest, (now) => ({ pr: { ...now.pr, watching: true, watchUntil: new Date(Date.now() + WATCH_DAYS * 86_400_000).toISOString() } }));
}

// Open on GitHub: the PR's page in the person's browser, through gh. Read-only: no job or PR record changes.
export async function browsePr(root, id, { env = process.env } = {}) {
  const latest = latestOf(root, id);
  await runGh(['pr', 'view', String(latest.pr.number), '--web'], { cwd: latest.pr.repoRoot, env });
  return { opened: latest.pr.url };
}

// ---- Reviews of any PR ----

export function reviewPrompt(info, extra) {
  return [
    `Review PR #${info.number}: ${info.title}`,
    info.body && info.body.trim() ? `\nDescription:\n${info.body.trim()}` : '',
    `\nThis folder is the PR's code. See its changes with: git diff origin/${info.baseRefName}...HEAD`,
    'Do not change any files. Report findings ranked by severity (high, medium, low), each with file:line and one or two sentences.',
    'End with one line saying whether it looks ready to merge.',
    extra && extra.trim() ? `\nThe person asked you to also: ${extra.trim()}` : '',
  ].filter(Boolean).join('\n');
}

export async function postReview(root, id, { env = process.env } = {}) {
  const dir = findJobDir(root, id);
  const job = readJob(dir);
  if (job.kind !== 'review') throw new PodiumError('not-a-review', 'Only a review can be posted to a PR.');
  if (job.posted) throw new PodiumError('already-posted', 'This review is already on the PR.');
  const file = path.join(dir, 'output.md');
  const output = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '';
  const label = job.agent.charAt(0).toUpperCase() + job.agent.slice(1);
  const bodyFile = path.join(os.tmpdir(), `podium-review-${id}.md`);
  fs.writeFileSync(bodyFile, `**${label} review**\n\n${output || 'No findings.'}`);
  try {
    await runGh(['pr', 'review', String(job.reviewOf.number), '--comment', '--body-file', bodyFile], { cwd: job.repoRoot ?? job.cwd, env });
  } finally {
    fs.rmSync(bodyFile, { force: true });
  }
  return updateJob(root, dir, { posted: true }, 'review-posted');
}

// ---- What to send an agent when a PR needs fixing (pre-fills the form; nothing runs) ----

const LOG_LINES = 200;
const FENCE = '```';

export async function fixPrompt(root, id, kind, { env = process.env } = {}) {
  if (!['ci', 'comments'].includes(kind)) throw new PodiumError('bad-kind', 'Use --kind ci or --kind comments.');
  const latest = latestOf(root, id);
  const pr = latest.pr;
  const cwd = pr.repoRoot;
  if (kind === 'ci') {
    if (!pr.checks.failedRunId) throw new PodiumError('no-failure', 'No failed check with a log was found.');
    const log = await runGh(['run', 'view', pr.checks.failedRunId, '--log-failed'], { cwd, env });
    const tail = log.trimEnd().split(/\r?\n/).slice(-LOG_LINES).join('\n');
    return { text: `CI failed on PR #${pr.number} (${pr.checks.failing.join(', ')}). Fix the cause, keep the change small, and run the tests. The last ${LOG_LINES} lines of the failed log:\n\n${FENCE}\n${tail}\n${FENCE}` };
  }
  const repo = (await ghJson(['repo', 'view', '--json', 'nameWithOwner'], { cwd, env })).nameWithOwner;
  const inline = await ghJson(['api', `repos/${repo}/pulls/${pr.number}/comments`], { cwd, env });
  const reviews = (await ghJson(['pr', 'view', String(pr.number), '--json', 'reviews'], { cwd, env })).reviews ?? [];
  const lines = [
    ...inline.map((c) => `- ${c.path}:${c.line ?? c.original_line ?? '?'} (${c.user?.login ?? 'someone'}): ${String(c.body).trim()}`),
    ...reviews.filter((r) => r.body && r.body.trim()).map((r) => `- ${r.author?.login ?? 'someone'}: ${r.body.trim()}`),
  ];
  if (!lines.length) throw new PodiumError('no-comments', 'There are no review comments on this PR.');
  return { text: `Address the review comments on PR #${pr.number}. Change only what they ask for:\n\n${lines.join('\n')}` };
}
