import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Writable, Readable } from 'node:stream';
import { createSprint, tick, loadSprint, setPaused, saveSprint, retryTicket } from '../engine/sprint.js';
import { ensureSprints, sprintLoop, beatOf } from '../engine/sprint-run.js';
import { main } from '../engine/cli.js';
import path from 'node:path';
import { listJobDirs, readJob } from '../engine/store.js';
import { waitFor, scriptAgent, sprintWorld } from './helpers.js';

const T = (over = {}) => ({ key: 'ABC-11', title: 'Login form', type: 'feat', plan: 'docs/plan.md', agent: 'fa', reviewer: 'fr', ...over });
const draft = (tickets) => ({ name: 'Test sprint', tickets });
// Tick until `until(sprint)` holds; each tick re-reads the sprint's state, as a restarted runner would.
const run = (root, id, env, until, { now } = {}) => waitFor(async () => {
  const s = await tick(root, id, { env, now: now ? now() : Date.now() });
  return until(s) ? s : null;
}, { timeoutMs: 90_000, intervalMs: 150 });
const jobsBy = (root, role) => listJobDirs(root).map(readJob).filter((j) => j.sprint?.role === role).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
const promptOf = (root, job) => fs.readFileSync(path.join(listJobDirs(root).find((d) => d.endsWith(job.id)), 'prompt.md'), 'utf8');

async function cli(root, argv, { stdin = '', cwd } = {}) {
  let out = '';
  const stdout = new Writable({ write(c, _e, cb) { out += c; cb(); } });
  const code = await main(argv, { stdout, stdin: Readable.from([stdin]), env: { ...process.env, PODIUM_DATA_DIR: root }, cwd });
  return { code, body: JSON.parse(out) };
}

test('ensureSprints starts a runner only for a sprint that needs one and has no live heartbeat', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', []);
  scriptAgent(root, 'fr', []);
  const s = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  const spawned = [];
  const spawn = (script, args) => { spawned.push(args); return 1; };
  assert.deepEqual(ensureSprints(root, { spawn }).started, [s.id]);
  fs.writeFileSync(beatOf(root, s.id), JSON.stringify({ pid: process.pid, at: Date.now() }));
  assert.deepEqual(ensureSprints(root, { spawn }).started, [], 'a live runner is left alone');
  fs.writeFileSync(beatOf(root, s.id), JSON.stringify({ pid: process.pid, at: Date.now() - 10 * 60_000 }));
  assert.deepEqual(ensureSprints(root, { spawn }).started, [s.id], 'a stale heartbeat is replaced');
  assert.deepEqual(spawned[0], [root, s.id]);
});

test('sprintLoop ticks until nothing is left for it, writing a heartbeat, then removes it', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ err: 'boom', exit: 3 }]);
  scriptAgent(root, 'fr', []);
  const s = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  let beats = 0;
  await sprintLoop(root, s.id, { env: w.env, sleep: async () => { if (fs.existsSync(beatOf(root, s.id))) beats++; await new Promise((r) => setTimeout(r, 100)); } });
  assert.ok(beats > 0);
  assert.equal(loadSprint(root, s.id).tickets[0].state, 'parked');
  assert.equal(fs.existsSync(beatOf(root, s.id)), false);
});

test('sprintLoop records a tick that throws in runner.json, carries on, and ends when nothing is left', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', []);
  scriptAgent(root, 'fr', []);
  const s = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  let ticks = 0;
  let seen = null;
  const tickFn = async () => { ticks++; throw new Error('disk full'); };
  const sleep = async () => {
    seen = JSON.parse(fs.readFileSync(beatOf(root, s.id), 'utf8'));
    await setPaused(root, s.id, true); // nothing left for the runner after this
  };
  await sprintLoop(root, s.id, { env: w.env, sleep, tickFn });
  assert.equal(ticks, 2, 'the loop carried on after the first error');
  assert.equal(seen.pid, process.pid);
  assert.equal(seen.lastError, 'disk full');
  assert.ok(Date.parse(seen.errorAt));
  const left = JSON.parse(fs.readFileSync(beatOf(root, s.id), 'utf8'));
  assert.equal(left.lastError, 'disk full', 'the trace stays after the loop');
  assert.equal(left.pid, null);
  assert.deepEqual(ensureSprints(root, { spawn: () => 1 }).started, [], 'paused: no runner wanted');
});

test('the CLI shows, pauses and resumes a sprint, and status --here lists it', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', []);
  scriptAgent(root, 'fr', []);
  const s = await createSprint(root, { name: 'Oct week 2', tickets: [T()] }, { cwd: w.repo, session: 'chat-1' });
  const st = await cli(root, ['sprint', 'status', '--here'], { cwd: w.repo });
  assert.equal(st.code, 0);
  assert.equal(st.body.sprints[0].name, 'Oct week 2');
  assert.equal(st.body.sprints[0].tickets[0].state, 'pending');
  const paused = await cli(root, ['sprint', 'pause', '--id', s.id]);
  assert.equal(paused.body.sprint.paused, true);
  const here = await cli(root, ['status', '--here'], { cwd: w.repo });
  assert.equal(here.body.sprints.length, 1);
  assert.deepEqual(here.body.jobs, []);
  const inbox = await cli(root, ['sprint', 'inbox', '--session', 'chat-1']);
  assert.deepEqual(inbox.body, { messages: [] });
  const bad = await cli(root, ['sprint', 'nope']);
  assert.equal(bad.code, 1);
  assert.equal(bad.body.error.code, 'unknown-command');
});

// A wake-up (a merge's ensureSprints) that reads the heartbeat just before the runner clears it starts no runner, so
// the runner looks once more after clearing it.
test('sprintLoop goes on when the sprint wants a runner again just as it clears its heartbeat', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', []);
  scriptAgent(root, 'fr', []);
  const s = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  const park = () => { const raw = loadSprint(root, s.id); Object.assign(raw.tickets[0], { state: 'parked', reason: 'x', resume: 'author' }); saveSprint(root, raw); };
  park();
  let ticks = 0;
  let releases = 0;
  const tickFn = async () => { ticks++; if (ticks === 2) park(); };
  const released = async () => {
    releases++;
    assert.equal(fs.existsSync(beatOf(root, s.id)), false, 'the heartbeat is cleared first');
    if (releases === 1) await retryTicket(root, s.id, 'ABC-11');
  };
  await sprintLoop(root, s.id, { env: w.env, sleep: async () => {}, tickFn, released });
  assert.equal(ticks, 2, 'it ticked again for the wake-up it would have missed');
  assert.equal(releases, 2);
  assert.equal(fs.existsSync(beatOf(root, s.id)), false);
});

test('a writer that changes no files parks with "made no changes", quoting its report, and Retry runs it again', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ say: 'I read the ticket key but could not open it.', tests: 'passed' }, { write: 'a.txt' }, { write: 'b.txt' }]);
  scriptAgent(root, 'fr', [{ say: 'VERDICT: pass' }, { say: 'VERDICT: pass' }]);
  const s0 = await createSprint(root, draft([T()]), { cwd: w.repo });
  const parked = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  const t = parked.tickets[0];
  assert.equal(t.reason, 'Fa made no changes for task 1');
  assert.equal(t.resume, 'author');
  assert.ok(t.findings.endsWith('I read the ticket key but could not open it.'), t.findings);
  assert.deepEqual(jobsBy(root, 'reviewer'), [], 'nothing went to review');
  assert.match(parked.messages.at(-1).text, /needs you: Fa made no changes for task 1/);
  await retryTicket(root, s0.id, 'ABC-11');
  const done = await run(root, s0.id, w.env, (x) => ['pr-open', 'parked'].includes(x.tickets[0].state));
  assert.equal(done.tickets[0].state, 'pr-open', done.tickets[0].reason);
  assert.equal(jobsBy(root, 'reviewer').length, 2);
});

test('a writer that changes nothing but says why goes to review, and the reviewer is told', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ say: 'CHANGES: none-needed: a.txt already says this', tests: 'none-needed: nothing changed' }, { write: 'b.txt' }]);
  scriptAgent(root, 'fr', [{ say: 'VERDICT: pass' }, { say: 'VERDICT: pass' }]);
  const s0 = await createSprint(root, draft([T()]), { cwd: w.repo });
  const s = await run(root, s0.id, w.env, (x) => ['pr-open', 'parked'].includes(x.tickets[0].state));
  assert.equal(s.tickets[0].state, 'pr-open', s.tickets[0].reason);
  const review = promptOf(root, jobsBy(root, 'reviewer')[0]);
  assert.ok(review.includes('The writer changed no files and said none were needed:'), review);
  assert.ok(review.includes('a.txt already says this'), review);
});

test('a writer that changes files but also says none were needed is reviewed as a change, without the no-change note', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ write: 'a.txt', say: 'CHANGES: none-needed: the tests already cover it' }, { write: 'b.txt' }]);
  scriptAgent(root, 'fr', [{ say: 'VERDICT: pass' }, { say: 'VERDICT: pass' }]);
  const s0 = await createSprint(root, draft([T()]), { cwd: w.repo });
  const s = await run(root, s0.id, w.env, (x) => ['pr-open', 'parked'].includes(x.tickets[0].state));
  assert.equal(s.tickets[0].state, 'pr-open', s.tickets[0].reason);
  const review = promptOf(root, jobsBy(root, 'reviewer')[0]);
  assert.ok(review.includes('a.txt'), 'the change is in the review');
  assert.ok(!review.includes('The writer changed no files'), review);
});

test('a writer that commits its own work, leaving the copy clean, is not parked for making no changes', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ write: 'a.txt', commit: 'mine' }, { write: 'b.txt', commit: 'mine too' }]);
  scriptAgent(root, 'fr', [{ say: 'VERDICT: pass' }, { say: 'VERDICT: pass' }]);
  const s0 = await createSprint(root, draft([T()]), { cwd: w.repo });
  const s = await run(root, s0.id, w.env, (x) => ['pr-open', 'parked'].includes(x.tickets[0].state));
  assert.equal(s.tickets[0].state, 'pr-open', s.tickets[0].reason);
  assert.equal(jobsBy(root, 'reviewer').length, 2, 'each task went to review');
});
