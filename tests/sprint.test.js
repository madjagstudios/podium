import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createSprint, loadSprint, listSprints, locked, sprintSummary } from '../engine/sprint.js';
import { isAlive } from '../engine/status.js';
import { scriptAgent, sprintWorld, PLAN } from './helpers.js';

const ticket = (over = {}) => ({ key: 'abc-11', title: 'Login form', type: 'feat', plan: 'docs/plan.md', agent: 'fa', reviewer: 'fr', ...over });

test('createSprint reads each plan into tasks with their agents and saves the sprint', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', []);
  scriptAgent(root, 'fr', []);
  scriptAgent(root, 'fb', []);
  const s = await createSprint(root, { name: 'Oct week 2', tickets: [ticket({ tasks: [{ n: 2, agent: 'fb' }] })] }, { cwd: w.repo, session: 'chat-1' });
  assert.equal(s.name, 'Oct week 2');
  assert.equal(s.base, 'main');
  assert.equal(s.maxParallel, 3);
  assert.equal(s.session, 'chat-1');
  const t = s.tickets[0];
  assert.equal(t.key, 'ABC-11');
  assert.equal(t.state, 'pending');
  assert.deepEqual(t.tasks.map((x) => [x.n, x.title, x.agent, x.reviewer]), [[1, 'Add a.txt', 'fa', 'fr'], [2, 'Add b.txt', 'fb', 'fr']]);
  assert.deepEqual(loadSprint(root, s.id), s);
  assert.equal(listSprints(root, { project: s.project }).length, 1);
  assert.equal(listSprints(root, { project: 'elsewhere' }).length, 0);
  const sum = sprintSummary(root, s);
  assert.deepEqual(sum.tickets[0], {
    key: 'ABC-11', title: 'Login form', state: 'pending', task: 1, of: 2, phase: null, agent: 'fa', reason: null, findings: null, pr: null, reviews: 0,
    latest: null,
    tasks: [
      { n: 1, title: 'Add a.txt', agent: 'fa', reviewer: 'fr', status: 'to-do', canAssign: true },
      { n: 2, title: 'Add b.txt', agent: 'fb', reviewer: 'fr', status: 'to-do', canAssign: true },
    ],
    canRetry: false, giveTo: null, canStop: true,
    plan: 'docs/plan.md', writer: null, reviewer: null, canAssignPlan: false, after: [], waitingOn: [], slot: 'free',
    proposed: null, canApprove: false, canOneTask: false, canRevise: false,
  });
});

test('createSprint refuses what it cannot run, saying why', async () => {
  const { root, w } = sprintWorld({ plans: { 'docs/plan.md': PLAN, 'docs/none.md': '# Nothing\n' } });
  scriptAgent(root, 'fa', []);
  scriptAgent(root, 'fr', []);
  const bad = async (draft, code) => assert.rejects(createSprint(root, draft, { cwd: w.repo }), (e) => e.code === code);
  await bad({ name: 'x', tickets: [] }, 'no-tickets');
  await bad({ name: 'x', tickets: [ticket({ key: 'nope' })] }, 'bad-ticket');
  await bad({ name: 'x', tickets: [ticket(), ticket()] }, 'bad-ticket');
  // A ticket may come without a plan, but then needs a reviewer for the tasks its plan will have.
  await bad({ name: 'x', tickets: [ticket({ plan: undefined, reviewer: undefined })] }, 'no-agent');
  await bad({ name: 'x', tickets: [ticket({ plan: 'docs/missing.md' })] }, 'no-plan');
  await bad({ name: 'x', tickets: [ticket({ plan: 'docs/none.md' })] }, 'no-tasks');
  await bad({ name: 'x', tickets: [ticket({ reviewer: undefined })] }, 'no-agent');
  await bad({ name: 'x', tickets: [ticket({ agent: 'ghost' })] }, 'unknown-agent');
  await bad({ name: 'x', base: 'nowhere', tickets: [ticket()] }, 'unknown-base');
  await assert.rejects(createSprint(root, { name: 'x', tickets: [ticket({ tasks: [{ n: 3, agent: 'fa' }] })] }, { cwd: w.repo }),
    (e) => e.code === 'no-such-task' && e.message === 'ABC-11 has no task 3 in its plan.');
});

test('createSprint refuses a ticket whose branch already exists', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', []);
  scriptAgent(root, 'fr', []);
  w.git(w.repo, 'branch', 'feat/abc-11-login-form');
  await assert.rejects(createSprint(root, { name: 'x', tickets: [ticket()] }, { cwd: w.repo }), (e) => e.code === 'branch-taken'
    && e.message === "ABC-11's branch feat/abc-11-login-form already exists in this repo. Delete it or rename the ticket's title.");
  assert.ok(await createSprint(root, { name: 'x', tickets: [ticket({ title: 'Login form v2' })] }, { cwd: w.repo }));
});

test('locked runs one holder at a time and frees the lock after an error', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', []);
  scriptAgent(root, 'fr', []);
  const s = await createSprint(root, { name: 'x', tickets: [ticket()] }, { cwd: w.repo });
  const order = [];
  await Promise.all([
    locked(root, s.id, async () => { order.push('a1'); await new Promise((r) => setTimeout(r, 100)); order.push('a2'); }),
    locked(root, s.id, async () => { order.push('b'); }),
  ]);
  assert.deepEqual(order, ['a1', 'a2', 'b']);
  await assert.rejects(locked(root, s.id, async () => { throw new Error('x'); }));
  assert.equal(await locked(root, s.id, async () => 'free'), 'free');
});

// A sprint with its lock file path, for the lock tests.
async function lockWorld() {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', []);
  scriptAgent(root, 'fr', []);
  const s = await createSprint(root, { name: 'x', tickets: [ticket()] }, { cwd: w.repo });
  return { root, w, id: s.id, lock: path.join(root, 'sprints', s.id, 'sprint.lock') };
}
const plant = (lock, pid, token = 'planted') => fs.writeFileSync(lock, JSON.stringify({ pid, token }));
const busy = (e) => e.code === 'sprint-busy';

test('locked reclaims a lock whose holder is dead, at once', async () => {
  const { root, id, lock } = await lockWorld();
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  assert.equal(isAlive(dead), false);
  plant(lock, dead);
  const started = Date.now();
  assert.equal(await locked(root, id, async () => 'ok'), 'ok');
  assert.ok(Date.now() - started < 1000);
  assert.equal(fs.existsSync(lock), false);
  assert.deepEqual(fs.readdirSync(path.dirname(lock)).filter((f) => f.includes('.stale.')), []);
  plant(lock, 999999);
  if (!isAlive(999999)) assert.equal(await locked(root, id, async () => 'ok2'), 'ok2');
});

test('locked leaves a live, fresh lock alone and gives up with sprint-busy', async () => {
  const { root, id, lock } = await lockWorld();
  plant(lock, process.pid);
  await assert.rejects(locked(root, id, async () => 'no', { waitMs: 200 }), busy);
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).token, 'planted');
});

test('locked reclaims a lock older than the stale limit even if its holder looks alive', async () => {
  const { root, id, lock } = await lockWorld();
  plant(lock, process.pid);
  const old = new Date(Date.now() - 11 * 60_000);
  fs.utimesSync(lock, old, old);
  assert.equal(await locked(root, id, async () => 'ok'), 'ok');
});

test('locked judges an unreadable lock file by age only', async () => {
  const { root, id, lock } = await lockWorld();
  fs.writeFileSync(lock, 'not json');
  await assert.rejects(locked(root, id, async () => 'no', { waitMs: 150 }), busy);
  const old = new Date(Date.now() - 11 * 60_000);
  fs.utimesSync(lock, old, old);
  assert.equal(await locked(root, id, async () => 'ok'), 'ok');
});

test('locked releases only its own lock: a lock someone else took over stays', async () => {
  const { root, id, lock } = await lockWorld();
  await locked(root, id, async () => { plant(lock, process.pid, 'someone-else'); });
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).token, 'someone-else');
  fs.rmSync(lock);
  await locked(root, id, async () => { fs.rmSync(lock); });
  assert.equal(fs.existsSync(lock), false);
});

test('locked says sprint-not-found for an id with no sprint', async () => {
  const { root } = await lockWorld();
  await assert.rejects(locked(root, 'no-such-id', async () => 'x'), (e) => e.code === 'sprint-not-found');
});

test('createSprint refuses a plan outside the repo or one that is not a file', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', []);
  scriptAgent(root, 'fr', []);
  const outside = path.resolve(w.repo, '..', 'outside.md');
  fs.writeFileSync(outside, PLAN);
  try {
    const bad = async (plan) => assert.rejects(createSprint(root, { name: 'x', tickets: [ticket({ plan })] }, { cwd: w.repo }), (e) => e.code === 'no-plan');
    await bad('../outside.md');
    await bad(outside);
    await bad('docs');
  } finally {
    fs.rmSync(outside, { force: true });
  }
});
