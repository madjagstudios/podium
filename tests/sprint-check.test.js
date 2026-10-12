// The repo's full check runs in the ticket's copy before its PR.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createSprint, tick, locked, retryTicket, stopTicket, setPaused, saveSprint } from '../engine/sprint.js';
import { isAlive } from '../engine/status.js';
import { setBootTime } from '../engine/check.js';
import { listJobDirs, readJob } from '../engine/store.js';
import { setSetting } from '../engine/settings.js';
import { projectKey } from '../engine/paths.js';
import { waitFor, scriptAgent, sprintWorld } from './helpers.js';

const T = (over = {}) => ({ key: 'ABC-11', title: 'Login form', type: 'feat', plan: 'docs/plan.md', agent: 'fa', reviewer: 'fr', ...over });
const run = (root, id, env, until) => waitFor(async () => { const s = await tick(root, id, { env }); return until(s) ? s : null; }, { timeoutMs: 90_000, intervalMs: 150 });
const jobsBy = (root, role) => listJobDirs(root).map(readJob).filter((j) => j.sprint?.role === role).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
const promptOf = (root, job) => fs.readFileSync(path.join(listJobDirs(root).find((d) => d.endsWith(job.id)), 'prompt.md'), 'utf8');
const node = `"${process.execPath}"`;

function world(check, { minutes } = {}) {
  const { root, w } = sprintWorld();
  setSetting(root, 'repoCheck', { [projectKey(w.repo)]: check });
  if (minutes) setSetting(root, 'checkMinutes', minutes);
  scriptAgent(root, 'fr', [{ say: 'VERDICT: pass' }, { say: 'VERDICT: pass' }]);
  return { root, w };
}

test('a failing full check parks the ticket before the PR, and gh is never called', async () => {
  const { root, w } = world(`${node} -e "console.log('3 tests failed'); process.exit(1)"`);
  scriptAgent(root, 'fa', [{ write: 'a.txt' }, { write: 'b.txt' }]);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  const s = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  const t = s.tickets[0];
  assert.equal(t.reason, 'The full check failed before the PR');
  assert.match(t.findings, /3 tests failed/);
  assert.equal(t.resume, 'check-fix');
  assert.deepEqual(w.calls(), [], 'gh is never called');
});

test('a passing full check opens the PR; while it runs the ticket says so and the sprint is not locked', async () => {
  const { root, w } = world(`${node} -e "setTimeout(process.exit, 3000)"`);
  scriptAgent(root, 'fa', [{ write: 'a.txt' }, { write: 'b.txt' }]);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  const checking = await run(root, s0.id, w.env, (x) => x.tickets[0].phase === 'check');
  assert.equal(checking.tickets[0].state, 'running');
  await locked(root, s0.id, async () => {}, { waitMs: 200 });
  await assert.rejects(stopTicket(root, s0.id, 'ABC-11'), (e) => e.code === 'ticket-busy');
  const s = await run(root, s0.id, w.env, (x) => ['pr-open', 'parked'].includes(x.tickets[0].state));
  assert.equal(s.tickets[0].state, 'pr-open', s.tickets[0].reason);
  assert.equal(s.tickets[0].pr.number, 12);
});

test('Retry after a failed check sends the writer a fix with the log, then runs the check again', async () => {
  const { root, w } = world(`${node} -e "console.log('lint: fixed.txt is missing'); process.exit(require('fs').existsSync('fixed.txt') ? 0 : 1)"`);
  scriptAgent(root, 'fa', [{ write: 'a.txt' }, { write: 'b.txt' }, { write: 'fixed.txt', say: 'Added fixed.txt.' }]);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  await retryTicket(root, s0.id, 'ABC-11');
  const s = await run(root, s0.id, w.env, (x) => ['pr-open', 'parked'].includes(x.tickets[0].state));
  assert.equal(s.tickets[0].state, 'pr-open', s.tickets[0].reason);
  const authors = jobsBy(root, 'author');
  const fix = authors.at(-1);
  assert.match(fix.title, /^ABC-11: fix what the full check found/);
  assert.match(promptOf(root, fix), /lint: fixed\.txt is missing/);
  assert.equal(fix.followUpOf, authors[1].id);
});

test('what a check writes or rewrites never reaches the PR, even after a failed check and its fix', async () => {
  const script = "const f=require('fs');f.mkdirSync('TestResults',{recursive:true});f.writeFileSync('TestResults/out.trx','junk');f.writeFileSync('a.txt','REWRITTEN BY THE CHECK');process.exit(f.existsSync('fixed.txt')?0:1)";
  const { root, w } = world(`${node} -e "${script}"`);
  scriptAgent(root, 'fa', [{ write: 'a.txt' }, { write: 'b.txt' }, { write: 'fixed.txt', say: 'Added fixed.txt.' }]);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  await retryTicket(root, s0.id, 'ABC-11');
  const s = await run(root, s0.id, w.env, (x) => ['pr-open', 'parked'].includes(x.tickets[0].state));
  assert.equal(s.tickets[0].state, 'pr-open', s.tickets[0].reason);
  const { branch } = jobsBy(root, 'author')[0];
  const shipped = w.git(w.remote, 'log', '-p', `main..${branch}`);
  assert.match(shipped, /fixed\.txt/);
  assert.match(shipped, /a\.txt/);
  assert.doesNotMatch(shipped, /TestResults|REWRITTEN BY THE CHECK/);
});

test('a passing check clears its log, so a PR that then cannot open shows only its own reason', async () => {
  const { root, w } = world(`${node} -e "console.log('lint: fixed.txt is missing'); process.exit(require('fs').existsSync('fixed.txt') ? 0 : 1)"`);
  scriptAgent(root, 'fa', [{ write: 'a.txt' }, { write: 'b.txt' }, { write: 'fixed.txt', say: 'Added fixed.txt.' }]);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  w.git(w.repo, 'remote', 'remove', 'origin');
  await retryTicket(root, s0.id, 'ABC-11');
  const s = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  const t = s.tickets[0];
  assert.equal(t.resume, 'pr', t.reason);
  assert.equal(t.findings, null);
});

test('a check far past its limit is stopped through its runner even while the sprint is paused', async () => {
  // Backdated 3 hours below: a CI machine may have started since, which would read as a check from before the boot.
  setBootTime(0);
  try {
    const { root, w } = world(`${node} -e "setInterval(Date.now, 1000)"`);
    scriptAgent(root, 'fa', [{ write: 'a.txt' }, { write: 'b.txt' }]);
    const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
    const checking = await run(root, s0.id, w.env, (x) => x.tickets[0].phase === 'check');
    const file = path.join(checking.tickets[0].check.dir, 'check.json');
    const rec = await waitFor(() => { try { const r = JSON.parse(fs.readFileSync(file, 'utf8')); return r.checkPid && r.beatAt ? r : null; } catch { return null; } });
    await setPaused(root, s0.id, true);
    // As after a long sleep of the machine: far past its limit by the clock, its runner still beating.
    const s = await run(root, s0.id, w.env, (x) => {
      if (x.tickets[0].state !== 'parked') {
        const now = JSON.parse(fs.readFileSync(file, 'utf8'));
        fs.writeFileSync(file, JSON.stringify({ ...now, startedAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString() }));
      }
      return x.tickets[0].state === 'parked';
    });
    assert.equal(s.paused, true);
    assert.match(s.tickets[0].reason, /^The full check ran past its time limit/);
    assert.equal(s.tickets[0].resume, 'check-fix');
    await waitFor(() => !isAlive(rec.checkPid) && !isAlive(rec.runnerPid), { timeoutMs: 30_000 });
  } finally {
    setBootTime(null);
  }
});

// A check that writes a build folder and rewrites a tracked file, then fails.
const MESSY = (exit) => `${node} -e "const f=require('fs');f.mkdirSync('TestResults',{recursive:true});f.writeFileSync('TestResults/out.trx','junk');f.writeFileSync('a.txt','REWRITTEN BY THE CHECK');process.exit(${exit})"`;
const checksOf = (root, id) => { try { return fs.readdirSync(path.join(root, 'sprints', id, 'checks')); } catch { return []; } };

test('a lost check whose repo check is then removed: Retry opens the PR with none of the check\'s leftovers', async () => {
  const { root, w } = world(MESSY(1));
  scriptAgent(root, 'fa', [{ write: 'a.txt' }, { write: 'b.txt' }]);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  const checking = await run(root, s0.id, w.env, (x) => x.tickets[0].phase === 'check');
  const file = path.join(checking.tickets[0].check.dir, 'check.json');
  const rec = await waitFor(() => { try { const r = JSON.parse(fs.readFileSync(file, 'utf8')); return r.endedAt ? r : null; } catch { return null; } });
  // As if its runner died before it could write the result: no result, and a runner that is gone.
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  fs.writeFileSync(file, JSON.stringify({ ...rec, endedAt: null, exitCode: null, runnerPid: dead }));
  const lost = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  assert.equal(lost.tickets[0].resume, 'check', lost.tickets[0].reason);
  setSetting(root, 'repoCheck', {});
  await retryTicket(root, s0.id, 'ABC-11');
  const s = await run(root, s0.id, w.env, (x) => ['pr-open', 'parked'].includes(x.tickets[0].state));
  assert.equal(s.tickets[0].state, 'pr-open', s.tickets[0].reason);
  const { branch } = jobsBy(root, 'author')[0];
  const shipped = w.git(w.remote, 'log', '-p', `main..${branch}`);
  assert.match(shipped, /a\.txt/);
  assert.doesNotMatch(shipped, /TestResults|REWRITTEN BY THE CHECK/);
});

test('a failed check whose repo check is then removed: Retry opens the PR without a fix and without the check\'s leftovers', async () => {
  const { root, w } = world(MESSY(1));
  scriptAgent(root, 'fa', [{ write: 'a.txt' }, { write: 'b.txt' }]);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  const parked = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  assert.equal(parked.tickets[0].resume, 'check-fix');
  setSetting(root, 'repoCheck', {});
  await retryTicket(root, s0.id, 'ABC-11');
  const s = await run(root, s0.id, w.env, (x) => ['pr-open', 'parked'].includes(x.tickets[0].state));
  assert.equal(s.tickets[0].state, 'pr-open', s.tickets[0].reason);
  assert.equal(s.tickets[0].findings, null, 'the old check log is done with');
  assert.equal(jobsBy(root, 'author').length, 2, 'no fix ran against the old log');
  const { branch } = jobsBy(root, 'author')[0];
  assert.doesNotMatch(w.git(w.remote, 'log', '-p', `main..${branch}`), /TestResults|REWRITTEN BY THE CHECK/);
});

test('a tick that dies between starting the check and saving the sprint never starts a second check', async () => {
  const { root, w } = world(`${node} -e "setTimeout(process.exit, 4000)"`);
  scriptAgent(root, 'fa', [{ write: 'a.txt' }, { write: 'b.txt' }]);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  let crashed = false;
  // The first save made after the check's folder exists (it is spawned by then) fails: a runner killed there.
  const saveFn = (r, s, lock) => {
    const t = s.tickets[0];
    if (!crashed && t.phase === 'check' && t.check?.dir && fs.existsSync(t.check.dir)) { crashed = true; throw new Error('killed'); }
    return saveSprint(r, s, lock);
  };
  await waitFor(async () => {
    try { await tick(root, s0.id, { env: w.env, saveFn }); } catch (e) { if (e.message === 'killed') return true; throw e; }
    return null;
  }, { timeoutMs: 90_000, intervalMs: 150 });
  assert.equal(checksOf(root, s0.id).length, 1);
  const after = await tick(root, s0.id, { env: w.env });
  assert.equal(after.tickets[0].phase, 'check');
  assert.equal(checksOf(root, s0.id).length, 1, 'the next tick reads the check it started, and starts no other');
  const s = await run(root, s0.id, w.env, (x) => ['pr-open', 'parked'].includes(x.tickets[0].state));
  assert.equal(s.tickets[0].state, 'pr-open', s.tickets[0].reason);
  assert.equal(checksOf(root, s0.id).length, 1);
});

test('stopping a ticket after its check failed keeps its branch without the check\'s leftovers', async () => {
  const { root, w } = world(MESSY(1));
  scriptAgent(root, 'fa', [{ write: 'a.txt' }, { write: 'b.txt' }]);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  const parked = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  assert.equal(parked.tickets[0].phase, 'check');
  const s = await stopTicket(root, s0.id, 'ABC-11');
  assert.equal(s.tickets[0].state, 'stopped');
  const { branch } = jobsBy(root, 'author')[0];
  const kept = w.git(w.repo, 'log', '-p', `main..${branch}`);
  assert.match(kept, /b\.txt/);
  assert.doesNotMatch(kept, /TestResults|REWRITTEN BY THE CHECK|unfinished work saved/);
});

test('a hand-edited time limit that is not a number above 0 gives the check 30 minutes, and none gets more than a day', async () => {
  for (const [minutes, want] of [['soon', 30], [0, 30], [-5, 30], [null, 30], [1e9, 1440]]) {
    const { root, w } = world(`${node} -e "process.exit(0)"`);
    const file = path.join(root, 'settings.json');
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), checkMinutes: minutes }));
    scriptAgent(root, 'fa', [{ write: 'a.txt' }, { write: 'b.txt' }]);
    const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
    const checking = await run(root, s0.id, w.env, (x) => x.tickets[0].phase === 'check' || x.tickets[0].state !== 'running' && x.tickets[0].state !== 'pending');
    assert.equal(checking.tickets[0].check?.minutes, want, String(minutes));
    const rec = JSON.parse(fs.readFileSync(path.join(checking.tickets[0].check.dir, 'check.json'), 'utf8'));
    assert.equal(rec.limitMs, want * 60_000);
  }
});

test('a check that runs past its limit parks the ticket', async () => {
  const { root, w } = world(`${node} -e "setInterval(Date.now, 1000)"`, { minutes: 0.03 });
  scriptAgent(root, 'fa', [{ write: 'a.txt' }, { write: 'b.txt' }]);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  const s = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  assert.match(s.tickets[0].reason, /^The full check ran past its time limit/);
  assert.equal(s.tickets[0].resume, 'check-fix');
});
