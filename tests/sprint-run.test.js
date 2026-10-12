import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Writable, Readable } from 'node:stream';
import { createSprint, tick, loadSprint, setPaused, saveSprint, retryTicket } from '../engine/sprint.js';
import { ensureSprints, sprintLoop, beatOf } from '../engine/sprint-run.js';
import { main } from '../engine/cli.js';
import { waitFor, scriptAgent, sprintWorld } from './helpers.js';

const T = (over = {}) => ({ key: 'ABC-11', title: 'Login form', type: 'feat', plan: 'docs/plan.md', agent: 'fa', reviewer: 'fr', ...over });

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
