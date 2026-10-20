// A writer's missing TESTS line is asked for once; a ticket stopped on its tests can be accepted and go on to review.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { createSprint, tick, loadSprint, saveSprint, sprintSummary, acceptTests, retryTicket } from '../engine/sprint.js';
import { listJobDirs, readJob, findJobDir } from '../engine/store.js';
import { main } from '../engine/cli.js';
import { setSetting } from '../engine/settings.js';
import { projectKey } from '../engine/paths.js';
import { notesSection } from '../engine/sprint-text.js';
import { waitFor, scriptAgent, sprintWorld, RESUMES } from './helpers.js';

const ONE = '# Plan\n\n### Task 1: Add a.txt\nWrite a.txt.\n';
const T = (over = {}) => ({ key: 'ABC-11', title: 'Login form', type: 'feat', plan: 'docs/one.md', agent: 'fa', reviewer: 'fr', ...over });
const run = (root, id, env, until) => waitFor(async () => { const s = await tick(root, id, { env }); return until(s) ? s : null; }, { timeoutMs: 90_000, intervalMs: 150 });
const settled = (s) => !['pending', 'running', 'waiting'].includes(s.tickets[0].state);
const jobsBy = (root, role) => listJobDirs(root).map(readJob).filter((j) => j.sprint?.role === role).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
const promptOf = (root, job) => fs.readFileSync(path.join(findJobDir(root, job.id), 'prompt.md'), 'utf8');
const node = `"${process.execPath}"`;
const REASON = 'The date tests fail on main too.';

async function world(writer, reviewer = [{ say: 'VERDICT: pass' }], { resumes = true } = {}) {
  const { root, w } = sprintWorld({ plans: { 'docs/one.md': ONE } });
  scriptAgent(root, 'fa', writer, resumes ? RESUMES : {});
  scriptAgent(root, 'fr', reviewer);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  return { root, w, s0 };
}

async function cli(root, argv, stdin = '') {
  let out = '';
  const stdout = new Writable({ write(c, _e, cb) { out += c; cb(); } });
  const code = await main(argv, { stdout, stdin: Readable.from([stdin]), env: { ...process.env, PODIUM_DATA_DIR: root }, spawn: () => {} });
  return { code, body: JSON.parse(out) };
}

test('a writer whose step ends without its TESTS line is asked for it once, in the same conversation, and its answer gates the step', async () => {
  const { root, w, s0 } = await world([{ write: 'a.txt', say: 'Wrote a.txt.', tests: false }, { say: 'Ran npm test.', tests: 'passed' }]);
  const s = await run(root, s0.id, w.env, settled);
  assert.equal(s.tickets[0].state, 'pr-open', s.tickets[0].reason);
  const [writer, ask] = jobsBy(root, 'author');
  assert.equal(ask.followUpOf, writer.id);
  assert.equal(ask.resumeFrom, writer.agentSession.id, 'it resumes the writer\'s conversation');
  assert.match(promptOf(root, ask), /^ABC-11 task 1: your TESTS line\n\nYour last step on task 1 \(Add a\.txt\) ended without its TESTS line/);
  const review = promptOf(root, jobsBy(root, 'reviewer')[0]);
  assert.match(review, /Wrote a\.txt\.[\s\S]*Ran npm test\./, 'the reviewer reads the step and its answer');
});

test('asked once and still no line, or an agent that can\'t resume: the ticket parks as before, saying so', async () => {
  const twice = await world([{ write: 'a.txt', tests: false }, { say: 'Done.', tests: false }]);
  const parked = await run(twice.root, twice.s0.id, twice.w.env, (x) => x.tickets[0].state === 'parked');
  assert.equal(parked.tickets[0].reason, "Fa didn't say whether task 1's tests ran");
  assert.equal(jobsBy(twice.root, 'author').length, 2, 'asked once only');
  assert.equal(parked.tickets[0].resume, 'author');
  const fresh = await world([{ write: 'a.txt', tests: false }], [], { resumes: false });
  const stuck = await run(fresh.root, fresh.s0.id, fresh.w.env, (x) => x.tickets[0].state === 'parked');
  assert.equal(stuck.tickets[0].reason, "Fa didn't say whether task 1's tests ran");
  assert.equal(jobsBy(fresh.root, 'author').length, 1, 'not asked: its conversation does not resume');
});

test('a ticket stopped on its writer\'s tests can be accepted: the task goes to its review, whose reviewer reads the reason, and nothing else does', async () => {
  const { root, w, s0 } = await world([{ write: 'a.txt', tests: 'failed' }]);
  const parked = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  assert.equal(parked.tickets[0].reason, "Task 1's tests failed in Fa's sandbox");
  const sum = sprintSummary(root, parked).tickets[0];
  assert.deepEqual([sum.canAccept, sum.testsWhere], [true, 'sandbox']);
  await assert.rejects(acceptTests(root, s0.id, 'ABC-11', '  '), (e) => e.code === 'nothing-to-note');
  const accepted = await acceptTests(root, s0.id, 'abc-11', REASON);
  const t = accepted.tickets[0];
  assert.deepEqual([t.state, t.resume, t.reason], ['waiting', 'review', 'Accepted: Fr reviews task 1 next']);
  assert.deepEqual(t.notes.map((x) => [x.kind, x.task, x.text]), [['accept', 1, REASON]]);
  assert.deepEqual(notesSection(t), [], 'writers and other tasks never read it');
  const s = await run(root, s0.id, w.env, settled);
  assert.equal(s.tickets[0].state, 'pr-open', s.tickets[0].reason);
  const review = promptOf(root, jobsBy(root, 'reviewer')[0]);
  assert.match(review, /The person looked at this task's test results and accepted them, for the reasons quoted next: don't fail the task for those test results, and judge everything else\./);
  assert.ok(review.includes(`\n${REASON}\n`));
  assert.doesNotMatch(review, /Fail the task if its tests did not run or failed/);
  assert.equal(jobsBy(root, 'author').length, 1, 'the writer did not run again');
});

test('a ticket stopped on the task test on this machine can be accepted too, and only a tests stop can', async () => {
  const { root, w } = sprintWorld({ plans: { 'docs/one.md': ONE } });
  // Fails once the task's a.txt is there, so it passes at the base: this change broke it.
  setSetting(root, 'repoTaskTest', { [projectKey(w.repo)]: `${node} -e "console.log('2 failing');process.exit(require('fs').existsSync('a.txt')?1:0)"` });
  // The fix writes a file of its own (a step that changes nothing parks before its task test); a.txt stays, so it fails too.
  scriptAgent(root, 'fa', [{ write: 'a.txt' }, { write: 'a2.txt' }]);
  scriptAgent(root, 'fr', [{ say: 'Broken.\nVERDICT: fail' }, { say: 'Still broken.\nVERDICT: fail' }]);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  const parked = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  assert.equal(parked.tickets[0].reason, "Task 1's task test fails on this machine and passes at the ticket's base: this change broke it");
  assert.equal(sprintSummary(root, parked).tickets[0].testsWhere, 'host');
  const { code, body } = await cli(root, ['sprint', 'accept', '--id', s0.id, '--ticket', 'ABC-11', '--text', '-'], `${REASON}\n`);
  assert.equal(code, 0, JSON.stringify(body));
  assert.equal(body.sprint.tickets[0].state, 'waiting');
  // Its review fails, then the fix's task test fails too: accepted again, the fix's review follows.
  const fixed = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  assert.deepEqual([fixed.tickets[0].reason, fixed.tickets[0].resume], ["Task 1's task test fails on this machine and passes at the ticket's base: this change broke it", 'fix']);
  assert.equal((await acceptTests(root, s0.id, 'ABC-11', 'Still only the date tests.')).tickets[0].resume, 'fix-review');
  const again = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  assert.match(again.tickets[0].reason, /^Review failed/);
  const second = promptOf(root, jobsBy(root, 'reviewer')[1]);
  assert.ok(second.includes(REASON) && second.includes('Still only the date tests.'), 'every acceptance of this task');
  assert.equal(sprintSummary(root, again).tickets[0].canAccept, false, 'a failed review is no tests stop');
  await assert.rejects(acceptTests(root, s0.id, 'ABC-11', REASON), (e) => e.code === 'not-tests-park');
  // Stopped on something else entirely: refused too.
  const other = loadSprint(root, s0.id);
  Object.assign(other.tickets[0], { state: 'waiting' });
  saveSprint(root, other);
  await assert.rejects(acceptTests(root, s0.id, 'ABC-11', REASON), (e) => e.code === 'not-tests-park');
});

test('Accept on a fix stopped on its tests goes to the fix\'s review, and keeps the review count', async () => {
  const { root, w, s0 } = await world([{ write: 'a.txt' }, { write: 'b.txt', tests: 'failed' }], [{ say: 'Missing b.\nVERDICT: fail' }, { say: 'VERDICT: pass' }]);
  const parked = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  assert.equal(parked.tickets[0].resume, 'fix');
  const t = (await acceptTests(root, s0.id, 'ABC-11', REASON)).tickets[0];
  assert.deepEqual([t.resume, t.fails], ['fix-review', 1]);
  const s = await run(root, s0.id, w.env, settled);
  assert.equal(s.tickets[0].state, 'pr-open', s.tickets[0].reason);
  assert.ok(promptOf(root, jobsBy(root, 'reviewer')[1]).includes(REASON));
  // A later task's review never reads this task's acceptance.
  assert.equal(await retryTicket(root, s0.id, 'ABC-11').catch((e) => e.code), 'not-stuck');
});

test('an acceptance reaches only its own task\'s reviews, even in a plan that numbers two tasks alike', async () => {
  const { root, w } = sprintWorld({ plans: { 'docs/dup.md': '# Plan\n\n### Task 1: Add a.txt\nWrite a.txt.\n\n### Task 1: Add b.txt\nWrite b.txt.\n' } });
  scriptAgent(root, 'fa', [{ write: 'a.txt', tests: 'failed' }, { write: 'b.txt' }]);
  scriptAgent(root, 'fr', [{ say: 'VERDICT: pass' }, { say: 'VERDICT: pass' }]);
  const s0 = await createSprint(root, { name: 'x', tickets: [T({ plan: 'docs/dup.md' })] }, { cwd: w.repo });
  await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  await acceptTests(root, s0.id, 'ABC-11', REASON);
  const s = await run(root, s0.id, w.env, settled);
  assert.equal(s.tickets[0].state, 'pr-open', s.tickets[0].reason);
  const [first, second] = jobsBy(root, 'reviewer');
  assert.ok(promptOf(root, first).includes(REASON));
  assert.ok(!promptOf(root, second).includes(REASON), 'the other task numbered 1 never reads it');
  assert.match(promptOf(root, second), /Fail the task if its tests did not run or failed/);
});
