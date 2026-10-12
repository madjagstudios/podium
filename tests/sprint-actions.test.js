import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { createSprint, tick, locked, loadSprint, saveSprint, setPaused, retryTicket, assignTask, claimMessages, markMessages, sprintSummary, CLAIM_MS } from '../engine/sprint.js';
import { listJobDirs, readJob } from '../engine/store.js';
import { main } from '../engine/cli.js';
import { setSetting } from '../engine/settings.js';
import { waitFor, scriptAgent, sprintWorld, tempRoot } from './helpers.js';
import { ticketSteps, sprintStepLine } from '../mod/view.js';

const T = (over = {}) => ({ key: 'ABC-11', title: 'Login form', type: 'feat', plan: 'docs/plan.md', agent: 'fa', reviewer: 'fr', ...over });
const run = (root, id, env, until) => waitFor(async () => { const s = await tick(root, id, { env }); return until(s) ? s : null; }, { timeoutMs: 90_000, intervalMs: 150 });

test('Pause lets the running step finish and starts nothing; Resume carries on', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ write: 'a.txt', ms: 500 }]);
  scriptAgent(root, 'fr', [{ say: 'VERDICT: pass' }]);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  const s1 = await tick(root, s0.id, { env: w.env });
  const author = s1.tickets[0].job;
  await setPaused(root, s0.id, true);
  await waitFor(() => readJob(listJobDirs(root).find((d) => d.endsWith(author))).status === 'needs-review');
  const s2 = await tick(root, s0.id, { env: w.env });
  assert.equal(s2.tickets[0].phase, 'author', 'no review started while paused');
  assert.equal(s2.tickets[0].job, author);
  await setPaused(root, s0.id, false);
  const s3 = await tick(root, s0.id, { env: w.env });
  assert.equal(s3.tickets[0].phase, 'review');
});

test('Retry with another agent gives a parked step to that agent', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ err: 'boom', exit: 3 }]);
  scriptAgent(root, 'fb', [{ write: 'a.txt' }]);
  scriptAgent(root, 'fr', [{ say: 'VERDICT: pass' }]);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  await run(root, s0.id, w.env, (s) => s.tickets[0].state === 'parked');
  const r = await retryTicket(root, s0.id, 'abc-11', { agent: 'fb' });
  assert.equal(r.tickets[0].tasks[0].agent, 'fb');
  assert.equal(r.tickets[0].state, 'waiting');
  const s = await run(root, s0.id, w.env, (x) => x.tickets[0].phase === 'review');
  assert.equal(s.tickets[0].task, 0);
  await assert.rejects(retryTicket(root, s0.id, 'ABC-11'), (e) => e.code === 'not-stuck');
  await assert.rejects(retryTicket(root, s0.id, 'ABC-99'), (e) => e.code === 'no-such-ticket');
});

test('Retry after "Review failed twice" runs a fix with the findings, and one more fail parks again', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ write: 'a.txt' }, { write: 'a2.txt' }, { write: 'a3.txt' }]);
  scriptAgent(root, 'fr', [{ say: 'Broken.\nVERDICT: fail' }, { say: 'Still broken.\nVERDICT: fail' }, { say: 'Not yet.\nVERDICT: fail' }]);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  await run(root, s0.id, w.env, (s) => s.tickets[0].state === 'parked');
  const r = await retryTicket(root, s0.id, 'ABC-11');
  assert.equal(r.tickets[0].resume, 'fix');
  assert.equal(r.tickets[0].fails, 1);
  const s = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  assert.equal(s.tickets[0].reason, 'Review failed again on task 1 after a retry', 'one fix and one review after a Retry is not two new failures');
  assert.match(s.tickets[0].findings, /Not yet\.$/);
  const authors = listJobDirs(root).map(readJob).filter((j) => j.sprint?.role === 'author').sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  assert.equal(authors.length, 3);
  const prompt = fs.readFileSync(path.join(listJobDirs(root).find((d) => d.endsWith(authors[2].id)), 'prompt.md'), 'utf8');
  assert.match(prompt, /Still broken\./);
});

test('a retried ticket waits for a free slot: it never runs beyond sprintParallel', async () => {
  const { root, w } = sprintWorld();
  setSetting(root, 'sprintParallel', 1);
  scriptAgent(root, 'fa', [{ err: 'boom', exit: 3 }, { write: 'a.txt' }]);
  scriptAgent(root, 'fb', [{ err: 'boom', exit: 3, ms: 3000 }]);
  scriptAgent(root, 'fr', []);
  const s0 = await createSprint(root, { name: 'x', tickets: [T(), T({ key: 'ABC-12', title: 'Payouts', agent: 'fb' })] }, { cwd: w.repo });
  await run(root, s0.id, w.env, (s) => s.tickets[0].state === 'parked' && s.tickets[1].state === 'running');
  await retryTicket(root, s0.id, 'ABC-11');
  const s1 = await tick(root, s0.id, { env: w.env });
  assert.deepEqual(s1.tickets.map((t) => t.state), ['waiting', 'running'], 'ABC-12 holds the only slot');
  const s2 = await run(root, s0.id, w.env, (s) => s.tickets[0].state !== 'waiting');
  assert.equal(s2.tickets[1].state, 'parked', 'ABC-11 ran only once ABC-12 let go of the slot');
  assert.equal(s2.tickets[0].state, 'running');
});

test('a step dispatched but never saved holds its slot: a retry waits until it is adopted and done', async () => {
  const { root, w } = sprintWorld();
  setSetting(root, 'sprintParallel', 1);
  scriptAgent(root, 'fa', [{ err: 'boom', exit: 3 }, { write: 'a.txt' }]);
  scriptAgent(root, 'fb', [{ write: 'b.txt', ms: 3000 }]);
  scriptAgent(root, 'fr', []);
  const s0 = await createSprint(root, { name: 'x', tickets: [T(), T({ key: 'ABC-12', title: 'Payouts', agent: 'fb' })] }, { cwd: w.repo });
  // ABC-11 parks; the same tick starts ABC-12, and the save after its dispatch fails (a runner killed there).
  let crashed = false;
  const saveFn = (r, s, lock) => {
    if (!crashed && s.tickets[1].job) { crashed = true; throw new Error('killed'); }
    return saveSprint(r, s, lock);
  };
  await waitFor(async () => {
    try { await tick(root, s0.id, { env: w.env, saveFn }); } catch (e) { if (e.message === 'killed') return true; throw e; }
    return null;
  }, { timeoutMs: 90_000, intervalMs: 150 });
  const saved = loadSprint(root, s0.id);
  assert.equal(saved.tickets[0].state, 'parked');
  assert.equal(saved.tickets[1].job, null, 'the sprint never recorded ABC-12\'s step');
  assert.ok(saved.tickets[1].dispatching, 'only its intent');
  await retryTicket(root, s0.id, 'ABC-11');
  const s = await tick(root, s0.id, { env: w.env });
  assert.deepEqual(s.tickets.map((t) => t.state), ['waiting', 'running'], 'ABC-12 was adopted first and holds the only slot');
  const authors = listJobDirs(root).map(readJob).filter((j) => j.sprint?.role === 'author');
  assert.equal(authors.filter((j) => j.sprint.ticket === 'ABC-11').length, 1, 'ABC-11 did not start again yet');
  assert.equal(authors.filter((j) => j.sprint.ticket === 'ABC-12').length, 1, 'ABC-12 was adopted, not started twice');
  assert.equal(s.tickets[1].job, authors.find((j) => j.sprint.ticket === 'ABC-12').id);
});

test('a retry waits while another ticket\'s intent to dispatch has no job yet: that ticket starts again first', async () => {
  const { root, w } = sprintWorld();
  setSetting(root, 'sprintParallel', 1);
  scriptAgent(root, 'fa', [{ write: 'a.txt' }]);
  scriptAgent(root, 'fb', [{ write: 'b.txt', ms: 3000 }]);
  scriptAgent(root, 'fr', []);
  const s0 = await createSprint(root, { name: 'x', tickets: [T(), T({ key: 'ABC-12', title: 'Payouts', agent: 'fb' })] }, { cwd: w.repo });
  // ABC-11 is due a retry. ABC-12 saved its intent to dispatch, but the runner was killed before the job was made.
  const s1 = loadSprint(root, s0.id);
  Object.assign(s1.tickets[0], { state: 'waiting', resume: 'author', retryAt: new Date(0).toISOString() });
  s1.tickets[1].dispatching = { role: 'author', task: 0, phase: 'author', at: new Date().toISOString() };
  saveSprint(root, s1);
  const s = await tick(root, s0.id, { env: w.env });
  assert.deepEqual(s.tickets.map((t) => t.state), ['waiting', 'running'], 'ABC-12 kept the slot its intent held');
  const authors = listJobDirs(root).map(readJob).filter((j) => j.sprint?.role === 'author');
  assert.deepEqual(authors.map((j) => j.sprint.ticket), ['ABC-12']);
});

test('assignTask changes a task not yet started, and refuses one that ran', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', []);
  scriptAgent(root, 'fb', []);
  scriptAgent(root, 'fr', []);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  const s = await assignTask(root, s0.id, 'ABC-11', 2, { agent: 'fb', reviewer: 'fa' });
  assert.deepEqual([s.tickets[0].tasks[1].agent, s.tickets[0].tasks[1].reviewer], ['fb', 'fa']);
  await assert.rejects(assignTask(root, s0.id, 'ABC-11', 9, { agent: 'fb' }), (e) => e.code === 'no-such-task');
  await assert.rejects(assignTask(root, s0.id, 'ABC-11', 2, { agent: 'ghost' }), (e) => e.code === 'unknown-agent');
});

test('messages go to the sprint\'s chat once, and never to another chat', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ err: 'boom', exit: 3 }]);
  scriptAgent(root, 'fr', []);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo, session: 'chat-1' });
  await run(root, s0.id, w.env, (s) => s.tickets[0].state === 'parked');
  const now = Date.now();
  assert.deepEqual((await claimMessages(root, 'chat-2', { now })).messages, []);
  const mine = (await claimMessages(root, 'chat-1', { now })).messages;
  assert.equal(mine.length, 1);
  assert.equal(mine[0].id, `${s0.id}:1`);
  assert.match(mine[0].text, /^ABC-11 \(Login form\) needs you: Fa stopped on task 1/);
  assert.deepEqual((await claimMessages(root, 'chat-1', { now: now + 1000 })).messages, [], 'claimed');
  assert.equal((await claimMessages(root, 'chat-1', { now: now + CLAIM_MS + 1000 })).messages.length, 1, 'an unconfirmed claim expires');
  assert.deepEqual((await claimMessages(root, 'chat-2', { now: now + 24 * 60 * 60_000 })).messages, [], 'another chat never takes it');
  assert.deepEqual(await markMessages(root, [mine[0].id]), { marked: 1, failed: [] });
  assert.deepEqual((await claimMessages(root, 'chat-1', { now: now + 100 * 60_000 })).messages, []);
});

test('the inbox takes only this project\'s sprint news with --here, and the summary counts news', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ err: 'boom', exit: 3 }]);
  scriptAgent(root, 'fr', []);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo, session: 'chat-1' });
  const parked = await run(root, s0.id, w.env, (s) => s.tickets[0].state === 'parked');
  assert.equal(sprintSummary(root, parked).news, 1);
  assert.deepEqual((await claimMessages(root, 'chat-1', { project: 'elsewhere' })).messages, []);
  const inbox = async (cwd) => {
    let out = '';
    const stdout = new Writable({ write(c, _e, cb) { out += c; cb(); } });
    await main(['sprint', 'inbox', '--session', 'chat-1', '--here', '--cwd', cwd], { stdout, env: { ...process.env, PODIUM_DATA_DIR: root } });
    return JSON.parse(out).messages;
  };
  assert.deepEqual(await inbox(tempRoot()), [], 'another folder\'s chat gets nothing');
  const mine = await inbox(w.repo);
  assert.equal(mine.length, 1);
  await markMessages(root, [mine[0].id]);
  assert.equal(sprintSummary(root, loadSprint(root, s0.id)).news, 0);
});

test('assignTask refuses a task that ran or is running, and a call that changes nothing', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ write: 'a.txt', ms: 500 }]);
  scriptAgent(root, 'fb', []);
  scriptAgent(root, 'fr', []);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  const s1 = await tick(root, s0.id, { env: w.env });
  assert.equal(s1.tickets[0].state, 'running');
  assert.equal(s1.tickets[0].phase, 'author');
  await assert.rejects(assignTask(root, s0.id, 'ABC-11', 1, { agent: 'fb' }), (e) => e.code === 'task-started');
  await assert.rejects(assignTask(root, s0.id, 'ABC-11', 2, {}), (e) => e.code === 'nothing-to-change');
});

test('claimMessages does not block on a busy sprint', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ err: 'boom', exit: 3 }]);
  scriptAgent(root, 'fr', []);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo, session: 'chat-1' });
  await run(root, s0.id, w.env, (s) => s.tickets[0].state === 'parked');
  const holder = locked(root, s0.id, () => new Promise((r) => setTimeout(r, 3000)));
  const started = Date.now();
  const busy = await claimMessages(root, 'chat-1', { waitMs: 200 });
  assert.ok(Date.now() - started < 1500, 'returned without waiting for the holder');
  assert.deepEqual(busy, { messages: [] });
  await holder;
  assert.equal((await claimMessages(root, 'chat-1')).messages.length, 1);
});

test('a retry resets the usage-limit budget', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ err: 'boom', exit: 3 }]);
  scriptAgent(root, 'fr', []);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  await run(root, s0.id, w.env, (s) => s.tickets[0].state === 'parked');
  const raw = loadSprint(root, s0.id);
  raw.tickets[0].waits = 5;
  saveSprint(root, raw);
  assert.equal(loadSprint(root, s0.id).tickets[0].waits, 5);
  const r = await retryTicket(root, s0.id, 'ABC-11');
  assert.equal(r.tickets[0].waits, 0);
});

test('markMessages for a sprint that no longer exists marks nothing and fails nothing', async () => {
  const { root } = sprintWorld();
  assert.deepEqual(await markMessages(root, ['gone-sprint:1']), { marked: 0, failed: [] });
});

test('after a retry the park words say "again", counting retries, and a pass starts the count over', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ write: 'a.txt' }, { write: 'a2.txt' }, { write: 'a3.txt' }, { write: 'a4.txt' }, { write: 'b.txt' }]);
  scriptAgent(root, 'fr', [{ say: 'Hmm.' }, { say: 'Hmm.' }, { say: 'Hmm.' }, { say: 'Hmm.' }, { say: 'VERDICT: pass' }]);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  const first = await run(root, s0.id, w.env, (s) => s.tickets[0].state === 'parked');
  assert.equal(first.tickets[0].reason, "The reviewer didn't give a verdict on task 1, twice");
  assert.equal(first.tickets[0].retries, 0);
  assert.equal((await retryTicket(root, s0.id, 'ABC-11')).tickets[0].retries, 1);
  const second = await run(root, s0.id, w.env, (s) => s.tickets[0].state === 'parked');
  assert.equal(second.tickets[0].reason, "The reviewer didn't give a verdict on task 1 again after a retry");
  await retryTicket(root, s0.id, 'ABC-11');
  const third = await run(root, s0.id, w.env, (s) => s.tickets[0].state === 'parked');
  assert.equal(third.tickets[0].reason, "The reviewer didn't give a verdict on task 1 again after 2 retries");
  assert.equal(third.tickets[0].retries, 2);
  await retryTicket(root, s0.id, 'ABC-11');
  const passed = await run(root, s0.id, w.env, (s) => s.tickets[0].task === 1);
  assert.equal(passed.tickets[0].retries, 0, 'a passed review starts the count over');
});

test('a failed review after two retries says how many', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ write: 'a.txt' }, { write: 'a2.txt' }, { write: 'a3.txt' }, { write: 'a4.txt' }]);
  const fail = { say: 'Broken.\nVERDICT: fail' };
  scriptAgent(root, 'fr', [fail, fail, fail, fail]);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  await run(root, s0.id, w.env, (s) => s.tickets[0].state === 'parked');
  await retryTicket(root, s0.id, 'ABC-11');
  await run(root, s0.id, w.env, (s) => s.tickets[0].state === 'parked');
  await retryTicket(root, s0.id, 'ABC-11');
  const s = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  assert.equal(s.tickets[0].reason, 'Review failed again on task 1 after 2 retries');
});

test('the retry note says which agent does what, after any override', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', []);
  scriptAgent(root, 'fb', []);
  scriptAgent(root, 'fr', []);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  const park = (over) => {
    const s = loadSprint(root, s0.id);
    Object.assign(s.tickets[0], { state: 'parked', task: 1, ...over });
    saveSprint(root, s);
  };
  const noteFor = async (resume, agent) => {
    park({ resume });
    const r = await retryTicket(root, s0.id, 'ABC-11', { agent });
    return r.tickets[0].reason;
  };
  assert.equal(await noteFor(null), 'Trying again: Fa does task 2');
  assert.equal(await noteFor('author'), 'Trying again: Fa does task 2');
  assert.equal(await noteFor('fix'), 'Trying again: Fa fixes task 2, then Fr reviews it');
  assert.equal(await noteFor('review'), 'Trying again: Fr reviews task 2');
  assert.equal(await noteFor('fix-review'), 'Trying again: Fr reviews task 2');
  assert.equal(await noteFor('pr'), 'Trying again: opening the PR');
  assert.equal(await noteFor('fix', 'fb'), 'Trying again: Fb fixes task 2, then Fr reviews it', 'the override shows');
  assert.equal(await noteFor('review', 'fb'), 'Trying again: Fb reviews task 2');
  park({ resume: 'pr', task: 2 });
  assert.equal((await retryTicket(root, s0.id, 'ABC-11')).tickets[0].reason, 'Trying again: opening the PR', 'all tasks done');
});

// A retried step follows up the failed one, which the follow-up marks `continued` (endStatus: failed).
// The step list must still say that step failed, not that it wrote, fixed or reviewed the task.
test('after retries, the step list keeps each failed step\'s outcome', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ err: 'boom', exit: 3 }, { write: 'a.txt' }, { err: 'boom', exit: 3 }, { write: 'a2.txt' }, { write: 'b.txt', ms: 3000 }]);
  scriptAgent(root, 'fr', [{ err: 'boom', exit: 3 }, { say: 'Broken.\nVERDICT: fail' }, { say: 'VERDICT: pass' }]);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  const parked = (s) => s.tickets[0].state === 'parked';
  await run(root, s0.id, w.env, parked);                       // the writer failed
  await retryTicket(root, s0.id, 'ABC-11');
  await run(root, s0.id, w.env, parked);                       // the retried write passed; its review failed to run
  await retryTicket(root, s0.id, 'ABC-11');
  await run(root, s0.id, w.env, parked);                       // the review failed the task; its fix failed
  await retryTicket(root, s0.id, 'ABC-11');
  const s = await run(root, s0.id, w.env, (x) => x.tickets[0].task === 1); // the fix and its review passed
  const jobs = listJobDirs(root).map(readJob);
  const steps = ticketSteps(jobs, { id: s.id, ticket: 'ABC-11' });
  const lines = [...steps].reverse().map((j) => sprintStepLine(j, steps).replace(/ · [^·]* ago$/, ''));
  assert.deepEqual(lines.slice(0, 7), [
    "Fa couldn't finish task 1 · failed",
    'Fa wrote task 1',
    "Fr couldn't review task 1 · failed",
    'Fr reviewed task 1 · failed',
    "Fa couldn't finish task 1 · failed",
    'Fa fixed task 1',
    'Fr reviewed task 1 · passed',
  ]);
  const retried = steps.filter((j) => j.followUpOf && jobs.find((x) => x.id === j.followUpOf)?.endStatus === 'failed');
  assert.equal(retried.length, 2, 'the retried write and the retried fix each follow up the step that failed');
});
