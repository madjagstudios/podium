// A sprint's news, its PRs' too, reaches only its own chat.
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { createSprint, tick, loadSprint, saveSprint, claimMessages, sprintSummary, locked, adoptSprint, setReadHook } from '../engine/sprint.js';
import { listJobDirs, readJob, createJob, updateJob } from '../engine/store.js';
import { main } from '../engine/cli.js';
import { dispatch } from '../engine/dispatch.js';
import { openPr, refreshPr, tellSprint, FINISH_LOCK, setFinishTimings, flushSprintNews } from '../engine/pr.js';
import { claimDelivery } from '../engine/delivery.js';
import { waitFor, scriptAgent, sprintWorld, ghWorld, tempRoot } from './helpers.js';

const T = (over = {}) => ({ key: 'ABC-11', title: 'Login form', type: 'feat', plan: 'docs/plan.md', agent: 'fa', reviewer: 'fr', ...over });
const run = (root, id, env, until) => waitFor(async () => { const s = await tick(root, id, { env }); return until(s) ? s : null; }, { timeoutMs: 90_000, intervalMs: 150 });
const MERGED = { match: ['pr', 'view'], stdout: { state: 'MERGED', mergeable: 'UNKNOWN', reviewDecision: '', statusCheckRollup: [], comments: [], reviews: [], mergeCommit: { oid: 'abc123' } } };
const DAY = 24 * 60 * 60_000;

async function shippedSprint(gh = []) {
  const { root, w } = sprintWorld({ gh });
  scriptAgent(root, 'fa', [{ write: 'a.txt' }, { write: 'b.txt' }]);
  scriptAgent(root, 'fr', [{ say: 'VERDICT: pass' }, { say: 'VERDICT: pass' }]);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo, session: 'chat-1' });
  const s = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'pr-open');
  return { root, w, s };
}

test('a sprint step\'s PR opening is a sprint message, and the step stays delivered', async () => {
  const { root, s } = await shippedSprint();
  assert.ok(s.messages.some((m) => m.text === 'ABC-11: Login form (PR #12) is open. https://github.com/o/r/pull/12'));
  const latest = readJob(listJobDirs(root).find((d) => d.endsWith(s.tickets[0].latest)));
  assert.equal(latest.status, 'in-review');
  assert.equal(latest.delivered, true);
  assert.deepEqual(claimDelivery(root, latest.id, 'chat-2'), { claimed: false, reason: 'delivered' });
  assert.equal(sprintSummary(root, s).chat, 'chat-1');
});

test('a sprint ticket\'s PR merging is a sprint message that another chat never claims', async () => {
  const { root, w, s } = await shippedSprint([MERGED]);
  const merged = await refreshPr(root, s.tickets[0].latest, { env: w.env });
  assert.equal(merged.status, 'merged');
  assert.equal(merged.delivered, true, 'the step stays delivered');
  assert.ok(loadSprint(root, s.id).messages.some((m) => m.text === 'ABC-11: Login form (PR #12) merged.'));
  const later = Date.now() + DAY;
  assert.deepEqual((await claimMessages(root, 'chat-2', { now: later })).messages, [], 'another chat never takes it');
  assert.ok((await claimMessages(root, 'chat-1', { now: later })).messages.length >= 1);
});

// A sprint that is gone has no chat following it, so its PR news is dropped (the PR stays on GitHub).
test('a merged sprint PR whose sprint is gone drops its news: the step stays delivered and no chat is offered it', async () => {
  const root = tempRoot();
  const w = ghWorld([{ match: ['pr', 'create'], stdout: 'https://github.com/o/r/pull/7\n' }, MERGED]);
  scriptAgent(root, 'sa', [{ write: 'a.txt' }]);
  const meta = { sprint: { id: 's-gone', ticket: 'ABC-12', task: 1, role: 'author' }, delivered: true };
  const res = await dispatch(root, { agent: 'sa', permission: 'edit-worktree', cwd: w.repo, prompt: 'ABC-12 task 1: A', ticket: 'ABC-12', branch: 'fix/abc-12-a', session: 'chat-1', meta });
  await waitFor(() => !['queued', 'running'].includes(readJob(res.dir).status) || null, { timeoutMs: 60_000 });
  const opened = await openPr(root, res.job.id, { env: w.env, title: 'ABC-12: A', fromSprint: true });
  assert.equal(opened.delivered, true, 'the step stays delivered');
  const merged = await refreshPr(root, opened.id, { env: w.env });
  assert.equal(merged.status, 'merged');
  assert.equal(merged.delivered, true, 'the step stays delivered');
  assert.equal(merged.sprintNews, null, 'nothing kept: there is no sprint to hand it to');
  for (const chat of ['chat-1', 'chat-2']) assert.deepEqual(claimDelivery(root, merged.id, chat, { now: Date.now() + DAY }), { claimed: false, reason: 'delivered' }, chat);
});

test('a watcher refresh racing a pane merge does not say "merged." twice', async () => {
  const { root, w, s } = await shippedSprint([MERGED, MERGED]);
  const first = await refreshPr(root, s.tickets[0].latest, { env: w.env });
  const again = await refreshPr(root, s.tickets[0].latest, { env: w.env });
  assert.equal(first.status, 'merged');
  assert.equal(again.status, 'merged');
  assert.equal(loadSprint(root, s.id).messages.filter((m) => m.text === 'ABC-11: Login form (PR #12) merged.').length, 1);
});

// The test above runs its two refreshes one after the other. Here both callers read the step (in review)
// and wait on GitHub together; only then does gh answer both "merged". The thread's terminal transition is serialised, so
// the sprint is told once.
test('two callers that both read the PR in review, then both find it merged, tell the sprint once', async () => {
  const { root, w, s } = await shippedSprint([MERGED]);
  const sync = tempRoot();
  const arrived = path.join(sync, 'arrived');
  const gate = path.join(sync, 'go');
  const spec = JSON.parse(fs.readFileSync(w.env.PODIUM_FAKE_GH, 'utf8'));
  spec.responses = [{ ...MERGED, arrived, gate }];
  fs.writeFileSync(w.env.PODIUM_FAKE_GH, JSON.stringify(spec));
  const id = s.tickets[0].latest;
  const callers = [refreshPr(root, id, { env: w.env }), refreshPr(root, id, { env: w.env })];
  // Both have read the step and are waiting on gh's answer.
  await waitFor(() => (fs.existsSync(arrived) && fs.readFileSync(arrived, 'utf8').trim().split('\n').length >= 2) || null, { timeoutMs: 30_000 });
  assert.equal(readJob(listJobDirs(root).find((d) => d.endsWith(id))).status, 'in-review', 'neither has recorded anything yet');
  fs.writeFileSync(gate, 'go');
  const [a, b] = await Promise.all(callers);
  assert.equal(a.status, 'merged');
  assert.equal(b.status, 'merged');
  const said = loadSprint(root, s.id).messages.filter((m) => m.text === 'ABC-11: Login form (PR #12) merged.');
  assert.equal(said.length, 1, 'one notice');
  assert.equal(said[0].key, 'pr:12:merged');
  assert.ok(listJobDirs(root).every((d) => !fs.existsSync(path.join(d, FINISH_LOCK))), 'the lock is gone');
});

// Two finishers that genuinely overlap (the second takes the first's lock for stale while the first is
// still telling the sprint): one tells the sprint, the other's tell fails (the sprint can't be read just then). The loser
// must not undo the winner (delivered back to false would offer the same news through the job channel too).
test('two overlapping finishers, one telling the sprint and one failing to, leave one notice anywhere and delivered never false', async () => {
  const { root, w, s } = await shippedSprint([MERGED]);
  const id = s.tickets[0].latest;
  const jobDirOf = (jid) => listJobDirs(root).find((d) => d.endsWith(jid));
  const KEY = 'pr:12:merged';
  setFinishTimings({ staleMs: 300, waitMs: 30_000 });
  // Once the merged notice is in the sprint, its state can't be read for a while (a scanner holding the file): the second
  // finisher to reach the sprint fails to tell it.
  setReadHook((file) => {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { /* let the real read fail as it will */ }
    if (text.includes(KEY)) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
  });
  try {
    // The sprint is busy at first, so the first finisher waits inside its lock, telling the sprint.
    const hold = locked(root, s.id, () => new Promise((r) => setTimeout(r, 1500)));
    const first = refreshPr(root, id, { env: w.env });
    await waitFor(() => listJobDirs(root).some((d) => fs.existsSync(path.join(d, FINISH_LOCK))) || null, { timeoutMs: 30_000 });
    // The second arrives while the first holds the lock, waits past the (shortened) stale time and takes it over.
    const second = refreshPr(root, id, { env: w.env });
    await hold;
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.status, 'merged');
    assert.equal(b.status, 'merged');
  } finally {
    setReadHook(null);
    setFinishTimings();
  }
  const latest = readJob(jobDirOf(id));
  assert.equal(latest.status, 'merged');
  assert.equal(latest.delivered, true, 'the loser never set delivered back to false');
  const notices = () => loadSprint(root, s.id).messages.filter((m) => m.key === KEY || m.text === 'ABC-11: Login form (PR #12) merged.');
  assert.equal(notices().length, 1, 'one notice in the sprint');
  // And none through the job channel, for any chat.
  for (const chat of ['chat-1', 'chat-2']) assert.equal(claimDelivery(root, id, chat, { now: Date.now() + DAY }).claimed, false, chat);
  // News a step may still hold for its sprint is handed over by key: still one notice.
  await flushSprintNews(root);
  assert.equal(notices().length, 1);
  assert.equal(readJob(jobDirOf(id)).delivered, true);
});

// The loser may also be the one that writes first (its tell failed before the winner's went in): it keeps the step
// delivered and holds the news as sprintNews, which goes to the sprint by key (said once) and is never a job notice.
test('a finisher whose tell failed keeps the step delivered and hands the news to the sprint later, said once', async () => {
  const { root, w, s } = await shippedSprint([MERGED]);
  const id = s.tickets[0].latest;
  const dir = listJobDirs(root).find((d) => d.endsWith(id));
  setReadHook(() => { throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }); });
  let merged;
  try {
    merged = await refreshPr(root, id, { env: w.env });
  } finally {
    setReadHook(null);
  }
  assert.equal(merged.status, 'merged');
  assert.equal(merged.delivered, true, 'still delivered: the job channel never offers it');
  assert.deepEqual(merged.sprintNews, [{ key: 'pr:12:merged', text: 'ABC-11: Login form (PR #12) merged.' }]);
  assert.deepEqual(claimDelivery(root, id, 'chat-1', { now: Date.now() + DAY }), { claimed: false, reason: 'delivered' });
  // Another teller got the same news in meanwhile (by key); handing it over then says nothing more.
  assert.equal(await tellSprint(root, s.id, 'ABC-11: Login form (PR #12) merged.', { key: 'pr:12:merged' }), true);
  assert.equal(await flushSprintNews(root), 1);
  assert.equal(readJob(dir).sprintNews, null);
  assert.equal(readJob(dir).delivered, true);
  assert.equal(loadSprint(root, s.id).messages.filter((m) => m.key === 'pr:12:merged').length, 1);
});

test('an event told twice (a crash between telling and recording it) is said once: its key is kept with the message', async () => {
  const { root, s } = await shippedSprint();
  assert.equal(await tellSprint(root, s.id, 'ABC-11: Login form (PR #12) merged.', { key: 'pr:12:merged' }), true);
  assert.equal(await tellSprint(root, s.id, 'ABC-11: Login form (PR #12) merged.', { key: 'pr:12:merged' }), true);
  assert.equal(loadSprint(root, s.id).messages.filter((m) => m.key === 'pr:12:merged').length, 1);
});

// A sprint that is gone answers true (the news is done with: dropped), not false (keep it for later).
test('tellSprint gives up quickly when the sprint is busy, drops news for a sprint that is gone, and logs neither', async () => {
  const { root, s } = await shippedSprint();
  const dir = listJobDirs(root).find((d) => d.endsWith(s.tickets[0].latest));
  const log = path.join(dir, 'stderr.log');
  const before = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  const holder = locked(root, s.id, () => new Promise((r) => setTimeout(r, 1500)));
  const started = Date.now();
  assert.equal(await tellSprint(root, s.id, 'x', { dir, waitMs: 100 }), false);
  assert.ok(Date.now() - started < 1200, 'it did not wait the default 30 s');
  await holder;
  assert.equal(await tellSprint(root, 's-gone', 'x', { dir, waitMs: 100 }), true);
  assert.equal(fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '', before, 'busy and gone are expected: nothing is logged');
});

test('tellSprint writes any other error to the step\'s activity log and still answers false', async () => {
  const root = tempRoot();
  const dir = path.join(root, 'job');
  fs.mkdirSync(dir, { recursive: true });
  const say = async () => { throw Object.assign(new Error('disk is full'), { code: 'ENOSPC' }); };
  assert.equal(await tellSprint(root, 's1', 'x', { dir, say }), false);
  assert.match(fs.readFileSync(path.join(dir, 'stderr.log'), 'utf8'), /disk is full/);
});

// "Take them here". A sprint whose chat is gone moves to the chat that asks; its news, and the notice one
// of its steps carries, are that chat's from then on, and no other's. (The step here is undelivered with its PR in
// review; a step whose PR merged or closed is never a job notice at all, see below.)
test('a sprint taken into another chat gives that chat its news and its steps\' PR news, and no other chat', async () => {
  const { root, w } = sprintWorld();
  for (const name of ['fa', 'fr']) scriptAgent(root, name, []);
  const s = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo, session: 'chat-1' });
  await locked(root, s.id, async ({ token }) => {
    const raw = loadSprint(root, s.id);
    raw.messages.push({ id: '1', at: new Date().toISOString(), text: 'ABC-11 (Login form) needs you: stuck', delivered: false, claimedAt: null });
    saveSprint(root, raw, { token });
  });
  const { job, dir } = createJob(root, { project: 'demo', ticket: 'ABC-11', agent: 'fa', permission: 'edit-worktree', cwd: w.repo, prompt: 'x' });
  updateJob(root, dir, { status: 'in-review', endedAt: new Date().toISOString(), origin: { session: 'chat-1' }, sprint: { id: s.id, ticket: 'ABC-11', task: 1, role: 'author' }, delivered: false, notifiedAt: new Date().toISOString() });
  const later = Date.now() + DAY;
  assert.deepEqual(claimDelivery(root, job.id, 'chat-2', { now: later }), { claimed: false, reason: 'not-yours-yet' });
  assert.deepEqual((await claimMessages(root, 'chat-2')).messages, []);

  const adopted = await adoptSprint(root, s.id, 'chat-2', { project: loadSprint(root, s.id).project });
  assert.equal(sprintSummary(root, adopted).chat, 'chat-2');
  assert.deepEqual(claimDelivery(root, job.id, 'chat-1', { now: later }), { claimed: false, reason: 'not-yours-yet' }, 'the old chat no longer takes it');
  assert.deepEqual(claimDelivery(root, job.id, 'chat-3', { now: later }), { claimed: false, reason: 'not-yours-yet' }, 'nor does any other');
  assert.deepEqual(claimDelivery(root, job.id, 'chat-2', { now: later }), { claimed: true });
  assert.deepEqual((await claimMessages(root, 'chat-3')).messages, []);
  assert.deepEqual((await claimMessages(root, 'chat-2')).messages.map((m) => m.text), ['ABC-11 (Login form) needs you: stuck']);
});

// After "Take them here", a sprint that can't be read for a moment must not hand its step's PR news back
// to the chat the step started in. Only a sprint confirmed gone lets the step's own origin decide. (The step's PR is in review,
// as above: a merged or closed one is refused to every chat.)
test('after Take them here, a sprint that can\'t be read just now gives its step\'s news to no chat; one that is gone, to the step\'s own', async () => {
  const { root, w } = sprintWorld();
  for (const name of ['fa', 'fr']) scriptAgent(root, name, []);
  const s = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo, session: 'chat-1' });
  const { job, dir } = createJob(root, { project: 'demo', ticket: 'ABC-11', agent: 'fa', permission: 'edit-worktree', cwd: w.repo, prompt: 'x' });
  updateJob(root, dir, { status: 'in-review', endedAt: new Date().toISOString(), origin: { session: 'chat-1' }, sprint: { id: s.id, ticket: 'ABC-11', task: 1, role: 'author' }, delivered: false, notifiedAt: new Date().toISOString() });
  await adoptSprint(root, s.id, 'chat-2', { project: loadSprint(root, s.id).project });
  const later = Date.now() + DAY;
  // Every read of its state fails (a scanner holding the file): busy, not gone.
  setReadHook(() => { throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }); });
  try {
    assert.throws(() => loadSprint(root, s.id), { code: 'sprint-busy' });
    for (const chat of ['chat-1', 'chat-2', 'chat-3']) {
      assert.deepEqual(claimDelivery(root, job.id, chat, { now: later }), { claimed: false, reason: 'not-yours-yet' }, chat);
    }
  } finally {
    setReadHook(null);
  }
  assert.deepEqual(claimDelivery(root, job.id, 'chat-1', { now: later }), { claimed: false, reason: 'not-yours-yet' }, 'readable again: still not the old chat');
  // Confirmed gone: the step's own origin decides.
  fs.rmSync(path.join(root, 'sprints', s.id), { recursive: true, force: true });
  assert.throws(() => loadSprint(root, s.id), { code: 'sprint-not-found' });
  assert.deepEqual(claimDelivery(root, job.id, 'chat-2', { now: later }), { claimed: false, reason: 'not-yours-yet' });
  assert.deepEqual(claimDelivery(root, job.id, 'chat-1', { now: later }), { claimed: true });
});

// "not found" also comes from a sprint folder whose state files are missing. Only a sprint folder that is
// itself absent lets the step's own chat take its news; missing, malformed or busy state refuses every chat.
test('after Take them here, a sprint folder with missing, malformed or busy state gives its step\'s news to no chat', async () => {
  const { root, w } = sprintWorld();
  for (const name of ['fa', 'fr']) scriptAgent(root, name, []);
  const s = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo, session: 'chat-1' });
  const { job, dir } = createJob(root, { project: 'demo', ticket: 'ABC-11', agent: 'fa', permission: 'edit-worktree', cwd: w.repo, prompt: 'x' });
  updateJob(root, dir, { status: 'in-review', endedAt: new Date().toISOString(), origin: { session: 'chat-1' }, sprint: { id: s.id, ticket: 'ABC-11', task: 1, role: 'author' }, delivered: false, notifiedAt: new Date().toISOString() });
  await adoptSprint(root, s.id, 'chat-2', { project: loadSprint(root, s.id).project });
  const later = Date.now() + DAY;
  const folder = path.join(root, 'sprints', s.id);
  const stateDir = path.join(folder, 'state');
  const saved = fs.readdirSync(stateDir).filter((f) => f.endsWith('.json'));
  const backup = tempRoot();
  for (const f of saved) fs.copyFileSync(path.join(stateDir, f), path.join(backup, f));
  const restore = () => { for (const f of fs.readdirSync(stateDir)) fs.rmSync(path.join(stateDir, f), { force: true }); for (const f of saved) fs.copyFileSync(path.join(backup, f), path.join(stateDir, f)); };
  const refusedToAll = (why) => {
    for (const chat of ['chat-1', 'chat-2', 'chat-3']) assert.deepEqual(claimDelivery(root, job.id, chat, { now: later }), { claimed: false, reason: 'not-yours-yet' }, `${why}: ${chat}`);
  };
  // Missing: the folder is there, its state files are not (loadSprint says sprint-not-found).
  for (const f of fs.readdirSync(stateDir)) fs.rmSync(path.join(stateDir, f), { force: true });
  assert.throws(() => loadSprint(root, s.id), { code: 'sprint-not-found' });
  refusedToAll('missing state');
  restore();
  // Malformed: the newest state file is not JSON (and old enough not to be a write in progress).
  const newest = saved.sort((a, b) => Number(a.split('.')[0]) - Number(b.split('.')[0])).at(-1);
  fs.writeFileSync(path.join(stateDir, newest), '{"tickets": [');
  const old = new Date(Date.now() - 10 * 60_000);
  fs.utimesSync(path.join(stateDir, newest), old, old);
  assert.throws(() => loadSprint(root, s.id));
  refusedToAll('malformed state');
  restore();
  // Busy: every read fails for a moment.
  setReadHook(() => { throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }); });
  try {
    refusedToAll('busy');
  } finally {
    setReadHook(null);
  }
  // Readable again: the sprint's chat (chat-2) takes it, the old one doesn't.
  assert.deepEqual(claimDelivery(root, job.id, 'chat-1', { now: later }), { claimed: false, reason: 'not-yours-yet' });
  assert.deepEqual(claimDelivery(root, job.id, 'chat-2', { now: later }), { claimed: true });
});

test('podium sprint adopt moves the sprint to the chat given, and needs one', async () => {
  const { root, w } = sprintWorld();
  for (const name of ['fa', 'fr']) scriptAgent(root, name, []);
  const s = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo, session: 'chat-1' });
  const cli = async (argv) => {
    let out = '';
    const stdout = new Writable({ write(c, _e, cb) { out += c; cb(); } });
    await main(argv, { stdout, env: { ...process.env, PODIUM_DATA_DIR: root }, cwd: w.repo });
    return JSON.parse(out);
  };
  assert.equal((await cli(['sprint', 'adopt', '--id', s.id, '--session', 'chat-2'])).sprint.chat, 'chat-2');
  assert.equal(loadSprint(root, s.id).session, 'chat-2');
  assert.equal((await cli(['sprint', 'adopt', '--id', s.id])).error.code, 'missing-option');
});

test('adopting a sprint of another repo is refused, in plain words, and changes nothing; its own repo may', async () => {
  const { root, w } = sprintWorld();
  for (const name of ['fa', 'fr']) scriptAgent(root, name, []);
  const s = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo, session: 'chat-1' });
  const before = JSON.stringify(loadSprint(root, s.id));
  await assert.rejects(
    async () => adoptSprint(root, s.id, 'chat-2', { project: 'some-other-repo' }),
    (e) => e.name === 'PodiumError' && /belongs to another repo; take its updates from a chat in that repo/.test(e.message),
  );
  assert.equal(JSON.stringify(loadSprint(root, s.id)), before, 'the sprint is untouched');
  assert.equal(loadSprint(root, s.id).session, 'chat-1');
  const adopted = await adoptSprint(root, s.id, 'chat-2', { project: loadSprint(root, s.id).project });
  assert.equal(sprintSummary(root, adopted).chat, 'chat-2');
});

// ---- One channel (the sprint's messages) and a keyed outbox ----

const CLOSED = { match: ['pr', 'view'], stdout: { ...MERGED.stdout, state: 'CLOSED', mergeCommit: null } };
const MERGED_TEXT = 'ABC-11: Login form (PR #12) merged.';
const CLOSED_TEXT = 'ABC-11: Login form (PR #12) was closed without merging.';
const jobDirIn = (root, id) => listJobDirs(root).find((d) => d.endsWith(id));
// The keys a step holds for its sprint, in order, whatever shape they were written in.
const outbox = (j) => {
  const n = j.sprintNews;
  if (!n) return [];
  if (Array.isArray(n)) return n.map((x) => x.key);
  if (typeof n.key === 'string') return [n.key];
  return Object.keys(n);
};
// Every read of the sprint's state fails for a while (a scanner holding the file): the sprint can't take news.
const busyReads = () => setReadHook(() => { throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }); });
// gh answers "pr view" with this PR state from now on.
const answer = (w, state) => {
  const spec = JSON.parse(fs.readFileSync(w.env.PODIUM_FAKE_GH, 'utf8'));
  spec.responses = [spec.responses[0], { match: ['pr', 'view'], stdout: { ...MERGED.stdout, state, mergeCommit: state === 'MERGED' ? { oid: 'abc123' } : null } }];
  fs.writeFileSync(w.env.PODIUM_FAKE_GH, JSON.stringify(spec));
};
const noChatTakes = (root, id) => {
  for (const chat of ['chat-1', 'chat-2']) assert.equal(claimDelivery(root, id, chat, { now: Date.now() + DAY }).claimed, false, `${chat} is never offered it`);
};

test('news the sprint could not take is dropped once the sprint is archived: no job notice, and the sprint stays archived', async () => {
  const { root, w, s } = await shippedSprint([MERGED]);
  const id = s.tickets[0].latest;
  const dir = jobDirIn(root, id);
  busyReads();
  try {
    assert.equal((await refreshPr(root, id, { env: w.env })).status, 'merged');
    assert.deepEqual(outbox(readJob(dir)), ['pr:12:merged']);
    // The flush fails: the sprint is still busy. The news stays.
    await flushSprintNews(root, { waitMs: 100 });
    assert.deepEqual(outbox(readJob(dir)), ['pr:12:merged']);
  } finally {
    setReadHook(null);
  }
  // Then the sprint is archived (its tickets have ended and its messages were delivered).
  await locked(root, s.id, async ({ token }) => {
    const raw = loadSprint(root, s.id);
    for (const m of raw.messages) m.delivered = true;
    raw.archived = true;
    saveSprint(root, raw, { token });
  });
  const before = loadSprint(root, s.id).messages.length;
  await flushSprintNews(root);
  const after = readJob(dir);
  assert.deepEqual(outbox(after), [], 'the outbox is empty');
  assert.equal(after.delivered, true);
  const sprint = loadSprint(root, s.id);
  assert.equal(sprint.archived, true, 'the sprint is not unarchived');
  assert.equal(sprint.messages.length, before, 'nothing is queued into the archived sprint');
  assert.equal(sprint.messages.some((m) => m.key === 'pr:12:merged'), false);
  noChatTakes(root, id);
});

test('a sprint folder deleted while news is pending: two overlapping flushes give no job notice, delivered stays true, the outbox empties', async () => {
  const { root, w, s } = await shippedSprint([MERGED]);
  const id = s.tickets[0].latest;
  const dir = jobDirIn(root, id);
  busyReads();
  try {
    await refreshPr(root, id, { env: w.env });
  } finally {
    setReadHook(null);
  }
  assert.deepEqual(outbox(readJob(dir)), ['pr:12:merged']);
  fs.rmSync(path.join(root, 'sprints', s.id), { recursive: true, force: true });
  const flushes = [flushSprintNews(root), flushSprintNews(root)];
  await Promise.all(flushes);
  const after = readJob(dir);
  assert.equal(after.status, 'merged');
  assert.equal(after.delivered, true, 'delivered never goes back to false');
  assert.deepEqual(outbox(after), []);
  noChatTakes(root, id);
});

test('closed news kept, then the PR reopened and merged while the sprint is still busy: both are kept, and said once each, in order', async () => {
  const { root, w, s } = await shippedSprint([CLOSED]);
  const id = s.tickets[0].latest;
  const dir = jobDirIn(root, id);
  busyReads();
  try {
    assert.equal((await refreshPr(root, id, { env: w.env })).status, 'closed');
    answer(w, 'OPEN');
    assert.equal((await refreshPr(root, id, { env: w.env })).pr.state, 'OPEN');
    answer(w, 'MERGED');
    assert.equal((await refreshPr(root, id, { env: w.env })).status, 'merged');
    assert.deepEqual(outbox(readJob(dir)), ['pr:12:closed', 'pr:12:merged'], 'the merge did not replace the close');
    assert.equal(readJob(dir).delivered, true);
    noChatTakes(root, id);
  } finally {
    setReadHook(null);
  }
  await flushSprintNews(root);
  const said = loadSprint(root, s.id).messages.filter((m) => m.key?.startsWith('pr:12:'));
  assert.deepEqual(said.map((m) => [m.key, m.text]), [['pr:12:closed', CLOSED_TEXT], ['pr:12:merged', MERGED_TEXT]]);
  assert.deepEqual(outbox(readJob(dir)), []);
  await flushSprintNews(root);
  assert.equal(loadSprint(root, s.id).messages.filter((m) => m.key?.startsWith('pr:12:')).length, 2, 'a later flush says nothing more');
});

test('a flush overlapping a finisher: each key is said exactly once, and none stays in the outbox once said', async () => {
  const { root, w, s } = await shippedSprint([CLOSED]);
  const id = s.tickets[0].latest;
  const dir = jobDirIn(root, id);
  busyReads();
  try {
    await refreshPr(root, id, { env: w.env });
  } finally {
    setReadHook(null);
  }
  assert.deepEqual(outbox(readJob(dir)), ['pr:12:closed']);
  answer(w, 'MERGED');
  // The sprint is held: the finisher (the PR reopened and merged) waits on it, and a flush started alongside gives up.
  let release = null;
  const hold = locked(root, s.id, () => new Promise((r) => { release = r; }));
  await waitFor(() => release, { timeoutMs: 10_000 });
  const finisher = refreshPr(root, id, { env: w.env });
  const flush = flushSprintNews(root, { waitMs: 300 });
  await flush;
  release();
  await hold;
  assert.equal((await finisher).status, 'merged');
  const check = () => {
    const keys = loadSprint(root, s.id).messages.filter((m) => m.key?.startsWith('pr:12:')).map((m) => m.key);
    for (const k of outbox(readJob(dir))) assert.equal(keys.includes(k), false, `${k} was said and is still in the outbox`);
    return keys;
  };
  check();
  // Two more flushes overlapping each other.
  await Promise.all([flushSprintNews(root), flushSprintNews(root)]);
  assert.deepEqual(check().sort(), ['pr:12:closed', 'pr:12:merged']);
  assert.deepEqual(outbox(readJob(dir)), []);
  assert.equal(readJob(dir).delivered, true);
  noChatTakes(root, id);
});

test('a finisher whose sprint is free again tells the older kept key first: closed, then merged, and empties the outbox', async () => {
  const { root, w, s } = await shippedSprint([CLOSED]);
  const id = s.tickets[0].latest;
  const dir = jobDirIn(root, id);
  busyReads();
  try {
    await refreshPr(root, id, { env: w.env });
  } finally {
    setReadHook(null);
  }
  assert.deepEqual(outbox(readJob(dir)), ['pr:12:closed']);
  answer(w, 'MERGED');
  // No flush runs: the PR reopens and merges, and the sprint can take news again.
  assert.equal((await refreshPr(root, id, { env: w.env })).status, 'merged');
  const said = loadSprint(root, s.id).messages.filter((m) => m.key?.startsWith('pr:12:')).map((m) => m.key);
  assert.deepEqual(said, ['pr:12:closed', 'pr:12:merged']);
  assert.deepEqual(outbox(readJob(dir)), []);
  assert.equal(readJob(dir).delivered, true);
});

test('news written in the older single-event shape ({ key, text }) still flushes, once', async () => {
  const { root, s } = await shippedSprint();
  const id = s.tickets[0].latest;
  const dir = jobDirIn(root, id);
  updateJob(root, dir, { status: 'merged', delivered: true, sprintNews: { key: 'pr:12:merged', text: MERGED_TEXT } });
  await flushSprintNews(root);
  await flushSprintNews(root);
  assert.equal(loadSprint(root, s.id).messages.filter((m) => m.key === 'pr:12:merged').length, 1);
  assert.deepEqual(outbox(readJob(dir)), []);
});

test('a sprint step whose PR merged or closed is never a job notice, even undelivered and with its outbox empty', async () => {
  const { root, w } = sprintWorld();
  for (const name of ['fa', 'fr']) scriptAgent(root, name, []);
  const s = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo, session: 'chat-1' });
  for (const status of ['merged', 'closed']) {
    const { job, dir } = createJob(root, { project: 'demo', ticket: 'ABC-11', agent: 'fa', permission: 'edit-worktree', cwd: w.repo, prompt: 'x' });
    updateJob(root, dir, { status, endedAt: new Date().toISOString(), origin: { session: 'chat-1' }, sprint: { id: s.id, ticket: 'ABC-11', task: 1, role: 'author' }, delivered: false, sprintNews: null });
    noChatTakes(root, job.id);
  }
  // Nor once the sprint's folder is gone.
  fs.rmSync(path.join(root, 'sprints', s.id), { recursive: true, force: true });
  for (const d of listJobDirs(root)) noChatTakes(root, readJob(d).id);
});

test('podium sprint adopt checks the repo it is run in, and only adopts a sprint of that repo', async () => {
  const { root, w } = sprintWorld();
  for (const name of ['fa', 'fr']) scriptAgent(root, name, []);
  const s = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo, session: 'chat-1' });
  const elsewhere = tempRoot();
  const cli = async (argv, cwd) => {
    let out = '';
    const stdout = new Writable({ write(c, _e, cb) { out += c; cb(); } });
    await main(argv, { stdout, env: { ...process.env, PODIUM_DATA_DIR: root }, cwd });
    return JSON.parse(out);
  };
  // Run without --here too: the check does not depend on the caller remembering the flag.
  const refused = await cli(['sprint', 'adopt', '--id', s.id, '--session', 'chat-2'], elsewhere);
  assert.match(refused.error.message, /belongs to another repo/);
  assert.equal(loadSprint(root, s.id).session, 'chat-1');
  assert.equal((await cli(['sprint', 'adopt', '--id', s.id, '--session', 'chat-2', '--here'], w.repo)).sprint.chat, 'chat-2');
  assert.equal(loadSprint(root, s.id).session, 'chat-2');
});
