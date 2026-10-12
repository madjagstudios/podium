// Writers report their tests, and a ticket parks unless they passed.
// Scripted runs print "TESTS: passed" unless a step says otherwise (tests: 'not-run' | 'failed' | 'none-needed: why' | false).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createSprint, tick, retryTicket } from '../engine/sprint.js';
import { listJobDirs, readJob } from '../engine/store.js';
import { waitFor, scriptAgent, sprintWorld } from './helpers.js';

const T = (over = {}) => ({ key: 'ABC-11', title: 'Login form', type: 'feat', plan: 'docs/plan.md', agent: 'fa', reviewer: 'fr', ...over });
const run = (root, id, env, until) => waitFor(async () => { const s = await tick(root, id, { env }); return until(s) ? s : null; }, { timeoutMs: 90_000, intervalMs: 150 });
const jobsBy = (root, role) => listJobDirs(root).map(readJob).filter((j) => j.sprint?.role === role).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
const promptOf = (root, job) => fs.readFileSync(path.join(listJobDirs(root).find((d) => d.endsWith(job.id)), 'prompt.md'), 'utf8');

async function parkedWith(writer) {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [writer]);
  scriptAgent(root, 'fr', []);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  const s = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  return { root, t: s.tickets[0] };
}

test('a writer that did not run its tests parks the ticket, and no review starts', async () => {
  const { root, t } = await parkedWith({ write: 'a.txt', say: 'Wrote a.txt.', tests: 'not-run' });
  assert.equal(t.reason, "Fa didn't run task 1's tests");
  assert.match(t.findings, /Wrote a\.txt\.$/);
  assert.equal(t.resume, 'author', 'Retry runs the writer again');
  assert.equal(jobsBy(root, 'reviewer').length, 0);
});

test('failed tests park the ticket', async () => {
  const { t } = await parkedWith({ write: 'a.txt', tests: 'failed' });
  assert.equal(t.reason, "Task 1's tests failed");
});

test('a writer that says nothing about its tests parks the ticket', async () => {
  const { t } = await parkedWith({ write: 'a.txt', tests: false });
  assert.equal(t.reason, "Fa didn't say whether task 1's tests ran");
});

test('none-needed with no reason parks the ticket, and no review starts', async () => {
  const { root, t } = await parkedWith({ write: 'a.txt', say: 'Only a doc line.', tests: 'none-needed' });
  assert.equal(t.reason, 'Fa said no tests were needed for task 1 but gave no reason');
  assert.match(t.findings, /TESTS: none-needed\nOnly a doc line\.$/);
  assert.equal(t.resume, 'author', 'Retry runs the writer again');
  assert.equal(jobsBy(root, 'reviewer').length, 0);
});

test('passed tests start the review, and its prompt carries the writer\'s report', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ write: 'a.txt', say: 'Ran the a tests: 3 passed.' }, { write: 'b.txt' }]);
  scriptAgent(root, 'fr', [{ say: 'VERDICT: pass' }, { say: 'VERDICT: pass' }]);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'pr-open');
  const prompt = promptOf(root, jobsBy(root, 'reviewer')[0]);
  assert.match(prompt, /## The writer reported\n```[\s\S]*TESTS: passed\nRan the a tests: 3 passed\.\n```/);
  assert.match(prompt, /Fail the task if its tests did not run or failed\./);
});

test('none-needed starts the review with the reason', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ write: 'a.txt', tests: 'none-needed: docs only' }, { write: 'b.txt' }]);
  scriptAgent(root, 'fr', [{ say: 'VERDICT: pass' }, { say: 'VERDICT: pass' }]);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'pr-open');
  assert.match(promptOf(root, jobsBy(root, 'reviewer')[0]), /The writer said this task needed no tests: docs only\. Fail the task if it needed tests\./);
});

test('a fix whose tests failed parks, and Retry sends the reviewer\'s findings again', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ write: 'a.txt' }, { write: 'a2.txt', tests: 'failed' }, { write: 'a3.txt' }, { write: 'b.txt' }]);
  scriptAgent(root, 'fr', [{ say: 'Missing the a test.\nVERDICT: fail' }, { say: 'VERDICT: pass' }, { say: 'VERDICT: pass' }]);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  const parked = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  assert.equal(parked.tickets[0].reason, "Task 1's tests failed");
  assert.equal(parked.tickets[0].resume, 'fix');
  await retryTicket(root, s0.id, 'ABC-11');
  const s = await run(root, s0.id, w.env, (x) => ['pr-open', 'parked'].includes(x.tickets[0].state));
  assert.equal(s.tickets[0].state, 'pr-open', s.tickets[0].reason);
  const fixes = jobsBy(root, 'author').filter((j) => /fix what the reviewer found/.test(j.title));
  assert.equal(fixes.length, 2);
  assert.match(promptOf(root, fixes[1]), /## The reviewer said\n`{3,}\n[\s\S]*Missing the a test\.\n`{3,}/);
});

test('a fix whose tests fail twice still gets the reviewer\'s findings, never its own old report', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ write: 'a.txt' }, { write: 'a2.txt', tests: 'failed' }, { write: 'a3.txt', tests: 'failed' }, { write: 'a4.txt' }, { write: 'b.txt' }]);
  scriptAgent(root, 'fr', [{ say: 'Missing the a test.\nVERDICT: fail' }, { say: 'VERDICT: pass' }, { say: 'VERDICT: pass' }]);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  const parked = (n) => (x) => x.tickets[0].state === 'parked' && jobsBy(root, 'author').length === n;
  const first = await run(root, s0.id, w.env, parked(2));
  assert.match(first.tickets[0].findings, /TESTS: failed/, 'the person sees the fix\'s report');
  await retryTicket(root, s0.id, 'ABC-11');
  const second = await run(root, s0.id, w.env, parked(3));
  assert.equal(second.tickets[0].reason, "Task 1's tests failed");
  await retryTicket(root, s0.id, 'ABC-11');
  const s = await run(root, s0.id, w.env, (x) => ['pr-open', 'parked'].includes(x.tickets[0].state));
  assert.equal(s.tickets[0].state, 'pr-open', s.tickets[0].reason);
  const fixes = jobsBy(root, 'author').filter((j) => /fix what the reviewer found/.test(j.title));
  assert.equal(fixes.length, 3);
  // The fix prompt ends with the tests line; the reviewer's findings (which echo its own prompt) sit above it.
  const prompt = promptOf(root, fixes[2]);
  const reviewerSaid = prompt.slice(prompt.indexOf('## The reviewer said'), prompt.lastIndexOf('Finish with one line'));
  assert.match(reviewerSaid, /Missing the a test\./);
  assert.doesNotMatch(reviewerSaid, /^TESTS: failed$/m, 'the second fix\'s report is not passed off as the reviewer\'s');
});
