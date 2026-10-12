// A ticket may be drafted without a plan. Its writer plans it first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable, Readable } from 'node:stream';
import { draftSprint, startSprint, createSprint, loadSprint, saveSprint, sprintSummary, assignTask, assignTicket, draftNotes } from '../engine/sprint.js';
import { main } from '../engine/cli.js';
import { scriptAgent, sprintWorld } from './helpers.js';

const T = (over = {}) => ({ key: 'ABC-11', title: 'Login form', type: 'feat', plan: 'docs/plan.md', agent: 'fa', reviewer: 'fr', ...over });
const P = (over = {}) => ({ key: 'ABC-14', title: 'Export to CSV', type: 'feat', agent: 'fa', reviewer: 'fr', summary: 'Users want their payouts as CSV.', ...over });

function world() {
  const { root, w } = sprintWorld();
  for (const name of ['fa', 'fb', 'fr']) scriptAgent(root, name, []);
  return { root, w };
}

// The CLI takes a spawn so Start never starts a real runner here.
const NO_RUNNER = () => { throw new Error('no runner in tests'); };
async function cli(root, argv, { stdin = '', cwd } = {}) {
  let out = '';
  const stdout = new Writable({ write(c, _e, cb) { out += c; cb(); } });
  const code = await main(argv, { stdout, stdin: Readable.from([stdin]), env: { ...process.env, PODIUM_DATA_DIR: root }, cwd, spawn: NO_RUNNER });
  return { code, body: JSON.parse(out) };
}

test('a ticket may be drafted without a plan: its writer plans it, and its reviewer reviews its tasks', async () => {
  const { root, w } = world();
  const d = await draftSprint(root, { name: 'Oct', tickets: [P(), T()] }, { cwd: w.repo });
  const t = d.tickets[0];
  assert.deepEqual([t.plan, t.agent, t.reviewer, t.tasks, t.summary, t.after, t.proposed, t.asked], [null, 'fa', 'fr', [], 'Users want their payouts as CSV.', [], null, null]);
  assert.equal(d.tickets[1].summary, null);
  assert.deepEqual(d.tickets[1].after, []);
  assert.deepEqual(sprintSummary(root, d).tickets[0], {
    key: 'ABC-14', title: 'Export to CSV', state: 'pending', task: 0, of: 0, phase: null, agent: 'fa', reason: null, findings: null, pr: null, reviews: 0,
    latest: null, tasks: [], canRetry: false, giveTo: null, canStop: false,
    plan: null, writer: 'fa', reviewer: 'fr', canAssignPlan: true, after: [], waitingOn: [], slot: null,
    proposed: null, canApprove: false, canOneTask: false, canRevise: false,
  });
  const byDefault = await draftSprint(root, { name: 'x', agent: 'fb', reviewer: 'fr', tickets: [P({ key: 'ABC-15', title: 'Import', agent: undefined, reviewer: undefined })] }, { cwd: w.repo });
  assert.deepEqual([byDefault.tickets[0].agent, byDefault.tickets[0].reviewer], ['fb', 'fr'], 'the sprint\'s writer and reviewer stand in');
  const long = await draftSprint(root, { name: 'y', tickets: [P({ key: 'ABC-16', title: 'Long', summary: 'x'.repeat(30_000) })] }, { cwd: w.repo });
  assert.equal(long.tickets[0].summary.length, 20_000);
});

test('a ticket without a plan needs a writer and a reviewer, and takes no task overrides', async () => {
  const { root, w } = world();
  const bad = async (ticket, code, message) => assert.rejects(draftSprint(root, { name: 'x', tickets: [ticket] }, { cwd: w.repo }), (e) => e.code === code && e.message === message);
  await bad(P({ agent: undefined }), 'no-agent', 'ABC-14 has no plan yet and no writer to plan it.');
  await bad(P({ reviewer: undefined }), 'no-agent', 'ABC-14 has no plan yet and no reviewer for its tasks.');
  await bad(P({ reviewer: 'ghost' }), 'unknown-agent', 'No agent called "ghost" (ABC-14).');
  await bad(P({ tasks: [{ n: 1, agent: 'fb' }] }), 'no-such-task', "ABC-14 has no plan yet, so its tasks can't be set. Set its writer and reviewer instead.");
  await bad(P({ plan: 'docs/missing.md' }), 'no-plan', "ABC-14's plan docs/missing.md is not in the repo.");
});

test('Start checks a plan-less ticket\'s writer and reviewer again', async () => {
  const { root, w } = world();
  const d = await draftSprint(root, { name: 'x', tickets: [P()] }, { cwd: w.repo });
  const s = loadSprint(root, d.id);
  s.tickets[0].agent = 'ghost';
  saveSprint(root, s);
  await assert.rejects(startSprint(root, d.id), (e) => e.code === 'unknown-agent' && e.message === 'No agent called "ghost" (ABC-14\'s writer).');
  assert.equal(loadSprint(root, d.id).draft, true);
  const ok = await createSprint(root, { name: 'y', tickets: [P({ key: 'ABC-15', title: 'Import' })] }, { cwd: w.repo });
  assert.equal(ok.draft, false);
});

test('a plan-less ticket\'s writer and reviewer change on the draft, and as task 0 until its plan is written', async () => {
  const { root, w } = world();
  const d = await draftSprint(root, { name: 'x', tickets: [P(), T()] }, { cwd: w.repo });
  let s = await assignTicket(root, d.id, 'ABC-14', { agent: 'fb' });
  assert.deepEqual([s.tickets[0].agent, s.tickets[0].reviewer], ['fb', 'fr']);
  s = await assignTask(root, d.id, 'abc-14', 0, { reviewer: 'fb' });
  assert.deepEqual([s.tickets[0].agent, s.tickets[0].reviewer], ['fb', 'fb']);
  await assert.rejects(assignTask(root, d.id, 'ABC-11', 0, { agent: 'fb' }), (e) => e.code === 'no-such-task' && e.message === 'ABC-11 has no task 0.');
  await assert.rejects(assignTask(root, d.id, 'ABC-14', 1, { agent: 'fb' }), (e) => e.code === 'no-such-task');
  await assert.rejects(assignTask(root, d.id, 'ABC-14', 0, { agent: 'ghost' }), (e) => e.code === 'unknown-agent');
  const raw = loadSprint(root, d.id);
  raw.tickets[0].state = 'running';
  saveSprint(root, raw);
  await assert.rejects(assignTask(root, d.id, 'ABC-14', 0, { agent: 'fa' }), (e) => e.code === 'task-started' && e.message === "ABC-14's plan is being written right now.");
  assert.equal(sprintSummary(root, loadSprint(root, d.id)).tickets[0].canAssignPlan, false);
});

test('the CLI sets a plan-less ticket\'s writer as task 0', async () => {
  const { root, w } = world();
  const d = await draftSprint(root, { name: 'x', tickets: [P()] }, { cwd: w.repo });
  const r = await cli(root, ['sprint', 'assign', '--id', d.id, '--ticket', 'ABC-14', '--task', '0', '--agent', 'fb']);
  assert.equal(r.code, 0);
  assert.equal(r.body.sprint.tickets[0].writer, 'fb');
});

// Smoke run 2026-10-08: the person said what the plan must be, but Claude passed only the title as the summary.
test('a plan-less ticket with only its title to plan from gets a plain note in the draft\'s answer', async () => {
  const { root, w } = world();
  const d = await draftSprint(root, { name: 'x', tickets: [
    P({ key: 'SMK-11', title: 'Add a CODE_OF_CONDUCT.md', summary: 'Add a CODE_OF_CONDUCT.md.' }),
    P({ key: 'SMK-12', title: 'Add CONTRIBUTING.md', summary: undefined }),
    P({ key: 'SMK-13', title: 'Add a LICENSE', summary: 'SMK-13: add a license' }),
    P(),
    T({ key: 'SMK-14', title: 'Has a plan' }),
  ] }, { cwd: w.repo });
  assert.deepEqual(draftNotes(d), [
    'SMK-11 has only its title to plan from. If the person told you more about it, throw this draft away (action "discard") and draft it again with that text as its summary.',
    'SMK-12 has only its title to plan from. If the person told you more about it, throw this draft away (action "discard") and draft it again with that text as its summary.',
    'SMK-13 has only its title to plan from. If the person told you more about it, throw this draft away (action "discard") and draft it again with that text as its summary.',
  ]);
  // The draft proposes a full check, so the answer carries no "no check" note beside the title-only ones.
  const r = await cli(root, ['sprint', 'draft', '--json', '-'], { stdin: JSON.stringify({ name: 'y', check: 'npm test', tickets: [P({ key: 'SMK-15', title: 'Docs', summary: 'Docs' }), P({ key: 'SMK-16', title: 'More' })] }), cwd: w.repo });
  assert.equal(r.code, 0);
  assert.deepEqual(r.body.notes, ['SMK-15 has only its title to plan from. If the person told you more about it, throw this draft away (action "discard") and draft it again with that text as its summary.']);
  // Only proposed: until that draft is started, another draft for the repo still hears it has no check.
  const other = await cli(root, ['sprint', 'draft', '--json', '-'], { stdin: JSON.stringify({ name: 'z', tickets: [P({ key: 'SMK-17', title: 'Other' })] }), cwd: w.repo });
  assert.equal(other.body.notes.length, 1);
  assert.match(other.body.notes[0], /no full check yet/);
  // Once Start saved it, a later draft carries no note.
  assert.equal((await cli(root, ['sprint', 'start', '--id', r.body.sprint.id])).code, 0);
  const full = await cli(root, ['sprint', 'draft', '--json', '-'], { stdin: JSON.stringify({ name: 'w', tickets: [P({ key: 'SMK-18', title: 'Last' })] }), cwd: w.repo });
  assert.deepEqual(full.body.notes, []);
});
