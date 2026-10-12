// Sprints: several tickets, each worked task by task in its own copy, with a
// reviewer agent between tasks; every ticket ends as a PR. State lives in versioned files,
// <data>/sprints/<id>/state/<n>.json (see saveSprint), and is re-read on every tick, so a restart resumes.
// Every change goes through locked() (the runner and the person's commands both write it) and saveSprint,
// whose commit is refused if the state changed since it was loaded.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isAlive, reconcile } from './status.js';
import { readJson } from './fsutil.js';
import { newJobId } from './ids.js';
import { projectKey } from './paths.js';
import { PodiumError } from './errors.js';
import { loadSettings, repoInput, repoSettings, setRepoSettings, DEFAULT_SETTINGS, MAX_CHECK_MINUTES } from './settings.js';
import { loadAdapters } from './adapters/registry.js';
import { findJobDir, listJobDirs, readJob, updateJob } from './store.js';
import { dispatch } from './dispatch.js';
import { threadOf, openPr, setAutoMerge } from './pr.js';
import { repoRoot, resolveBase, gitIn, removeWorktree, fetchBase } from './worktree.js';
import { readOutput } from './retention.js';
import { parseTasks, verdictOf, isUsageLimit, ticketBranch, authorPrompt, fixPrompt, reviewerPrompt, planPath, planPrompt, revisePrompt, planNews, ticketPrBody, testsOf, testsParkReason, REPORT_CHARS, checkFixPrompt } from './sprint-text.js';
import { startCheck as spawnCheck, checkState, checkRunning, stopCheck } from './check.js';
import { safeArgText } from './launch.js';

const KEY = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
// A lock's holder refreshes the lock file's time every LOCK_HEARTBEAT_MS while it holds it, so a lock
// unrefreshed for LOCK_STALE_MS means a holder whose event loop has not run for that long (hung or
// suspended), not merely a long tick.
export const LOCK_STALE_MS = 10 * 60_000;
export const LOCK_HEARTBEAT_MS = 30_000;
let lockStaleMs = LOCK_STALE_MS;
let lockHeartbeatMs = LOCK_HEARTBEAT_MS;
// Tests only: shorter timings, so a slow holder can outlast the stale time within a test.
export function setLockTimings({ staleMs = LOCK_STALE_MS, heartbeatMs = LOCK_HEARTBEAT_MS } = {}) {
  lockStaleMs = staleMs;
  lockHeartbeatMs = heartbeatMs;
}
let commitHook = null;
// Tests only: runs inside saveSprint after the ownership check and right before the commit, so a test can
// suspend a writer exactly there.
export function setCommitHook(fn) {
  commitHook = fn;
}
let readHook = null;
// Tests only: runs before each read of a state file and may throw, to stand for a read error.
export function setReadHook(fn) {
  readHook = fn;
}
let hardLinks = true;
// Tests only: false makes commits (and readers) take the path for a filesystem that refuses hard links.
export function setHardLinks(on) {
  hardLinks = on;
}
const sprintsDir = (root) => path.join(root, 'sprints');
const notFound = (id) => new PodiumError('sprint-not-found', `No sprint with id "${id}".`);

// Is the sprint's own folder absent? Only that confirms a sprint is gone: sprint-not-found also comes
// from a folder whose state files are missing, which may be a state being written, moved aside or damaged. False on any
// error other than "no such file" (unsure is not gone).
export function sprintFolderGone(root, id) {
  try {
    fs.statSync(path.join(sprintsDir(root), id));
    return false;
  } catch (e) {
    return e?.code === 'ENOENT';
  }
}

// A sprint's state is one file per version: <data>/sprints/<id>/state/<n>.json, n zero-padded so names
// sort; the highest one is the current state. A save commits n+1, where n is the version its copy was
// loaded at, with an exclusive create (a hard link, which fails if the name exists): if n+1 exists,
// someone saved since this copy was read, and the save is refused. So a writer working from old state (one
// that lost the lock while suspended) can never overwrite newer state, whatever it checked beforehand.
// A commit is also refused when any higher number exists, before writing and again just after (see
// saveSprint): pruning removes old numbers, so an exclusive create alone could bring one back.
// The version a copy was loaded (or last saved) at is kept in this WeakMap, never on the object, so it is
// not written into the state and copies still compare equal. An object never loaded counts as version 0:
// a new sprint, which commits version 1. A legacy sprint (sprint.json, no state files) reads as version 0.
const versions = new WeakMap();
const KEEP_VERSIONS = 10;
// Only where hard links are refused can a reader meet a state file half written (the fallback writes in
// place). There, an empty or unparsable file this old is a write that died part-way: its number counts
// as used. Younger, it may be a write in progress: the reader waits briefly, then skips it, and a save
// from the version below is refused until it completes. With hard links a committed file is always
// complete, so an unparsable one is damage, and Podium stops rather than read an older state.
export const DEAD_WRITE_MS = 30_000;
const STATE_FILE = /^\d{12}\.json$/;
const stateDir = (root, id) => path.join(sprintsDir(root), id, 'state');
const stateFile = (dir, n) => path.join(dir, `${String(n).padStart(12, '0')}.json`);
const NO_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS']);
const changed = () => new PodiumError('sprint-busy', 'The sprint changed while Podium was saving it. Try again in a moment.');
const unreadable = () => new PodiumError('sprint-busy', 'Podium could not read the sprint\'s saved state just now. Try again in a moment.');
const damaged = (file) => new PodiumError('sprint-damaged', `The sprint's saved state ${file} is damaged (empty or not valid JSON). Podium stopped rather than go back to an older state. Move that file out of its folder to use the state saved before it.`);
const READ_RETRIES = 3;
const READ_RETRY_MS = 50;
const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// A read that fails for any reason but "no such file" (a scanner or backup holding the file, a
// permission blip) is tried again a few times, then refused as busy. It is never taken for a missing or
// half-written state: falling back to an older version would let the next save put that state back.
function retried(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return fn();
    } catch (e) {
      if (e.code === 'ENOENT') throw e;
      if (attempt >= READ_RETRIES) throw unreadable();
      wait(READ_RETRY_MS);
    }
  }
}

// Newest first.
function stateNames(dir) {
  return retried(() => {
    try { return fs.readdirSync(dir).filter((f) => STATE_FILE.test(f)).sort().reverse(); } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
  });
}
const highest = (dir) => { const [top] = stateNames(dir); return top ? Number(top.slice(0, 12)) : 0; };

// The parsed state, or null if the file read but is empty or not valid JSON. ENOENT is thrown.
function parsed(file) {
  const text = retried(() => { readHook?.(file); return fs.readFileSync(file, 'utf8'); });
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : null;
  } catch { return null; }
}
const isDead = (file) => Date.now() - retried(() => fs.statSync(file).mtimeMs) > DEAD_WRITE_MS;

// Whether commits in dir use hard links (see commit). Probed once per folder; a probe that fails for
// another reason counts as hard links, so an unparsable file is reported, never skipped.
const linkModes = new Map();
function linksWork(dir) {
  if (!hardLinks) return false;
  if (linkModes.has(dir)) return linkModes.get(dir);
  const probe = path.join(dir, `.links.${process.pid}.${randomUUID()}`);
  try {
    fs.writeFileSync(`${probe}.a.tmp`, '');
    fs.linkSync(`${probe}.a.tmp`, `${probe}.b.tmp`);
    linkModes.set(dir, true);
  } catch (e) {
    if (NO_LINKS.has(e.code) && fs.existsSync(`${probe}.a.tmp`)) linkModes.set(dir, false);
  } finally {
    for (const f of [`${probe}.a.tmp`, `${probe}.b.tmp`]) { try { fs.rmSync(f, { force: true }); } catch { /* prune removes it */ } }
  }
  return linkModes.get(dir) ?? true;
}

function readNewest(root, id, dir) {
  let used = 0;
  for (const f of stateNames(dir)) {
    const file = path.join(dir, f);
    const n = Number(f.slice(0, 12));
    let sprint = parsed(file);
    if (!sprint) {
      if (linksWork(dir)) throw damaged(file);
      for (let i = 0; !sprint && i < READ_RETRIES && !isDead(file); i++) { wait(READ_RETRY_MS); sprint = parsed(file); }
    }
    if (sprint) return { sprint, version: Math.max(n, used) };
    if (!used && isDead(file)) used = n;
  }
  const legacy = readJson(path.join(sprintsDir(root), id, 'sprint.json'), null);
  return legacy ? { sprint: legacy, version: used } : null;
}

// { sprint, version } or null. A file that vanishes while being read was pruned or withdrawn (see
// saveSprint): list the folder again.
function readState(root, id) {
  const dir = stateDir(root, id);
  for (let attempt = 0; ; attempt++) {
    try {
      return readNewest(root, id, dir);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      if (attempt >= 10) throw unreadable();
    }
  }
}

export function loadSprint(root, id) {
  const got = readState(root, id);
  if (!got) throw notFound(id);
  versions.set(got.sprint, got.version);
  return got.sprint;
}

// Commit tmp as target, exclusively. A filesystem that refuses hard links gets a create-exclusive write
// instead (still exclusive, but a reader may meet the file half written: readState allows for it).
function commit(tmp, target, json) {
  if (hardLinks) {
    try {
      fs.linkSync(tmp, target);
      return;
    } catch (e) {
      if (e.code === 'EEXIST') throw changed();
      if (!NO_LINKS.has(e.code)) throw e;
    }
  }
  try {
    fs.writeFileSync(target, json, { flag: 'wx' });
  } catch (e) {
    throw e.code === 'EEXIST' ? changed() : e;
  }
}

// Best-effort: keep the newest KEEP_VERSIONS states, and remove temp files a killed writer left.
function prune(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const f of names.filter((x) => STATE_FILE.test(x)).sort().slice(0, -KEEP_VERSIONS)) {
    try { fs.rmSync(path.join(dir, f), { force: true }); } catch { /* next save tries again */ }
  }
  for (const f of names.filter((x) => x.endsWith('.tmp'))) {
    const file = path.join(dir, f);
    try { if (Date.now() - fs.statSync(file).mtimeMs > DEAD_WRITE_MS) fs.rmSync(file, { force: true }); } catch { /* in use or gone */ }
  }
}

// Commits the next version (see above): throws sprint-busy if the sprint changed since this copy was
// loaded. Under locked(), also pass the holder's { token }: a holder whose lock has passed to another
// process is refused before it commits, so the lock's rightful holder is the one whose save goes in.
// That check is only an early exit; the exclusive commit is what makes a lost race safe.
export function saveSprint(root, sprint, { token } = {}) {
  const dir = stateDir(root, sprint.id);
  fs.mkdirSync(dir, { recursive: true });
  const next = (versions.get(sprint) ?? 0) + 1;
  // Early exit: a number at or below the highest one is obsolete.
  if (highest(dir) >= next) throw changed();
  const target = stateFile(dir, next);
  const json = JSON.stringify(sprint, null, 2) + '\n';
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, json);
  try {
    if (token !== undefined && lockTokenOf(path.join(sprintsDir(root), sprint.id, 'sprint.lock')) !== token) {
      throw new PodiumError('sprint-busy', 'The sprint is busy. Try again in a moment.');
    }
    commitHook?.();
    commit(tmp, target, json);
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* prune removes it later */ }
  }
  // The exclusive create cannot tell a free number from one pruned while this writer was delayed. If any
  // higher number exists now, the state moved on without this commit: withdraw it and refuse. A folder
  // that cannot be listed counts the same, since the commit cannot be shown to be current.
  let obsolete;
  try { obsolete = highest(dir) > next ? changed() : null; } catch (e) { obsolete = e; }
  if (obsolete) {
    try { fs.rmSync(target, { force: true }); } catch { /* below the newest, so never read; pruned later */ }
    throw obsolete;
  }
  versions.set(sprint, next);
  prune(dir);
}

// An archived sprint (every ticket merged, closed or stopped) is left out unless asked for.
export function listSprints(root, { project, includeArchived = false } = {}) {
  const dir = sprintsDir(root);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .map((id) => { try { return loadSprint(root, id); } catch { return null; } })
    .filter((s) => s && (!project || s.project === project) && (includeArchived || !s.archived))
    .sort((a, b) => b.id.localeCompare(a.id));
}

export const RECLAIM_STALE_MS = 30_000;

function lockTokenOf(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).token ?? null; } catch { return null; }
}

// The lock file holds { pid, token }. A lock is stale when its holder is gone or it is old: its holder
// has not refreshed it (see heartbeat) for the stale time. An unreadable file counts by age only. Returns what was judged stale, so a reclaimer can check
// it is still that same lock, or null.
function staleLock(file, staleMs = lockStaleMs) {
  let mtimeMs;
  try { mtimeMs = fs.statSync(file).mtimeMs; } catch { return null; }
  let held = null;
  try { held = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* unreadable: by age only */ }
  const token = typeof held?.token === 'string' ? held.token : null;
  if (Date.now() - mtimeMs > staleMs) return { token, mtimeMs };
  if (token && Number.isInteger(held.pid) && !isAlive(held.pid)) return { token, mtimeMs };
  return null;
}

function stillSame(file, judged, staleMs) {
  const now = staleLock(file, staleMs);
  if (!now) return false;
  return judged.token ? now.token === judged.token : !now.token && now.mtimeMs === judged.mtimeMs;
}

function removeAside(file) {
  const aside = `${file}.stale.${process.pid}.${randomUUID()}`;
  try { fs.renameSync(file, aside); } catch { return; }
  try { fs.rmSync(aside, { force: true }); } catch { /* leftover is harmless */ }
}

// Judging a lock stale and removing it are two steps, and between them another process may reclaim the
// same lock and take a fresh one, which a plain rename would then throw away. So reclaimers take turns
// through a short-lived mutex, and under it remove the lock only if it is still the one judged stale.
// The mutex is held for milliseconds; one left by a dead process (or older than 30 s) is moved aside.
function reclaim(file, judged) {
  const mutex = `${file}.reclaim`;
  const token = randomUUID();
  try {
    fs.writeFileSync(mutex, JSON.stringify({ pid: process.pid, token, at: Date.now() }), { flag: 'wx' });
  } catch {
    const old = staleLock(mutex, RECLAIM_STALE_MS);
    if (old) {
      // The same care for the mutex: only the stale one is moved aside, never a fresh one.
      if (stillSame(mutex, old, RECLAIM_STALE_MS)) removeAside(mutex);
    }
    return; // someone else is reclaiming, or we cleared their leftover: the caller loops
  }
  try {
    if (stillSame(file, judged, lockStaleMs)) removeAside(file);
  } finally {
    release(mutex, token);
  }
}

// While a holder works, it refreshes its lock's time so no one judges it stale; only while the lock is still ours.
function heartbeat(file, token) {
  try {
    if (lockTokenOf(file) !== token) return;
    const now = new Date();
    fs.utimesSync(file, now, now);
  } catch { /* gone or busy: the next beat tries again */ }
}

// Only remove the lock if it is still ours (it may have been reclaimed while we ran long).
function release(file, token) {
  try {
    if (JSON.parse(fs.readFileSync(file, 'utf8')).token !== token) return;
    fs.rmSync(file, { force: true });
  } catch { /* gone, replaced or unreadable: not ours to remove */ }
}

// fn gets { token }: pass it to saveSprint so a holder that lost the lock cannot write.
export async function locked(root, id, fn, { waitMs = 30_000 } = {}) {
  const dir = path.join(sprintsDir(root), id);
  if (!fs.existsSync(dir)) throw notFound(id);
  const file = path.join(dir, 'sprint.lock');
  const token = randomUUID();
  const end = Date.now() + waitMs;
  for (;;) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token }), { flag: 'wx' });
      break;
    } catch (e) {
      if (e.code === 'ENOENT') throw notFound(id);
      // Windows reports a delete-pending lock file as EPERM or EACCES: wait and retry like EEXIST.
      if (!['EEXIST', 'EPERM', 'EACCES'].includes(e.code)) throw e;
      const judged = staleLock(file);
      if (judged) reclaim(file, judged);
      if (Date.now() > end) throw new PodiumError('sprint-busy', 'The sprint is busy. Try again in a moment.');
      if (!judged) await new Promise((r) => setTimeout(r, 50));
      else await new Promise((r) => setTimeout(r, 5));
    }
  }
  const beat = setInterval(() => heartbeat(file, token), lockHeartbeatMs);
  beat.unref();
  try {
    return await fn({ token });
  } finally {
    clearInterval(beat);
    release(file, token);
  }
}

// The tracker's text for a ticket (summary) and the person's notes on a plan (revisePlan) are kept to this length.
const TEXT_CHARS = 20_000;

// A ticket as the runner first sees it: nothing run yet.
function freshTicket(fields) {
  return {
    ...fields,
    state: 'pending', task: 0, phase: null, job: null, thread: null, latest: null, start: null, startFor: null,
    fails: 0, retries: 0, reviews: 0, rounds: 0, trying: null, resume: null, reason: null, findings: null, retryAt: null, dispatching: null,
    pr: null, startedAt: null, endedAt: null,
  };
}

// A ticket's "after" as drafted: the keys of tickets in the same sprint it waits for, upper-cased, once each.
function afterOf(key, t) {
  if (t.after === undefined || t.after === null) return [];
  if (!Array.isArray(t.after)) throw new PodiumError('bad-after', `${key}'s "after" must be a list of ticket keys.`);
  return [...new Set(t.after.map((k) => String(k).toUpperCase()))];
}

// Every "after" names another ticket of the sprint, and no tickets wait for each other (none of them could start).
function checkAfter(tickets) {
  const byKey = new Map(tickets.map((t) => [t.key, t]));
  for (const t of tickets) {
    for (const k of t.after ?? []) {
      if (k === t.key) throw new PodiumError('bad-after', `${t.key} can't wait for itself.`);
      if (!byKey.has(k)) throw new PodiumError('bad-after', `${t.key} waits for ${k}, which is not in this sprint.`);
    }
  }
  const state = new Map(); // 1: being visited, 2: done
  const visit = (key, trail) => {
    if (state.get(key) === 2) return;
    if (state.get(key) === 1) {
      const loop = [...trail.slice(trail.indexOf(key)), key];
      throw new PodiumError('bad-after', `These tickets wait for each other, so none of them could start: ${loop.join(' → ')}.`);
    }
    state.set(key, 1);
    for (const k of byKey.get(key).after ?? []) visit(k, [...trail, key]);
    state.set(key, 2);
  };
  for (const t of tickets) visit(t.key, []);
}

// Each ticket makes its own branch: one that exists already would stop its first task.
async function branchesFree(repo, tickets) {
  for (const t of tickets) {
    const branch = ticketBranch(t.type, t.key, t.title);
    if (await resolveBase(repo, `refs/heads/${branch}`)) {
      throw new PodiumError('branch-taken', `${t.key}'s branch ${branch} already exists in this repo. Delete it or rename the ticket's title.`);
    }
  }
}

// A summary that only repeats the title (such as "Add a CODE_OF_CONDUCT.md." for a ticket the person
// had described) gives the planner nothing more. Compared without the key, case, spaces and punctuation.
const bareText = (text, key) => String(text ?? '').toLowerCase().split(String(key).toLowerCase()).join('').replace(/[^\p{L}\p{N}]+/gu, '');
const titleOnly = (t) => !bareText(t.summary, t.key) || bareText(t.summary, t.key) === bareText(t.title, t.key);

// Notes for Claude in the draft's answer: each plan-less ticket with only its title to plan from. A draft's
// summary can't be edited, so the way to add the person's words is to draft it again. With the settings (the CLI passes
// them), also a repo with no full check: PRs would open without one, so Claude proposes one before Start.
export function draftNotes(sprint, settings = null) {
  const notes = sprint.tickets.filter((t) => !t.plan && titleOnly(t)).map((t) => `${t.key} has only its title to plan from. If the person told you more about it, throw this draft away (action "discard") and draft it again with that text as its summary.`);
  // A check proposed with the draft counts: it is saved for the repo when the person presses Start.
  if (settings && !repoSettings(settings, sprint.project).check && !sprint.proposed?.check) {
    notes.push('This repo has no full check yet, so each ticket\'s PR would open without one. Before Start, propose one to the person: the command line that builds, tests and checks the whole repo (for example "dotnet build && dotnet test"). When they agree to it, throw this draft away (action "discard") and draft it again with check (it takes effect when they press Start), or they can set it in the Podium pane (Settings, This repo).');
  }
  return notes;
}

// A new sprint is always a draft: it is checked and saved, and nothing runs until startSprint.
// A ticket may come without a plan: its writer (agent) plans it first, and at Approve its tasks get that
// writer and its reviewer. Any ticket may carry the tracker's text for it (summary), which the planner reads.
export async function draftSprint(root, draft, { cwd, session = null, now = new Date() } = {}) {
  const tickets = Array.isArray(draft?.tickets) ? draft.tickets : [];
  if (!tickets.length) throw new PodiumError('no-tickets', 'A sprint needs at least one ticket.');
  // The repo's commands and full check, checked before anything is saved. Claude proposes them; the person
  // confirms: they stay on the draft (proposed, shown on its board) and are saved for the repo only at Start.
  const repoValues = repoInput(draft);
  const repo = await repoRoot(cwd).catch(() => null);
  if (!repo) throw new PodiumError('not-a-git-repo', 'A sprint runs in a git repo, but this folder is not in one.');
  const base = draft.base || 'main';
  if (!(await resolveBase(repo, base))) throw new PodiumError('unknown-base', `There is no branch called "${base}" in this repo.`);
  const known = loadAdapters(root).adapters;
  const seen = new Set();
  const built = tickets.map((t) => {
    const key = String(t.key ?? '').toUpperCase();
    if (!KEY.test(key)) throw new PodiumError('bad-ticket', `"${t.key}" is not a ticket key like ABC-12.`);
    if (seen.has(key)) throw new PodiumError('bad-ticket', `${key} is in the sprint twice.`);
    seen.add(key);
    const fields = { key, title: String(t.title ?? key).replace(/\s*[\r\n]+\s*/g, ' ').trim() || key, type: t.type ?? 'feat', summary: t.summary ? String(t.summary).slice(0, TEXT_CHARS) : null, after: afterOf(key, t) };
    if (!t.plan) {
      if (Array.isArray(t.tasks) && t.tasks.length) throw new PodiumError('no-such-task', `${key} has no plan yet, so its tasks can't be set. Set its writer and reviewer instead.`);
      const agent = t.agent ?? draft.agent;
      const reviewer = t.reviewer ?? draft.reviewer;
      if (!agent) throw new PodiumError('no-agent', `${key} has no plan yet and no writer to plan it.`);
      if (!reviewer) throw new PodiumError('no-agent', `${key} has no plan yet and no reviewer for its tasks.`);
      for (const name of [agent, reviewer]) {
        if (!known.has(name)) throw new PodiumError('unknown-agent', `No agent called "${name}" (${key}).`);
      }
      return freshTicket({ ...fields, plan: null, agent, reviewer, tasks: [], proposed: null, asked: null });
    }
    const file = path.resolve(repo, String(t.plan));
    const rel = path.relative(repo, file);
    const isFile = (() => { try { return fs.statSync(file).isFile(); } catch { return false; } })();
    if (rel.startsWith('..') || path.isAbsolute(rel) || !isFile) throw new PodiumError('no-plan', `${key}'s plan ${t.plan} is not in the repo.`);
    const parsed = parseTasks(fs.readFileSync(file, 'utf8'));
    if (!parsed.length) throw new PodiumError('no-tasks', `Couldn't find tasks ("### Task N:" headings) in ${key}'s plan ${t.plan}.`);
    const overrides = new Map((t.tasks ?? []).map((x) => [Number(x.n), x]));
    for (const n of overrides.keys()) {
      if (!parsed.some((task) => task.n === n)) throw new PodiumError('no-such-task', `${key} has no task ${n} in its plan.`);
    }
    const tasks = parsed.map((task) => {
      const o = overrides.get(task.n) ?? {};
      const agent = o.agent ?? t.agent ?? draft.agent;
      const reviewer = o.reviewer ?? t.reviewer ?? draft.reviewer;
      for (const [role, name] of [['agent', agent], ['reviewer', reviewer]]) {
        if (!name) throw new PodiumError('no-agent', `${key} task ${task.n} has no ${role}.`);
        if (!known.has(name)) throw new PodiumError('unknown-agent', `No agent called "${name}" (${key} task ${task.n}).`);
      }
      return { ...task, agent, reviewer };
    });
    return freshTicket({ ...fields, plan: String(t.plan), tasks });
  });
  checkAfter(built);
  await branchesFree(repo, built);
  const sprint = {
    id: newJobId(now), name: String(draft.name ?? 'Sprint'), project: projectKey(cwd), repo, base, session,
    maxParallel: Number(loadSettings(root).sprintParallel) || 3, autoMerge: draft.mergeWhenGreen === true, paused: false,
    draft: true, createdAt: now.toISOString(), startedAt: null, finishedAt: null, tickets: built, messages: [],
    proposed: Object.keys(repoValues).length ? repoValues : null,
  };
  saveSprint(root, sprint);
  return sprint;
}

const discarded = () => new PodiumError('discarded', 'This draft was thrown away.');
const notStarted = (what) => new PodiumError('not-started', `This sprint has not started yet. ${what}`);

// The draft board's changes (Discard here, the edits) are refused once a sprint has started.
function draftOnly(s) {
  if (s.discardedAt) throw discarded();
  if (!s.draft) throw new PodiumError('not-a-draft', 'This sprint has started, so this can no longer change. Pause it or stop a ticket instead.');
}

// Start a draft: check again what may have changed since it was drafted (a branch made, an agent
// removed, a writer changed on the board), then let the runner take it.
export function startSprint(root, id, { now = new Date() } = {}) {
  return change(root, id, async (s) => {
    if (s.discardedAt) throw discarded();
    if (!s.draft) throw new PodiumError('already-started', 'This sprint has already started.');
    const known = loadAdapters(root).adapters;
    for (const t of s.tickets) {
      // A ticket with no plan yet: its own writer and reviewer.
      if (!t.tasks.length) {
        for (const [role, name] of [['writer', t.agent], ['reviewer', t.reviewer]]) {
          if (!known.has(name)) throw new PodiumError('unknown-agent', `No agent called "${name}" (${t.key}'s ${role}).`);
        }
      }
      for (const x of t.tasks) {
        for (const [role, name] of [['writer', x.agent], ['reviewer', x.reviewer]]) {
          if (!known.has(name)) throw new PodiumError('unknown-agent', `No agent called "${name}" (${t.key} task ${x.n}'s ${role}).`);
        }
      }
    }
    await branchesFree(s.repo, s.tickets);
    // The commands and check proposed with the draft are saved for the repo now, before anything runs; the
    // sprint keeps what was saved (applied) so the reply can say so. (Should this save of the sprint then fail, Start
    // pressed again saves the same values.)
    if (s.proposed) Object.assign(s, { applied: setRepoSettings(root, s.project, s.proposed), proposed: null });
    Object.assign(s, { draft: false, startedAt: now.toISOString() });
  });
}

// Throw a draft away. It is archived, not deleted: the change goes through change() like every other
// (a concurrent edit is never lost), a mistaken press loses nothing on disk, and an archived sprint is
// no longer listed.
export function discardSprint(root, id, { now = new Date() } = {}) {
  return change(root, id, (s) => {
    draftOnly(s);
    // What the draft proposed for the repo goes with it: nothing was saved.
    Object.assign(s, { archived: true, discardedAt: now.toISOString(), proposed: null });
  });
}

// A sprint drafted and started at once. Only tests use it: the tool and the pane always draft first.
export async function createSprint(root, input, opts = {}) {
  const d = await draftSprint(root, input, opts);
  return startSprint(root, d.id, { now: opts.now });
}

const REVIEWING = new Set(['review', 'fix-review']);
// A ticket drafted without a plan is planned first: "plan" writes it, "revise" changes it with the person's notes.
const PLANNING = new Set(['plan', 'revise']);
// Where a written plan waits for the person: tasks found ("plan-ready"), or none ("no-tasks").
const PLAN_WAITS = new Set(['plan-ready', 'no-tasks']);
// A ticket's first step: its first task's writer, or, for a ticket with no tasks yet, the plan.
const firstStep = (t) => (t.tasks.length ? 'author' : 'plan');
// Steps that run no agent: opening the PR, saving a written plan (its checkpoint and read), and the full check.
const NO_AGENT = new Set(['pr', 'plan-save', 'check']);
// A PR that has merged or closed; a stopped ticket has no PR. One list of what has ended and one of what
// has shipped, so the sprint's finish, its archiving and its runner all agree.
const PR_ENDED = new Set(['merged', 'closed']);
const ENDED = new Set([...PR_ENDED, 'stopped']);
const SHIPPED = new Set(['pr-open', ...ENDED]);

// A pr-open ticket whose PR has since merged or closed (the PR watcher records it on the thread) reads as that.
function shippedState(root, t) {
  if (t.state !== 'pr-open' || !t.latest) return t.state;
  try {
    const { status } = threadOf(root, readJob(findJobDir(root, t.latest))).latest;
    return PR_ENDED.has(status) ? status : t.state;
  } catch {
    return t.state; // the job was pruned: keep what the sprint says
  }
}

// Tickets between steps, where the person may act; and tickets whose current task is at work or stuck.
const STUCK = new Set(['parked', 'waiting']);
const AT_WORK = new Set(['running', 'waiting', 'parked']);

// What the pane and the tool show of a sprint, the board included. A ticket whose PR merged since the last tick reads
// as merged. What the person may do now mirrors retryTicket, stopTicket, assignTask and the plan actions.
export function sprintSummary(root, s) {
  // Each ticket's state and the tickets it waits for, read once: a pending ticket's slot counts the ones ahead of it (slotOf).
  const states = s.tickets.map((t) => shippedState(root, t));
  const waitLists = s.tickets.map((t, i) => waitingOn(root, s, t, states[i]));
  let ahead = 0;
  const slots = s.tickets.map((t, i) => {
    const slot = slotOf(s, t, states[i], waitLists[i], ahead);
    if (slot && !t.dispatching) ahead++; // one being dispatched is counted by holding() already
    return slot;
  });
  return {
    id: s.id, name: s.name, draft: Boolean(s.draft), discarded: Boolean(s.discardedAt), paused: s.paused, finishedAt: s.finishedAt, autoMerge: s.autoMerge,
    maxParallel: s.maxParallel,
    // Whether the repo has a full check: without one the board warns that PRs open without it.
    check: Boolean(repoSettings(loadSettings(root), s.project).check),
    // The sprint's own chat: only it is told the sprint's news, so another chat's board says news waits for it.
    chat: s.session ?? null,
    // A draft's proposed commands and check, saved for the repo at Start: the board shows them.
    proposed: s.draft && s.proposed ? s.proposed : null,
    // Listed though archived (sprintSummaries' `finished`): a finished sprint, never live work.
    ...(s.archived ? { archived: true } : {}),
    // Messages not yet delivered: the mod asks for the sprint inbox only when some sprint has news.
    news: s.messages.filter((m) => !m.delivered).length,
    tickets: s.tickets.map((t, i) => {
      const state = states[i];
      const task = t.tasks[Math.min(t.task, t.tasks.length - 1)];
      const stuck = !s.draft && STUCK.has(state);
      const step = t.resume ?? firstStep(t);
      const planless = !t.tasks.length;
      const waits = waitLists[i];
      return {
        key: t.key, title: t.title, state, task: Math.min(t.task + 1, t.tasks.length), of: t.tasks.length, phase: t.phase,
        agent: planless ? (t.agent ?? null) : REVIEWING.has(t.phase) ? task.reviewer : task.agent,
        reason: t.reason, findings: t.findings, pr: t.pr, reviews: t.reviews,
        latest: t.latest,
        tasks: t.tasks.map((x, i) => ({
          n: x.n, title: x.title, agent: x.agent, reviewer: x.reviewer,
          status: i < t.task ? 'done' : i === t.task && AT_WORK.has(state) ? 'current' : 'to-do',
          canAssign: assignable(t, i),
        })),
        canRetry: stuck,
        // Give to another agent hands on the stuck step: a review to another reviewer, anything else (the plan
        // too) to another writer. Opening the PR and saving the plan run no agent.
        giveTo: stuck && !NO_AGENT.has(step) ? (REVIEWING.has(step) ? 'reviewer' : 'writer') : null,
        canStop: !s.draft && OPEN_STATES.has(state) && !(state === 'running' && stepBusy(root, t)),
        plan: t.plan ?? null, writer: t.agent ?? null, reviewer: t.reviewer ?? null,
        canAssignPlan: planless && OPEN_STATES.has(state) && state !== 'running',
        after: t.after ?? [], waitingOn: waits, slot: slots[i],
        proposed: state === 'plan-ready' && t.proposed ? t.proposed.map((x) => ({ n: x.n, title: x.title })) : null,
        canApprove: !s.draft && state === 'plan-ready',
        canOneTask: !s.draft && state === 'no-tasks',
        canRevise: !s.draft && mayRevise(t, state),
      };
    }),
  };
}

// The tickets a started ticket that has not begun still waits for ("after"): those it names not merged yet.
function waitingOn(root, s, t, state) {
  if (s.draft || state !== 'pending' || t.latest) return [];
  return (t.after ?? []).filter((k) => {
    const d = s.tickets.find((x) => x.key === k);
    return d && shippedState(root, d) !== 'merged';
  });
}

// Whether a pending ticket that may start finds a free slot now ("waiting for a free slot" or "starting"), counted
// as the tick counts them (holding), plus `ahead`: the pending tickets before it that may start too, since the tick starts
// them in ticket order and they take the free slots first. null for any other ticket, and while the sprint is a draft or paused.
function slotOf(s, t, state, waits, ahead = 0) {
  if (s.draft || s.paused || state !== 'pending' || waits.length) return null;
  return holding(s, t, ACTIVE) + ahead >= s.maxParallel ? 'full' : 'free';
}

// The name and project of a sprint whose state can't be read, for its card only. Any state file (or the
// legacy sprint.json) that still parses will do: neither field ever changes. Never used as state.
function sprintLabel(root, id) {
  const dir = stateDir(root, id);
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => STATE_FILE.test(f)).sort().reverse(); } catch { /* no state folder */ }
  for (const file of [...names.map((f) => path.join(dir, f)), path.join(sprintsDir(root), id, 'sprint.json')]) {
    try {
      const s = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (s && typeof s === 'object') return { name: s.name ?? null, project: s.project ?? null };
    } catch { /* unreadable too: try the next */ }
  }
  return null;
}

// The finished, archived sprints the pane is sent of each fold: FINISHED_SPRINTS (mod/view.js) + 1, this
// chat's and other chats'. tests/sprint-archive.test.js holds the two in step.
export const PANE_FINISHED = 6;

// Newest finished first, as the pane orders them (finishedSprints in mod/view.js): by finishedAt, a missing one last, ties by id.
const finishedMs = (s) => Date.parse(s.finishedAt ?? '') || 0;
const newerFinished = (a, b) => finishedMs(b) - finishedMs(a) || b.id.localeCompare(a.id);
// A bucket of the newest `max` (kept sorted, newest first) and how many were offered: one pass, never every sprint kept.
function keepNewest(bucket, s, max) {
  bucket.seen += 1;
  if (bucket.kept.length >= max && newerFinished(s, bucket.kept[bucket.kept.length - 1]) >= 0) return;
  const at = bucket.kept.findIndex((x) => newerFinished(s, x) < 0);
  bucket.kept.splice(at < 0 ? bucket.kept.length : at, 0, s);
  if (bucket.kept.length > max) bucket.kept.pop();
}

// Every sprint as the pane and the tool list it. A sprint that can't be read comes back as a card saying so, never
// left out; a momentary read failure (sprint-busy) comes back as { id, busy: true }.
// `finished: N` (the pane) also includes the newest N finished archived sprints from `session`'s chat and N from all
// other chats combined, ordered by finish time. Discarded sprints are excluded. `counts.olderFinished` counts the rest
// in each group. The sprint the open board or ticket shows (`sprint`) is included separately and counts toward neither
// group's limit or older count.
export function sprintSummaries(root, { project, includeArchived = false, id = null, finished = 0, session = null, sprint = null, counts = null } = {}) {
  const dir = sprintsDir(root);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const mine = { kept: [], seen: 0 };
  const others = { kept: [], seen: 0 };
  for (const sid of fs.readdirSync(dir)) {
    if (id && sid !== id) continue;
    try {
      const s = loadSprint(root, sid);
      if (project && s.project !== project) continue;
      if (!includeArchived && s.archived) {
        if (finished > 0 && !s.discardedAt && s.tickets.length && s.tickets.every((t) => ENDED.has(t.state))) {
          if (sprint && s.id === sprint) out.push(sprintSummary(root, s));
          else keepNewest(!session || !s.session || s.session === session ? mine : others, s, finished);
        }
        continue;
      }
      out.push(sprintSummary(root, s));
    } catch (e) {
      if (e?.code === 'sprint-not-found') continue;
      // A read that failed just now (a state file vanished mid-read) is no damage: a marker, so the pane
      // keeps its last view of the sprint instead of flashing an error card.
      if (e?.code === 'sprint-busy') { out.push({ id: sid, busy: true }); continue; }
      const label = sprintLabel(root, sid);
      if (project && label?.project && label.project !== project) continue;
      out.push({
        id: sid, name: label?.name ?? null, unreadable: e instanceof PodiumError ? String(e.message) : `Podium could not show this sprint (${firstLine(e?.message ?? e)}).`, draft: false, discarded: false,
        paused: false, finishedAt: null, autoMerge: false, maxParallel: null, news: 0, tickets: [],
      });
    }
  }
  for (const s of [...mine.kept, ...others.kept]) {
    try { out.push(sprintSummary(root, s)); } catch { /* a finished sprint that can't be summarised is simply not listed */ }
  }
  if (counts) counts.olderFinished = { mine: mine.seen - mine.kept.length, others: others.seen - others.kept.length };
  return out.sort((a, b) => b.id.localeCompare(a.id));
}

export const RETRY_MS = 15 * 60_000;
// Consecutive 15-minute waits on one step before asking the person: 24 x 15 min is about 6 hours.
export const MAX_WAITS = 24;
const ACTIVE = new Set(['running', 'waiting']);
const RUNNING = new Set(['running']);
// The tickets other than t that hold a slot: those in one of these states, and any with a step being
// dispatched (its job may exist already, so it counts until it is adopted or started again).
const holding = (sprint, t, states) => sprint.tickets.filter((x) => x !== t && (states.has(x.state) || x.dispatching)).length;
const label = (name) => name.charAt(0).toUpperCase() + name.slice(1);
// Reconciled, as the job list sees it: a step whose runner died reads as lost, so the ticket parks.
const jobOf = (root, id) => reconcile(root, findJobDir(root, id));
const clockAt = (ms) => new Date(ms).toTimeString().slice(0, 5);

function say(sprint, text, now) {
  sprint.messages.push({ id: String(sprint.messages.length + 1), at: new Date(now).toISOString(), text, delivered: false, claimedAt: null });
}

function park(sprint, t, reason, now, findings = t.findings) {
  Object.assign(t, { state: 'parked', reason, resume: t.trying, findings, job: null, retryAt: null, waits: 0, dispatching: null });
  say(sprint, `${t.key} (${t.title}) needs you: ${reason}${findings ? `\n${findings}` : ''}`, now);
}

function tail(dir, file) {
  try {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    return text.slice(-4000);
  } catch {
    return '';
  }
}

// A planning step is task 0 (the ticket has no tasks yet) and carries plan: true, which is what marks it as
// planning: a plan may number a real task 0. After the last task passes, t.task is one past the end: the full check's fix
// belongs to the last task.
const meta = (sprint, t, role, plan = false) => ({ sprint: { id: sprint.id, ticket: t.key, task: t.tasks[Math.min(t.task, t.tasks.length - 1)]?.n ?? 0, role, ...(plan ? { plan: true } : {}) }, delivered: true });

const roleOf = (phase) => (REVIEWING.has(phase) ? 'reviewer' : 'author');

// Dispatching a step and saving the sprint are two steps: a runner killed between them would leave a
// started step the sprint knows nothing about. So the intent is saved first, and the next tick adopts
// the step it finds (see adoptDispatched) instead of starting it again.
async function dispatchStep(root, t, phase, opts, args) {
  // The wall clock, not opts.now: it is compared with the job's own createdAt.
  t.dispatching = { role: roleOf(phase), task: t.task, phase, at: new Date().toISOString() };
  opts.save?.();
  try {
    return await dispatch(root, args);
  } catch (e) {
    t.dispatching = null;
    throw e;
  }
}

// Record a step that has started (or was found started).
function started(t, phase, job) {
  // Where planning began (the ticket's first step, made from the base): the plan's checkpoint is checked against it, so
  // a follow-up that undoes an earlier step's stray change counts as having changed nothing (see strayFiles).
  if (PLANNING.has(phase) && !t.latest) t.planFrom = job.baseCommit;
  // Where the ticket's copy started: its first step's base. The PR's one commit is made from here (squashTicket).
  if (!t.latest && (phase === 'author' || PLANNING.has(phase))) t.from = job.baseCommit;
  if (phase === 'author' || PLANNING.has(phase)) {
    t.thread ??= job.id;
    // start is the commit the task began from, for the review's diff. Only a task's first step sets it:
    // a step run again (a retry, a usage-limit wait) starts from HEAD, which may hold the task's own work.
    // A planning step has no review: task 1 begins from the plan's checkpoint.
    if (phase === 'author' && t.startFor !== t.task) Object.assign(t, { start: job.baseCommit, startFor: t.task });
    Object.assign(t, { latest: job.id, startedAt: t.startedAt ?? job.createdAt });
  } else if (phase === 'fix' || phase === 'check-fix') {
    t.latest = job.id;
  } else {
    t.rounds += 1;
  }
  Object.assign(t, { state: 'running', phase, job: job.id, trying: phase, dispatching: null });
}

// A step recorded as being dispatched: adopt the job it made, if any (true), or say there is none (false).
function adoptDispatched(root, sprint, t) {
  const d = t.dispatching;
  const n = PLANNING.has(d.phase) ? 0 : t.tasks[Math.min(d.task, t.tasks.length - 1)]?.n;
  const found = listJobDirs(root)
    .map((dir) => { try { return readJob(dir); } catch { return null; } })
    .filter((j) => j?.sprint && j.sprint.id === sprint.id && j.sprint.ticket === t.key && j.sprint.task === n && j.sprint.role === d.role && Boolean(j.sprint.plan) === PLANNING.has(d.phase) && j.createdAt >= d.at)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0];
  if (!found) return false;
  started(t, d.phase, found);
  return true;
}

// Where a ticket's copy starts. A ticket with no "after" branches from the local base. One that waited
// for others starts from the base as the remote has it now, with their merged work: Podium fetches it and
// branches from <remote>/<base>, never moving or checking out the local branch. Its PR still targets the base.
// A fetch that fails says so in Podium's words, whatever the step (it parks as is), with git's reason, cut short, last.
// A tick fetches at most once (opts.fetched): every ticket it starts uses that fetch, or its failure, so dependants never
// wait on the remote one after another under the sprint's lock. Which waiting tickets may use it was decided before it
// (tick's `ready`), so none starts from a fetch taken before its last dependency merged. And where a dependency's merge
// commit is known (a PR refresh records it), the fetch must hold it: GitHub can call a PR merged before a fetch sees its
// commit. { wait: true } when it does not: the ticket stays as it is and starts on a later tick, from a later fetch.
async function startFrom(root, sprint, t, opts) {
  if (!(t.after ?? []).length) return { base: sprint.base };
  let from;
  try {
    opts.fetched ??= (opts.fetchFn ?? fetchBase)(sprint.repo, sprint.base);
    from = await opts.fetched;
  } catch (e) {
    let why = firstLine(e?.message).replace(/^git \S+: /, '');
    if (why.length > 160) why = `${why.slice(0, 159)}…`;
    throw new PodiumError('fetch-failed', `Podium couldn't get the latest ${sprint.base} from ${e?.remote ?? 'its remote'}, so ${t.key} can't start yet. Retry when it can be reached. (${why})`);
  }
  for (const key of t.after) {
    const commit = mergeCommitOf(root, sprint.tickets.find((x) => x.key === key));
    if (commit && !(await holds(sprint.repo, from, commit))) return { wait: true };
  }
  return { base: sprint.base, from };
}

// The commit a merged dependency's PR made on the base, when a refresh recorded one; else null.
function mergeCommitOf(root, d) {
  if (!d?.latest || shippedState(root, d) !== 'merged') return null;
  try {
    return threadOf(root, readJob(findJobDir(root, d.latest))).latest.pr?.mergeCommit ?? null;
  } catch {
    return null;
  }
}

// Does ref hold commit? One the repo has not fetched is not held either.
async function holds(repo, ref, commit) {
  try {
    await gitIn(repo, ['merge-base', '--is-ancestor', commit, ref]);
    return true;
  } catch {
    return false;
  }
}

// A ticket that has not begun and names others it waits for.
const waitsFor = (t) => Boolean((t.after ?? []).length && !t.latest);

// "after": may a ticket that has not begun start? null: yes (it names no tickets, or every one has merged, or
// it has begun already: an approved plan or a Retry carries on). { wait: true }: some are not merged yet.
// { blocked }: one was stopped, or its PR closed without merging, so it parks and the person decides.
function afterGate(root, s, t) {
  const after = t.after ?? [];
  if (!after.length || t.latest) return null;
  const deps = after.map((k) => s.tickets.find((x) => x.key === k)).filter(Boolean);
  for (const d of deps) {
    const state = shippedState(root, d);
    if (state === 'stopped') return { blocked: `${d.key} was stopped, so this can't start; retry to start it anyway or stop it` };
    if (state === 'closed') return { blocked: `${d.key}'s PR was closed without merging, so this can't start; retry to start it anyway or stop it` };
  }
  return deps.every((d) => shippedState(root, d) === 'merged') ? null : { wait: true };
}

async function startAuthor(root, sprint, t, opts) {
  const { env } = opts;
  t.trying = 'author';
  const task = t.tasks[t.task];
  const common = { agent: task.agent, ticket: t.key, cwd: sprint.repo, session: sprint.session, env, prompt: authorPrompt(t, task), meta: meta(sprint, t, 'author') };
  const from = t.latest ? null : await startFrom(root, sprint, t, opts);
  if (from?.wait) return;
  const res = await dispatchStep(root, t, 'author', opts, t.latest
    ? { ...common, followUp: t.latest }
    : { ...common, permission: 'edit-worktree', ...from, branch: ticketBranch(t.type, t.key, t.title) });
  started(t, 'author', res.job);
}

// Step 0 of a ticket drafted without a plan: its writer writes the plan in the ticket's copy, on its
// branch. "revise" changes it with the person's notes as a follow-up, so the same agent keeps its conversation.
async function startPlan(root, sprint, t, phase, opts) {
  const { env, now } = opts;
  t.trying = phase;
  t.plan ??= planPath(t, now);
  const prompt = phase === 'revise' ? revisePrompt(t, t.asked) : planPrompt(t);
  const common = { agent: t.agent, ticket: t.key, cwd: sprint.repo, session: sprint.session, env, prompt, meta: meta(sprint, t, 'author', true) };
  const from = t.latest ? null : await startFrom(root, sprint, t, opts);
  if (from?.wait) return;
  const res = await dispatchStep(root, t, phase, opts, t.latest
    ? { ...common, followUp: t.latest }
    : { ...common, permission: 'edit-worktree', ...from, branch: ticketBranch(t.type, t.key, t.title) });
  started(t, phase, res.job);
}

async function startFix(root, sprint, t, opts) {
  const { env } = opts;
  t.trying = 'fix';
  const task = t.tasks[t.task];
  // A fix parked for its tests runs again with the reviewer's findings, kept aside while its report was shown.
  // They go back into findings before the step starts, so a later park, wait or restart of this fix still has them.
  const said = t.reviewSaid ?? t.findings;
  Object.assign(t, { findings: said, reviewSaid: null });
  const res = await dispatchStep(root, t, 'fix', opts, { agent: task.agent, ticket: t.key, cwd: sprint.repo, session: sprint.session, env, prompt: fixPrompt(t, task, said), followUp: t.latest, meta: meta(sprint, t, 'author') });
  started(t, 'fix', res.job);
}

// The writer's report for its review: its output, and what it said about its tests.
function writerReport(root, t) {
  let report = '';
  try { report = readOutput(findJobDir(root, t.latest)) ?? ''; } catch { /* the step's record is gone: no report */ }
  return { report, tests: testsOf(report) };
}

// Commit what the latest step left in the copy, and record that checkpoint on the step: nothing is left to Keep on it, and
// Steps and diff shows its work (its base commit to here) even when the agent committed.
async function checkpointWork(root, t, message) {
  const copy = jobOf(root, t.latest).worktree;
  await gitIn(copy, ['add', '-A']);
  if (await gitIn(copy, ['status', '--porcelain'])) await gitIn(copy, ['commit', '-q', '-m', message]);
  const head = await gitIn(copy, ['rev-parse', 'HEAD']);
  updateJob(root, findJobDir(root, t.latest), { status: 'done', hasChanges: false, checkpoint: head }, 'checkpointed');
  return { copy, head };
}

// Checkpoint the task's work, then hand its diff since the task began to the reviewer.
async function startReview(root, sprint, t, phase, opts) {
  const { env } = opts;
  t.trying = phase;
  const task = t.tasks[t.task];
  const { copy, head } = await checkpointWork(root, t, phase === 'review' ? `wip(${t.key}): task ${task.n} ${task.title}` : `wip(${t.key}): task ${task.n} review fixes`);
  const diff = await gitIn(copy, ['diff', t.start, head]);
  const res = await dispatchStep(root, t, phase, opts, { agent: task.reviewer, permission: 'read-only', ticket: t.key, cwd: sprint.repo, session: sprint.session, env, prompt: reviewerPrompt(t, task, diff, copy, writerReport(root, t)), meta: meta(sprint, t, 'reviewer') });
  started(t, phase, res.job);
}

// The planning step finished: checkpoint the plan, read its tasks, and wait for the person. Saving is its
// own step ("plan-save"): if the checkpoint or the read fails, Retry saves and reads again without running the
// writer, unless the plan is gone by then (see redo). No file, or an empty one, at the plan's path parks the ticket
// on the writer's step; Retry asks the writer again in the same conversation. t.phase still says which planning
// step wrote it ("plan" or "revise").
const isPlanFile = (file) => { try { return fs.statSync(file).isFile(); } catch { return false; } };

// Files a stray change names in the park reason; the rest are counted.
const STRAY_NAMED = 5;

// The files the planning steps changed besides the plan, from where planning began (planFrom; for a ticket planned
// before it was recorded, its first step's base) to the checkpoint. Renames count as both their paths.
async function strayFiles(root, t, copy, checkpoint) {
  const from = t.planFrom ?? ticketStart(root, t);
  if (!from) return [];
  const plan = t.plan.replace(/\\/g, '/');
  const out = await gitIn(copy, ['diff', '--name-only', '--no-renames', '-z', from, checkpoint]);
  return out.split('\0').filter((f) => f && f !== plan);
}

// A ticket parked because its planner changed more than the plan may be sent back with notes, like a plan waiting.
const mayRevise = (t, state = t.state) => PLAN_WAITS.has(state) || (state === 'parked' && Boolean(t.planExtra?.length));

async function planReady(root, sprint, t, opts) {
  const { now } = opts;
  t.trying = 'plan-save';
  const job = jobOf(root, t.latest);
  const copy = job.worktree;
  await gitIn(copy, ['add', '-A']);
  if (await gitIn(copy, ['status', '--porcelain'])) {
    await gitIn(copy, ['commit', '-q', '-m', t.phase === 'revise' ? `wip(${t.key}): plan changes` : `wip(${t.key}): plan`]);
  }
  const checkpoint = await gitIn(copy, ['rev-parse', 'HEAD']);
  updateJob(root, findJobDir(root, t.latest), { status: 'done', hasChanges: false, checkpoint }, 'checkpointed');
  const where = path.join(copy, t.plan);
  const writer = PLANNING.has(t.phase) ? t.phase : 'plan';
  let text;
  // A folder (or anything else that is not a file) at the plan's path is the writer's mistake, like no file at all.
  if (fs.existsSync(where) && !isPlanFile(where)) {
    t.trying = writer;
    return park(sprint, t, `${label(job.agent)} wrote a folder, not a plan file, at ${t.plan}`, now);
  }
  try { text = fs.readFileSync(where, 'utf8'); } catch (e) {
    // Only a missing file is the writer's doing; any other read error (no permission) parks with Podium's own
    // reason (guarded, plainReason) on the save step.
    if (e?.code !== 'ENOENT') throw e;
    t.trying = writer;
    return park(sprint, t, `${label(job.agent)} finished without writing the plan to ${t.plan}`, now);
  }
  // An empty plan is never one empty task.
  if (!text.trim()) {
    t.trying = writer;
    return park(sprint, t, `${label(job.agent)} wrote an empty plan to ${t.plan}`, now);
  }
  // The checkpoint holds the whole copy, and task 1's review starts after it: anything else the planner changed (or
  // committed itself) would ship unreviewed. It waits for the person instead: Ask for changes (the writer undoes it), Retry
  // (the writer plans again) or Stop.
  const stray = await strayFiles(root, t, copy, checkpoint);
  if (stray.length) {
    t.trying = writer;
    t.planExtra = stray;
    const named = stray.length > STRAY_NAMED ? `${stray.slice(0, STRAY_NAMED).join(', ')} and ${stray.length - STRAY_NAMED} more` : stray.join(', ');
    return park(sprint, t, `${label(job.agent)} changed files other than the plan: ${named}. Ask for changes to keep only the plan, or stop the ticket.`, now);
  }
  const tasks = parseTasks(text);
  // A plan changed after the person's notes says so (planNews); t.asked is cleared below.
  const asked = t.phase === 'revise' ? t.asked : null;
  Object.assign(t, {
    state: tasks.length ? 'plan-ready' : 'no-tasks', phase: null, job: null, trying: null, resume: null, waits: 0, asked: null, planExtra: null,
    reason: tasks.length ? null : "Couldn't find tasks in this plan",
    // A plan with no tasks can still run whole ("Run as one task").
    proposed: tasks.length ? tasks : [{ n: 1, title: t.title, text: text.replace(/\r\n/g, '\n').trim() }],
  });
  say(sprint, planNews(sprint.id, t, where, { asked }), now);
}

// The commit a ticket's copy started from: recorded at its first step (t.from), else its first step's base. null when
// neither can be read.
function ticketStart(root, t) {
  if (t.from) return t.from;
  try { return readJob(findJobDir(root, t.thread)).baseCommit ?? null; } catch { return null; }
}

// One commit for the PR, in the ticket's own copy: its checkpoints become `KEY: title` (the title as drafted: git is
// not run through cmd), whose body is the PR's; the checkpoints stay readable in Steps and diff until the copy goes.
// Returns null when it made no commit, else the commit the push may replace on the remote (the lease).
// Ownership: the only commit Podium may replace is the one it recorded making for this branch (t.pushed, saved before
// the push), so the lease is the remote-tracking commit only when it is that commit, else "" (the branch must not exist).
// A fetched commit's parent or subject proves nothing about who made it.
async function squashTicket(root, t, copy, body) {
  if (!copy || !fs.existsSync(copy)) return null;
  const from = ticketStart(root, t);
  if (!from) return null;
  const branch = await gitIn(copy, ['branch', '--show-current']);
  const recorded = branch && t.pushed?.branch === branch ? t.pushed.sha : null;
  const tracked = branch ? await gitIn(copy, ['rev-parse', '--verify', '-q', `refs/remotes/origin/${branch}`]).catch(() => '') : '';
  const lease = tracked && recorded && tracked === recorded ? tracked : '';
  await gitIn(copy, ['add', '-A']);
  await gitIn(copy, ['reset', '-q', '--soft', from]);
  if (!(await gitIn(copy, ['status', '--porcelain']))) return null;
  const subject = `${t.key}: ${t.title}`;
  const message = `${subject}\n\n${body}\n`;
  // The recorded commit again, when it holds exactly this tree, on this start, with this message.
  const same = recorded ? await sameCommit(copy, recorded, from, message) : false;
  if (same) {
    await gitIn(copy, ['reset', '-q', '--soft', recorded]);
  } else {
    // The message goes in through a file, exactly as written (no command line to quote or cut short, no tidying).
    const file = path.join(os.tmpdir(), `podium-squash-${randomUUID()}.txt`);
    fs.writeFileSync(file, message);
    try { await gitIn(copy, ['commit', '-q', '--cleanup=verbatim', '-F', file]); } finally { fs.rmSync(file, { force: true }); }
  }
  if (branch) t.pushed = { branch, sha: await gitIn(copy, ['rev-parse', 'HEAD']) };
  return lease;
}

// Is `sha` a commit on `from` whose tree is the index's and whose message is `message`? (Podium's own earlier squash.)
async function sameCommit(copy, sha, from, message) {
  try {
    const [parent, tree, index, said] = await Promise.all([
      gitIn(copy, ['rev-parse', '--verify', '-q', `${sha}^`]),
      gitIn(copy, ['rev-parse', '--verify', '-q', `${sha}^{tree}`]),
      gitIn(copy, ['write-tree']),
      gitIn(copy, ['cat-file', 'commit', sha]),
    ]);
    // gitIn trims what git prints, so the stored message is compared without its trailing whitespace.
    const text = said.slice(said.indexOf('\n\n') + 2);
    return parent === from && tree === index && text === message.trimEnd();
  } catch {
    return false;
  }
}

async function openTicketPr(root, sprint, t, opts) {
  const { env, watch } = opts;
  t.trying = 'pr';
  // A PR opened by an earlier tick that stopped before saving the sprint is adopted, not opened twice.
  const { latest } = threadOf(root, jobOf(root, t.latest));
  let job = latest.pr?.state === 'OPEN' ? latest : null;
  if (!job) {
    // A sprint PR: a plain body (the ticket and what changed), one commit unless the repo keeps a ticket's
    // commits (repoSquash), and a title Windows can pass on gh's command line. The squashed branch replaces any earlier push.
    const body = ticketPrBody(t);
    const squash = repoSettings(loadSettings(root), sprint.project).squash;
    const replaces = squash ? await squashTicket(root, t, latest.worktree, body) : null;
    // What Podium is about to push (t.pushed) is saved before the push: a crash after it still knows the commit is ours.
    if (replaces !== null) opts.save?.();
    job = await openPr(root, t.latest, { env, watch, title: safeArgText(`${t.key}: ${t.title}`), body, fromSprint: true, forcePush: replaces, autoMerge: Boolean(sprint.autoMerge) });
  }
  // Auto-merge is set in the PR's first write. A PR adopted from an earlier tick that lacks it gets it
  // under the PR's lock, waiting briefly since this tick holds the sprint's lock; a busy PR is left as it is.
  if (sprint.autoMerge && !job.pr.autoMerge) await setAutoMerge(root, job.id, true, { waitMs: 2000 }).catch(() => {});
  Object.assign(t, { state: 'pr-open', phase: null, job: null, pr: { number: job.pr.number, url: job.pr.url }, endedAt: new Date(opts.now).toISOString() });
  say(sprint, `${t.key}: ${t.title} (PR #${job.pr.number}) is open. ${job.pr.url}`, opts.now);
}

// ---- The full check before the PR ----

// After the last task's review passed: the repo's full check (repoCheck) when it has one, else the PR.
function afterLastTask(root, sprint, t, opts) {
  return repoSettings(loadSettings(root), sprint.project).check ? runFullCheck(root, sprint, t, opts) : openTicketPr(root, sprint, t, opts);
}

// Podium runs the check in the ticket's copy, in a process of its own (engine/check.js): the tick that starts it returns at
// once, so the sprint is never locked while it runs, and later ticks read how it went (checkFinished).
async function runFullCheck(root, sprint, t, opts) {
  t.trying = 'check';
  const settings = loadSettings(root);
  const { check } = repoSettings(settings, sprint.project);
  const copy = jobOf(root, t.latest).worktree;
  // Everything reviewed or fixed is committed by now: the check starts from that commit, with nothing else in the copy (a
  // check run again, after one that was lost, starts from where that one did). With no check any more (it was removed
  // since one was lost), what the lost one left goes all the same, and the PR opens.
  const from = t.phase === 'check' ? t.check?.head : null;
  if (!check) {
    await dropLeftovers(copy, from);
    return openTicketPr(root, sprint, t, opts);
  }
  if (!copy || !fs.existsSync(copy)) throw new PodiumError('no-copy', `${t.key}'s copy is gone, so its full check can't run.`);
  const head = await dropLeftovers(copy, from);
  const minutes = checkMinutesOf(settings);
  const dir = path.join(sprintsDir(root), sprint.id, 'checks', `${t.key}-${Date.now()}`);
  // The check's folder is saved before the check starts: a tick that dies between the two leaves a ticket whose next tick
  // reads this folder (with no record in it the check reads as lost, and parks for Retry), never one that starts a second.
  Object.assign(t, { state: 'running', phase: 'check', job: null, check: { dir, minutes, head }, dispatching: null });
  opts.save?.();
  spawnCheck(dir, { command: check, cwd: copy, limitMs: minutes * 60_000 });
}

// The check's time limit in minutes: a hand-edited setting that is not a number above 0 counts as the default, and none
// is longer than a day (a timer past about 24 days overflows).
function checkMinutesOf(settings) {
  const n = Number(settings.checkMinutes);
  return Math.min(Number.isFinite(n) && n > 0 ? n : DEFAULT_SETTINGS.checkMinutes, MAX_CHECK_MINUTES);
}

// What a check wrote, rewrote or committed never reaches the PR: the copy goes back to the commit the check started from
// (to; else HEAD), and anything git does not ignore that is not in it goes. Ignored build output stays. Only ever in the
// ticket's own copy; with no copy it does nothing. Returns the commit the copy is at.
async function dropLeftovers(copy, to = null) {
  if (!copy || !fs.existsSync(copy)) return null;
  await gitIn(copy, ['reset', '-q', '--hard', to || 'HEAD']);
  await gitIn(copy, ['clean', '-fdq']);
  return gitIn(copy, ['rev-parse', 'HEAD']);
}

// The check has ended: passed opens the PR; failed or past its limit parks for the writer's fix (Retry); lost parks to run
// it again. While paused, a finished check waits like a finished step. One far past its limit is asked to stop here
// (stopCheck) and parks as timed out, paused or not: nothing new starts from that.
async function checkFinished(root, sprint, t, opts) {
  const { now } = opts;
  const r = checkState(t.check?.dir);
  if (r.state === 'running') return;
  if (r.overdue) stopCheck(t.check?.dir);
  else if (sprint.paused) return;
  if (r.state === 'passed') {
    await dropLeftovers(jobOf(root, t.latest).worktree, t.check.head);
    // The log of an earlier failed check is done with: a PR that then fails to open shows only its own reason.
    t.findings = null;
    return openTicketPr(root, sprint, t, opts);
  }
  if (r.state === 'lost') {
    t.trying = 'check';
    return park(sprint, t, 'The full check stopped unexpectedly before the PR', now, r.log || null);
  }
  t.trying = 'check-fix';
  const why = r.state === 'timed-out' ? `The full check ran past its time limit (${t.check.minutes} min) before the PR` : 'The full check failed before the PR';
  return park(sprint, t, why, now, r.log || '(the check printed nothing)');
}

// Retry after a failed check: the last task's writer fixes what it found, in the same copy (and conversation), then the
// check runs again (advance).
async function startCheckFix(root, sprint, t, opts) {
  const { env } = opts;
  t.trying = 'check-fix';
  const task = t.tasks[t.tasks.length - 1];
  const { check } = repoSettings(loadSettings(root), sprint.project);
  // Straight after a check, what it wrote or rewrote goes first, so the fix's checkpoint never commits it. A fix run again
  // (its step failed) keeps what that step left: its writer carries on from there.
  if (t.phase === 'check') await dropLeftovers(jobOf(root, t.latest).worktree, t.check?.head);
  const res = await dispatchStep(root, t, 'check-fix', opts, { agent: task.agent, ticket: t.key, cwd: sprint.repo, session: sprint.session, env, prompt: checkFixPrompt(t, check, t.findings), followUp: t.latest, meta: meta(sprint, t, 'author') });
  started(t, 'check-fix', res.job);
}

async function redo(root, sprint, t, opts) {
  const step = t.resume ?? firstStep(t);
  Object.assign(t, { resume: null, reason: null, retryAt: null });
  if (step === 'fix') return startFix(root, sprint, t, opts);
  if (step === 'review' || step === 'fix-review') return startReview(root, sprint, t, step, opts);
  if (step === 'pr') return openTicketPr(root, sprint, t, opts);
  if (step === 'check') return runFullCheck(root, sprint, t, opts);
  if (step === 'check-fix') {
    // The repo's check was removed since this one failed: no fix against its old log. What the check (or a fix that
    // stopped) left goes, and the PR opens.
    if (!repoSettings(loadSettings(root), sprint.project).check) {
      t.trying = 'pr';
      await dropLeftovers(jobOf(root, t.latest).worktree, t.phase === 'check' ? t.check?.head : null);
      t.findings = null;
      return openTicketPr(root, sprint, t, opts);
    }
    return startCheckFix(root, sprint, t, opts);
  }
  if (step === 'plan-save') {
    // Save the written plan again, unless it is gone by now: then its writer writes it again.
    t.trying = step;
    if (isPlanFile(path.join(jobOf(root, t.latest).worktree, t.plan))) return planReady(root, sprint, t, opts);
    return startPlan(root, sprint, t, PLANNING.has(t.phase) ? t.phase : 'plan', opts);
  }
  if (PLANNING.has(step)) return startPlan(root, sprint, t, step, opts);
  return startAuthor(root, sprint, t, opts);
}

async function advance(root, sprint, t, opts) {
  const { now } = opts;
  if (t.dispatching) {
    // An earlier tick stopped between starting a step and saving it: adopt the step, or start it again.
    if (!adoptDispatched(root, sprint, t)) {
      if (sprint.paused) return;
      const { phase } = t.dispatching;
      t.dispatching = null;
      Object.assign(t, { resume: null, reason: null, retryAt: null });
      if (phase === 'fix') return startFix(root, sprint, t, opts);
      if (phase === 'check-fix') return startCheckFix(root, sprint, t, opts);
      if (REVIEWING.has(phase)) return startReview(root, sprint, t, phase, opts);
      if (PLANNING.has(phase)) return startPlan(root, sprint, t, phase, opts);
      return startAuthor(root, sprint, t, opts);
    }
  }
  if (t.state === 'waiting') {
    if (sprint.paused || now < Date.parse(t.retryAt)) return;
    // A retry takes a slot like any start: it waits while sprintParallel tickets are working.
    if (holding(sprint, t, RUNNING) >= sprint.maxParallel) return;
    return redo(root, sprint, t, opts);
  }
  if (t.state !== 'running') return;
  // The full check runs no job: its own record says how it went.
  if (t.phase === 'check') return checkFinished(root, sprint, t, opts);
  const job = jobOf(root, t.job);
  // Pause: running steps finish, and nothing new starts until Resume.
  if (['queued', 'running'].includes(job.status) || sprint.paused) return;
  // The full check's fix runs after the last task, one past the end of the list.
  const task = t.tasks[Math.min(t.task, t.tasks.length - 1)];
  // What the step worked on, in the person's words: a task, the plan, or the full check's fixes.
  const what = PLANNING.has(t.phase) ? 'the plan' : t.phase === 'check-fix' ? 'the fixes for the full check' : `task ${task.n}`;
  const dir = findJobDir(root, job.id);
  // The step's answer, read once: its tests line, its verdict, and (with stderr) a usage limit are read from it.
  const output = readOutput(dir) ?? '';
  const said = `${output}\n${tail(dir, 'stderr.log')}`;
  if (['failed', 'lost', 'cancelled'].includes(job.status)) {
    t.trying = t.phase;
    if (isUsageLimit(said)) {
      // A wrong match must not wait forever: after about six hours of waits on one step, ask the person.
      if ((t.waits ?? 0) >= MAX_WAITS) return park(sprint, t, `${label(job.agent)} has hit a usage limit for 6 hours on ${what}`, now);
      t.waits = (t.waits ?? 0) + 1;
      const at = now + RETRY_MS;
      Object.assign(t, { state: 'waiting', resume: t.phase, job: null, retryAt: new Date(at).toISOString(), reason: `${label(job.agent)} hit a usage limit; trying again at ${clockAt(at)}` });
      return;
    }
    return park(sprint, t, `${label(job.agent)} stopped on ${what}: ${job.error ?? job.status}`, now);
  }
  t.waits = 0;
  if (PLANNING.has(t.phase)) return planReady(root, sprint, t, opts);
  // Writers report their tests: only "passed", or "none-needed" with a reason, goes on to the review
  // (testsParkReason). Retry runs the writer again. The full check's fix (check-fix) is exempt: the check runs right after.
  if (t.phase === 'author' || t.phase === 'fix') {
    const reason = testsParkReason(testsOf(output), label(job.agent), task.n);
    if (reason) {
      t.trying = t.phase;
      // A fix runs again with the reviewer's findings, not this report (startFix).
      if (t.phase === 'fix') t.reviewSaid = t.findings;
      return park(sprint, t, reason, now, output.trim().slice(-REPORT_CHARS) || null);
    }
  }
  if (t.phase === 'author') return startReview(root, sprint, t, 'review', opts);
  if (t.phase === 'fix') return startReview(root, sprint, t, 'fix-review', opts);
  // The full check's fixes are checked by the check itself, which runs again.
  if (t.phase === 'check-fix') {
    await checkpointWork(root, t, `wip(${t.key}): full check fixes`);
    return runFullCheck(root, sprint, t, opts);
  }
  // A review finished.
  const { verdict, findings } = verdictOf(output);
  if (verdict === 'pass') {
    Object.assign(t, { reviews: t.reviews + 1, fails: 0, retries: 0, findings: null, task: t.task + 1 });
    if (t.task >= t.tasks.length) return afterLastTask(root, sprint, t, opts);
    return startAuthor(root, sprint, t, opts);
  }
  const why = verdict ? findings : `The reviewer didn't give a verdict. ${findings}`.trim();
  // fails counts this task's failed reviews: the first goes back to the author as a fix, the
  // second parks. A Retry then runs that fix (with these findings) and counts from 1 again.
  if (t.fails === 0) {
    Object.assign(t, { fails: 1, findings: why });
    return startFix(root, sprint, t, opts);
  }
  t.trying = 'fix';
  return park(sprint, t, parkReason(t, task.n, Boolean(verdict)), now, why);
}

// After a Retry the person already knows about the first failures: "twice" would read as two new ones.
function parkReason(t, n, gaveVerdict) {
  const k = t.retries ?? 0;
  const after = k > 1 ? `after ${k} retries` : 'after a retry';
  if (gaveVerdict) return k ? `Review failed again on task ${n} ${after}` : `Review failed twice on task ${n}`;
  return k ? `The reviewer didn't give a verdict on task ${n} again ${after}` : `The reviewer didn't give a verdict on task ${n}, twice`;
}

const firstLine = (text) => String(text ?? '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';

// A PodiumError is already plain, except gitIn's, which carries git's own wording. Those and anything
// else unexpected get a sentence naming the step.
function plainReason(t, e) {
  if (e instanceof PodiumError && e.code !== 'git-failed') return e.message;
  // A ticket with no tasks yet has no task number: its step is the plan.
  const n = t.tasks[Math.min(t.task, t.tasks.length - 1)]?.n;
  const sentence = {
    plan: "Podium couldn't start or save the plan",
    revise: "Podium couldn't start or save the plan's changes",
    'plan-save': t.phase === 'revise' ? "Podium couldn't save or read the plan's changes" : "Podium couldn't save or read the plan",
    author: `Podium couldn't start task ${n}`,
    fix: `Podium couldn't start the fix for task ${n}`,
    review: `Podium couldn't save task ${n}'s work and start its review`,
    'fix-review': `Podium couldn't save task ${n}'s work and start its review`,
    pr: "Podium couldn't open the PR",
    check: "Podium couldn't run the full check",
    'check-fix': "Podium couldn't start the fixes for the full check",
  }[t.trying] ?? "Podium couldn't continue";
  return `${sentence}: ${firstLine(e?.message)}`;
}

// A step that throws (a branch name taken, a refused dispatch, a git error) parks the ticket with the reason.
async function guarded(sprint, t, step, now) {
  try {
    await step();
  } catch (e) {
    if (e?.code === 'sprint-busy') throw e; // this tick lost the lock: it must not write anything more
    park(sprint, t, plainReason(t, e), now);
  }
}

export function sprintReport(sprint, now = Date.now()) {
  const minutes = Math.max(1, Math.round((now - Date.parse(sprint.startedAt ?? sprint.createdAt)) / 60_000));
  return [
    `Sprint "${sprint.name}" is done.`,
    ...sprint.tickets.map((t) => {
      if (t.state === 'stopped') return `- ${t.key} ${t.title}: stopped`;
      const who = [...new Set(t.tasks.map((x) => label(x.agent)))].join(', ');
      const by = [...new Set(t.tasks.map((x) => label(x.reviewer)))].join(', ');
      // One review per task is the normal path; only extra rounds mean work was sent back
      // ("2 review rounds" for two tasks reads as a retry).
      const sentBack = Math.max(0, t.rounds - t.tasks.length);
      const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
      return `- ${t.key} ${t.title}: PR #${t.pr?.number} ${t.pr?.url ?? ''} · ${plural(t.tasks.length, 'task')} by ${who}, reviewed by ${by} · ${sentBack ? `${plural(sentBack, 'review')} sent work back for fixes` : 'every review passed first time'}`;
    }),
    `It took ${minutes} min.`,
  ].join('\n');
}

// saveFn is a test seam: a save that throws stands for a runner killed at that point.
// fetchFn is a test seam too: it stands for fetchBase.
export async function tick(root, id, { env = process.env, now = Date.now(), watch = false, saveFn = saveSprint, fetchFn = fetchBase } = {}) {
  return locked(root, id, async ({ token }) => {
    const sprint = loadSprint(root, id);
    // A draft runs nothing until it is started: no step, no save, no news. Nor does an archived or thrown-away
    // sprint (one archived with no finishedAt recorded would get a "finished" report again, which the inbox would claim).
    if (sprint.draft || sprint.archived || sprint.discardedAt) return sprint;
    const save = () => saveFn(root, sprint, { token });
    // "after": the waiting tickets whose dependencies have all merged, decided now, before anything this tick
    // fetches. One whose last dependency merges later in the tick waits for the next tick's fetch (see startFrom).
    const ready = new Set(sprint.tickets.filter((t) => t.state === 'pending' && waitsFor(t) && !afterGate(root, sprint, t)).map((t) => t.key));
    const opts = { env, now, watch, save, fetchFn };
    // First account for every step an earlier tick dispatched but never saved, so no admission below
    // can give its slot away (a retry or a pending start would otherwise run beside it).
    for (const t of sprint.tickets) {
      if (!t.dispatching) continue;
      await guarded(sprint, t, () => { adoptDispatched(root, sprint, t); }, now);
      save();
    }
    for (const t of sprint.tickets) {
      await guarded(sprint, t, () => advance(root, sprint, t, opts), now);
      save();
    }
    if (!sprint.paused) {
      for (const t of sprint.tickets) {
        if (t.state !== 'pending') continue;
        // "after": wait for the tickets it names to merge, or park it if one never will.
        const gate = afterGate(root, sprint, t);
        if (gate?.blocked) {
          park(sprint, t, gate.blocked, now);
          save();
          continue;
        }
        if (gate || (waitsFor(t) && !ready.has(t.key))) continue;
        // Only starting needs a slot: the tickets after this one still have their "after" checked (a stopped dependency
        // parks its dependant now, not once a slot frees).
        if (holding(sprint, t, ACTIVE) >= sprint.maxParallel) continue;
        await guarded(sprint, t, () => (t.tasks.length ? startAuthor(root, sprint, t, opts) : startPlan(root, sprint, t, 'plan', opts)), now);
        save();
      }
    }
    settle(root, sprint, now);
    save();
    return sprint;
  });
}

// Record merged and closed PRs; a sprint is finished once every ticket has its PR or was stopped, and archived
// once every ticket has ended and its news is delivered.
function settle(root, sprint, now) {
  for (const t of sprint.tickets) t.state = shippedState(root, t);
  if (!sprint.finishedAt && sprint.tickets.every((t) => SHIPPED.has(t.state))) {
    sprint.finishedAt = new Date(now).toISOString();
    say(sprint, sprintReport(sprint, now), now);
  }
  if (sprint.finishedAt && sprint.tickets.every((t) => ENDED.has(t.state)) && sprint.messages.every((m) => m.delivered)) sprint.archived = true;
}

// The runner stops once every ticket has its PR, so the status calls record merged and
// closed PRs: a sprint whose tickets have all ended is archived and stops being listed.
// A sprint with undelivered messages stays listed: the chat finds news only through unarchived
// sprints. Never waits on a busy sprint: the next status call tries again. Best-effort: every
// failure is swallowed so archiving can never fail a status call.
export async function archiveEnded(root, summaries) {
  for (const sum of summaries) {
    // A finished sprint listed though archived (sprintSummaries' `finished`) is already done with: no lock taken.
    if (sum.busy || sum.archived || sum.news > 0 || !sum.tickets.length || !sum.tickets.every((t) => ENDED.has(t.state))) continue;
    const ended = new Map(sum.tickets.map((t) => [t.key, t.state]));
    try {
      await change(root, sum.id, (s) => {
        if (s.archived) return false;
        for (const t of s.tickets) if (t.state === 'pr-open' && PR_ENDED.has(ended.get(t.key))) t.state = ended.get(t.key);
        if (!s.tickets.every((t) => ENDED.has(t.state))) return false;
        if (!s.messages.every((m) => m.delivered)) return false;
        s.archived = true;
      }, { waitMs: 200 });
    } catch { /* best-effort: the next status call tries again */ }
  }
}

// Does this sprint need its runner? Not when everything left waits on the person, or on PRs to merge: a ticket waiting
// for others ("after") gives the runner nothing to do until one merges, and then the PR watcher and the pane's
// minute check ask for a runner again. One whose wait is blocked (a stopped or closed dependency) is parked by a tick.
export function wantsRunner(root, s) {
  if (s.draft || s.finishedAt || s.archived || s.discardedAt) return false;
  return s.tickets.some((t) => {
    if (t.state === 'running') {
      if (!s.paused) return true;
      return stepBusy(root, t);
    }
    if (s.paused) return false;
    if (t.state === 'waiting') return true;
    return t.state === 'pending' && !afterGate(root, s, t)?.wait;
  });
}

export const CLAIM_MS = 120_000;

function ticketOf(sprint, key) {
  const t = sprint.tickets.find((x) => x.key === String(key).toUpperCase());
  if (!t) throw new PodiumError('no-such-ticket', `${key} is not in this sprint.`);
  return t;
}

function knownAgent(root, name) {
  if (!loadAdapters(root).adapters.has(name)) throw new PodiumError('unknown-agent', `No agent called "${name}".`);
  return name;
}

// fn may return false for "nothing changed": the sprint is then not saved.
const change = (root, id, fn, { waitMs } = {}) => locked(root, id, async ({ token }) => {
  const sprint = loadSprint(root, id);
  if ((await fn(sprint)) !== false) saveSprint(root, sprint, { token });
  return sprint;
}, { waitMs });

export function setPaused(root, id, paused) {
  return change(root, id, (s) => {
    if (s.draft) throw notStarted('Start it from its board first.');
    s.paused = Boolean(paused);
  });
}

// What the board says while a retried step waits to start: who does what, using the agents after any override.
function retryNote(t, step) {
  if (step === 'plan') return `Trying again: ${label(t.agent)} writes the plan`;
  if (step === 'revise') return `Trying again: ${label(t.agent)} changes the plan`;
  if (step === 'plan-save') return 'Trying again: saving the plan';
  const task = t.tasks[Math.min(t.task, t.tasks.length - 1)];
  const [author, reviewer] = [label(task.agent), label(task.reviewer)];
  if (step === 'pr') return 'Trying again: opening the PR';
  if (step === 'check') return 'Trying again: running the full check';
  if (step === 'check-fix') return `Trying again: ${author} fixes what the full check found, then it runs again`;
  if (step === 'review' || step === 'fix-review') return `Trying again: ${reviewer} reviews task ${task.n}`;
  if (step === 'fix') return `Trying again: ${author} fixes task ${task.n}, then ${reviewer} reviews it`;
  return `Trying again: ${author} does task ${task.n}`;
}

export function retryTicket(root, id, key, { agent = null } = {}) {
  return change(root, id, (s) => {
    const t = ticketOf(s, key);
    if (!['parked', 'waiting'].includes(t.state)) throw new PodiumError('not-stuck', `${t.key} is not parked or waiting.`);
    const step = t.resume ?? firstStep(t);
    // Opening the PR runs no task agent, so an agent override has nothing to change there. The plan's writer is
    // the ticket's own, who also writes its tasks at Approve. Saving the plan runs no agent and the board
    // offers no other agent there (giveTo), so an override is refused rather than quietly dropped or kept for a
    // rerun the person was not told about.
    if (agent && step === 'plan-save') throw new PodiumError('no-agent-change', `Saving ${t.key}'s plan runs no agent, so there is none to change. Retry it as it is.`);
    if (agent && step === 'check') throw new PodiumError('no-agent-change', `${t.key}'s full check runs no agent, so there is none to change. Retry it as it is.`);
    if (agent && step !== 'pr') {
      if (PLANNING.has(step)) t.agent = knownAgent(root, agent);
      else if (step === 'review' || step === 'fix-review') t.tasks[t.task].reviewer = knownAgent(root, agent);
      // The full check's fix is the last task's writer's.
      else t.tasks[Math.min(t.task, t.tasks.length - 1)].agent = knownAgent(root, agent);
    }
    // A fresh review after the person looked: the two-fail count starts again. A fix counts as
    // one fail already, so one more failed review parks again rather than looping.
    if (step === 'review') t.fails = 0;
    if (step === 'fix') t.fails = 1;
    Object.assign(t, { state: 'waiting', resume: step, retryAt: new Date(0).toISOString(), reason: retryNote(t, step), waits: 0, retries: (t.retries ?? 0) + 1, planExtra: null });
  });
}

// End a ticket the person has given up on. Its branch is kept so the work is not lost; only its copy goes.
// Stopping the last ticket that was holding a sprint up finishes the sprint here: no runner is left to do it.
export function stopTicket(root, id, key, { now = Date.now() } = {}) {
  return change(root, id, async (s) => {
    if (s.draft) throw notStarted('Remove the ticket from the draft instead.');
    const t = ticketOf(s, key);
    // Only a step that is still going makes a ticket busy: a paused ticket whose step finished can be stopped.
    // Saved intent to dispatch (a runner killed before the job was made) is not work: adopt the job if one
    // exists, or clear the intent. (A tick holds the sprint lock while it dispatches, so a dispatch in
    // flight is never seen here.)
    if (t.dispatching && !adoptDispatched(root, s, t)) t.dispatching = null;
    if (t.state === 'running' && stepBusy(root, t)) throw new PodiumError('ticket-busy', `${t.key} is working right now. Pause the sprint, wait for the step to finish, then stop it.`);
    if (t.state === 'stopped') throw new PodiumError('not-stoppable', `${t.key} is already stopped.`);
    if (!OPEN_STATES.has(t.state)) throw new PodiumError('not-stoppable', `${t.key} already has its PR, so there is nothing to stop. Close the PR on GitHub if you don't want it.`);
    let branch = null;
    let kept = null;
    if (t.latest) {
      let job = null;
      try { job = readJob(findJobDir(root, t.latest)); } catch { /* the step's record is gone: nothing to clean up */ }
      branch = job?.branch ?? null;
      if (job?.worktree && fs.existsSync(job.worktree)) {
        try {
          // After a full check, what it wrote or rewrote is not the ticket's work: it goes first, so the kept
          // branch never carries it.
          if (t.phase === 'check') await dropLeftovers(job.worktree, t.check?.head);
          branch = await saveUnfinished(job.worktree, t.key) ?? branch;
          // A step not yet checkpointed keeps where its work ends (Steps and diff, as startReview records it).
          const checkpoint = job.checkpoint ? null : await gitIn(job.worktree, ['rev-parse', 'HEAD']);
          if (job.status === 'needs-review') updateJob(root, findJobDir(root, job.id), { status: 'done', hasChanges: false, ...(checkpoint ? { checkpoint } : {}) }, 'checkpointed');
          else if (checkpoint) updateJob(root, findJobDir(root, job.id), { checkpoint });
        } catch (e) {
          kept = { path: job.worktree, reason: firstLine(e?.message) };
        }
        if (!kept) await removeWorktree(job.repoRoot ?? s.repo, job.worktree, null).catch(() => {});
      }
    }
    Object.assign(t, { state: 'stopped', phase: null, job: null, retryAt: null, resume: null, reason: null, dispatching: null, endedAt: new Date(now).toISOString() });
    say(s, kept
      ? `${t.key} (${t.title}) was stopped. Its copy is kept at ${kept.path} because Podium couldn't save its unfinished changes: ${kept.reason}`
      : `${t.key} (${t.title}) was stopped.${branch ? ` Its branch ${branch} is kept.` : ''}`, now);
    settle(root, s, now);
  });
}

// Read as the tick reads it (reconciled): a step whose runner died is not going.
function stepGoing(root, id) {
  try { return ['queued', 'running'].includes(jobOf(root, id).status); } catch { return false; }
}

// Is a ticket's current step still going? The full check runs no job: its own record says.
const stepBusy = (root, t) => (t.phase === 'check' ? checkRunning(t.check?.dir) : stepGoing(root, t.job));

// Commit whatever an agent left in the copy (edits or new files) to the branch the copy is on, so removing
// the copy loses nothing. Returns that branch; throws if the work can't be saved.
async function saveUnfinished(copy, key) {
  await gitIn(copy, ['add', '-A']);
  if (!(await gitIn(copy, ['status', '--porcelain']))) return null;
  const branch = await gitIn(copy, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch === 'HEAD') throw new PodiumError('not-on-branch', 'the copy is not on a branch');
  await gitIn(copy, ['commit', '-q', '-m', `wip(${key}): unfinished work saved when the ticket was stopped`]);
  return branch;
}

// Tickets still going: only on these may a task's writer or reviewer change.
const OPEN_STATES = new Set(['pending', 'waiting', 'parked', 'running', 'plan-ready', 'no-tasks']);
// A task whose writer or reviewer may still change: not run yet (or stuck before it ran) on a ticket still going.
function assignable(t, i) {
  return OPEN_STATES.has(t.state) && i >= t.task && !(i === t.task && t.state === 'running');
}

export function assignTask(root, id, key, n, { agent = null, reviewer = null } = {}) {
  return change(root, id, (s) => {
    // A draft or a started sprint's tasks not run yet, never a thrown-away draft (as draftOnly says).
    if (s.discardedAt) throw discarded();
    const t = ticketOf(s, key);
    // Task 0 of a ticket with no tasks yet is its plan: its writer plans it and, with its reviewer, is
    // given every task at Approve. Both may change until the plan is being written, and again while it waits.
    if (Number(n) === 0 && !t.tasks.length) {
      if (!agent && !reviewer) throw new PodiumError('nothing-to-change', 'Say which agent or reviewer to use.');
      if (!OPEN_STATES.has(t.state)) throw new PodiumError('ticket-ended', `${t.key} has ended, so its tasks can no longer change.`);
      if (t.state === 'running') throw new PodiumError('task-started', `${t.key}'s plan is being written right now.`);
      if (agent) t.agent = knownAgent(root, agent);
      if (reviewer) t.reviewer = knownAgent(root, reviewer);
      return;
    }
    const at = t.tasks.findIndex((x) => x.n === Number(n));
    if (at === -1) throw new PodiumError('no-such-task', `${t.key} has no task ${n}.`);
    if (!agent && !reviewer) throw new PodiumError('nothing-to-change', 'Say which agent or reviewer to use.');
    if (!OPEN_STATES.has(t.state)) throw new PodiumError('ticket-ended', `${t.key} has ended, so its tasks can no longer change.`);
    if (!assignable(t, at)) throw new PodiumError('task-started', `${t.key} task ${n} has already run or is running.`);
    if (agent) t.tasks[at].agent = knownAgent(root, agent);
    if (reviewer) t.tasks[at].reviewer = knownAgent(root, reviewer);
  });
}

// ---- A plan waiting for the person: every answer through change() ----

// Approve: the plan's tasks become the ticket's, each with the ticket's writer and reviewer (changeable on the board
// like any task not yet run), and the ticket runs on: its next tick starts task 1 in the same copy, after the
// plan's checkpoint, as a follow-up of the plan's step. whole: Run as one task, for a plan with no tasks.
export function approvePlan(root, id, key, { whole = false } = {}) {
  return change(root, id, (s) => {
    if (s.draft) throw notStarted('Its plan is written once it runs.');
    const t = ticketOf(s, key);
    if (!PLAN_WAITS.has(t.state)) throw new PodiumError('no-plan-waiting', `${t.key} has no plan waiting for approval.`);
    if (whole && t.state !== 'no-tasks') throw new PodiumError('plan-has-tasks', `${t.key}'s plan has tasks: approve it instead.`);
    if (!whole && t.state === 'no-tasks') throw new PodiumError('no-tasks', `Couldn't find tasks in ${t.key}'s plan. Run it as one task, or ask for changes.`);
    // An empty plan is never one empty task (planReady parks it; this guards a state saved before that).
    if (whole && !String(t.proposed?.[0]?.text ?? '').trim()) throw new PodiumError('empty-plan', `${t.key}'s plan is empty, so there is nothing to run. Ask for changes instead.`);
    t.tasks = t.proposed.map((x) => ({ n: x.n, title: x.title, text: x.text, agent: t.agent, reviewer: t.reviewer }));
    // The tasks' counts start afresh: a retry while planning is not one of task 1's (its park reason would say "after a retry").
    Object.assign(t, { state: 'pending', proposed: null, reason: null, task: 0, phase: null, trying: null, resume: null, retries: 0, fails: 0 });
  });
}

// Ask for changes: the plan goes back to its writer with the person's notes, as a follow-up in the same copy (and
// the same conversation when the agent can resume one), then waits at Plan ready again. It takes a slot like a retry.
// Also from a ticket parked because its planner changed files other than the plan (mayRevise), so it can undo them.
export function revisePlan(root, id, key, text) {
  return change(root, id, (s) => {
    if (s.draft) throw notStarted('Its plan is written once it runs.');
    const t = ticketOf(s, key);
    if (!mayRevise(t)) throw new PodiumError('no-plan-waiting', `${t.key} has no plan waiting for approval.`);
    const notes = String(text ?? '').trim();
    if (!notes) throw new PodiumError('nothing-to-change', 'Say what should change in the plan.');
    Object.assign(t, {
      state: 'waiting', resume: 'revise', asked: notes.slice(0, TEXT_CHARS), proposed: null, planExtra: null,
      reason: `${label(t.agent)} changes the plan next`, retryAt: new Date(0).toISOString(), waits: 0,
    });
  });
}

// ---- The draft board: every change through change(), refused once the sprint has started ----

export const MAX_AT_ONCE = 5;

export function moveTicket(root, id, key, to) {
  return change(root, id, (s) => {
    draftOnly(s);
    const at = s.tickets.indexOf(ticketOf(s, key));
    if (to !== 'up' && to !== 'down') throw new PodiumError('bad-value', 'Move a ticket up or down.');
    const next = to === 'up' ? at - 1 : at + 1;
    if (next < 0 || next >= s.tickets.length) return false; // already first or last: nothing to save
    [s.tickets[at], s.tickets[next]] = [s.tickets[next], s.tickets[at]];
  });
}

export function removeTicket(root, id, key) {
  return change(root, id, (s) => {
    draftOnly(s);
    const t = ticketOf(s, key);
    if (s.tickets.length === 1) throw new PodiumError('last-ticket', 'A sprint needs at least one ticket. Discard the draft instead.');
    s.tickets = s.tickets.filter((x) => x !== t);
    // No one waits for a ticket that has left the sprint. One that did waits instead for what it waited for, in its
    // place and listed once (A ← B ← C without B: C waits for A), so the order the person chose still holds.
    for (const x of s.tickets) {
      if (!x.after?.includes(t.key)) continue;
      x.after = [...new Set(x.after.flatMap((k) => (k === t.key ? (t.after ?? []) : [k])))].filter((k) => k !== x.key);
    }
    checkAfter(s.tickets); // it can't make a loop (it only follows edges that were there), but nothing unchecked is saved
  });
}

// The writer and/or reviewer of every task of a draft ticket.
export function assignTicket(root, id, key, { agent = null, reviewer = null } = {}) {
  return change(root, id, (s) => {
    draftOnly(s);
    const t = ticketOf(s, key);
    if (!agent && !reviewer) throw new PodiumError('nothing-to-change', 'Say which agent or reviewer to use.');
    if (agent) knownAgent(root, agent);
    if (reviewer) knownAgent(root, reviewer);
    // A ticket with no plan yet: its own writer and reviewer, who get every task at Approve.
    if (!t.tasks.length) {
      if (agent) t.agent = agent;
      if (reviewer) t.reviewer = reviewer;
    }
    for (const task of t.tasks) {
      if (agent) task.agent = agent;
      if (reviewer) task.reviewer = reviewer;
    }
  });
}

// What a draft ticket waits for: the whole list (keys; [] clears it), or one key added or dropped.
export function setAfter(root, id, key, { keys = null, add = null, drop = null } = {}) {
  return change(root, id, (s) => {
    draftOnly(s);
    const t = ticketOf(s, key);
    if (keys === null && !add && !drop) throw new PodiumError('nothing-to-change', 'Say which tickets it waits for.');
    const up = (k) => String(k).toUpperCase();
    let next = keys === null ? [...(t.after ?? [])] : [...new Set(keys.map(up))];
    if (add) next = [...new Set([...next, up(add)])];
    if (drop) next = next.filter((k) => k !== up(drop));
    checkAfter(s.tickets.map((x) => (x === t ? { ...x, after: next } : x)));
    if (JSON.stringify(next) === JSON.stringify(t.after ?? [])) return false;
    t.after = next;
  });
}

// A draft's Merge when green and how many of its tickets run at once.
export function setSprintOptions(root, id, { mergeWhenGreen, atOnce } = {}) {
  return change(root, id, (s) => {
    draftOnly(s);
    if (mergeWhenGreen === undefined && atOnce === undefined) throw new PodiumError('nothing-to-change', 'Say what to change: Merge when green or At once.');
    if (atOnce !== undefined) {
      const n = Number(atOnce);
      if (!Number.isInteger(n) || n < 1 || n > MAX_AT_ONCE) throw new PodiumError('bad-value', `At once must be a whole number from 1 to ${MAX_AT_ONCE}.`);
      s.maxParallel = n;
    }
    if (mergeWhenGreen !== undefined) s.autoMerge = mergeWhenGreen === true;
  });
}

const isPending = (m, now) => !m.delivered && !(m.claimedAt && now - Date.parse(m.claimedAt) < CLAIM_MS);
// This chat may take a message when the sprint has no chat, or it is this chat's sprint. Never another chat's, however long
// it waits (a notice taken by another chat would lead it to act on the sprint); the board says news waits.
const mayTake = (s, session) => !s.session || s.session === session;

// Claim → submit → mark, as for jobs: a claim the chat never confirms expires.
// Never blocks the chat: a sprint whose runner holds the lock is skipped and picked up on the next poll.
// project: only that project's sprints (a chat takes news for the project it is in).
export async function claimMessages(root, session, { now = Date.now(), waitMs = 2000, project } = {}) {
  const messages = [];
  // Never an archived or thrown-away sprint: an archived one is done with (the pane may still list it as
  // finished), and its news was delivered before it was archived. Checked again under the lock.
  const closed = (s) => Boolean(s.archived || s.discardedAt);
  for (const listed of listSprints(root, { project, includeArchived: true })) {
    if (closed(listed) || !mayTake(listed, session) || !listed.messages.some((m) => isPending(m, now))) continue;
    try {
      await change(root, listed.id, (s) => {
        if (closed(s)) return false;
        const before = messages.length;
        for (const m of s.messages) {
          if (!isPending(m, now) || !mayTake(s, session)) continue;
          m.claimedAt = new Date(now).toISOString();
          messages.push({ id: `${s.id}:${m.id}`, sprint: s.name, text: m.text });
        }
        return messages.length > before;
      }, { waitMs });
    } catch (e) {
      if (e.code !== 'sprint-busy') throw e;
    }
  }
  return { messages };
}

export async function markMessages(root, ids) {
  let marked = 0;
  const failed = [];
  const bySprint = new Map();
  for (const full of ids) {
    const str = String(full);
    const at = str.lastIndexOf(':');
    if (at < 1) continue;
    const sid = str.slice(0, at);
    const entry = bySprint.get(sid) ?? { mids: [], fulls: [] };
    entry.mids.push(str.slice(at + 1));
    entry.fulls.push(str);
    bySprint.set(sid, entry);
  }
  for (const [sid, { mids, fulls }] of bySprint) {
    const mark = () => change(root, sid, (s) => {
      let n = 0;
      for (const m of s.messages) if (mids.includes(m.id) && !m.delivered) { m.delivered = true; n++; }
      marked += n;
      return n > 0;
    });
    try {
      try {
        await mark();
      } catch (e) {
        if (e.code !== 'sprint-busy') throw e;
        await mark();
      }
    } catch (e) {
      if (e.code === 'sprint-not-found') continue; // a removed sprint has nothing to mark
      if (e.code !== 'sprint-busy') throw e;
      failed.push(...fulls);
    }
  }
  return { marked, failed };
}

// "Take them here": the person moves a sprint whose chat is gone to this chat. Its news, and any PR news one of its
// steps carries, are this chat's from now on (claimMessages, and claimDelivery reads the sprint's chat for a sprint step);
// steps started later carry it as their origin too. Only a sprint of the caller's own repo (project): this chat's inbox and
// job list are limited to its repo, so another repo's news adopted here would be stranded. The check runs under the lock.
export function adoptSprint(root, id, session, { project } = {}) {
  if (!session) throw new PodiumError('missing-option', 'Say which chat takes the sprint.');
  return change(root, id, (s) => {
    if (project && s.project !== project) {
      throw new PodiumError('other-repo', 'That sprint belongs to another repo; take its updates from a chat in that repo.');
    }
    if (s.session === session) return false;
    s.session = session;
  });
}

// One message for a sprint's own chat from outside the sprint's own steps (a PR on a sprint ticket merged or closed).
// key names the event ("pr:12:merged"): a message with that key already in the sprint is never added again, so an event
// told twice is said once. An archived sprint (thrown away, or every ticket ended and its news delivered) takes
// nothing and stays archived: no chat follows it, and the mod never polls an archived sprint for news.
// Answers 'said', 'already-said' or 'archived'.
export async function sayTo(root, id, text, { now = Date.now(), waitMs = 30_000, key = null } = {}) {
  let outcome = 'said';
  await change(root, id, (s) => {
    if (s.archived) { outcome = 'archived'; return false; }
    if (key && s.messages.some((m) => m.key === key)) { outcome = 'already-said'; return false; }
    say(s, text, now);
    if (key) s.messages[s.messages.length - 1].key = key;
    outcome = 'said';
  }, { waitMs });
  return outcome;
}
