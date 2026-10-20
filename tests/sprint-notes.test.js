// The person's notes on a sprint ticket: every later planner, writer and reviewer of that ticket reads them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { createSprint, draftSprint, startSprint, discardSprint, tick, loadSprint, saveSprint, sprintSummary, addNote, retryTicket } from '../engine/sprint.js';
import { listJobDirs, readJob, findJobDir } from '../engine/store.js';
import { main } from '../engine/cli.js';
import { waitFor, scriptAgent, sprintWorld } from './helpers.js';

const ONE = '# Plan\n\n### Task 1: Add a.txt\nWrite a.txt.\n';
const T = (over = {}) => ({ key: 'ABC-11', title: 'Login form', type: 'feat', plan: 'docs/one.md', agent: 'fa', reviewer: 'fr', ...over });
const run = (root, id, env, until) => waitFor(async () => { const s = await tick(root, id, { env }); return until(s) ? s : null; }, { timeoutMs: 90_000, intervalMs: 150 });
const jobsOf = (root, key, role) => listJobDirs(root).map(readJob).filter((j) => j.sprint?.ticket === key && j.sprint?.role === role)
  .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
const promptOf = (root, job) => fs.readFileSync(path.join(findJobDir(root, job.id), 'prompt.md'), 'utf8');
const NOTE = 'The date tests fail on main too: leave them.';

async function cli(root, argv, { stdin = '' } = {}) {
  let out = '';
  const stdout = new Writable({ write(c, _e, cb) { out += c; cb(); } });
  // Nothing here may start a real runner.
  const code = await main(argv, { stdout, stdin: Readable.from([stdin]), env: { ...process.env, PODIUM_DATA_DIR: root }, spawn: () => {} });
  return { code, body: JSON.parse(out) };
}

test('a note on a ticket reaches its writer and reviewer, and no other ticket\'s', async () => {
  const { root, w } = sprintWorld({ plans: { 'docs/one.md': ONE } });
  scriptAgent(root, 'fa', [{ write: 'a.txt' }, { write: 'a.txt' }]);
  scriptAgent(root, 'fr', [{ say: 'VERDICT: pass' }, { say: 'VERDICT: pass' }]);
  const d = await draftSprint(root, { name: 'x', tickets: [T(), T({ key: 'ABC-12', title: 'Payouts' })] }, { cwd: w.repo });
  // A draft's ticket takes notes: its agents read them once it runs.
  await addNote(root, d.id, 'abc-11', NOTE);
  await startSprint(root, d.id);
  await run(root, d.id, w.env, (s) => s.tickets.every((t) => !['pending', 'running', 'waiting'].includes(t.state)));
  const [author11] = jobsOf(root, 'ABC-11', 'author');
  const [review11] = jobsOf(root, 'ABC-11', 'reviewer');
  const [author12] = jobsOf(root, 'ABC-12', 'author');
  const [review12] = jobsOf(root, 'ABC-12', 'reviewer');
  assert.ok(promptOf(root, author11).includes(`: ${NOTE}`), 'the writer reads it');
  assert.ok(promptOf(root, review11).includes(`: ${NOTE}`), 'the reviewer reads it');
  assert.match(promptOf(root, review11), /never fail the task for following one/);
  for (const job of [author12, review12]) assert.ok(!promptOf(root, job).includes(NOTE), 'another ticket never sees it');
});

test('Retry with a note: the fix that runs next reads the note and its task\'s text', async () => {
  const { root, w } = sprintWorld({ plans: { 'docs/one.md': ONE } });
  scriptAgent(root, 'fa', [{ write: 'a.txt' }, { write: 'a2.txt' }, { write: 'a3.txt' }]);
  scriptAgent(root, 'fr', [{ say: 'Broken.\nVERDICT: fail' }, { say: 'Still broken.\nVERDICT: fail' }, { say: 'VERDICT: pass' }]);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  await run(root, s0.id, w.env, (s) => s.tickets[0].state === 'parked');
  const r = await retryTicket(root, s0.id, 'ABC-11', { note: `  ${NOTE}  ` });
  assert.deepEqual(r.tickets[0].notes.map((x) => [x.n, x.kind, x.text]), [[1, 'note', NOTE]]);
  assert.equal(r.tickets[0].resume, 'fix');
  await run(root, s0.id, w.env, (s) => !['pending', 'running', 'waiting'].includes(s.tickets[0].state));
  const authors = jobsOf(root, 'ABC-11', 'author');
  assert.equal(authors.length, 3);
  const fix = promptOf(root, authors[2]);
  assert.match(fix, /fix what the reviewer found/);
  assert.match(fix, /## The task\n```\n### Task 1: Add a\.txt\nWrite a\.txt\.\n```/);
  assert.ok(fix.includes(`: ${NOTE}`));
  assert.ok(!promptOf(root, authors[0]).includes(NOTE), 'a step that ran before the note never had it');
  // A retry with no note adds none.
  const plain = await draftSprint(root, { name: 'y', tickets: [T({ key: 'ABC-13', title: 'Other' })] }, { cwd: w.repo });
  const stored = loadSprint(root, plain.id);
  Object.assign(stored.tickets[0], { state: 'parked', resume: 'author' });
  saveSprint(root, stored);
  assert.equal((await retryTicket(root, plain.id, 'ABC-13', { note: '  ' })).tickets[0].notes, undefined);
});

test('addNote keeps the person\'s words; refuses an empty note, an ended ticket and a thrown-away draft; keeps the newest 50', async () => {
  const { root, w } = sprintWorld({ plans: { 'docs/one.md': ONE } });
  scriptAgent(root, 'fa', []);
  scriptAgent(root, 'fr', []);
  const d = await draftSprint(root, { name: 'x', tickets: [T(), T({ key: 'ABC-12', title: 'Payouts' })] }, { cwd: w.repo });
  const now = Date.parse('2026-10-14T15:00:00Z');
  const s = await addNote(root, d.id, 'abc-11', `  ${NOTE}\n`, { now });
  assert.deepEqual(s.tickets[0].notes, [{ n: 1, at: '2026-10-14T15:00:00.000Z', kind: 'note', text: NOTE }]);
  assert.equal(s.tickets[1].notes, undefined, 'only that ticket');
  await assert.rejects(addNote(root, d.id, 'ABC-11', ' \n '), (e) => e.code === 'nothing-to-note');
  await assert.rejects(addNote(root, d.id, 'ABC-99', NOTE), (e) => e.code === 'no-such-ticket');
  // Each note is cut to the engine's length.
  const long = await addNote(root, d.id, 'ABC-11', 'z'.repeat(12_000));
  assert.equal(long.tickets[0].notes.at(-1).text.length, 10_000);
  for (let i = 0; i < 50; i++) await addNote(root, d.id, 'ABC-11', `note ${i + 3}`);
  const kept = loadSprint(root, d.id).tickets[0].notes;
  assert.equal(kept.length, 50);
  assert.deepEqual([kept[0].n, kept.at(-1).n, kept.at(-1).text], [3, 52, 'note 52'], 'numbers carry on past the ones left out');
  // The summary shows the latest few, cut short, and how many there are.
  const sum = sprintSummary(root, loadSprint(root, d.id)).tickets[0];
  assert.deepEqual(sum.notes.map((x) => x.n), [50, 51, 52]);
  assert.deepEqual([sum.noteCount, sum.canNote], [50, true]);
  const cut = sprintSummary(root, { ...loadSprint(root, d.id), tickets: [{ ...loadSprint(root, d.id).tickets[0], notes: [{ n: 1, at: 'x', kind: 'note', text: 'y'.repeat(1_000) }] }] }).tickets[0];
  assert.equal(cut.notes[0].text.length, 300);
  // An ended ticket takes none: no agent would read it.
  const stored = loadSprint(root, d.id);
  stored.tickets[1].state = 'stopped';
  saveSprint(root, stored);
  await assert.rejects(addNote(root, d.id, 'ABC-12', NOTE), (e) => e.code === 'ticket-ended');
  assert.equal(sprintSummary(root, loadSprint(root, d.id)).tickets[1].canNote, false);
  discardSprint(root, d.id);
  await assert.rejects(addNote(root, d.id, 'ABC-11', NOTE), (e) => e.code === 'discarded');
  assert.equal(sprintSummary(root, loadSprint(root, d.id)).tickets[0].canNote, false);
});

test('once every task is reviewed, a note is taken only while the full check\'s fix is next: no other agent would read it', async () => {
  const { root, w } = sprintWorld({ plans: { 'docs/one.md': ONE } });
  scriptAgent(root, 'fa', []);
  scriptAgent(root, 'fr', []);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  const at = (patch) => { const s = loadSprint(root, s0.id); Object.assign(s.tickets[0], patch); saveSprint(root, s); };
  // Parked where the PR couldn't open: only the PR is ahead.
  at({ state: 'parked', resume: 'pr', task: 1 });
  await assert.rejects(addNote(root, s0.id, 'ABC-11', NOTE), (e) => e.code === 'no-agent-ahead' && /no agent works on it again/.test(e.message));
  await assert.rejects(retryTicket(root, s0.id, 'ABC-11', { note: NOTE }), (e) => e.code === 'no-agent-ahead');
  assert.equal(sprintSummary(root, loadSprint(root, s0.id)).tickets[0].canNote, false);
  assert.equal((await retryTicket(root, s0.id, 'ABC-11')).tickets[0].state, 'waiting', 'a retry without a note still runs');
  // The full check is running, or is next: still no agent ahead.
  at({ state: 'running', phase: 'check', resume: null });
  await assert.rejects(addNote(root, s0.id, 'ABC-11', NOTE), (e) => e.code === 'no-agent-ahead');
  // Parked after the full check failed: its fix is next, and reads the note.
  at({ state: 'parked', phase: 'check', resume: 'check-fix' });
  assert.equal(sprintSummary(root, loadSprint(root, s0.id)).tickets[0].canNote, true);
  assert.deepEqual((await retryTicket(root, s0.id, 'ABC-11', { note: NOTE })).tickets[0].notes.map((x) => x.text), [NOTE]);
  // The fix being started when its runner died (dispatching saved, resume cleared): the next tick starts it, and it reads the note.
  at({ state: 'waiting', phase: 'check', resume: null, notes: [], dispatching: { phase: 'check-fix', at: new Date().toISOString() } });
  assert.equal(sprintSummary(root, loadSprint(root, s0.id)).tickets[0].canNote, true);
  assert.equal((await addNote(root, s0.id, 'ABC-11', NOTE)).tickets[0].notes.length, 1);
  assert.equal((await retryTicket(root, s0.id, 'ABC-11', { note: 'Again.' })).tickets[0].notes.length, 2);
  // And a check being started is no agent.
  at({ state: 'waiting', resume: null, dispatching: { phase: 'check', at: new Date().toISOString() } });
  await assert.rejects(addNote(root, s0.id, 'ABC-11', NOTE), (e) => e.code === 'no-agent-ahead');
});

test('sprint note takes its text on stdin and says when a step is running; sprint retry --note - adds one', async () => {
  const { root, w } = sprintWorld({ plans: { 'docs/one.md': ONE } });
  scriptAgent(root, 'fa', []);
  scriptAgent(root, 'fr', []);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  const first = await cli(root, ['sprint', 'note', '--id', s0.id, '--ticket', 'abc-11', '--text', '-'], { stdin: `${NOTE}\n` });
  assert.equal(first.code, 0, JSON.stringify(first.body));
  assert.deepEqual(first.body.noted, { key: 'ABC-11', n: 1, running: false });
  assert.deepEqual(first.body.sprint.tickets[0].notes.map((x) => x.text), [NOTE]);
  const stored = loadSprint(root, s0.id);
  stored.tickets[0].state = 'running';
  saveSprint(root, stored);
  const busy = await cli(root, ['sprint', 'note', '--id', s0.id, '--ticket', 'ABC-11', '--text', '-'], { stdin: 'Second.' });
  assert.deepEqual(busy.body.noted, { key: 'ABC-11', n: 2, running: true });
  // A step being started when its runner died (dispatching saved, the step not yet) may be running already.
  const starting = loadSprint(root, s0.id);
  Object.assign(starting.tickets[0], { state: 'pending', dispatching: { phase: 'author', at: new Date().toISOString() } });
  saveSprint(root, starting);
  const maybe = await cli(root, ['sprint', 'note', '--id', s0.id, '--ticket', 'ABC-11', '--text', '-'], { stdin: 'Maybe running.' });
  assert.equal(maybe.body.noted.running, true);
  const notes = loadSprint(root, s0.id);
  Object.assign(notes.tickets[0], { dispatching: null });
  notes.tickets[0].notes = notes.tickets[0].notes.filter((x) => x.text !== 'Maybe running.');
  saveSprint(root, notes);
  const parked = loadSprint(root, s0.id);
  Object.assign(parked.tickets[0], { state: 'parked', resume: 'author' });
  saveSprint(root, parked);
  const retried = await cli(root, ['sprint', 'retry', '--id', s0.id, '--ticket', 'ABC-11', '--note', '-'], { stdin: 'Third.' });
  assert.equal(retried.code, 0, JSON.stringify(retried.body));
  assert.deepEqual(loadSprint(root, s0.id).tickets[0].notes.map((x) => x.text), [NOTE, 'Second.', 'Third.']);
  assert.equal(loadSprint(root, s0.id).tickets[0].state, 'waiting');
  const empty = await cli(root, ['sprint', 'note', '--id', s0.id, '--ticket', 'ABC-11', '--text', '-'], { stdin: '' });
  assert.equal(empty.body.error.code, 'nothing-to-note');
});
