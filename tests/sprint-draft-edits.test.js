// The draft board's edits, all through change().
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { draftSprint, createSprint, discardSprint, loadSprint, moveTicket, removeTicket, assignTicket, assignTask, setSprintOptions, stopTicket, MAX_AT_ONCE } from '../engine/sprint.js';
import { main } from '../engine/cli.js';
import { scriptAgent, sprintWorld } from './helpers.js';

const T = (over = {}) => ({ key: 'ABC-11', title: 'Login form', type: 'feat', plan: 'docs/plan.md', agent: 'fa', reviewer: 'fr', ...over });
const THREE = [T(), T({ key: 'ABC-12', title: 'Payouts' }), T({ key: 'ABC-13', title: 'Export' })];
const keys = (s) => s.tickets.map((t) => t.key);
const versions = (root, id) => fs.readdirSync(path.join(root, 'sprints', id, 'state')).filter((f) => /^\d{12}\.json$/.test(f)).length;

async function draftWorld(tickets = THREE) {
  const { root, w } = sprintWorld();
  for (const name of ['fa', 'fb', 'fr']) scriptAgent(root, name, []);
  const d = await draftSprint(root, { name: 'Oct', tickets }, { cwd: w.repo });
  return { root, w, id: d.id };
}

async function cli(root, argv) {
  let out = '';
  const stdout = new Writable({ write(c, _e, cb) { out += c; cb(); } });
  const code = await main(argv, { stdout, env: { ...process.env, PODIUM_DATA_DIR: root } });
  return { code, body: JSON.parse(out) };
}

test('a draft ticket moves up and down; at either end nothing is saved', async () => {
  const { root, id } = await draftWorld();
  assert.deepEqual(keys(await moveTicket(root, id, 'abc-13', 'up')), ['ABC-11', 'ABC-13', 'ABC-12']);
  assert.deepEqual(keys(await moveTicket(root, id, 'ABC-11', 'down')), ['ABC-13', 'ABC-11', 'ABC-12']);
  const before = versions(root, id);
  assert.deepEqual(keys(await moveTicket(root, id, 'ABC-13', 'up')), ['ABC-13', 'ABC-11', 'ABC-12']);
  assert.equal(versions(root, id), before, 'already first: no new version');
  await assert.rejects(moveTicket(root, id, 'ABC-11', 'sideways'), (e) => e.code === 'bad-value');
  await assert.rejects(moveTicket(root, id, 'ABC-99', 'up'), (e) => e.code === 'no-such-ticket');
});

test('a draft keeps at least one ticket', async () => {
  const { root, id } = await draftWorld([T(), T({ key: 'ABC-12', title: 'Payouts' })]);
  assert.deepEqual(keys(await removeTicket(root, id, 'ABC-11')), ['ABC-12']);
  await assert.rejects(removeTicket(root, id, 'ABC-12'), (e) => e.code === 'last-ticket' && e.message === 'A sprint needs at least one ticket. Discard the draft instead.');
});

test('a ticket\'s writer and reviewer are set for all its tasks, and one task\'s for that task alone', async () => {
  const { root, id } = await draftWorld();
  const all = await assignTicket(root, id, 'ABC-12', { agent: 'fb' });
  assert.deepEqual(all.tickets[1].tasks.map((x) => [x.agent, x.reviewer]), [['fb', 'fr'], ['fb', 'fr']]);
  assert.deepEqual(all.tickets[0].tasks.map((x) => x.agent), ['fa', 'fa'], 'other tickets keep theirs');
  const one = await assignTask(root, id, 'ABC-12', 2, { reviewer: 'fa' });
  assert.deepEqual(one.tickets[1].tasks.map((x) => [x.agent, x.reviewer]), [['fb', 'fr'], ['fb', 'fa']]);
  await assert.rejects(assignTicket(root, id, 'ABC-12', { agent: 'ghost' }), (e) => e.code === 'unknown-agent');
  await assert.rejects(assignTicket(root, id, 'ABC-12', {}), (e) => e.code === 'nothing-to-change');
});

test('Merge when green and At once (1 to 5) are set on the draft', async () => {
  const { root, id } = await draftWorld();
  const s = await setSprintOptions(root, id, { mergeWhenGreen: true, atOnce: 2 });
  assert.equal(s.autoMerge, true);
  assert.equal(s.maxParallel, 2);
  assert.equal((await setSprintOptions(root, id, { mergeWhenGreen: false })).autoMerge, false);
  for (const bad of [0, 6, 2.5, 'x']) {
    await assert.rejects(setSprintOptions(root, id, { atOnce: bad }), (e) => e.code === 'bad-value' && e.message === `At once must be a whole number from 1 to ${MAX_AT_ONCE}.`, String(bad));
  }
  await assert.rejects(setSprintOptions(root, id, {}), (e) => e.code === 'nothing-to-change');
});

test('once started, the draft edits are refused; a task that ran or a ticket that ended cannot be reassigned', async () => {
  const { root, w } = sprintWorld();
  for (const name of ['fa', 'fb', 'fr']) scriptAgent(root, name, []);
  const s = await createSprint(root, { name: 'Run', tickets: [T(), T({ key: 'ABC-12', title: 'Payouts' })] }, { cwd: w.repo });
  const started = (e) => e.code === 'not-a-draft';
  await assert.rejects(moveTicket(root, s.id, 'ABC-12', 'up'), started);
  await assert.rejects(removeTicket(root, s.id, 'ABC-12'), started);
  await assert.rejects(assignTicket(root, s.id, 'ABC-12', { agent: 'fb' }), started);
  await assert.rejects(setSprintOptions(root, s.id, { atOnce: 2 }), started);
  assert.equal((await assignTask(root, s.id, 'ABC-12', 1, { agent: 'fb' })).tickets[1].tasks[0].agent, 'fb', 'a task not yet run still can');
  await stopTicket(root, s.id, 'ABC-12');
  await assert.rejects(assignTask(root, s.id, 'ABC-12', 2, { agent: 'fa' }), (e) => e.code === 'ticket-ended');
});

test('one task\'s writer and reviewer can be set on a draft, which stays a draft', async () => {
  const { root, id } = await draftWorld();
  const s = await assignTask(root, id, 'ABC-11', 1, { agent: 'fb', reviewer: 'fa' });
  assert.deepEqual(s.tickets[0].tasks.map((x) => [x.agent, x.reviewer]), [['fb', 'fa'], ['fa', 'fr']]);
  assert.equal(s.draft, true);
});

test('a thrown-away draft refuses every edit as discarded', async () => {
  const { root, id } = await draftWorld();
  await discardSprint(root, id);
  const gone = (e) => e.code === 'discarded';
  await assert.rejects(moveTicket(root, id, 'ABC-12', 'up'), gone);
  await assert.rejects(removeTicket(root, id, 'ABC-12'), gone);
  await assert.rejects(assignTicket(root, id, 'ABC-12', { agent: 'fb' }), gone);
  await assert.rejects(setSprintOptions(root, id, { atOnce: 2 }), gone);
  // One task's writer or reviewer too: the thrown-away draft must not change.
  const before = versions(root, id);
  await assert.rejects(assignTask(root, id, 'ABC-12', 1, { agent: 'fb' }), gone);
  await assert.rejects(assignTask(root, id, 'ABC-12', 1, { reviewer: 'fa' }), gone);
  assert.equal(versions(root, id), before, 'nothing saved');
  assert.equal(loadSprint(root, id).tickets.find((t) => t.key === 'ABC-12').tasks[0].agent, 'fa');
});

test('the CLI makes the same draft changes', async () => {
  const { root, id } = await draftWorld();
  const moved = await cli(root, ['sprint', 'move', '--id', id, '--ticket', 'ABC-12', '--to', 'up']);
  assert.deepEqual(moved.body.sprint.tickets.map((t) => t.key), ['ABC-12', 'ABC-11', 'ABC-13']);
  assert.equal((await cli(root, ['sprint', 'remove', '--id', id, '--ticket', 'ABC-13'])).code, 0);
  assert.equal((await cli(root, ['sprint', 'assign', '--id', id, '--ticket', 'ABC-11', '--agent', 'fb'])).code, 0);
  assert.equal((await cli(root, ['sprint', 'assign', '--id', id, '--ticket', 'ABC-11', '--task', '2', '--reviewer', 'fa'])).code, 0);
  assert.equal((await cli(root, ['sprint', 'options', '--id', id, '--merge-when-green', 'true', '--at-once', '4'])).code, 0);
  const s = loadSprint(root, id);
  assert.deepEqual(keys(s), ['ABC-12', 'ABC-11']);
  assert.deepEqual(s.tickets[1].tasks.map((x) => [x.agent, x.reviewer]), [['fb', 'fr'], ['fb', 'fa']]);
  assert.deepEqual([s.autoMerge, s.maxParallel], [true, 4]);
  assert.equal((await cli(root, ['sprint', 'options', '--id', id, '--at-once'])).body.error.code, 'missing-option');
});

test('a ticket title is trimmed and its line breaks become single spaces when drafted', async () => {
  const { id, root } = await draftWorld([T({ title: '  Login form\r\n  with a\nremember box \n' }), T({ key: 'ABC-12', title: ' \n ' })]);
  const s = loadSprint(root, id);
  assert.equal(s.tickets[0].title, 'Login form with a remember box');
  assert.equal(s.tickets[1].title, 'ABC-12', 'a blank title falls back to the key');
});
