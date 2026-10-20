// The repo's task test: Podium runs it on this machine after each writer's step, and its result is the gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createSprint, draftSprint, startSprint, tick, loadSprint, saveSprint, retryTicket, stopTicket, setPaused, answerCommits, sprintSummary, wantsRunner } from '../engine/sprint.js';
import { setBootTime } from '../engine/check.js';
import { listJobDirs, readJob, findJobDir } from '../engine/store.js';
import { setSetting, loadSettings, repoSettings } from '../engine/settings.js';
import { projectKey } from '../engine/paths.js';
import { ticketStatusLine } from '../mod/view.js';
import { waitFor, scriptAgent, sprintWorld } from './helpers.js';

const ONE = '# Plan\n\n### Task 1: Add a.txt\nWrite a.txt.\n';
const T = (over = {}) => ({ key: 'ABC-11', title: 'Login form', type: 'feat', plan: 'docs/one.md', agent: 'fa', reviewer: 'fr', ...over });
const run = (root, id, env, until) => waitFor(async () => { const s = await tick(root, id, { env }); return until(s) ? s : null; }, { timeoutMs: 90_000, intervalMs: 150 });
const settled = (s) => !['pending', 'running', 'waiting'].includes(s.tickets[0].state);
const jobsBy = (root, role) => listJobDirs(root).map(readJob).filter((j) => j.sprint?.role === role).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
const promptOf = (root, job) => fs.readFileSync(path.join(findJobDir(root, job.id), 'prompt.md'), 'utf8');
const node = `"${process.execPath}"`;
// A task test as the repo would set it: a node script on this machine, in the ticket's copy.
const script = (body) => `${node} -e "const f=require('fs');${body}"`;

function world(taskTest) {
  const { root, w } = sprintWorld({ plans: { 'docs/one.md': ONE } });
  setSetting(root, 'repoTaskTest', { [projectKey(w.repo)]: taskTest });
  return { root, w };
}

test('a writer whose own run failed goes to review when the task test passes on this machine; the reviewer is told, and the test\'s leftovers never ship', async () => {
  const { root, w } = world(script("f.writeFileSync('host-ran.txt','x');process.exit(f.existsSync('a.txt')?0:1)"));
  scriptAgent(root, 'fa', [{ write: 'a.txt', tests: 'failed' }]);
  scriptAgent(root, 'fr', [{ say: 'VERDICT: pass' }]);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  const s = await run(root, s0.id, w.env, settled);
  assert.equal(s.tickets[0].state, 'pr-open', s.tickets[0].reason);
  const [review] = jobsBy(root, 'reviewer');
  const prompt = promptOf(root, review);
  assert.match(prompt, /Podium ran the repo's task test on this machine after this change, and it passed\./);
  assert.doesNotMatch(prompt, /Fail the task if its tests did not run or failed/);
  assert.deepEqual([s.tickets[0].hostTest.state, s.tickets[0].hostTest.task], ['passed', 1]);
  const [author] = jobsBy(root, 'author');
  const files = w.git(w.remote, 'ls-tree', '-r', '--name-only', author.branch);
  assert.match(files, /^a\.txt$/m);
  assert.doesNotMatch(files, /host-ran\.txt/, 'what the test wrote is gone before the review');
});

test('a task test that fails on this machine parks the task even when the writer said it passed; Retry runs the writer again with the log, then the test', async () => {
  const { root, w } = world(script("console.log('host: b.txt is missing');process.exit(f.existsSync('a.txt')&&!f.existsSync('b.txt')?1:0)"));
  scriptAgent(root, 'fa', [{ write: 'a.txt' }, { write: 'b.txt', say: 'Added b.txt.' }]);
  scriptAgent(root, 'fr', [{ say: 'VERDICT: pass' }]);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  const parked = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  const t = parked.tickets[0];
  assert.equal(t.reason, "Task 1's task test fails on this machine and passes at the ticket's base: this change broke it");
  assert.match(t.findings, /host: b\.txt is missing/);
  assert.equal(t.resume, 'author');
  assert.equal(jobsBy(root, 'reviewer').length, 0, 'no review of a task whose test failed');
  assert.equal(sprintSummary(root, parked).tickets[0].giveTo, 'writer');
  await retryTicket(root, s0.id, 'ABC-11');
  const s = await run(root, s0.id, w.env, settled);
  assert.equal(s.tickets[0].state, 'pr-open', s.tickets[0].reason);
  const authors = jobsBy(root, 'author');
  assert.equal(authors.length, 2);
  assert.equal(authors[1].followUpOf, authors[0].id, 'the same writer carries on in its copy');
  const again = promptOf(root, authors[1]);
  assert.match(again, /## Podium ran the repo's task test on this machine after the last step, and it failed/);
  assert.match(again, /host: b\.txt is missing/);
  assert.ok(again.trimEnd().endsWith('none-needed: <why>`.'), 'the TESTS line stays last');
});

test('a fix whose task test fails keeps the reviewer\'s findings for its retry, with the log beside them', async () => {
  const { root, w } = world(script("console.log('host: c.txt is missing');process.exit(f.existsSync('b.txt')&&!f.existsSync('c.txt')?1:0)"));
  scriptAgent(root, 'fa', [{ write: 'a.txt' }, { write: 'b.txt' }, { write: 'c.txt' }]);
  scriptAgent(root, 'fr', [{ say: 'Missing b.\nVERDICT: fail' }, { say: 'VERDICT: pass' }]);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  const parked = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  assert.equal(parked.tickets[0].resume, 'fix');
  assert.match(parked.tickets[0].findings, /host: c\.txt is missing/);
  await retryTicket(root, s0.id, 'ABC-11');
  const s = await run(root, s0.id, w.env, settled);
  assert.equal(s.tickets[0].state, 'pr-open', s.tickets[0].reason);
  const authors = jobsBy(root, 'author');
  assert.equal(authors.length, 3);
  // The fix's own part of the prompt (a follow-up's prompt starts with the steps before it).
  const fix = promptOf(root, authors[2]);
  const own = fix.slice(fix.lastIndexOf('ABC-11 task 1: fix what the reviewer found'));
  assert.match(own.slice(own.indexOf('## The reviewer said')), /^## The reviewer said\n`+\n[\s\S]*Missing b\.\n`+\n\n## Podium ran the repo's task test on this machine after the last step, and it failed\n[\s\S]*host: c\.txt is missing/);
  const reviews = jobsBy(root, 'reviewer');
  assert.match(promptOf(root, reviews[1]), /on this machine after this change, and it passed/);
});

test('while the task test runs the ticket says so and can\'t be stopped; a lost run parks, and Retry runs the test again, not the writer', async () => {
  const { root, w } = world(script('setTimeout(()=>process.exit(0),3000)'));
  scriptAgent(root, 'fa', [{ write: 'a.txt' }]);
  scriptAgent(root, 'fr', [{ say: 'VERDICT: pass' }]);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  const testing = await run(root, s0.id, w.env, (x) => x.tickets[0].phase === 'task-test');
  const sum = sprintSummary(root, testing).tickets[0];
  assert.deepEqual([sum.state, sum.canStop], ['running', false]);
  assert.equal(ticketStatusLine(sum), 'Task 1 of 1 · running the task test on this machine');
  await assert.rejects(stopTicket(root, s0.id, 'ABC-11'), (e) => e.code === 'ticket-busy');
  // Its record is gone: the run is lost.
  const stored = loadSprint(root, s0.id);
  stored.tickets[0].taskTest = { ...stored.tickets[0].taskTest, dir: path.join(stored.tickets[0].taskTest.dir, 'missing') };
  saveSprint(root, stored);
  const parked = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  assert.equal(parked.tickets[0].reason, 'The task test stopped unexpectedly on task 1');
  assert.equal(parked.tickets[0].resume, 'task-test');
  assert.equal(sprintSummary(root, parked).tickets[0].giveTo, null, 'no agent to give it to');
  await assert.rejects(retryTicket(root, s0.id, 'ABC-11', { agent: 'fr' }), (e) => e.code === 'no-agent-change');
  await retryTicket(root, s0.id, 'ABC-11');
  const s = await run(root, s0.id, w.env, settled);
  assert.equal(s.tickets[0].state, 'pr-open', s.tickets[0].reason);
  assert.equal(jobsBy(root, 'author').length, 1, 'the writer did not run again');
});

test('a draft proposes the repo\'s task test, Start saves it, and an empty one removes it', async () => {
  const { root, w } = sprintWorld({ plans: { 'docs/one.md': ONE } });
  scriptAgent(root, 'fa', []);
  scriptAgent(root, 'fr', []);
  const d = await draftSprint(root, { name: 'x', tickets: [T()], taskTest: '  npm test  ' }, { cwd: w.repo });
  assert.deepEqual(d.proposed, { taskTest: 'npm test' });
  assert.equal(repoSettings(loadSettings(root), d.project).taskTest, null, 'nothing is saved at draft time');
  const s = await startSprint(root, d.id);
  assert.deepEqual(s.applied, { taskTest: 'npm test' });
  assert.equal(repoSettings(loadSettings(root), d.project).taskTest, 'npm test');
  const d2 = await draftSprint(root, { name: 'y', tickets: [T({ key: 'ABC-12', title: 'Payouts' })], taskTest: '' }, { cwd: w.repo });
  await startSprint(root, d2.id);
  assert.equal(repoSettings(loadSettings(root), d.project).taskTest, null);
  await assert.rejects(draftSprint(root, { name: 'z', tickets: [T({ key: 'ABC-13', title: 'Other' })], taskTest: 42 }, { cwd: w.repo }), (e) => e.code === 'bad-setting' && /^The task test must be a command line/.test(e.message));
});

// A fix's task test that is lost, or that finds commits Podium didn't make, never costs the fix its reviewer's findings.
const FIX_TEST = script("setTimeout(()=>{console.log('host: c.txt is missing');process.exit(f.existsSync('b.txt')&&!f.existsSync('c.txt')?1:0)},1500)");
const fixTesting = (x) => x.tickets[0].phase === 'task-test' && x.tickets[0].taskTest?.writer === 'fix';
async function fixWorld() {
  const { root, w } = world(FIX_TEST);
  scriptAgent(root, 'fa', [{ write: 'a.txt' }, { write: 'b.txt' }, { write: 'c.txt' }]);
  scriptAgent(root, 'fr', [{ say: 'Missing b.\nVERDICT: fail' }, { say: 'VERDICT: pass' }]);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  await run(root, s0.id, w.env, fixTesting);
  return { root, w, s0 };
}
const fixSaid = (root) => {
  const fix = promptOf(root, jobsBy(root, 'author')[2]);
  const own = fix.slice(fix.lastIndexOf('ABC-11 task 1: fix what the reviewer found'));
  return own.slice(own.indexOf('## The reviewer said'));
};

test('a fix whose task test is lost, then fails, still gets the reviewer\'s findings when it runs again', async () => {
  const { root, w, s0 } = await fixWorld();
  const stored = loadSprint(root, s0.id);
  stored.tickets[0].taskTest = { ...stored.tickets[0].taskTest, dir: path.join(stored.tickets[0].taskTest.dir, 'missing') };
  saveSprint(root, stored);
  const lost = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  assert.equal(lost.tickets[0].resume, 'task-test');
  await retryTicket(root, s0.id, 'ABC-11');
  const failed = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  assert.equal(failed.tickets[0].resume, 'fix');
  await retryTicket(root, s0.id, 'ABC-11');
  const s = await run(root, s0.id, w.env, settled);
  assert.equal(s.tickets[0].state, 'pr-open', s.tickets[0].reason);
  assert.match(fixSaid(root), /^## The reviewer said\n`+\n[\s\S]*Missing b\.\n`+\n\n## Podium ran the repo's task test/);
});

test('Keep on commits found by a fix\'s task test runs the test again from them, and the fix keeps the reviewer\'s findings', async () => {
  const { root, w, s0 } = await fixWorld();
  const copy = readJob(findJobDir(root, loadSprint(root, s0.id).tickets[0].latest)).worktree;
  fs.writeFileSync(path.join(copy, 'by-hand.txt'), 'by hand\n');
  w.git(copy, 'add', '--', 'by-hand.txt');
  w.git(copy, 'commit', '-q', '-m', 'Fixed by hand');
  const asked = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  assert.ok(asked.tickets[0].foreign, asked.tickets[0].reason);
  const kept = await answerCommits(root, s0.id, 'ABC-11', { keep: true });
  assert.deepEqual([kept.sprint.tickets[0].resume, kept.sprint.tickets[0].reason], ['task-test', 'Keeping the commit: the task test runs again next']);
  const failed = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  assert.equal(failed.tickets[0].resume, 'fix');
  await retryTicket(root, s0.id, 'ABC-11');
  const s = await run(root, s0.id, w.env, settled);
  assert.equal(s.tickets[0].state, 'pr-open', s.tickets[0].reason);
  assert.match(fixSaid(root), /Missing b\./);
  const { branch } = jobsBy(root, 'author')[0];
  assert.match(w.git(w.remote, 'ls-tree', '-r', '--name-only', branch), /^by-hand\.txt$/m, 'the kept commit ships');
});

test('a fix whose task test is lost and then removed goes to review, and a fix after that review reads that review\'s findings', async () => {
  const { root, w } = world(FIX_TEST);
  scriptAgent(root, 'fa', [{ write: 'a.txt' }, { write: 'b.txt' }, { write: 'c.txt' }]);
  scriptAgent(root, 'fr', [{ say: 'Missing b.\nVERDICT: fail' }, { say: 'Still missing c.\nVERDICT: fail' }, { say: 'VERDICT: pass' }]);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  await run(root, s0.id, w.env, fixTesting);
  const stored = loadSprint(root, s0.id);
  stored.tickets[0].taskTest = { ...stored.tickets[0].taskTest, dir: path.join(stored.tickets[0].taskTest.dir, 'missing') };
  saveSprint(root, stored);
  await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  // The repo's task test is removed before Retry: the fix goes straight to its review, which fails again.
  setSetting(root, 'repoTaskTest', {});
  await retryTicket(root, s0.id, 'ABC-11');
  const parked = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  assert.match(parked.tickets[0].reason, /^Review failed/);
  assert.equal(parked.tickets[0].reviewSaid, null);
  assert.match(parked.tickets[0].findings, /Still missing c\.$/);
  await retryTicket(root, s0.id, 'ABC-11');
  await run(root, s0.id, w.env, settled);
  // The fix reads that review's findings, whole, not the earlier review's (they reach a fix's prompt only as what the
  // reviewer said).
  assert.ok(promptOf(root, jobsBy(root, 'author')[2]).includes(parked.tickets[0].findings.trim()), 'the latest review\'s findings');
});

// As after a long sleep: far past its limit by the clock, its runner (here: this process) still beating.
function overdueRecord(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const at = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
  fs.writeFileSync(path.join(dir, 'check.json'), JSON.stringify({ command: 'x', cwd: dir, limitMs: 1000, beatMs: 15_000, startedAt: at, runnerPid: process.pid, beatAt: new Date().toISOString(), checkPid: null, exitCode: null, timedOut: false, endedAt: null }));
}

test('a task test far past its limit is asked to stop, and the ticket waits for its end before cleaning the copy and parking', async () => {
  setBootTime(0);
  try {
    const { root, w } = world(script('setTimeout(()=>process.exit(0),20000)'));
    scriptAgent(root, 'fa', [{ write: 'a.txt' }]);
    scriptAgent(root, 'fr', [{ say: 'VERDICT: pass' }]);
    const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
    await run(root, s0.id, w.env, (x) => x.tickets[0].phase === 'task-test');
    const stored = loadSprint(root, s0.id);
    const dir = path.join(stored.tickets[0].taskTest.dir, 'overdue');
    overdueRecord(dir);
    stored.tickets[0].taskTest = { ...stored.tickets[0].taskTest, dir };
    saveSprint(root, stored);
    const asking = await tick(root, s0.id, { env: w.env });
    assert.equal(asking.tickets[0].state, 'running', 'it waits for the run to end');
    assert.ok(asking.tickets[0].taskTest.stopAt);
    assert.ok(fs.existsSync(path.join(dir, 'stop.request')), 'its runner is asked to stop');
    // Its runner may still write in the copy: Stop waits like the tick does, and a pause keeps the runner going.
    await assert.rejects(stopTicket(root, s0.id, 'ABC-11'), (e) => e.code === 'ticket-busy');
    assert.equal(sprintSummary(root, asking).tickets[0].canStop, false);
    await setPaused(root, s0.id, true);
    assert.equal(wantsRunner(root, loadSprint(root, s0.id)), true);
    // The runner stops its run and records the end: now the ticket parks, paused or not.
    const rec = JSON.parse(fs.readFileSync(path.join(dir, 'check.json'), 'utf8'));
    fs.writeFileSync(path.join(dir, 'check.json'), JSON.stringify({ ...rec, exitCode: 1, timedOut: true, stopped: true, endedAt: new Date().toISOString() }));
    assert.equal(wantsRunner(root, loadSprint(root, s0.id)), true, 'its end is still to be handled');
    const parked = await tick(root, s0.id, { env: w.env });
    assert.equal(parked.tickets[0].state, 'parked');
    assert.match(parked.tickets[0].reason, /^Task 1's task test ran past its time limit/);
    assert.equal(wantsRunner(root, parked), false, 'paused, with nothing left to see through');
  } finally {
    setBootTime(null);
  }
});

test('a runner that never stops (hung) is waited for a minute, then the ticket parks anyway', async () => {
  setBootTime(0);
  try {
    const { root, w } = world(script('setTimeout(()=>process.exit(0),20000)'));
    scriptAgent(root, 'fa', [{ write: 'a.txt' }]);
    scriptAgent(root, 'fr', []);
    const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
    await run(root, s0.id, w.env, (x) => x.tickets[0].phase === 'task-test');
    const stored = loadSprint(root, s0.id);
    const dir = path.join(stored.tickets[0].taskTest.dir, 'hung');
    overdueRecord(dir);
    stored.tickets[0].taskTest = { ...stored.tickets[0].taskTest, dir };
    saveSprint(root, stored);
    const first = Date.now();
    assert.equal((await tick(root, s0.id, { env: w.env, now: first })).tickets[0].state, 'running');
    assert.equal((await tick(root, s0.id, { env: w.env, now: first + 30_000 })).tickets[0].state, 'running', 'still within the minute');
    // Its runner still beats (so the run is not lost), but never stops it.
    const later = first + 61_000;
    const rec = JSON.parse(fs.readFileSync(path.join(dir, 'check.json'), 'utf8'));
    fs.writeFileSync(path.join(dir, 'check.json'), JSON.stringify({ ...rec, beatAt: new Date(later).toISOString() }));
    const parked = await tick(root, s0.id, { env: w.env, now: later });
    assert.equal(parked.tickets[0].state, 'parked');
    assert.match(parked.tickets[0].reason, /ran past its time limit/);
  } finally {
    setBootTime(null);
  }
});
