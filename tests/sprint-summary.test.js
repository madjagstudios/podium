// What the board reads, and a sprint whose state can't be read.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { draftSprint, startSprint, createSprint, loadSprint, saveSprint, tick, sprintSummary, sprintSummaries, claimMessages, archiveEnded, setReadHook } from '../engine/sprint.js';
import { ensureSprints } from '../engine/sprint-run.js';
import { main } from '../engine/cli.js';
import { scriptAgent, sprintWorld } from './helpers.js';
import { setSetting } from '../engine/settings.js';

const T = (over = {}) => ({ key: 'ABC-11', title: 'Login form', type: 'feat', plan: 'docs/plan.md', agent: 'fa', reviewer: 'fr', ...over });

async function cli(root, argv, cwd) {
  let out = '';
  const stdout = new Writable({ write(c, _e, cb) { out += c; cb(); } });
  await main(argv, { stdout, env: { ...process.env, PODIUM_DATA_DIR: root }, cwd });
  return JSON.parse(out);
}

test('the summary gives the board each task\'s writer, reviewer and progress, the newest step, and what may be done', async () => {
  const { root, w } = sprintWorld();
  for (const name of ['fa', 'fr']) scriptAgent(root, name, []);
  const d = await draftSprint(root, { name: 'Oct', tickets: [T(), T({ key: 'ABC-12', title: 'Payouts' }), T({ key: 'ABC-13', title: 'Export' })] }, { cwd: w.repo });
  const draft = sprintSummary(root, d);
  assert.equal(draft.draft, true);
  assert.equal(draft.maxParallel, 3);
  assert.deepEqual(draft.tickets[0].tasks, [
    { n: 1, title: 'Add a.txt', agent: 'fa', reviewer: 'fr', status: 'to-do', canAssign: true },
    { n: 2, title: 'Add b.txt', agent: 'fa', reviewer: 'fr', status: 'to-do', canAssign: true },
  ]);
  assert.deepEqual(draft.tickets.map((t) => [t.latest, t.canRetry, t.giveTo, t.canStop]), [[null, false, null, false], [null, false, null, false], [null, false, null, false]]);
  await startSprint(root, d.id);
  const raw = loadSprint(root, d.id);
  Object.assign(raw.tickets[0], { state: 'parked', task: 1, resume: 'review', latest: 'j-work', reason: 'Review failed twice on task 2', findings: 'Missing test.' });
  Object.assign(raw.tickets[1], { state: 'waiting', task: 2, resume: 'pr', reason: 'Trying again: opening the PR' });
  Object.assign(raw.tickets[2], { state: 'running', task: 0, phase: 'author', job: 'no-such-job', latest: 'no-such-job' });
  saveSprint(root, raw);
  const [a, b, c] = sprintSummary(root, loadSprint(root, d.id)).tickets;
  assert.deepEqual(a.tasks.map((x) => [x.status, x.canAssign]), [['done', false], ['current', true]]);
  assert.deepEqual([a.latest, a.canRetry, a.giveTo, a.canStop], ['j-work', true, 'reviewer', true]);
  assert.deepEqual(b.tasks.map((x) => x.status), ['done', 'done']);
  assert.deepEqual([b.canRetry, b.giveTo], [true, null], 'opening a PR runs no agent to give it to');
  assert.deepEqual(c.tasks.map((x) => [x.status, x.canAssign]), [['current', false], ['to-do', true]]);
  assert.equal(c.canStop, true, 'a running ticket whose step is gone may be stopped');
  assert.equal(c.giveTo, null);
});

test('a ticket whose step is still working cannot be stopped', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ write: 'a.txt', ms: 3000 }]);
  scriptAgent(root, 'fr', []);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  const s1 = await tick(root, s0.id, { env: w.env });
  const t = sprintSummary(root, s1).tickets[0];
  assert.equal(t.state, 'running');
  assert.equal(t.canStop, false);
  assert.equal(t.latest, s1.tickets[0].job);
});

test('a sprint whose saved state cannot be read comes back as a card saying so, in its own project only', async () => {
  const { root, w } = sprintWorld();
  for (const name of ['fa', 'fr']) scriptAgent(root, name, []);
  const d = await draftSprint(root, { name: 'Oct', tickets: [T()] }, { cwd: w.repo });
  saveSprint(root, loadSprint(root, d.id)); // version 2, so version 1 can still name it
  const state = path.join(root, 'sprints', d.id, 'state');
  const newest = fs.readdirSync(state).filter((f) => /^\d{12}\.json$/.test(f)).sort().at(-1);
  fs.writeFileSync(path.join(state, newest), '{"id": "brok');
  const [card] = sprintSummaries(root, { project: d.project });
  assert.equal(card.id, d.id);
  assert.equal(card.name, 'Oct');
  assert.match(card.unreadable, /is damaged/);
  assert.deepEqual(card.tickets, []);
  assert.deepEqual(sprintSummaries(root, { project: 'elsewhere' }), [], 'its project is still known');
  const here = await cli(root, ['status', '--here'], w.repo);
  assert.equal(here.sprints[0].id, d.id);
  assert.match(here.sprints[0].unreadable, /is damaged/);
  const tool = await cli(root, ['sprint', 'status', '--here'], w.repo);
  assert.match(tool.sprints[0].unreadable, /is damaged/);
});

test('a sprint whose saved state cannot be read gets no runner, gives no news and is not archived, and nothing reads an older state', async () => {
  const { root, w } = sprintWorld();
  for (const name of ['fa', 'fr']) scriptAgent(root, name, []);
  const d = await draftSprint(root, { name: 'Oct', tickets: [T()] }, { cwd: w.repo });
  await startSprint(root, d.id);
  // An older version holds news waiting to be delivered; the newest one is damaged.
  const raw = loadSprint(root, d.id);
  raw.messages.push({ id: String(raw.messages.length + 1), at: new Date().toISOString(), text: 'Old news', delivered: false, claimedAt: null });
  saveSprint(root, raw);
  saveSprint(root, raw);
  const state = path.join(root, 'sprints', d.id, 'state');
  const files = () => fs.readdirSync(state).filter((f) => /^\d{12}\.json$/.test(f)).sort();
  fs.writeFileSync(path.join(state, files().at(-1)), '');
  const before = files();
  assert.deepEqual(ensureSprints(root, { spawn: () => assert.fail('an unreadable sprint never gets a runner') }).started, []);
  assert.deepEqual((await claimMessages(root, 'chat-1', { waitMs: 0 })).messages, [], 'no news from an older state');
  const cards = sprintSummaries(root);
  assert.deepEqual(cards.map((c) => [c.id, c.news, c.tickets.length]), [[d.id, 0, 0]]);
  await archiveEnded(root, cards);
  assert.deepEqual(files(), before, 'nothing was written');
  await assert.rejects(tick(root, d.id, { env: w.env }), (e) => e.code === 'sprint-damaged');
});

test('a momentary read failure (sprint-busy) is a busy marker, not a card, while real damage still is a card', async (t) => {
  const { root, w } = sprintWorld();
  for (const name of ['fa', 'fr']) scriptAgent(root, name, []);
  const d = await draftSprint(root, { name: 'Oct', tickets: [T()] }, { cwd: w.repo });
  // The newest state file keeps vanishing mid-read (a prune or a commit elsewhere): readState gives up with sprint-busy.
  setReadHook((f) => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); });
  t.after(() => setReadHook(null));
  assert.throws(() => loadSprint(root, d.id), (e) => e.code === 'sprint-busy');
  assert.deepEqual(sprintSummaries(root, { project: d.project }), [{ id: d.id, busy: true }]);
  const here = await cli(root, ['status', '--here'], w.repo);
  assert.deepEqual(here.sprints, [{ id: d.id, busy: true }], 'archiveEnded passes over the marker too');
  setReadHook(null);
  const [back] = sprintSummaries(root, { project: d.project });
  assert.equal(back.busy, undefined);
  assert.equal(back.name, 'Oct');
});

test('a summary bug (not a Podium error) shows on the card in plain words, not as a raw message', async () => {
  const { root, w } = sprintWorld();
  for (const name of ['fa', 'fr']) scriptAgent(root, name, []);
  const d = await draftSprint(root, { name: 'Oct', tickets: [T()] }, { cwd: w.repo });
  const raw = loadSprint(root, d.id);
  raw.tickets[0].tasks = null; // sprintSummary maps it: a TypeError, not a PodiumError
  saveSprint(root, raw);
  const [card] = sprintSummaries(root, { project: d.project });
  assert.equal(card.id, d.id);
  assert.match(card.unreadable, /^Podium could not show this sprint \(.+\)\.?$/);
  assert.doesNotMatch(card.unreadable, /^Cannot read/);
  assert.deepEqual(card.tickets, []);
});

// The CLI takes a spawn so these never start a real runner.
const boom = () => { throw new Error('cannot start the runner'); };
async function cliSpawn(root, argv, cwd, spawn) {
  let out = '';
  const stdout = new Writable({ write(c, _e, cb) { out += c; cb(); } });
  await main(argv, { stdout, env: { ...process.env, PODIUM_DATA_DIR: root }, cwd, spawn });
  return JSON.parse(out);
}

test('Start, Resume and Retry still report success when the runner cannot be started afterwards', async () => {
  const { root, w } = sprintWorld();
  for (const name of ['fa', 'fr']) scriptAgent(root, name, []);
  const d = await draftSprint(root, { name: 'Oct', tickets: [T()] }, { cwd: w.repo });
  const started = await cliSpawn(root, ['sprint', 'start', '--id', d.id], w.repo, boom);
  assert.equal(started.error, undefined);
  assert.equal(started.sprint.draft, false, 'the sprint did start');
  await cliSpawn(root, ['sprint', 'pause', '--id', d.id], w.repo, boom);
  const resumed = await cliSpawn(root, ['sprint', 'resume', '--id', d.id], w.repo, boom);
  assert.equal(resumed.error, undefined);
  assert.equal(resumed.sprint.paused, false);
  const raw = loadSprint(root, d.id);
  Object.assign(raw.tickets[0], { state: 'parked', resume: 'author', reason: 'Stuck' });
  saveSprint(root, raw);
  const retried = await cliSpawn(root, ['sprint', 'retry', '--id', d.id, '--ticket', 'ABC-11'], w.repo, boom);
  assert.equal(retried.error, undefined);
  assert.equal(retried.sprint.tickets[0].state, 'waiting');
});

// Two pending tickets and one free slot. The tick starts them in ticket order, so only the first one
// is starting; the second waits for a free slot. A ticket held back by "after" takes no slot ahead of the others.
test('pending tickets share the free slots in ticket order', async () => {
  const { root, w } = sprintWorld();
  for (const name of ['fa', 'fr']) scriptAgent(root, name, []);
  const keys = ['ABC-11', 'ABC-12', 'ABC-13', 'ABC-14', 'ABC-15'];
  const s0 = await createSprint(root, { name: 'x', tickets: keys.map((key) => T({ key, title: key, ...(key === 'ABC-13' ? { after: ['ABC-11'] } : {}) })) }, { cwd: w.repo });
  const raw = loadSprint(root, s0.id);
  assert.equal(raw.maxParallel, 3);
  for (const t of raw.tickets.slice(0, 2)) Object.assign(t, { state: 'running', phase: 'author', job: 'no-such-job' });
  saveSprint(root, raw);
  const slots = sprintSummary(root, loadSprint(root, s0.id)).tickets.map((t) => [t.key, t.slot]);
  assert.deepEqual(slots, [['ABC-11', null], ['ABC-12', null], ['ABC-13', null], ['ABC-14', 'free'], ['ABC-15', 'full']]);
});

test('a pending ticket says whether a slot is free for it', async () => {
  const { root, w } = sprintWorld();
  for (const name of ['fa', 'fr']) scriptAgent(root, name, []);
  setSetting(root, 'sprintParallel', 1);
  const s0 = await createSprint(root, { name: 'x', tickets: [T(), T({ key: 'ABC-12', title: 'Payouts' })] }, { cwd: w.repo });
  const busy = loadSprint(root, s0.id);
  Object.assign(busy.tickets[0], { state: 'running', phase: 'author', job: 'no-such-job' });
  saveSprint(root, busy);
  const [a, b] = sprintSummary(root, loadSprint(root, s0.id)).tickets;
  assert.equal(a.slot, null);
  assert.equal(b.slot, 'full');
  const freed = loadSprint(root, s0.id);
  freed.tickets[0].state = 'parked';
  saveSprint(root, freed);
  assert.equal(sprintSummary(root, loadSprint(root, s0.id)).tickets[1].slot, 'free');
  const paused = loadSprint(root, s0.id);
  paused.paused = true;
  saveSprint(root, paused);
  assert.equal(sprintSummary(root, loadSprint(root, s0.id)).tickets[1].slot, null);
});
