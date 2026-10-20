// A task test that fails after a writer's step runs again at the ticket's base: failures already there are not this change's.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createSprint, tick, loadSprint, saveSprint, retryTicket, stopTicket, sprintSummary } from '../engine/sprint.js';
import { listJobDirs, readJob, findJobDir } from '../engine/store.js';
import { setSetting } from '../engine/settings.js';
import { projectKey } from '../engine/paths.js';
import { ticketStatusLine } from '../mod/view.js';
import { waitFor, scriptAgent, sprintWorld } from './helpers.js';

const ONE = '# Plan\n\n### Task 1: Add a.txt\nWrite a.txt.\n';
const T = (over = {}) => ({ key: 'ABC-11', title: 'Login form', type: 'feat', plan: 'docs/one.md', agent: 'fa', reviewer: 'fr', ...over });
const run = (root, id, env, until) => waitFor(async () => { const s = await tick(root, id, { env }); return until(s) ? s : null; }, { timeoutMs: 90_000, intervalMs: 150 });
const settled = (s) => s.tickets.every((t) => !['pending', 'running', 'waiting'].includes(t.state));
const jobsBy = (root, role) => listJobDirs(root).map(readJob).filter((j) => j.sprint?.role === role).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
const promptOf = (root, job) => fs.readFileSync(path.join(findJobDir(root, job.id), 'prompt.md'), 'utf8');
const node = `"${process.execPath}"`;
const script = (body) => `${node} -e "const f=require('fs');${body}"`;
// Fails everywhere, saying where it ran: after the writer's change (a.txt there), or at the base.
const ALWAYS = script("console.log(f.existsSync('a.txt')?'after: 3 failing':'base: 3 failing');process.exit(1)");

function world(taskTest) {
  const { root, w } = sprintWorld({ plans: { 'docs/one.md': ONE } });
  setSetting(root, 'repoTaskTest', { [projectKey(w.repo)]: taskTest });
  return { root, w };
}
const baselineDirs = (root, s) => {
  try { return fs.readdirSync(path.join(root, 'sprints', s.id, 'baselines')); } catch { return []; }
};

test('a task test that fails at the base too goes to review, whose reviewer weighs only what this change caused', async () => {
  const { root, w } = world(ALWAYS);
  scriptAgent(root, 'fa', [{ write: 'a.txt' }]);
  scriptAgent(root, 'fr', [{ say: 'VERDICT: pass' }]);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  const s = await run(root, s0.id, w.env, settled);
  assert.equal(s.tickets[0].state, 'pr-open', s.tickets[0].reason);
  const review = promptOf(root, jobsBy(root, 'reviewer')[0]);
  assert.match(review, /it fails at the ticket's base too, before this change\. Fail the task only for failures this change caused/);
  assert.ok(review.includes('after: 3 failing') && review.includes('base: 3 failing'), 'both runs\' logs');
  assert.doesNotMatch(review, /Fail the task if its tests did not run or failed/);
  // One run at the base, its throwaway copy gone once read.
  const [b] = Object.values(s.baselines);
  assert.equal(b.commit, s.tickets[0].from);
  assert.equal(b.removed, true);
  assert.equal(fs.existsSync(b.copy), false);
  assert.doesNotMatch(w.git(w.repo, 'worktree', 'list'), /baselines/);
});

test('a task test that passes at the base parks: this change broke it, and the writer\'s retry is told so', async () => {
  const { root, w } = world(script("console.log('host: a.txt breaks it');process.exit(f.existsSync('a.txt')&&!f.existsSync('fixed.txt')?1:0)"));
  scriptAgent(root, 'fa', [{ write: 'a.txt' }, { write: 'fixed.txt' }]);
  scriptAgent(root, 'fr', [{ say: 'VERDICT: pass' }]);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  const parked = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  assert.equal(parked.tickets[0].reason, "Task 1's task test fails on this machine and passes at the ticket's base: this change broke it");
  assert.match(parked.tickets[0].findings, /host: a\.txt breaks it/);
  assert.equal(parked.tickets[0].phase, 'task-test', 'parked as the task test\'s own failure');
  assert.equal(sprintSummary(root, parked).tickets[0].canAccept, true);
  await retryTicket(root, s0.id, 'ABC-11');
  const s = await run(root, s0.id, w.env, settled);
  assert.equal(s.tickets[0].state, 'pr-open', s.tickets[0].reason);
  assert.match(promptOf(root, jobsBy(root, 'author')[1]), /It passes at the ticket's base, before this task's change: this change broke it\./);
});

test('tickets with the same base and task test share one run at the base', async () => {
  const { root, w } = world(ALWAYS);
  scriptAgent(root, 'fa', [{ write: 'a.txt' }, { write: 'a.txt' }]);
  scriptAgent(root, 'fr', [{ say: 'VERDICT: pass' }, { say: 'VERDICT: pass' }]);
  const s0 = await createSprint(root, { name: 'x', tickets: [T(), T({ key: 'ABC-12', title: 'Payouts' })] }, { cwd: w.repo });
  const s = await run(root, s0.id, w.env, settled);
  assert.deepEqual(s.tickets.map((t) => t.state), ['pr-open', 'pr-open']);
  assert.equal(Object.keys(s.baselines).length, 1);
  assert.equal(baselineDirs(root, s).length, 1, 'one run for both');
  for (const review of jobsBy(root, 'reviewer')) assert.match(promptOf(root, review), /fails at the ticket's base too/);
});

test('while it runs at the base the ticket says so and can\'t be stopped; a lost run parks as a plain failure', async () => {
  // Slow only at the base (no a.txt there).
  const { root, w } = world(script("if(f.existsSync('a.txt')){console.log('after: 1 failing');process.exit(1)}setTimeout(()=>process.exit(1),20000)"));
  scriptAgent(root, 'fa', [{ write: 'a.txt' }]);
  scriptAgent(root, 'fr', []);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  const waiting = await run(root, s0.id, w.env, (x) => x.tickets[0].phase === 'baseline');
  const sum = sprintSummary(root, waiting).tickets[0];
  assert.deepEqual([sum.state, sum.canStop], ['running', false]);
  assert.equal(ticketStatusLine(sum), 'Task 1 of 1 · the task test failed; running it at the base to see if this change caused it');
  await assert.rejects(stopTicket(root, s0.id, 'ABC-11'), (e) => e.code === 'ticket-busy');
  // Its record is gone: lost.
  const stored = loadSprint(root, s0.id);
  const { key } = stored.tickets[0].baseline;
  const gone = path.join(stored.baselines[key].dir, 'missing');
  stored.baselines[key] = { ...stored.baselines[key], dir: gone };
  stored.tickets[0].baseline = { key, dir: gone };
  saveSprint(root, stored);
  const parked = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  assert.equal(parked.tickets[0].reason, "Task 1's task test failed on this machine");
  assert.match(parked.tickets[0].findings, /after: 1 failing/);
  assert.deepEqual([parked.tickets[0].resume, parked.tickets[0].phase], ['author', 'task-test']);
});

// A detached copy of the repo standing in for a run's throwaway copy.
function extraCopy(w, root, name) {
  const copy = path.join(root, name);
  w.git(w.repo, 'worktree', 'add', '-q', '--detach', copy, 'HEAD');
  return copy;
}

test('a ticket parked while its run at the base was being started keeps its writer when retried', async () => {
  const { root, w } = world(script("if(f.existsSync('a.txt')){console.log('after: 1 failing');process.exit(1)}setTimeout(()=>process.exit(1),20000)"));
  scriptAgent(root, 'fa', [{ write: 'a.txt' }]);
  scriptAgent(root, 'fr', []);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  await run(root, s0.id, w.env, (x) => x.tickets[0].phase === 'baseline');
  // As a start that threw leaves it: parked on the task test, its phase still the base's.
  const stored = loadSprint(root, s0.id);
  Object.assign(stored.tickets[0], { state: 'parked', resume: 'task-test', trying: 'task-test', reason: 'x' });
  saveSprint(root, stored);
  await retryTicket(root, s0.id, 'ABC-11');
  const again = await run(root, s0.id, w.env, (x) => x.tickets[0].phase === 'task-test' || x.tickets[0].phase === 'baseline');
  assert.equal(again.tickets[0].taskTest.writer, 'author');
});

test('a lost run at the base replaced by a new one keeps its copy listed until that copy can be removed', async () => {
  const { setBootTime } = await import('../engine/check.js');
  setBootTime(0);
  try {
    const { root, w } = world(ALWAYS);
    scriptAgent(root, 'fa', [{ write: 'a.txt', ms: 1500 }]);
    scriptAgent(root, 'fr', [{ say: 'VERDICT: pass' }]);
    const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
    const writing = await run(root, s0.id, w.env, (x) => x.tickets[0].phase === 'author' && x.tickets[0].from);
    // A run for this command and base that is lost (silent for hours) while its runner (here: this process) lives on.
    const { createHash } = await import('node:crypto');
    const key = createHash('sha256').update(`${ALWAYS}\0${writing.tickets[0].from}`).digest('hex').slice(0, 16);
    const old = extraCopy(w, root, 'old-baseline');
    const dir = path.join(root, 'old-record');
    fs.mkdirSync(dir);
    const hours = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
    fs.writeFileSync(path.join(dir, 'check.json'), JSON.stringify({ command: ALWAYS, cwd: old, limitMs: 1000, startedAt: hours, runnerPid: process.pid, beatAt: hours, checkPid: null, endedAt: null }));
    const stored = loadSprint(root, s0.id);
    stored.baselines = { [key]: { dir, copy: old, commit: writing.tickets[0].from, command: ALWAYS, minutes: 30, removed: false } };
    saveSprint(root, stored);
    const s = await run(root, s0.id, w.env, settled);
    assert.equal(s.tickets[0].state, 'pr-open', s.tickets[0].reason);
    assert.notEqual(s.baselines[key].copy, old, 'a new run replaced it');
    assert.deepEqual(s.oldBaselines.map((b) => b.copy), [old], 'the old copy stays listed while its runner may write');
    assert.equal(fs.existsSync(old), true);
    // Its runner ends: the next tick removes it, and the list empties.
    const rec = JSON.parse(fs.readFileSync(path.join(dir, 'check.json'), 'utf8'));
    fs.writeFileSync(path.join(dir, 'check.json'), JSON.stringify({ ...rec, endedAt: new Date().toISOString(), exitCode: 1 }));
    const after = await tick(root, s0.id, { env: w.env });
    assert.deepEqual(after.oldBaselines, []);
    assert.equal(fs.existsSync(old), false);
    assert.doesNotMatch(w.git(w.repo, 'worktree', 'list'), /old-baseline/);
  } finally {
    setBootTime(null);
  }
});

test('a copy whose runner may still write is left; once settled it goes, and a failing removal keeps the runner a while', async () => {
  const { setBootTime } = await import('../engine/check.js');
  const { wantsRunner } = await import('../engine/sprint.js');
  setBootTime(0);
  try {
    const { root, w } = world(ALWAYS);
    scriptAgent(root, 'fa', [{ write: 'a.txt' }]);
    scriptAgent(root, 'fr', [{ say: 'VERDICT: pass' }]);
    const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
    await run(root, s0.id, w.env, settled);
    // A run lost by checkState (silent for hours) whose runner (here: this process) is still alive.
    const dir = path.join(root, 'silent');
    fs.mkdirSync(dir);
    const hours = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
    fs.writeFileSync(path.join(dir, 'check.json'), JSON.stringify({ command: 'x', cwd: dir, limitMs: 1000, startedAt: hours, runnerPid: process.pid, beatAt: hours, checkPid: null, endedAt: null }));
    const copy = extraCopy(w, root, 'silent-copy');
    const stored = loadSprint(root, s0.id);
    stored.baselines.silent = { dir, copy, commit: 'x', command: 'x', minutes: 30, removed: false };
    saveSprint(root, stored);
    await tick(root, s0.id, { env: w.env });
    assert.equal(fs.existsSync(copy), true, 'never removed under a live runner');
    assert.equal(wantsRunner(root, loadSprint(root, s0.id)), false, 'nor does it keep the runner going');
    // Settled: removed on the next tick.
    const rec = JSON.parse(fs.readFileSync(path.join(dir, 'check.json'), 'utf8'));
    fs.writeFileSync(path.join(dir, 'check.json'), JSON.stringify({ ...rec, endedAt: new Date().toISOString(), exitCode: 1 }));
    assert.equal(wantsRunner(root, loadSprint(root, s0.id)), true, 'a copy to remove keeps the runner, the sprint finished or not');
    const after = await tick(root, s0.id, { env: w.env });
    assert.equal(after.baselines.silent.removed, true);
    assert.equal(fs.existsSync(copy), false);
    // A removal that keeps failing is given up after its retry time.
    const failing = loadSprint(root, s0.id);
    failing.baselines.silent = { ...failing.baselines.silent, removed: false, failedAt: new Date(Date.now() - 11 * 60_000).toISOString() };
    saveSprint(root, failing);
    assert.equal(wantsRunner(root, loadSprint(root, s0.id)), false);
  } finally {
    setBootTime(null);
  }
});

test('paused while a run at the base ends: the runner stops until Resume, then the ticket reads it', async () => {
  const { checkState } = await import('../engine/check.js');
  const { wantsRunner, setPaused } = await import('../engine/sprint.js');
  const { root, w } = world(script("if(f.existsSync('a.txt')){console.log('after: 1 failing');process.exit(1)}setTimeout(()=>process.exit(1),1500)"));
  scriptAgent(root, 'fa', [{ write: 'a.txt' }]);
  scriptAgent(root, 'fr', [{ say: 'VERDICT: pass' }]);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  const waiting = await run(root, s0.id, w.env, (x) => x.tickets[0].phase === 'baseline');
  await setPaused(root, s0.id, true);
  await waitFor(() => checkState(waiting.tickets[0].baseline.dir).state === 'failed', { timeoutMs: 30_000 });
  await tick(root, s0.id, { env: w.env });
  const paused = loadSprint(root, s0.id);
  assert.equal(paused.tickets[0].phase, 'baseline', 'a paused ticket reads it later');
  assert.equal(wantsRunner(root, paused), false, 'nothing for the runner to do while paused');
  await setPaused(root, s0.id, false);
  assert.equal(wantsRunner(root, loadSprint(root, s0.id)), true);
  const s = await run(root, s0.id, w.env, settled);
  assert.equal(s.tickets[0].state, 'pr-open', s.tickets[0].reason);
  assert.equal(Object.values(s.baselines)[0].removed, true);
});

test('a finished sprint with a copy still to remove is not archived until it is removed or given up', async () => {
  const { archiveEnded, sprintSummaries } = await import('../engine/sprint.js');
  const { root, w } = world(ALWAYS);
  scriptAgent(root, 'fa', [{ write: 'a.txt' }]);
  scriptAgent(root, 'fr', [{ say: 'VERDICT: pass' }]);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  await run(root, s0.id, w.env, settled);
  // Its PR merged and its news delivered: everything else says archive it.
  const done = loadSprint(root, s0.id);
  Object.assign(done.tickets[0], { state: 'merged' });
  done.finishedAt = new Date().toISOString();
  const [b] = Object.values(done.baselines);
  b.removed = false;
  b.failedAt = new Date().toISOString();
  saveSprint(root, done);
  const fresh = loadSprint(root, s0.id);
  fresh.messages = fresh.messages.map((m) => ({ ...m, delivered: true }));
  saveSprint(root, fresh);
  await archiveEnded(root, sprintSummaries(root, {}).filter((x) => x.id === s0.id).map((x) => ({ ...x, tickets: x.tickets.map((t) => ({ ...t, state: 'merged' })) })));
  assert.equal(loadSprint(root, s0.id).archived, undefined, 'its runner still retries the copy');
  // Given up after its retry time: archived.
  const late = loadSprint(root, s0.id);
  Object.values(late.baselines)[0].failedAt = new Date(Date.now() - 11 * 60_000).toISOString();
  saveSprint(root, late);
  await archiveEnded(root, sprintSummaries(root, {}).filter((x) => x.id === s0.id).map((x) => ({ ...x, tickets: x.tickets.map((t) => ({ ...t, state: 'merged' })) })));
  assert.equal(loadSprint(root, s0.id).archived, true);
});
