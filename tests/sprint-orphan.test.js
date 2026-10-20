// An agent whose runner is gone may still be writing in its copy: nothing else starts there until it ends.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createSprint, tick, stopTicket, sprintSummary } from '../engine/sprint.js';
import { dispatch } from '../engine/dispatch.js';
import { listJobDirs, readJob, updateJob } from '../engine/store.js';
import { isAlive, reconcile, AGENT_WAIT_MS } from '../engine/status.js';
import { doingText, sprintRow, ticketStatusLine } from '../mod/view.js';
import { waitFor, scriptAgent, sprintWorld, tempRoot, tempRepo } from './helpers.js';

const T = (over = {}) => ({ key: 'ABC-11', title: 'Login form', type: 'feat', plan: 'docs/plan.md', agent: 'fa', reviewer: 'fr', ...over });
const jobsBy = (root, role) => listJobDirs(root).map(readJob).filter((j) => j.sprint?.role === role);
const dirOf = (root, id) => listJobDirs(root).find((d) => d.endsWith(id));
// A writer still at work when its runner goes.
const BUSY = { write: 'a.txt', ms: 10_000 };
const LATE = 'written after its runner was gone\n';

// Ends a running job's runner, as a crash or a person ending that one process would, and leaves its agent running on in
// its copy: a process of the test's own stands in for it, alive for about 6 s, then writing late.txt in the copy. (On macOS
// and Linux the runner's own agent would run on; on Windows it ends with its runner, whose children go when it dies.)
async function orphan(root, find) {
  const job = await waitFor(() => { const j = find(); return j?.status === 'running' && j.runnerPid && j.agentPid ? j : null; }, { timeoutMs: 60_000 });
  process.kill(job.runnerPid);
  await waitFor(() => !isAlive(job.runnerPid), { timeoutMs: 30_000 });
  const late = path.join(job.worktree, 'late.txt');
  const script = `setTimeout(() => require('fs').writeFileSync(process.argv[1], ${JSON.stringify(LATE)}), 6000)`;
  const agent = spawn(process.execPath, ['-e', script, late], { detached: true, stdio: 'ignore', windowsHide: true });
  agent.unref();
  updateJob(root, dirOf(root, job.id), { agentPid: agent.pid }, 'test');
  return { ...job, agentPid: agent.pid, late };
}

test('a step whose runner dies while its agent writes on waits for the agent: nothing else starts in the copy, and Stop waits too', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [BUSY, { write: 'b.txt' }]);
  scriptAgent(root, 'fr', [{ say: 'VERDICT: pass' }, { say: 'VERDICT: pass' }]);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  await tick(root, s0.id, { env: w.env });
  const job = await orphan(root, () => jobsBy(root, 'author')[0]);
  // While its agent is alive (after a tick, so all through it), the step is still going.
  let waited = 0;
  for (;;) {
    const s = await tick(root, s0.id, { env: w.env });
    if (!isAlive(job.agentPid)) break;
    waited += 1;
    const t = s.tickets[0];
    assert.deepEqual([t.state, t.phase, t.job], ['running', 'author', job.id]);
    assert.equal(readJob(dirOf(root, job.id)).status, 'lost', 'its runner is gone');
    assert.equal(jobsBy(root, 'reviewer').length, 0, 'no review starts in the copy');
    const sum = sprintSummary(root, s).tickets[0];
    assert.deepEqual([sum.agentLeft, sum.canStop], [true, false]);
    assert.equal(ticketStatusLine(sum), "Podium's runner for Fa stopped, and Fa may still be working in this ticket's copy · nothing else runs there until it finishes");
    assert.equal(sprintRow(sum), "Fa's runner stopped · waiting for Fa to finish");
    assert.equal(doingText(sum), 'waiting for Fa on ABC-11 (its runner stopped)');
    if (waited === 1) await assert.rejects(stopTicket(root, s0.id, 'ABC-11'), (e) => e.code === 'ticket-busy');
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.ok(waited > 0, 'its agent outlived its runner');
  // Once it has ended, the step is lost as before, with everything the agent wrote already in the copy.
  const parked = await waitFor(async () => { const s = await tick(root, s0.id, { env: w.env }); return s.tickets[0].state === 'parked' ? s : null; }, { timeoutMs: 30_000 });
  assert.match(parked.tickets[0].reason, /^Fa stopped on task 1: The job stopped unexpectedly/);
  assert.doesNotMatch(parked.tickets[0].reason, /still running/);
  assert.equal(fs.readFileSync(job.late, 'utf8'), LATE);
  assert.equal(sprintSummary(root, parked).tickets[0].agentLeft, false);
});

// A usage limit in its output would otherwise wait and start the step again by itself.
for (const limited of [false, true]) {
  test(`past the longest wait, a step whose agent is still running parks, naming the process${limited ? ', even after a usage limit' : ''}`, async () => {
    const { root, w } = sprintWorld();
    scriptAgent(root, 'fa', [BUSY]);
    scriptAgent(root, 'fr', []);
    const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
    await tick(root, s0.id, { env: w.env });
    const job = await orphan(root, () => jobsBy(root, 'author')[0]);
    // What its agent had printed before its runner went.
    if (limited) fs.appendFileSync(path.join(dirOf(root, job.id), 'stderr.log'), "You've hit your usage limit. Try again in 5 hours.\n");
    const s = await tick(root, s0.id, { env: w.env, now: Date.now() + AGENT_WAIT_MS + 60_000 });
    assert.ok(isAlive(job.agentPid));
    assert.deepEqual([s.tickets[0].state, s.tickets[0].retryAt], ['parked', null]);
    assert.match(s.tickets[0].reason, new RegExp(`Its agent \\(process ${job.agentPid}\\) was still running after 2 hours\\. Retry works in the same copy, so end that process first if it is still Fa's\\.$`));
  });
}

test('a plain job\'s follow-up waits for an agent whose runner is gone', async () => {
  const root = tempRoot();
  scriptAgent(root, 'fa', [BUSY, { write: 'b.txt' }]);
  const repo = tempRepo();
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: repo });
  const res = await dispatch(root, { agent: 'fa', permission: 'edit-worktree', cwd: repo, prompt: 'Make a.txt' });
  const job = await orphan(root, () => readJob(res.dir));
  assert.equal(reconcile(root, res.dir).status, 'lost');
  await assert.rejects(dispatch(root, { agent: 'fa', cwd: repo, prompt: 'Now b.txt', followUp: job.id }), (e) => e.code === 'agent-still-running'
    && e.message === `Job ${job.id} stopped unexpectedly, but its agent (process ${job.agentPid}) is still running in its copy. Wait for it to finish, or end that process, then continue.`);
  await waitFor(() => !isAlive(job.agentPid), { timeoutMs: 30_000 });
  const next = await dispatch(root, { agent: 'fa', cwd: repo, prompt: 'Now b.txt', followUp: job.id });
  assert.equal(next.job.followUpOf, job.id);
  assert.equal(fs.readFileSync(job.late, 'utf8'), LATE);
});
