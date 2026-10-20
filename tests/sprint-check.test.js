// The repo's full check runs in the ticket's copy before its PR.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createSprint, tick, locked, retryTicket, stopTicket, setPaused, saveSprint, loadSprint, answerCommits, sprintSummary } from '../engine/sprint.js';
import { isAlive } from '../engine/status.js';
import { setBootTime } from '../engine/check.js';
import { listJobDirs, readJob, findJobDir } from '../engine/store.js';
import { setSetting } from '../engine/settings.js';
import { projectKey } from '../engine/paths.js';
import { waitFor, scriptAgent, sprintWorld, stuckCheck } from './helpers.js';

const T = (over = {}) => ({ key: 'ABC-11', title: 'Login form', type: 'feat', plan: 'docs/plan.md', agent: 'fa', reviewer: 'fr', ...over });
const run = (root, id, env, until) => waitFor(async () => { const s = await tick(root, id, { env }); return until(s) ? s : null; }, { timeoutMs: 90_000, intervalMs: 150 });
const jobsBy = (root, role) => listJobDirs(root).map(readJob).filter((j) => j.sprint?.role === role).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
const promptOf = (root, job) => fs.readFileSync(path.join(listJobDirs(root).find((d) => d.endsWith(job.id)), 'prompt.md'), 'utf8');
const node = `"${process.execPath}"`;

// Every check folder of every sprint in root.
function checksIn(root) {
  const list = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };
  const sprints = path.join(root, 'sprints');
  return list(sprints).flatMap((id) => list(path.join(sprints, id, 'checks')).map((c) => path.join(sprints, id, 'checks', c)));
}

// A sprint world whose full check never ends on its own; the test's end waits for every check of it to exit.
function stuckWorld(t, options) {
  let root = null;
  const made = world(stuckCheck(t, { checks: () => (root ? checksIn(root) : []) }), options);
  root = made.root;
  return made;
}

function world(check, { minutes } = {}) {
  const { root, w } = sprintWorld();
  setSetting(root, 'repoCheck', { [projectKey(w.repo)]: check });
  if (minutes) setSetting(root, 'checkMinutes', minutes);
  scriptAgent(root, 'fr', [{ say: 'VERDICT: pass' }, { say: 'VERDICT: pass' }]);
  return { root, w };
}

test('a failing full check parks the ticket before the PR, and gh is never called', async () => {
  const { root, w } = world(`${node} -e "console.log('3 tests failed'); process.exit(require('fs').existsSync('a.txt') ? 1 : 0)"`);
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

test('a check far past its limit is stopped through its runner even while the sprint is paused', async (t) => {
  // Backdated 3 hours below: a CI machine may have started since, which would read as a check from before the boot.
  setBootTime(0);
  try {
    const { root, w } = stuckWorld(t);
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

// Commits in a ticket's copy that Podium didn't make: a person's, made after the full check failed.
const FIXED = `${node} -e "console.log('lint: fixed.txt is missing'); process.exit(require('fs').existsSync('fixed.txt') ? 0 : 1)"`;
const copyOf = (root, t) => readJob(findJobDir(root, t.latest)).worktree;
function commitByHand(w, copy, file = 'fixed.txt') {
  fs.writeFileSync(path.join(copy, file), 'by hand\n');
  w.git(copy, 'add', '--', file);
  w.git(copy, 'commit', '-q', '-m', 'Fixed by hand');
  return w.git(copy, 'rev-parse', 'HEAD');
}

test('a commit made in the copy after a failed check is never dropped: Retry asks whether to keep it, and kept it ships', async () => {
  const { root, w } = world(FIXED);
  scriptAgent(root, 'fa', [{ write: 'a.txt' }, { write: 'b.txt' }]);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  const parked = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  const copy = copyOf(root, parked.tickets[0]);
  const mine = commitByHand(w, copy);
  await retryTicket(root, s0.id, 'ABC-11');
  const asked = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  const t = asked.tickets[0];
  assert.match(t.reason, /^A commit in this ticket's copy was not made by Podium \(newest: \w+ Fixed by hand\)\. Keep it/);
  assert.equal(w.git(copy, 'rev-parse', 'HEAD'), mine, 'the commit is still there');
  const card = sprintSummary(root, asked).tickets[0];
  assert.deepEqual([card.canRetry, card.foreignCommits?.count], [false, 1]);
  await assert.rejects(retryTicket(root, s0.id, 'ABC-11'), (e) => e.code === 'commits-question');
  await answerCommits(root, s0.id, 'ABC-11', { keep: true });
  const s = await run(root, s0.id, w.env, (x) => ['pr-open', 'parked'].includes(x.tickets[0].state));
  assert.equal(s.tickets[0].state, 'pr-open', s.tickets[0].reason);
  assert.equal(jobsBy(root, 'author').length, 2, 'the full check ran again; no writer was asked to fix it');
  const { branch } = jobsBy(root, 'author')[0];
  assert.match(w.git(w.remote, 'log', '-p', `main..${branch}`), /fixed\.txt/);
});

test('dropping commits Podium didn\'t make puts the copy back, and the step it was on runs with the check\'s log', async () => {
  const { root, w } = world(FIXED);
  scriptAgent(root, 'fa', [{ write: 'a.txt' }, { write: 'b.txt' }, { write: 'fixed.txt', say: 'Added fixed.txt.' }]);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  const parked = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  const copy = copyOf(root, parked.tickets[0]);
  commitByHand(w, copy, 'other.txt');
  await retryTicket(root, s0.id, 'ABC-11');
  await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked' && Boolean(x.tickets[0].foreign));
  const { sprint, dropped } = await answerCommits(root, s0.id, 'ABC-11', { keep: false });
  assert.equal(dropped.length, 1);
  assert.match(dropped[0], /Fixed by hand/);
  assert.equal(w.git(copy, 'rev-parse', 'HEAD'), parked.tickets[0].check.head);
  assert.deepEqual([sprint.tickets[0].state, sprint.tickets[0].resume], ['waiting', 'check-fix']);
  const s = await run(root, s0.id, w.env, (x) => ['pr-open', 'parked'].includes(x.tickets[0].state));
  assert.equal(s.tickets[0].state, 'pr-open', s.tickets[0].reason);
  const fix = jobsBy(root, 'author').at(-1);
  assert.match(promptOf(root, fix), /lint: fixed\.txt is missing/);
  assert.doesNotMatch(promptOf(root, fix), /Fixed by hand/);
});

test('kept commits after the repo\'s check was removed open the PR without the check\'s leftovers', async () => {
  const { root, w } = world(MESSY(1));
  scriptAgent(root, 'fa', [{ write: 'a.txt' }, { write: 'b.txt' }]);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  const parked = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  commitByHand(w, copyOf(root, parked.tickets[0]));
  await retryTicket(root, s0.id, 'ABC-11');
  await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked' && Boolean(x.tickets[0].foreign));
  setSetting(root, 'repoCheck', {});
  await answerCommits(root, s0.id, 'ABC-11', { keep: true });
  const s = await run(root, s0.id, w.env, (x) => ['pr-open', 'parked'].includes(x.tickets[0].state));
  assert.equal(s.tickets[0].state, 'pr-open', s.tickets[0].reason);
  const { branch } = jobsBy(root, 'author')[0];
  const shipped = w.git(w.remote, 'log', '-p', `main..${branch}`);
  assert.match(shipped, /fixed\.txt/);
  assert.doesNotMatch(shipped, /TestResults|REWRITTEN BY THE CHECK/);
});

test('Keep saves changes left uncommitted in the copy as a git stash instead of deleting them', async () => {
  const { root, w } = world(FIXED);
  scriptAgent(root, 'fa', [{ write: 'a.txt' }, { write: 'b.txt' }]);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  const parked = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  const copy = copyOf(root, parked.tickets[0]);
  commitByHand(w, copy);
  await retryTicket(root, s0.id, 'ABC-11');
  await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked' && Boolean(x.tickets[0].foreign));
  // Someone goes on editing by hand while the question waits: only a new file, in a repo whose status hides those.
  w.git(copy, 'config', 'status.showUntrackedFiles', 'no');
  fs.writeFileSync(path.join(copy, 'notes.txt'), 'my notes\n');
  const { saved } = await answerCommits(root, s0.id, 'ABC-11', { keep: true });
  assert.equal(saved, "Podium: ABC-11's uncommitted changes before keeping its commits");
  assert.match(w.git(w.repo, 'stash', 'list'), /Podium: ABC-11's uncommitted changes before keeping its commits/);
  assert.match(w.git(w.repo, 'show', '--name-only', '--format=', 'stash@{0}^3'), /notes\.txt/);
  const s = await run(root, s0.id, w.env, (x) => ['pr-open', 'parked'].includes(x.tickets[0].state));
  assert.equal(s.tickets[0].state, 'pr-open', s.tickets[0].reason);
  const { branch } = jobsBy(root, 'author')[0];
  assert.doesNotMatch(w.git(w.remote, 'log', '-p', `main..${branch}`), /my notes/);
});

test('Stop while the question about commits waits keeps the commits and saves uncommitted edits as a git stash', async () => {
  const { root, w } = world(FIXED);
  scriptAgent(root, 'fa', [{ write: 'a.txt' }, { write: 'b.txt' }]);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  const parked = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  const copy = copyOf(root, parked.tickets[0]);
  commitByHand(w, copy);
  await retryTicket(root, s0.id, 'ABC-11');
  await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked' && Boolean(x.tickets[0].foreign));
  fs.writeFileSync(path.join(copy, 'b.txt'), 'edited by hand\n');
  const s = await stopTicket(root, s0.id, 'ABC-11');
  const stopped = s.messages.find((m) => /was stopped\./.test(m.text))?.text;
  assert.match(stopped, /was stopped\. Its branch .* is kept\. Changes left uncommitted in its copy were saved as a git stash \("Podium: ABC-11's uncommitted changes before stopping"\)\./);
  assert.match(w.git(w.repo, 'stash', 'show', '-p', 'stash@{0}'), /edited by hand/);
  const { branch } = jobsBy(root, 'author')[0];
  assert.match(w.git(w.repo, 'log', '--format=%s', `main..${branch}`), /Fixed by hand/);
});

test('a commit made after the check passed but the PR couldn\'t open is asked about, and kept it is checked before it ships', async () => {
  const { root, w } = world(FIXED);
  scriptAgent(root, 'fa', [{ write: 'a.txt' }, { write: 'b.txt' }, { write: 'fixed.txt' }]);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  // The check fails, the writer fixes it, the check passes, and GitHub refuses the PR.
  await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  const spec = w.env.PODIUM_FAKE_GH;
  const answers = JSON.parse(fs.readFileSync(spec, 'utf8'));
  fs.writeFileSync(spec, JSON.stringify({ ...answers, responses: [{ match: ['pr', 'create'], stderr: 'GitHub is down', code: 1 }] }));
  await retryTicket(root, s0.id, 'ABC-11');
  const refused = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked' && x.tickets[0].resume === 'pr');
  fs.writeFileSync(spec, JSON.stringify(answers));
  commitByHand(w, copyOf(root, refused.tickets[0]), 'extra.txt');
  await retryTicket(root, s0.id, 'ABC-11');
  const asked = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked' && Boolean(x.tickets[0].foreign));
  assert.match(asked.tickets[0].reason, /^A commit in this ticket's copy was not made by Podium/);
  assert.deepEqual(w.calls().filter((c) => c[0] === 'pr' && c[1] === 'create').length, 1, 'no second PR attempt with the unchecked commit');
  const checksBefore = checksOf(root, s0.id).length;
  await answerCommits(root, s0.id, 'ABC-11', { keep: true });
  const s = await run(root, s0.id, w.env, (x) => ['pr-open', 'parked'].includes(x.tickets[0].state));
  assert.equal(s.tickets[0].state, 'pr-open', s.tickets[0].reason);
  assert.equal(checksOf(root, s0.id).length, checksBefore + 1, 'the full check ran again on the kept commit');
  const { branch } = jobsBy(root, 'author')[0];
  assert.match(w.git(w.remote, 'log', '-p', `main..${branch}`), /extra\.txt/);
});

test('stopping a ticket keeps commits made in its copy after the full check on its branch', async () => {
  const { root, w } = world(MESSY(1));
  scriptAgent(root, 'fa', [{ write: 'a.txt' }, { write: 'b.txt' }]);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  const parked = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  commitByHand(w, copyOf(root, parked.tickets[0]));
  await stopTicket(root, s0.id, 'ABC-11');
  const { branch } = jobsBy(root, 'author')[0];
  const kept = w.git(w.repo, 'log', '-p', `main..${branch}`);
  assert.match(kept, /Fixed by hand/);
  assert.doesNotMatch(kept, /TestResults|REWRITTEN BY THE CHECK/);
});

test('a check that runs past its limit parks the ticket', async (t) => {
  const { root, w } = stuckWorld(t, { minutes: 0.03 });
  scriptAgent(root, 'fa', [{ write: 'a.txt' }, { write: 'b.txt' }]);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  const s = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  assert.match(s.tickets[0].reason, /^The full check ran past its time limit/);
  assert.equal(s.tickets[0].resume, 'check-fix');
});

// One failure of the base is not N tickets' failures.
const BASE_FAIL = "The full check fails on main too, before this ticket's change: fix it on main, then Sync with base (Retry asks the writer to fix it here anyway)";

test('tickets whose full check fails the same way on the base park with one shared reason, from one run there, and no fix starts', async () => {
  const { root, w } = world(`${node} -e "console.log('15 files fail: the path has a space'); process.exit(1)"`);
  // One writer for both tickets: each step writes a file of its own, whichever ticket it falls to.
  scriptAgent(root, 'fa', [{ write: 'a.txt' }, { write: 'b.txt' }, { write: 'c.txt' }, { write: 'd.txt' }]);
  scriptAgent(root, 'fr', [{ say: 'VERDICT: pass' }, { say: 'VERDICT: pass' }, { say: 'VERDICT: pass' }, { say: 'VERDICT: pass' }]);
  const s0 = await createSprint(root, { name: 'x', tickets: [T(), T({ key: 'ABC-12', title: 'Payouts' })] }, { cwd: w.repo });
  const s = await run(root, s0.id, w.env, (x) => x.tickets.every((t) => t.state === 'parked'));
  for (const t of s.tickets) {
    assert.equal(t.reason, BASE_FAIL);
    assert.match(t.findings, /15 files fail/, 'its own check\'s log');
    assert.deepEqual([t.resume, t.phase], ['check-fix', 'check']);
  }
  assert.equal(Object.keys(s.baselines).length, 1, 'one run at the base for both');
  assert.equal(jobsBy(root, 'author').filter((j) => /full check/.test(j.title)).length, 0, 'no fix dispatched');
  assert.equal(sprintSummary(root, s).tickets[0].canSync, true, 'Sync with base is the way on');
  // Retry still asks the writer to fix it here.
  await retryTicket(root, s0.id, 'ABC-11');
  await run(root, s0.id, w.env, (x) => jobsBy(root, 'author').some((j) => /fix what the full check found/.test(j.title)));
});

test('a full check that fails only with the ticket\'s change parks it as its writer\'s to fix', async () => {
  const { root, w } = world(`${node} -e "console.log('a.txt breaks the build'); process.exit(require('fs').existsSync('a.txt') ? 1 : 0)"`);
  scriptAgent(root, 'fa', [{ write: 'a.txt' }, { write: 'b.txt' }]);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  const waiting = await run(root, s0.id, w.env, (x) => x.tickets[0].phase === 'baseline' || x.tickets[0].state === 'parked');
  if (waiting.tickets[0].phase === 'baseline') assert.equal(sprintSummary(root, waiting).tickets[0].baselineOf, 'check');
  const s = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  assert.equal(s.tickets[0].reason, 'The full check failed before the PR');
  assert.match(s.tickets[0].findings, /a\.txt breaks the build/);
  assert.equal(s.tickets[0].phase, 'check');
});

test('a failed check is compared on the base with the command it ran, not one set since', async () => {
  const { root, w } = world(`${node} -e "console.log('a.txt breaks the build'); process.exit(require('fs').existsSync('a.txt') ? 1 : 0)"`);
  scriptAgent(root, 'fa', [{ write: 'a.txt' }, { write: 'b.txt' }]);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  await run(root, s0.id, w.env, (x) => x.tickets[0].phase === 'check' && x.tickets[0].state === 'running');
  // A check saved before its command was kept beside it, and a check line changed since to one that fails everywhere.
  await locked(root, s0.id, async ({ token }) => {
    const s = loadSprint(root, s0.id);
    delete s.tickets[0].check.command;
    saveSprint(root, s, { token });
  });
  setSetting(root, 'repoCheck', { [projectKey(w.repo)]: `${node} -e "process.exit(1)"` });
  const s = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  assert.equal(s.tickets[0].reason, 'The full check failed before the PR');
  assert.match(Object.values(s.baselines)[0].command, /a\.txt/, 'the base ran the command the check ran');
});

test('a run at the base whose save fails leaves the ticket on its check, so Retry still asks about commits made since', async () => {
  const { root, w } = world(FIXED);
  scriptAgent(root, 'fa', [{ write: 'a.txt' }, { write: 'b.txt' }]);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  let failed = false;
  const saveFn = (r, s, lock) => {
    if (!failed && s.tickets[0].phase === 'baseline') { failed = true; throw new Error('disk full'); }
    return saveSprint(r, s, lock);
  };
  const parked = await waitFor(async () => {
    const s = await tick(root, s0.id, { env: w.env, saveFn });
    return s.tickets[0].state === 'parked' ? s : null;
  }, { timeoutMs: 90_000, intervalMs: 150 });
  assert.equal(failed, true);
  const t = parked.tickets[0];
  assert.deepEqual([t.phase, t.resume], ['check', 'check']);
  assert.match(t.reason, /disk full/);
  commitByHand(w, copyOf(root, t));
  await retryTicket(root, s0.id, 'ABC-11');
  const asked = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  assert.equal(asked.tickets[0].foreign?.count, 1, asked.tickets[0].reason);
});

test('a run at the base whose record can\'t be read leaves the ticket on its check, so Retry still asks about commits made since', async () => {
  const { root, w } = world(FIXED);
  scriptAgent(root, 'fa', [{ write: 'a.txt' }, { write: 'b.txt' }]);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  const at = await run(root, s0.id, w.env, (x) => x.tickets[0].phase === 'baseline');
  // The run at the base ends, then its record is spoiled before the ticket reads it.
  const record = path.join(Object.values(at.baselines)[0].dir, 'check.json');
  await waitFor(() => { try { return JSON.parse(fs.readFileSync(record, 'utf8')).endedAt; } catch { return null; } }, { timeoutMs: 60_000, intervalMs: 100 });
  fs.writeFileSync(record, '{ not json');
  const parked = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  const t = parked.tickets[0];
  // Nothing is known of the base: a plain failure, for the writer's fix.
  assert.deepEqual([t.phase, t.resume, t.reason], ['check', 'check-fix', 'The full check failed before the PR']);
  commitByHand(w, copyOf(root, t));
  await retryTicket(root, s0.id, 'ABC-11');
  const asked = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  assert.equal(asked.tickets[0].foreign?.count, 1, asked.tickets[0].reason);
});
