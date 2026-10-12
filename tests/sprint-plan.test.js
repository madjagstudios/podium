// A ticket with no plan is planned first, then waits for the person.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { createSprint, tick, loadSprint, saveSprint, sprintSummary, wantsRunner, retryTicket, assignTask, approvePlan, revisePlan, RETRY_MS } from '../engine/sprint.js';
import { listJobDirs, readJob, findJobDir } from '../engine/store.js';
import { main } from '../engine/cli.js';
import { waitFor, scriptAgent, sprintWorld } from './helpers.js';

const NOW = Date.parse('2026-10-07T10:00:00Z');
const FILE = 'docs/plans/2026-10-07-abc-14-export-to-csv.md';
const PLAN2 = '# Export to CSV\n\n### Task 1: Add the export button\nAdd it.\n\n### Task 2: Write the CSV\nWrite it.\n';
const PLAN3 = '# Export to CSV\n\n### Task 1: Add the export button\nAdd it.\n\n### Task 2: Write the header\nIt.\n\n### Task 3: Write the rows\nThem.\n';
const P = (over = {}) => ({ key: 'ABC-14', title: 'Export to CSV', type: 'feat', agent: 'fa', reviewer: 'fr', summary: 'Users want their payouts as CSV.', ...over });
// Tick until `until(sprint)` holds, at a fixed clock (the plan's file name carries the day it was started).
const run = (root, id, env, until, now = () => NOW) => waitFor(async () => {
  const s = await tick(root, id, { env, now: now() });
  return until(s) ? s : null;
}, { timeoutMs: 90_000, intervalMs: 150 });
const settled = (s) => !['pending', 'running', 'waiting'].includes(s.tickets[0].state);
const jobsBy = (root, role) => listJobDirs(root).map(readJob).filter((j) => j.sprint?.role === role).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
const promptOf = (root, job) => fs.readFileSync(path.join(findJobDir(root, job.id), 'prompt.md'), 'utf8');
const jobNow = (root, id) => readJob(findJobDir(root, id));

async function cli(root, argv, { stdin = '', spawn = () => {} } = {}) {
  let out = '';
  const stdout = new Writable({ write(c, _e, cb) { out += c; cb(); } });
  const code = await main(argv, { stdout, stdin: Readable.from([stdin]), env: { ...process.env, PODIUM_DATA_DIR: root }, spawn });
  return { code, body: JSON.parse(out) };
}

test('a ticket with no plan is planned by its writer, in its copy on its branch, then waits at Plan ready', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ write: FILE, content: PLAN2, say: 'Wrote the plan.' }]);
  scriptAgent(root, 'fr', []);
  const s0 = await createSprint(root, { name: 'Oct', tickets: [P()] }, { cwd: w.repo, session: 'chat-1' });
  const s = await run(root, s0.id, w.env, settled);
  const t = s.tickets[0];
  assert.equal(t.state, 'plan-ready');
  assert.equal(t.plan, FILE);
  assert.deepEqual(t.proposed.map((x) => [x.n, x.title]), [[1, 'Add the export button'], [2, 'Write the CSV']]);
  assert.match(t.proposed[0].text, /^### Task 1: Add the export button\nAdd it\.$/);
  assert.deepEqual(t.tasks, [], 'no tasks until Approve');
  const [plan] = jobsBy(root, 'author');
  assert.deepEqual([plan.sprint.task, plan.sprint.plan, plan.agent, plan.branch, plan.base, plan.permission], [0, true, 'fa', 'feat/abc-14-export-to-csv', 'main', 'edit-worktree']);
  const prompt = promptOf(root, plan);
  assert.match(prompt, /short paragraph on the approach/);
  assert.match(prompt, /ABC-14: Export to CSV\n\nUsers want their payouts as CSV\./);
  assert.ok(prompt.includes(`save it as ${FILE}`));
  const done = jobNow(root, plan.id);
  assert.deepEqual([done.status, done.hasChanges], ['done', false], 'the plan is in its checkpoint: nothing to keep');
  assert.ok(done.checkpoint);
  assert.equal(w.git(done.worktree, 'log', '-1', '--format=%s'), 'wip(ABC-14): plan');
  assert.equal(w.git(w.repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'the person\'s checkout is untouched');
  const news = s.messages.at(-1).text;
  assert.match(news, /^ABC-14's plan is ready: 2 tasks\.\n/);
  assert.ok(news.includes(path.join(done.worktree, FILE)), 'it names the plan in Podium\'s copy');
  assert.match(news, /Its tasks: 1\. Add the export button; 2\. Write the CSV\./);
  assert.ok(news.includes(`action "approve" (id ${s0.id}, ticket ABC-14)`));
  assert.equal(wantsRunner(root, s), false, 'nothing runs until the person answers');
  const sum = sprintSummary(root, s).tickets[0];
  assert.deepEqual([sum.state, sum.plan, sum.canApprove, sum.canRevise, sum.canOneTask, sum.canStop, sum.canAssignPlan], ['plan-ready', FILE, true, true, false, true, true]);
  assert.deepEqual(sum.proposed, [{ n: 1, title: 'Add the export button' }, { n: 2, title: 'Write the CSV' }]);
});

// A sprint saved with a plan path in another folder keeps it: the path is read from the ticket.
test('a ticket whose saved plan path is in another folder is planned there and its plan read from there', async () => {
  const OLD = 'notes/plans/abc-14.md';
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ write: OLD, content: PLAN2 }]);
  scriptAgent(root, 'fr', []);
  const s0 = await createSprint(root, { name: 'Oct', tickets: [P()] }, { cwd: w.repo });
  const saved = loadSprint(root, s0.id);
  saved.tickets[0].plan = OLD;
  saveSprint(root, saved);
  const s = await run(root, s0.id, w.env, settled);
  assert.equal(s.tickets[0].state, 'plan-ready', s.tickets[0].reason);
  assert.equal(s.tickets[0].plan, OLD);
  assert.ok(promptOf(root, jobsBy(root, 'author')[0]).includes(`save it as ${OLD}`));
  assert.deepEqual(s.tickets[0].proposed.map((x) => x.title), ['Add the export button', 'Write the CSV']);
});

test('a plan with no "### Task N:" headings waits as "Couldn\'t find tasks in this plan"', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ write: FILE, content: '# Export\n\nJust do it all.\n' }]);
  scriptAgent(root, 'fr', []);
  const s0 = await createSprint(root, { name: 'Oct', tickets: [P()] }, { cwd: w.repo });
  const s = await run(root, s0.id, w.env, settled);
  const t = s.tickets[0];
  assert.deepEqual([t.state, t.reason], ['no-tasks', "Couldn't find tasks in this plan"]);
  assert.deepEqual(t.proposed, [{ n: 1, title: 'Export to CSV', text: '# Export\n\nJust do it all.' }]);
  assert.match(s.messages.at(-1).text, /^ABC-14's plan is written, but Podium couldn't find tasks in it\./);
  const sum = sprintSummary(root, s).tickets[0];
  assert.deepEqual([sum.canApprove, sum.canOneTask, sum.canRevise, sum.proposed], [false, true, true, null]);
});

test('a planning step that stops parks the ticket; Give to another agent plans again in the same copy', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ err: 'boom', exit: 3 }]);
  scriptAgent(root, 'fb', [{ write: FILE, content: PLAN2 }]);
  scriptAgent(root, 'fr', []);
  const s0 = await createSprint(root, { name: 'Oct', tickets: [P()] }, { cwd: w.repo });
  const s1 = await run(root, s0.id, w.env, settled);
  assert.equal(s1.tickets[0].state, 'parked');
  assert.equal(s1.tickets[0].reason, 'Fa stopped on the plan: Fa exited with code 3.');
  const sum = sprintSummary(root, s1).tickets[0];
  assert.deepEqual([sum.canRetry, sum.giveTo], [true, 'writer']);
  const r = await retryTicket(root, s0.id, 'ABC-14', { agent: 'fb' });
  assert.deepEqual([r.tickets[0].agent, r.tickets[0].reason], ['fb', 'Trying again: Fb writes the plan']);
  const s2 = await run(root, s0.id, w.env, settled);
  assert.equal(s2.tickets[0].state, 'plan-ready');
  const [first, second] = jobsBy(root, 'author');
  assert.equal(second.followUpOf, first.id);
  assert.equal(second.agent, 'fb');
  assert.equal(second.worktree, first.worktree);
});

test('a usage limit on the planning step waits, then plans again', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ err: 'You have hit your usage limit.', exit: 1 }, { write: FILE, content: PLAN2 }]);
  scriptAgent(root, 'fr', []);
  const s0 = await createSprint(root, { name: 'Oct', tickets: [P()] }, { cwd: w.repo });
  const s1 = await run(root, s0.id, w.env, (s) => s.tickets[0].state === 'waiting');
  assert.match(s1.tickets[0].reason, /^Fa hit a usage limit; trying again at \d\d:\d\d$/);
  assert.equal(s1.tickets[0].resume, 'plan');
  const s2 = await run(root, s0.id, w.env, settled, () => NOW + RETRY_MS + 1000);
  assert.equal(s2.tickets[0].state, 'plan-ready');
});

test('a writer that writes no plan file parks the ticket saying so; Retry asks again', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ say: 'My plan: do it.' }, { write: FILE, content: PLAN2 }]);
  scriptAgent(root, 'fr', []);
  const s0 = await createSprint(root, { name: 'Oct', tickets: [P()] }, { cwd: w.repo });
  const s1 = await run(root, s0.id, w.env, settled);
  assert.equal(s1.tickets[0].state, 'parked');
  assert.equal(s1.tickets[0].reason, `Fa finished without writing the plan to ${FILE}`);
  await retryTicket(root, s0.id, 'ABC-14');
  const s2 = await run(root, s0.id, w.env, settled);
  assert.equal(s2.tickets[0].state, 'plan-ready');
  assert.ok(promptOf(root, jobsBy(root, 'author')[1]).includes(FILE));
});

test('the writer of a plan being written cannot change; once it waits, it can', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ write: FILE, content: PLAN2, ms: 1500 }]);
  scriptAgent(root, 'fb', []);
  scriptAgent(root, 'fr', []);
  const s0 = await createSprint(root, { name: 'Oct', tickets: [P()] }, { cwd: w.repo });
  const s1 = await tick(root, s0.id, { env: w.env, now: NOW });
  assert.deepEqual([s1.tickets[0].state, s1.tickets[0].phase], ['running', 'plan']);
  assert.equal(sprintSummary(root, s1).tickets[0].agent, 'fa');
  await assert.rejects(assignTask(root, s0.id, 'ABC-14', 0, { agent: 'fb' }), (e) => e.code === 'task-started');
  await run(root, s0.id, w.env, settled);
  const s2 = await assignTask(root, s0.id, 'ABC-14', 0, { agent: 'fb' });
  assert.equal(s2.tickets[0].agent, 'fb');
});

// Every runner path a plan-less ticket reaches must work with no tasks. A git error while
// saving the plan goes through tick's error handler (plainReason), which must not look for a task.
// The plan is done but its checkpoint fails: the ticket parks on saving the plan.
async function parkOnSave(root, w, s0) {
  const s1 = await tick(root, s0.id, { env: w.env, now: NOW });
  assert.deepEqual([s1.tickets[0].state, s1.tickets[0].phase], ['running', 'plan']);
  await waitFor(() => !['queued', 'running'].includes(jobNow(root, s1.tickets[0].job).status), { timeoutMs: 60_000 });
  // Once the step is done, a held index lock makes the checkpoint's "git add" fail.
  const copy = jobNow(root, s1.tickets[0].job).worktree;
  const lock = path.join(path.resolve(copy, w.git(copy, 'rev-parse', '--git-dir')), 'index.lock');
  fs.writeFileSync(lock, '');
  const s2 = await tick(root, s0.id, { env: w.env, now: NOW });
  fs.rmSync(lock);
  return { s2, copy };
}

// A failed save must not run the writer again (a full agent run that may rewrite a good plan).
test('a plan that can\'t be saved parks the ticket naming the plan; Retry only saves it again', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ write: FILE, content: PLAN2, ms: 1500 }, { write: FILE, content: PLAN3 }]);
  scriptAgent(root, 'fr', []);
  const s0 = await createSprint(root, { name: 'Oct', tickets: [P()] }, { cwd: w.repo });
  const { s2, copy } = await parkOnSave(root, w, s0);
  assert.equal(s2.tickets[0].state, 'parked');
  assert.match(s2.tickets[0].reason, /^Podium couldn't save or read the plan: /);
  assert.equal(s2.tickets[0].resume, 'plan-save');
  assert.match(s2.messages.at(-1).text, /^ABC-14 \(Export to CSV\) needs you: Podium couldn't save or read the plan/);
  assert.equal(sprintSummary(root, s2).tickets[0].giveTo, null, 'saving the plan runs no agent');
  const r = await retryTicket(root, s0.id, 'ABC-14');
  assert.equal(r.tickets[0].reason, 'Trying again: saving the plan');
  const s3 = await run(root, s0.id, w.env, settled);
  assert.equal(s3.tickets[0].state, 'plan-ready', s3.tickets[0].reason);
  assert.deepEqual(s3.tickets[0].proposed.map((x) => x.title), ['Add the export button', 'Write the CSV'], 'the plan the writer wrote');
  assert.equal(jobsBy(root, 'author').length, 1, 'the writer was not run again');
  assert.equal(w.git(copy, 'log', '-1', '--format=%s'), 'wip(ABC-14): plan');
});

test('a plan that can\'t be saved and is gone by the retry is planned again', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ write: FILE, content: PLAN2, ms: 1500 }, { write: FILE, content: PLAN3 }]);
  scriptAgent(root, 'fr', []);
  const s0 = await createSprint(root, { name: 'Oct', tickets: [P()] }, { cwd: w.repo });
  const { s2, copy } = await parkOnSave(root, w, s0);
  assert.equal(s2.tickets[0].resume, 'plan-save');
  fs.rmSync(path.join(copy, FILE));
  await retryTicket(root, s0.id, 'ABC-14');
  const s3 = await run(root, s0.id, w.env, settled);
  assert.equal(s3.tickets[0].state, 'plan-ready', s3.tickets[0].reason);
  assert.deepEqual(s3.tickets[0].proposed.map((x) => x.title), ['Add the export button', 'Write the header', 'Write the rows']);
  const [first, second] = jobsBy(root, 'author');
  assert.equal(second.followUpOf, first.id, 'the writer is asked again in the same conversation');
  assert.equal(second.sprint.task, 0);
});

test('a folder at the plan\'s path is the writer\'s mistake: the ticket goes back to its planner, and Retry or Give to another agent recovers it', async () => {
  const { root, w } = sprintWorld();
  // The first writer leaves a folder where the plan should be; the second removes it and writes the plan.
  scriptAgent(root, 'fa', [{ write: `${FILE}/inner.md`, content: PLAN2 }]);
  scriptAgent(root, 'fb', [{ rm: FILE, write: FILE, content: PLAN3 }]);
  scriptAgent(root, 'fr', []);
  const s0 = await createSprint(root, { name: 'Oct', tickets: [P()] }, { cwd: w.repo });
  const s = await run(root, s0.id, w.env, settled);
  const t = s.tickets[0];
  assert.deepEqual([t.state, t.resume, t.reason], ['parked', 'plan', `Fa wrote a folder, not a plan file, at ${FILE}`]);
  assert.match(s.messages.at(-1).text, /^ABC-14 \(Export to CSV\) needs you: Fa wrote a folder, not a plan file, at /);
  assert.equal(sprintSummary(root, s).tickets[0].giveTo, 'writer', 'the board offers Give to another agent');
  const r = await retryTicket(root, s0.id, 'ABC-14', { agent: 'fb' });
  assert.deepEqual([r.tickets[0].resume, r.tickets[0].agent, r.tickets[0].reason], ['plan', 'fb', 'Trying again: Fb writes the plan']);
  const s2 = await run(root, s0.id, w.env, settled);
  assert.equal(s2.tickets[0].state, 'plan-ready', s2.tickets[0].reason);
  assert.deepEqual(s2.tickets[0].proposed.map((x) => x.title), ['Add the export button', 'Write the header', 'Write the rows']);
  assert.equal(jobsBy(root, 'author').length, 2);
});

test('Retry after a folder at the plan\'s path asks the same writer again', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ write: `${FILE}/inner.md`, content: PLAN2 }, { rm: FILE, write: FILE, content: PLAN2 }]);
  scriptAgent(root, 'fr', []);
  const s0 = await createSprint(root, { name: 'Oct', tickets: [P()] }, { cwd: w.repo });
  await run(root, s0.id, w.env, settled);
  await retryTicket(root, s0.id, 'ABC-14');
  const s2 = await run(root, s0.id, w.env, settled);
  assert.equal(s2.tickets[0].state, 'plan-ready', s2.tickets[0].reason);
  assert.equal(jobsBy(root, 'author').length, 2, 'the writer ran again');
});

test('a parked plan-save whose plan file became a folder asks the writer again on Retry, not the save', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ write: FILE, content: PLAN2, ms: 1500 }, { rm: FILE, write: FILE, content: PLAN3 }]);
  scriptAgent(root, 'fr', []);
  const s0 = await createSprint(root, { name: 'Oct', tickets: [P()] }, { cwd: w.repo });
  const { s2, copy } = await parkOnSave(root, w, s0);
  assert.equal(s2.tickets[0].resume, 'plan-save');
  fs.rmSync(path.join(copy, FILE));
  fs.mkdirSync(path.join(copy, FILE));
  await retryTicket(root, s0.id, 'ABC-14');
  const s3 = await run(root, s0.id, w.env, settled);
  assert.equal(s3.tickets[0].state, 'plan-ready', s3.tickets[0].reason);
  assert.equal(jobsBy(root, 'author').length, 2, 'the writer ran again');
});

test('an agent override on a parked plan-save is refused plainly: saving runs no agent, and the board offers none', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ write: FILE, content: PLAN2, ms: 1500 }]);
  scriptAgent(root, 'fb', []);
  scriptAgent(root, 'fr', []);
  const s0 = await createSprint(root, { name: 'Oct', tickets: [P()] }, { cwd: w.repo });
  const { s2 } = await parkOnSave(root, w, s0);
  assert.equal(s2.tickets[0].resume, 'plan-save');
  await assert.rejects(retryTicket(root, s0.id, 'ABC-14', { agent: 'fb' }), (e) => e.code === 'no-agent-change' && e.message === 'Saving ABC-14\'s plan runs no agent, so there is none to change. Retry it as it is.');
  const after = loadSprint(root, s0.id).tickets[0];
  assert.deepEqual([after.state, after.agent, after.resume], ['parked', 'fa', 'plan-save'], 'nothing changed');
});

test('an empty plan parks the ticket saying so; Retry asks the writer again', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ write: FILE, content: '  \n\n \t\n' }, { write: FILE, content: PLAN2 }]);
  scriptAgent(root, 'fr', []);
  const s0 = await createSprint(root, { name: 'Oct', tickets: [P()] }, { cwd: w.repo });
  const s1 = await run(root, s0.id, w.env, settled);
  assert.deepEqual([s1.tickets[0].state, s1.tickets[0].reason, s1.tickets[0].resume, s1.tickets[0].proposed ?? null], ['parked', `Fa wrote an empty plan to ${FILE}`, 'plan', null]);
  const r = await retryTicket(root, s0.id, 'ABC-14');
  assert.equal(r.tickets[0].reason, 'Trying again: Fa writes the plan');
  const s2 = await run(root, s0.id, w.env, settled);
  assert.equal(s2.tickets[0].state, 'plan-ready', s2.tickets[0].reason);
  assert.equal(jobsBy(root, 'author').length, 2);
});

test('Approve right after Ask for changes is refused: the plan is no longer waiting (the person and the runner race)', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ write: FILE, content: PLAN2 }]);
  scriptAgent(root, 'fr', []);
  const s0 = await createSprint(root, { name: 'Oct', tickets: [P()] }, { cwd: w.repo });
  await run(root, s0.id, w.env, settled);
  await revisePlan(root, s0.id, 'ABC-14', 'Split the CSV task in two.');
  await assert.rejects(approvePlan(root, s0.id, 'ABC-14'), (e) => e.code === 'no-plan-waiting' && e.message === 'ABC-14 has no plan waiting for approval.');
  const t = loadSprint(root, s0.id).tickets[0];
  assert.deepEqual([t.state, t.resume, t.tasks], ['waiting', 'revise', []], 'the revise is untouched');
});

test('Run as one task refuses a plan with no text', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', []);
  scriptAgent(root, 'fr', []);
  const s0 = await createSprint(root, { name: 'Oct', tickets: [P()] }, { cwd: w.repo });
  const s = loadSprint(root, s0.id);
  Object.assign(s.tickets[0], { state: 'no-tasks', reason: "Couldn't find tasks in this plan", proposed: [{ n: 1, title: 'Export to CSV', text: ' \n ' }] });
  saveSprint(root, s);
  await assert.rejects(approvePlan(root, s0.id, 'ABC-14', { whole: true }), (e) => e.code === 'empty-plan' && e.message === "ABC-14's plan is empty, so there is nothing to run. Ask for changes instead.");
  assert.deepEqual(loadSprint(root, s0.id).tickets[0].tasks, []);
});

test('a tick that dies after the plan\'s checkpoint but before saving the sprint gives one commit and one message', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ write: FILE, content: PLAN2 }]);
  scriptAgent(root, 'fr', []);
  const s0 = await createSprint(root, { name: 'Oct', tickets: [P()] }, { cwd: w.repo });
  let crashed = false;
  const saveFn = (r, s, lock) => {
    if (!crashed && s.tickets[0].state === 'plan-ready') { crashed = true; throw new Error('killed'); }
    return saveSprint(r, s, lock);
  };
  await waitFor(async () => {
    try { await tick(root, s0.id, { env: w.env, now: NOW, saveFn }); } catch (e) { if (!/killed/.test(e.message)) throw e; }
    return crashed;
  }, { timeoutMs: 60_000, intervalMs: 150 });
  const saved = loadSprint(root, s0.id).tickets[0];
  assert.deepEqual([saved.state, saved.phase], ['running', 'plan'], 'the sprint never recorded the plan as ready');
  const s = await run(root, s0.id, w.env, settled);
  assert.equal(s.tickets[0].state, 'plan-ready', s.tickets[0].reason);
  const [plan] = jobsBy(root, 'author');
  assert.equal(jobsBy(root, 'author').length, 1);
  const subjects = w.git(plan.worktree, 'log', '--format=%s').split('\n');
  assert.equal(subjects.filter((x) => x === 'wip(ABC-14): plan').length, 1, 'one plan commit');
  assert.equal(s.messages.filter((m) => /plan is ready/.test(m.text)).length, 1, 'one chat message');
});

test('a retry of a plan-less ticket parked before any step was recorded plans it', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ write: FILE, content: PLAN2 }]);
  scriptAgent(root, 'fr', []);
  const s0 = await createSprint(root, { name: 'Oct', tickets: [P()] }, { cwd: w.repo });
  // Parked with nothing to resume (as a step that threw before it said what it was trying would leave it).
  const parked = loadSprint(root, s0.id);
  Object.assign(parked.tickets[0], { state: 'parked', resume: null, reason: 'Something went wrong' });
  saveSprint(root, parked);
  const r = await retryTicket(root, s0.id, 'ABC-14', { agent: 'fa' });
  assert.deepEqual([r.tickets[0].resume, r.tickets[0].agent, r.tickets[0].reason], ['plan', 'fa', 'Trying again: Fa writes the plan']);
  const s = await run(root, s0.id, w.env, settled);
  assert.equal(s.tickets[0].state, 'plan-ready', s.tickets[0].reason);
});

test('a tick that dies between starting the plan and saving it adopts the planning step next time', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ write: FILE, content: PLAN2 }, { write: FILE, content: PLAN2 }]);
  scriptAgent(root, 'fr', []);
  const s0 = await createSprint(root, { name: 'Oct', tickets: [P()] }, { cwd: w.repo });
  let crashed = false;
  const saveFn = (r, s, lock) => {
    if (!crashed && s.tickets[0].job) { crashed = true; throw new Error('killed'); }
    return saveSprint(r, s, lock);
  };
  await assert.rejects(tick(root, s0.id, { env: w.env, now: NOW, saveFn }), /killed/);
  const saved = loadSprint(root, s0.id).tickets[0];
  assert.equal(saved.job, null, 'the sprint never recorded the step');
  assert.equal(saved.dispatching?.phase, 'plan', 'only its intent');
  const s = await run(root, s0.id, w.env, settled);
  assert.equal(s.tickets[0].state, 'plan-ready', s.tickets[0].reason);
  assert.equal(jobsBy(root, 'author').length, 1, 'the planning step was adopted, not started twice');
  assert.equal(s.tickets[0].dispatching, null);
});


test('Approve makes the plan\'s tasks the ticket\'s, with its writer and reviewer, and it runs on to its PR in the same copy', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ write: FILE, content: PLAN2 }, { write: 'a.txt' }, { write: 'b.txt' }]);
  scriptAgent(root, 'fr', [{ say: 'VERDICT: pass' }]);
  scriptAgent(root, 'fb', [{ say: 'VERDICT: pass' }]);
  const s0 = await createSprint(root, { name: 'Oct', tickets: [P()] }, { cwd: w.repo });
  await run(root, s0.id, w.env, settled);
  await assert.rejects(approvePlan(root, s0.id, 'ABC-14', { whole: true }), (e) => e.code === 'plan-has-tasks' && e.message === "ABC-14's plan has tasks: approve it instead.");
  const a = await approvePlan(root, s0.id, 'abc-14');
  const t = a.tickets[0];
  assert.deepEqual([t.state, t.proposed, t.reason, t.task], ['pending', null, null, 0]);
  assert.deepEqual(t.tasks.map((x) => [x.n, x.title, x.agent, x.reviewer]), [[1, 'Add the export button', 'fa', 'fr'], [2, 'Write the CSV', 'fa', 'fr']]);
  assert.match(t.tasks[0].text, /^### Task 1: Add the export button/);
  // Changeable on the board like any task not yet run.
  await assignTask(root, s0.id, 'ABC-14', 2, { reviewer: 'fb' });
  const s = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'pr-open');
  const authors = jobsBy(root, 'author');
  assert.equal(authors.length, 3, 'the plan, then two tasks');
  assert.equal(authors[1].followUpOf, authors[0].id, 'task 1 continues the plan\'s conversation');
  assert.equal(authors[1].worktree, authors[0].worktree);
  const reviews = jobsBy(root, 'reviewer');
  assert.doesNotMatch(promptOf(root, reviews[0]), /export-to-csv\.md/, 'task 1 is reviewed on its own diff, not the plan');
  assert.equal(reviews[1].agent, 'fb');
  // The plan and both tasks reach the PR as one commit, named for the ticket.
  assert.deepEqual(w.git(w.remote, 'log', '--format=%s', `${w.git(w.repo, 'rev-parse', 'main')}..feat/abc-14-export-to-csv`).split('\n'), ['ABC-14: Export to CSV']);
  assert.equal(s.tickets[0].pr.number, 12);
  // The approved tasks' titles are in the PR body, which lists them.
  const create = w.calls().find((c) => c[0] === 'pr' && c[1] === 'create');
  assert.match(create[create.indexOf('--body-text') + 1], /Changes:\n- Add the export button\n- Write the CSV$/);
  await assert.rejects(approvePlan(root, s0.id, 'ABC-14'), (e) => e.code === 'no-plan-waiting' && e.message === 'ABC-14 has no plan waiting for approval.');
});

test('Ask for changes sends the plan back to its writer in the same conversation, and it is ready again', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ write: FILE, content: PLAN2 }, { write: FILE, content: PLAN3 }]);
  scriptAgent(root, 'fr', []);
  const s0 = await createSprint(root, { name: 'Oct', tickets: [P()] }, { cwd: w.repo });
  await run(root, s0.id, w.env, settled);
  await assert.rejects(revisePlan(root, s0.id, 'ABC-14', '   '), (e) => e.code === 'nothing-to-change' && e.message === 'Say what should change in the plan.');
  const r = await revisePlan(root, s0.id, 'ABC-14', ' Split the CSV task in two. ');
  const t = r.tickets[0];
  assert.deepEqual([t.state, t.resume, t.asked, t.proposed, t.reason], ['waiting', 'revise', 'Split the CSV task in two.', null, 'Fa changes the plan next']);
  assert.equal(sprintSummary(root, r).tickets[0].canRevise, false, 'nothing to answer while it is being changed');
  const s = await run(root, s0.id, w.env, settled);
  assert.equal(s.tickets[0].state, 'plan-ready');
  assert.deepEqual(s.tickets[0].proposed.map((x) => x.title), ['Add the export button', 'Write the header', 'Write the rows']);
  const [plan, change] = jobsBy(root, 'author');
  assert.equal(change.followUpOf, plan.id);
  assert.deepEqual([change.sprint.task, change.sprint.plan], [0, true], 'a planning step says so: a real task may be numbered 0');
  assert.match(promptOf(root, change), /change the plan[\s\S]*Split the CSV task in two\./);
  assert.equal(w.git(change.worktree, 'log', '-1', '--format=%s'), 'wip(ABC-14): plan changes');
  // The second message says the plan was changed after the person's notes.
  assert.match(s.messages.at(-1).text, /^ABC-14's plan was changed after your notes \("Split the CSV task in two\."\): \d+ tasks?\.\n/);
  assert.match(s.messages.at(-1).text, /Read it there/);
  assert.equal(s.messages.filter((m) => /^ABC-14's plan (is ready|was changed)/.test(m.text)).length, 2, 'one message each time it is ready');
  assert.match(s.messages.filter((m) => /^ABC-14's plan (is ready|was changed)/.test(m.text))[0].text, /^ABC-14's plan is ready: \d+ tasks?\./);
  await assert.rejects(revisePlan(root, s0.id, 'ABC-99', 'x'), (e) => e.code === 'no-such-ticket');
});

test('Run as one task runs a plan with no tasks whole', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ write: FILE, content: '# Export\n\nJust do it all.\n' }, { write: 'all.txt' }]);
  scriptAgent(root, 'fr', [{ say: 'VERDICT: pass' }]);
  const s0 = await createSprint(root, { name: 'Oct', tickets: [P()] }, { cwd: w.repo });
  await run(root, s0.id, w.env, settled);
  await assert.rejects(approvePlan(root, s0.id, 'ABC-14'), (e) => e.code === 'no-tasks' && e.message === "Couldn't find tasks in ABC-14's plan. Run it as one task, or ask for changes.");
  const a = await approvePlan(root, s0.id, 'ABC-14', { whole: true });
  assert.deepEqual(a.tickets[0].tasks.map((x) => [x.n, x.title, x.agent, x.reviewer]), [[1, 'Export to CSV', 'fa', 'fr']]);
  await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'pr-open');
  assert.match(promptOf(root, jobsBy(root, 'author')[1]), /Just do it all\./);
});

test('a draft has no plan to answer yet', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', []);
  scriptAgent(root, 'fr', []);
  const { draftSprint } = await import('../engine/sprint.js');
  const d = await draftSprint(root, { name: 'Oct', tickets: [P()] }, { cwd: w.repo });
  await assert.rejects(approvePlan(root, d.id, 'ABC-14'), (e) => e.code === 'not-started');
  await assert.rejects(revisePlan(root, d.id, 'ABC-14', 'x'), (e) => e.code === 'not-started');
});

test('the CLI approves, sends back with notes and runs as one task, then asks for a runner', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ write: FILE, content: PLAN2 }, { write: FILE, content: PLAN3 }]);
  scriptAgent(root, 'fr', []);
  const s0 = await createSprint(root, { name: 'Oct', tickets: [P()] }, { cwd: w.repo });
  await run(root, s0.id, w.env, settled);
  const spawned = [];
  const spawn = (_file, args) => spawned.push(args);
  assert.equal((await cli(root, ['sprint', 'revise', '--id', s0.id, '--ticket', 'ABC-14'], { spawn })).body.error.code, 'missing-option');
  const back = await cli(root, ['sprint', 'revise', '--id', s0.id, '--ticket', 'ABC-14', '--text', '-'], { stdin: 'More tests.', spawn });
  assert.equal(back.code, 0);
  assert.equal(back.body.sprint.tickets[0].state, 'waiting');
  assert.equal(loadSprint(root, s0.id).tickets[0].asked, 'More tests.');
  assert.deepEqual(spawned, [[root, s0.id]], 'a runner is asked for');
  await run(root, s0.id, w.env, settled);
  assert.equal((await cli(root, ['sprint', 'one-task', '--id', s0.id, '--ticket', 'ABC-14'], { spawn })).body.error.code, 'plan-has-tasks');
  const ok = await cli(root, ['sprint', 'approve', '--id', s0.id, '--ticket', 'ABC-14'], { spawn });
  assert.equal(ok.code, 0);
  assert.equal(ok.body.sprint.tickets[0].of, 3);
  assert.equal(spawned.length, 2);
});

// The plan's checkpoint commits the whole copy, and task 1's review starts after it, so anything
// else the planner changed would ship unreviewed. It parks instead, naming the files.
const EXTRA = (files) => `Fa changed files other than the plan: ${files}. Ask for changes to keep only the plan, or stop the ticket.`;

test('a planner that also changes another file parks naming it; Ask for changes from there keeps only the plan', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [
    { write: FILE, content: PLAN2, also: { 'src/x.ts': 'export const x = 1;\n' } },
    { rm: 'src/x.ts', write: FILE, content: PLAN3 },
  ]);
  scriptAgent(root, 'fr', []);
  const s0 = await createSprint(root, { name: 'Oct', tickets: [P()] }, { cwd: w.repo });
  const s1 = await run(root, s0.id, w.env, settled);
  const t = s1.tickets[0];
  assert.deepEqual([t.state, t.reason, t.resume, t.proposed ?? null, t.tasks], ['parked', EXTRA('src/x.ts'), 'plan', null, []]);
  assert.equal(s1.messages.at(-1).text, `ABC-14 (Export to CSV) needs you: ${EXTRA('src/x.ts')}`);
  const sum = sprintSummary(root, s1).tickets[0];
  assert.deepEqual([sum.canRevise, sum.canApprove, sum.canOneTask, sum.canRetry, sum.giveTo, sum.plan], [true, false, false, true, 'writer', FILE]);
  await assert.rejects(approvePlan(root, s0.id, 'ABC-14'), (e) => e.code === 'no-plan-waiting');
  const r = await revisePlan(root, s0.id, 'ABC-14', 'Keep only the plan: take src/x.ts out.');
  assert.deepEqual([r.tickets[0].state, r.tickets[0].resume, r.tickets[0].asked], ['waiting', 'revise', 'Keep only the plan: take src/x.ts out.']);
  const s2 = await run(root, s0.id, w.env, settled);
  assert.equal(s2.tickets[0].state, 'plan-ready', s2.tickets[0].reason);
  assert.deepEqual(s2.tickets[0].proposed.map((x) => x.title), ['Add the export button', 'Write the header', 'Write the rows']);
  const [plan, change] = jobsBy(root, 'author');
  assert.equal(change.followUpOf, plan.id);
  assert.match(promptOf(root, change), /take src\/x\.ts out/);
  assert.equal(sprintSummary(root, s2).tickets[0].canRevise, true);
});

test('files the planner committed itself are caught too, and Retry runs the planner again', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [
    { write: FILE, content: PLAN2, also: { 'src/y.ts': 'y\n', 'README.md': 'changed\n' }, commit: 'my plan and some code' },
    { rm: 'src/y.ts', write: FILE, content: PLAN2, also: { 'README.md': 'hello\n' } },
  ]);
  scriptAgent(root, 'fr', []);
  const s0 = await createSprint(root, { name: 'Oct', tickets: [P()] }, { cwd: w.repo });
  const s1 = await run(root, s0.id, w.env, settled);
  assert.deepEqual([s1.tickets[0].state, s1.tickets[0].reason, s1.tickets[0].resume], ['parked', EXTRA('README.md, src/y.ts'), 'plan']);
  const r = await retryTicket(root, s0.id, 'ABC-14');
  assert.equal(r.tickets[0].reason, 'Trying again: Fa writes the plan');
  const s2 = await run(root, s0.id, w.env, settled);
  assert.equal(s2.tickets[0].state, 'plan-ready', s2.tickets[0].reason);
  const [first, second] = jobsBy(root, 'author');
  assert.equal(second.followUpOf, first.id, 'the planner ran again in the same copy');
});

test('Approve starts the tasks\' counts afresh: a retried plan\'s task 1 fails twice as "twice", not "after a retry"', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ say: 'My plan: do it.' }, { write: FILE, content: PLAN2 }, { write: 'a.txt' }, { write: 'a2.txt' }]);
  scriptAgent(root, 'fr', [{ say: 'Missing tests.\nVERDICT: fail' }, { say: 'Still missing.\nVERDICT: fail' }]);
  const s0 = await createSprint(root, { name: 'Oct', tickets: [P()] }, { cwd: w.repo });
  await run(root, s0.id, w.env, settled);
  await retryTicket(root, s0.id, 'ABC-14');
  await run(root, s0.id, w.env, settled);
  const a = await approvePlan(root, s0.id, 'ABC-14');
  assert.deepEqual([a.tickets[0].retries, a.tickets[0].fails], [0, 0]);
  const s = await run(root, s0.id, w.env, settled);
  assert.deepEqual([s.tickets[0].state, s.tickets[0].reason], ['parked', 'Review failed twice on task 1']);
});
