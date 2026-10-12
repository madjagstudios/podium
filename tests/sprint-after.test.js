// A ticket with "after" starts only once the tickets it names are merged.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { draftSprint, startSprint, loadSprint, sprintSummary, setAfter, removeTicket, createSprint, tick, saveSprint, stopTicket, retryTicket, wantsRunner } from '../engine/sprint.js';
import { fetchBase } from '../engine/worktree.js';
import { listJobDirs, readJob, findJobDir, updateJob } from '../engine/store.js';
import { main } from '../engine/cli.js';
import { scriptAgent, sprintWorld, waitFor, tempRoot } from './helpers.js';

const T = (over = {}) => ({ key: 'ABC-11', title: 'Login form', type: 'feat', plan: 'docs/plan.md', agent: 'fa', reviewer: 'fr', ...over });
const THREE = [T(), T({ key: 'ABC-12', title: 'Signup' }), T({ key: 'ABC-13', title: 'Export' })];
const versions = (root, id) => fs.readdirSync(path.join(root, 'sprints', id, 'state')).filter((f) => /^\d{12}\.json$/.test(f)).length;

function world() {
  const { root, w } = sprintWorld();
  for (const name of ['fa', 'fr']) scriptAgent(root, name, []);
  return { root, w };
}

async function cli(root, argv, { spawn = () => {} } = {}) {
  let out = '';
  const stdout = new Writable({ write(c, _e, cb) { out += c; cb(); } });
  const code = await main(argv, { stdout, env: { ...process.env, PODIUM_DATA_DIR: root }, spawn });
  return { code, body: JSON.parse(out) };
}

test('a draft ticket may wait for others in its sprint; unknown keys, itself and loops are refused', async () => {
  const { root, w } = world();
  const bad = async (tickets, message) => assert.rejects(draftSprint(root, { name: 'x', tickets }, { cwd: w.repo }), (e) => e.code === 'bad-after' && e.message === message);
  await bad([T({ after: 'ABC-12' })], 'ABC-11\'s "after" must be a list of ticket keys.');
  await bad([T({ after: ['ABC-99'] })], 'ABC-11 waits for ABC-99, which is not in this sprint.');
  await bad([T({ after: ['abc-11'] })], "ABC-11 can't wait for itself.");
  await bad([T({ after: ['ABC-12'] }), T({ key: 'ABC-12', title: 'Signup', after: ['ABC-11'] })], 'These tickets wait for each other, so none of them could start: ABC-11 → ABC-12 → ABC-11.');
  const d = await draftSprint(root, { name: 'x', tickets: [T(), T({ key: 'ABC-12', title: 'Signup', after: ['abc-11', 'ABC-11'] })] }, { cwd: w.repo });
  assert.deepEqual(d.tickets.map((t) => t.after), [[], ['ABC-11']]);
  const sum = sprintSummary(root, d).tickets[1];
  assert.deepEqual([sum.after, sum.waitingOn], [['ABC-11'], []], 'a draft waits for nothing yet');
});

test('the draft board sets and clears what a ticket waits for; removing a ticket drops it from the others', async () => {
  const { root, w } = world();
  const { id } = await draftSprint(root, { name: 'x', tickets: THREE }, { cwd: w.repo });
  const after = (s, key) => s.tickets.find((t) => t.key === key).after;
  let s = await setAfter(root, id, 'ABC-13', { add: 'abc-11' });
  assert.deepEqual(after(s, 'ABC-13'), ['ABC-11']);
  s = await setAfter(root, id, 'ABC-13', { add: 'ABC-12' });
  assert.deepEqual(after(s, 'ABC-13'), ['ABC-11', 'ABC-12']);
  const before = versions(root, id);
  await setAfter(root, id, 'ABC-13', { add: 'ABC-12' });
  assert.equal(versions(root, id), before, 'nothing changed, nothing saved');
  s = await setAfter(root, id, 'ABC-13', { drop: 'ABC-11' });
  assert.deepEqual(after(s, 'ABC-13'), ['ABC-12']);
  await assert.rejects(setAfter(root, id, 'ABC-12', { add: 'ABC-13' }), (e) => e.code === 'bad-after' && /wait for each other/.test(e.message));
  await assert.rejects(setAfter(root, id, 'ABC-12', { add: 'ABC-99' }), (e) => e.code === 'bad-after');
  await assert.rejects(setAfter(root, id, 'ABC-13', {}), (e) => e.code === 'nothing-to-change' && e.message === 'Say which tickets it waits for.');
  s = await setAfter(root, id, 'ABC-13', { keys: [] });
  assert.deepEqual(after(s, 'ABC-13'), []);
  s = await setAfter(root, id, 'ABC-13', { keys: ['ABC-11', 'abc-12'] });
  assert.deepEqual(after(s, 'ABC-13'), ['ABC-11', 'ABC-12']);
  s = await removeTicket(root, id, 'ABC-11');
  assert.deepEqual(after(s, 'ABC-13'), ['ABC-12']);
  await startSprint(root, id);
  await assert.rejects(setAfter(root, id, 'ABC-13', { keys: [] }), (e) => e.code === 'not-a-draft');
});

test('the CLI sets, adds, drops and clears "after"', async () => {
  const { root, w } = world();
  const { id } = await draftSprint(root, { name: 'x', tickets: THREE }, { cwd: w.repo });
  const of = (r) => r.body.sprint.tickets[2].after;
  assert.deepEqual(of(await cli(root, ['sprint', 'after', '--id', id, '--ticket', 'ABC-13', '--add', 'ABC-11'])), ['ABC-11']);
  assert.deepEqual(of(await cli(root, ['sprint', 'after', '--id', id, '--ticket', 'ABC-13', '--keys', 'ABC-11,ABC-12'])), ['ABC-11', 'ABC-12']);
  assert.deepEqual(of(await cli(root, ['sprint', 'after', '--id', id, '--ticket', 'ABC-13', '--drop', 'ABC-11'])), ['ABC-12']);
  assert.deepEqual(of(await cli(root, ['sprint', 'after', '--id', id, '--ticket', 'ABC-13', '--keys', 'none'])), []);
  assert.equal((await cli(root, ['sprint', 'after', '--id', id, '--ticket', 'ABC-13', '--keys', 'ABC-13'])).body.error.code, 'bad-after');
  assert.deepEqual(loadSprint(root, id).tickets[2].after, []);
});

const run = (root, id, env, until) => waitFor(async () => { const s = await tick(root, id, { env }); return until(s) ? s : null; }, { timeoutMs: 90_000, intervalMs: 150 });
const jobOf = (root, id) => readJob(findJobDir(root, id));
const authorsOf = (root, key) => listJobDirs(root).map(readJob).filter((j) => j.sprint?.role === 'author' && j.sprint.ticket === key);

// Someone else's work lands on GitHub's main: a clone pushes a commit the local main does not have.
function remoteAhead(w, file) {
  const clone = tempRoot();
  w.git(clone, 'clone', '-q', w.remote, '.');
  w.git(clone, 'config', 'user.name', 'Other');
  w.git(clone, 'config', 'user.email', 'other@example.com');
  fs.writeFileSync(path.join(clone, file), 'theirs\n');
  w.git(clone, 'add', '-A');
  w.git(clone, 'commit', '-q', '-m', `add ${file}`);
  w.git(clone, 'push', '-q', 'origin', 'main');
  return w.git(w.remote, 'rev-parse', 'main');
}

test('fetchBase fetches the base from its upstream remote (origin when none) and leaves the local branch alone', async () => {
  const { w } = sprintWorld();
  const ahead = remoteAhead(w, 'theirs.txt');
  const local = w.git(w.repo, 'rev-parse', 'main');
  assert.equal(await fetchBase(w.repo, 'main'), 'refs/remotes/origin/main');
  assert.equal(w.git(w.repo, 'rev-parse', 'refs/remotes/origin/main'), ahead);
  assert.equal(w.git(w.repo, 'rev-parse', 'main'), local);
  w.git(w.repo, 'remote', 'add', 'up', w.remote);
  w.git(w.repo, 'config', 'branch.main.remote', 'up');
  assert.equal(await fetchBase(w.repo, 'main'), 'refs/remotes/up/main');
  assert.equal(w.git(w.repo, 'rev-parse', 'refs/remotes/up/main'), ahead);
  w.git(w.repo, 'config', '--unset', 'branch.main.remote');
  assert.equal(await fetchBase(w.repo, 'main'), 'refs/remotes/origin/main');
  await assert.rejects(fetchBase(w.repo, 'nowhere'), (e) => e.code === 'git-failed' && e.remote === 'origin');
  assert.equal(w.git(w.repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
});

// An upstream of "." (a local branch) or a remote this repo doesn't have would fetch into an invalid ref and
// park the ticket for good. "." starts from the local base without fetching; an unknown name falls back to origin, and
// with no origin either, to the local base.
test('fetchBase starts from the local base for an upstream of ".", and falls back from a remote the repo does not have', async () => {
  const { w } = sprintWorld();
  const local = w.git(w.repo, 'rev-parse', 'main');
  const tracking = w.git(w.repo, 'rev-parse', 'refs/remotes/origin/main');
  const ahead = remoteAhead(w, 'theirs.txt');
  w.git(w.repo, 'config', 'branch.main.remote', '.');
  assert.equal(await fetchBase(w.repo, 'main'), 'refs/heads/main');
  assert.equal(w.git(w.repo, 'rev-parse', 'refs/remotes/origin/main'), tracking, 'nothing was fetched');
  w.git(w.repo, 'config', 'branch.main.remote', 'ghost');
  assert.equal(await fetchBase(w.repo, 'main'), 'refs/remotes/origin/main');
  assert.equal(w.git(w.repo, 'rev-parse', 'refs/remotes/origin/main'), ahead);
  w.git(w.repo, 'remote', 'rename', 'origin', 'up');
  assert.equal(await fetchBase(w.repo, 'main'), 'refs/heads/main', 'no origin either: the local base');
  w.git(w.repo, 'config', '--unset', 'branch.main.remote');
  assert.equal(await fetchBase(w.repo, 'main'), 'refs/heads/main');
  assert.equal(w.git(w.repo, 'rev-parse', 'main'), local);
});

test('a waiting ticket whose base tracks "." starts from the local base', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ write: 'b.txt', ms: 500 }]);
  scriptAgent(root, 'fr', []);
  const s0 = await createSprint(root, { name: 'x', tickets: [T(), T({ key: 'ABC-12', title: 'Signup', after: ['ABC-11'] })] }, { cwd: w.repo });
  const raw = loadSprint(root, s0.id);
  raw.tickets[0].state = 'merged';
  saveSprint(root, raw);
  remoteAhead(w, 'theirs.txt');
  w.git(w.repo, 'config', 'branch.main.remote', '.');
  const s1 = await tick(root, s0.id, { env: w.env });
  assert.equal(s1.tickets[1].state, 'running');
  assert.equal(jobOf(root, s1.tickets[1].job).baseCommit, w.git(w.repo, 'rev-parse', 'main'));
});

test('a ticket waits for its dependency\'s merge, then starts from GitHub\'s main with that work, leaving the local main alone', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ write: 'a.txt' }, { write: 'b.txt' }, { write: 'c.txt' }]);
  scriptAgent(root, 'fr', [{ say: 'VERDICT: pass' }, { say: 'VERDICT: pass' }]);
  const s0 = await createSprint(root, { name: 'x', tickets: [T(), T({ key: 'ABC-12', title: 'Signup', after: ['ABC-11'] })] }, { cwd: w.repo });
  const localMain = w.git(w.repo, 'rev-parse', 'main');
  const s1 = await run(root, s0.id, w.env, (s) => s.tickets[0].state === 'pr-open');
  assert.equal(s1.tickets[1].state, 'pending', 'its dependency\'s PR is only open');
  assert.deepEqual(sprintSummary(root, s1).tickets[1].waitingOn, ['ABC-11']);
  assert.deepEqual(authorsOf(root, 'ABC-12'), []);
  assert.equal(wantsRunner(root, s1), false, 'nothing for the runner to do until the merge');
  // The PR merges on GitHub, and the PR watcher records it on the thread.
  w.git(w.remote, 'update-ref', 'refs/heads/main', 'refs/heads/feat/abc-11-login-form');
  const merged = w.git(w.remote, 'rev-parse', 'main');
  updateJob(root, findJobDir(root, s1.tickets[0].latest), { status: 'merged' });
  assert.equal(wantsRunner(root, loadSprint(root, s0.id)), true);
  const s2 = await tick(root, s0.id, { env: w.env });
  assert.equal(s2.tickets[1].state, 'running');
  const job = jobOf(root, s2.tickets[1].job);
  assert.equal(job.baseCommit, merged, 'it starts from main as GitHub has it');
  assert.equal(job.base, 'main', 'its PR still targets main');
  assert.equal(job.branch, 'feat/abc-12-signup');
  assert.ok(fs.existsSync(path.join(job.worktree, 'a.txt')), 'it holds ABC-11\'s merged work');
  assert.equal(w.git(w.repo, 'rev-parse', 'main'), localMain, 'the local main never moved');
  assert.equal(w.git(w.repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(w.git(w.repo, 'rev-parse', 'refs/remotes/origin/main'), merged);
});

test('a ticket with no "after" still branches from the local main, even when GitHub\'s main is ahead', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ write: 'a.txt', ms: 500 }]);
  scriptAgent(root, 'fr', []);
  const ahead = remoteAhead(w, 'theirs.txt');
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  const s1 = await tick(root, s0.id, { env: w.env });
  const job = jobOf(root, s1.tickets[0].job);
  assert.equal(job.baseCommit, w.git(w.repo, 'rev-parse', 'main'));
  assert.notEqual(job.baseCommit, ahead);
});

test('a stopped dependency parks its dependant; Retry starts it from GitHub\'s main', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ write: 'b.txt', ms: 500 }]);
  scriptAgent(root, 'fr', []);
  const s0 = await createSprint(root, { name: 'x', tickets: [T(), T({ key: 'ABC-12', title: 'Signup', after: ['ABC-11'] })] }, { cwd: w.repo });
  await stopTicket(root, s0.id, 'ABC-11');
  assert.equal(wantsRunner(root, loadSprint(root, s0.id)), true, 'the runner is wanted, to park it');
  const ahead = remoteAhead(w, 'theirs.txt');
  const localMain = w.git(w.repo, 'rev-parse', 'main');
  const s1 = await tick(root, s0.id, { env: w.env });
  const t = s1.tickets[1];
  assert.equal(t.state, 'parked');
  assert.equal(t.reason, "ABC-11 was stopped, so this can't start; retry to start it anyway or stop it");
  assert.equal(s1.messages.at(-1).text, "ABC-12 (Signup) needs you: ABC-11 was stopped, so this can't start; retry to start it anyway or stop it");
  assert.deepEqual(sprintSummary(root, s1).tickets[1].waitingOn, []);
  await retryTicket(root, s0.id, 'ABC-12');
  const s2 = await tick(root, s0.id, { env: w.env });
  assert.equal(s2.tickets[1].state, 'running');
  assert.equal(jobOf(root, s2.tickets[1].job).baseCommit, ahead, 'Retry starts it from the updated base');
  assert.equal(w.git(w.repo, 'rev-parse', 'main'), localMain);
});

test('a dependency whose PR closed without merging parks its dependant, saying so', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', []);
  scriptAgent(root, 'fr', []);
  const s0 = await createSprint(root, { name: 'x', tickets: [T(), T({ key: 'ABC-12', title: 'Signup', after: ['ABC-11'] })] }, { cwd: w.repo });
  const raw = loadSprint(root, s0.id);
  raw.tickets[0].state = 'closed';
  saveSprint(root, raw);
  const s1 = await tick(root, s0.id, { env: w.env });
  assert.equal(s1.tickets[1].state, 'parked');
  assert.equal(s1.tickets[1].reason, "ABC-11's PR was closed without merging, so this can't start; retry to start it anyway or stop it");
});

test('podium sprint stop asks for a runner, so a ticket waiting for the stopped one parks soon', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', []);
  scriptAgent(root, 'fr', []);
  const s0 = await createSprint(root, { name: 'x', tickets: [T(), T({ key: 'ABC-12', title: 'Signup', after: ['ABC-11'] })] }, { cwd: w.repo });
  const spawned = [];
  const r = await cli(root, ['sprint', 'stop', '--id', s0.id, '--ticket', 'ABC-11'], { spawn: (_f, args) => spawned.push(args) });
  assert.equal(r.code, 0);
  assert.deepEqual(spawned, [[root, s0.id]]);
});

// The remote can't be reached (no network, or it is gone): the tick parks the ticket with a reason and carries on;
// Retry, once it can be reached, starts it from the fetched base. The local main never moves.
test('a fetch that fails parks the waiting ticket with a plain reason, and Retry starts it once the remote answers', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ write: 'b.txt', ms: 500 }]);
  scriptAgent(root, 'fr', []);
  const s0 = await createSprint(root, { name: 'x', tickets: [T(), T({ key: 'ABC-12', title: 'Signup', after: ['ABC-11'] })] }, { cwd: w.repo });
  const raw = loadSprint(root, s0.id);
  raw.tickets[0].state = 'merged';
  saveSprint(root, raw);
  const localMain = w.git(w.repo, 'rev-parse', 'main');
  const gone = path.join(tempRoot(), 'gone.git');
  w.git(w.repo, 'remote', 'set-url', 'origin', gone);
  const s1 = await tick(root, s0.id, { env: w.env });
  const t = s1.tickets[1];
  assert.equal(t.state, 'parked');
  assert.match(t.reason, /^Podium couldn't get the latest main from origin, so ABC-12 can't start yet\. Retry when it can be reached\. \(.+\)$/);
  assert.doesNotMatch(t.reason, /git fetch:/);
  assert.match(s1.messages.at(-1)?.text ?? '', /ABC-12 \(Signup\) needs you: Podium couldn't get the latest main from origin/);
  assert.equal(t.dispatching, null);
  assert.deepEqual(authorsOf(root, 'ABC-12'), []);
  assert.equal(w.git(w.repo, 'rev-parse', 'main'), localMain);
  w.git(w.repo, 'remote', 'set-url', 'origin', w.remote);
  const ahead = remoteAhead(w, 'theirs.txt');
  await retryTicket(root, s0.id, 'ABC-12');
  const s2 = await tick(root, s0.id, { env: w.env });
  assert.equal(s2.tickets[1].state, 'running');
  assert.equal(jobOf(root, s2.tickets[1].job).baseCommit, ahead);
  assert.equal(w.git(w.repo, 'rev-parse', 'main'), localMain);
});

// A ticket with no plan that waits for others plans in a copy made from the fetched base too.
test('a plan-less ticket that waited starts its plan from GitHub\'s main', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ write: 'notes.txt', ms: 500 }]);
  scriptAgent(root, 'fr', []);
  const s0 = await createSprint(root, { name: 'x', tickets: [T(), { key: 'ABC-12', title: 'Signup', type: 'feat', agent: 'fa', reviewer: 'fr', after: ['ABC-11'] }] }, { cwd: w.repo });
  const raw = loadSprint(root, s0.id);
  raw.tickets[0].state = 'merged';
  saveSprint(root, raw);
  const ahead = remoteAhead(w, 'theirs.txt');
  const localMain = w.git(w.repo, 'rev-parse', 'main');
  const s1 = await tick(root, s0.id, { env: w.env });
  assert.equal(s1.tickets[1].state, 'running');
  assert.equal(s1.tickets[1].phase, 'plan');
  assert.equal(jobOf(root, s1.tickets[1].job).baseCommit, ahead);
  assert.equal(w.git(w.repo, 'rev-parse', 'main'), localMain);
});

// A plan-less ticket whose fetch fails says so, not that its plan couldn't start or be saved.
test('a plan-less waiting ticket whose fetch fails parks saying the base could not be fetched', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', []);
  scriptAgent(root, 'fr', []);
  const s0 = await createSprint(root, { name: 'x', tickets: [T(), { key: 'ABC-12', title: 'Signup', type: 'feat', agent: 'fa', reviewer: 'fr', after: ['ABC-11'] }] }, { cwd: w.repo });
  const raw = loadSprint(root, s0.id);
  raw.tickets[0].state = 'merged';
  saveSprint(root, raw);
  w.git(w.repo, 'remote', 'set-url', 'origin', path.join(tempRoot(), 'gone.git'));
  const t = (await tick(root, s0.id, { env: w.env })).tickets[1];
  assert.equal(t.state, 'parked');
  assert.match(t.reason, /^Podium couldn't get the latest main from origin, so ABC-12 can't start yet. Retry when it can be reached. (.+)$/);
  assert.doesNotMatch(t.reason, /plan/);
});

// Longer loops, a loop the first ticket only leads into, a diamond, and the middle of a chain removed.
test('a loop of three tickets is refused, naming each in order', async () => {
  const { root, w } = world();
  await assert.rejects(
    draftSprint(root, { name: 'x', tickets: [T({ after: ['ABC-13'] }), T({ key: 'ABC-12', title: 'Signup', after: ['ABC-11'] }), T({ key: 'ABC-13', title: 'Export', after: ['ABC-12'] })] }, { cwd: w.repo }),
    (e) => e.code === 'bad-after' && e.message === 'These tickets wait for each other, so none of them could start: ABC-11 → ABC-13 → ABC-12 → ABC-11.',
  );
});

test('a loop the first ticket only leads into names just the tickets in the loop', async () => {
  const { root, w } = world();
  await assert.rejects(
    draftSprint(root, { name: 'x', tickets: [T({ after: ['ABC-12'] }), T({ key: 'ABC-12', title: 'Signup', after: ['ABC-13'] }), T({ key: 'ABC-13', title: 'Export', after: ['ABC-12'] })] }, { cwd: w.repo }),
    (e) => e.code === 'bad-after' && e.message === 'These tickets wait for each other, so none of them could start: ABC-12 → ABC-13 → ABC-12.',
  );
  // The same loop made on the draft board one key at a time.
  const { id } = await draftSprint(root, { name: 'y', tickets: [T({ after: ['ABC-12'] }), T({ key: 'ABC-12', title: 'Signup', after: ['ABC-13'] }), T({ key: 'ABC-13', title: 'Export' })] }, { cwd: w.repo });
  await assert.rejects(setAfter(root, id, 'ABC-13', { add: 'ABC-12' }), (e) => e.code === 'bad-after' && e.message === 'These tickets wait for each other, so none of them could start: ABC-12 → ABC-13 → ABC-12.');
  assert.deepEqual(loadSprint(root, id).tickets[2].after, []);
});

test('a diamond is not a loop: one ticket waits for two that both wait for a fourth', async () => {
  const { root, w } = world();
  const D = T({ key: 'ABC-14', title: 'Schema' });
  const d = await draftSprint(root, { name: 'x', tickets: [T({ after: ['ABC-12', 'ABC-13'] }), T({ key: 'ABC-12', title: 'Signup', after: ['ABC-14'] }), T({ key: 'ABC-13', title: 'Export', after: ['ABC-14'] }), D] }, { cwd: w.repo });
  assert.deepEqual(d.tickets.map((t) => t.after), [['ABC-12', 'ABC-13'], ['ABC-14'], ['ABC-14'], []]);
  // Built on the board instead, edge by edge.
  const { id } = await draftSprint(root, { name: 'y', tickets: [T(), T({ key: 'ABC-12', title: 'Signup' }), T({ key: 'ABC-13', title: 'Export' }), D] }, { cwd: w.repo });
  await setAfter(root, id, 'ABC-12', { add: 'ABC-14' });
  await setAfter(root, id, 'ABC-13', { add: 'ABC-14' });
  const s = await setAfter(root, id, 'ABC-11', { keys: ['ABC-12', 'ABC-13'] });
  assert.deepEqual(s.tickets.map((t) => t.after), [['ABC-12', 'ABC-13'], ['ABC-14'], ['ABC-14'], []]);
});

// The ticket after the removed one takes over what it waited for, so it still starts in order.
test('removing the middle of a chain makes the ticket after it wait for what the removed one waited for', async () => {
  const { root, w } = world();
  const { id } = await draftSprint(root, { name: 'x', tickets: [T(), T({ key: 'ABC-12', title: 'Signup', after: ['ABC-11'] }), T({ key: 'ABC-13', title: 'Export', after: ['ABC-12'] })] }, { cwd: w.repo });
  const s = await removeTicket(root, id, 'ABC-12');
  assert.deepEqual(s.tickets.map((t) => [t.key, t.after]), [['ABC-11', []], ['ABC-13', ['ABC-11']]]);
  assert.deepEqual(loadSprint(root, id).tickets.map((t) => t.after), [[], ['ABC-11']]);
  // Listed once, in place, when the ticket already waited for it too; a ticket that waited for nothing is left alone.
  const D = T({ key: 'ABC-14', title: 'Schema' });
  const y = await draftSprint(root, { name: 'y', tickets: [T(), T({ key: 'ABC-12', title: 'Signup', after: ['ABC-11', 'ABC-14'] }), T({ key: 'ABC-13', title: 'Export', after: ['ABC-12', 'ABC-11'] }), D, T({ key: 'ABC-15', title: 'Docs' })] }, { cwd: w.repo });
  const s2 = await removeTicket(root, y.id, 'ABC-12');
  assert.deepEqual(s2.tickets.map((t) => [t.key, t.after]), [['ABC-11', []], ['ABC-13', ['ABC-11', 'ABC-14']], ['ABC-14', []], ['ABC-15', []]]);
});

// Only starting needs a slot.
test('a dependant of a stopped ticket parks on the next tick even while every slot is taken', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ write: 'a.txt', ms: 3000 }]);
  scriptAgent(root, 'fr', []);
  const s0 = await createSprint(root, { name: 'x', tickets: [T(), T({ key: 'ABC-12', title: 'Signup' }), T({ key: 'ABC-13', title: 'Export' }), T({ key: 'ABC-14', title: 'Import', after: ['ABC-13'] })] }, { cwd: w.repo });
  const raw = loadSprint(root, s0.id);
  raw.maxParallel = 1;
  saveSprint(root, raw);
  await stopTicket(root, s0.id, 'ABC-13');
  const s1 = await tick(root, s0.id, { env: w.env });
  assert.deepEqual(s1.tickets.map((t) => t.state), ['running', 'pending', 'stopped', 'parked']);
  assert.equal(s1.tickets[3].reason, "ABC-13 was stopped, so this can't start; retry to start it anyway or stop it");
});

// Dependants share one fetch per tick, not one each under the sprint lock (up to two minutes each).
test('dependants starting in one tick share one fetch of the base, and one failed fetch parks them all', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ write: 'b.txt', ms: 500 }, { write: 'c.txt', ms: 500 }]);
  scriptAgent(root, 'fr', []);
  const tickets = [T(), T({ key: 'ABC-12', title: 'Signup', after: ['ABC-11'] }), T({ key: 'ABC-13', title: 'Export', after: ['ABC-11'] })];
  const s0 = await createSprint(root, { name: 'x', tickets }, { cwd: w.repo });
  const raw = loadSprint(root, s0.id);
  raw.tickets[0].state = 'merged';
  saveSprint(root, raw);
  const ahead = remoteAhead(w, 'theirs.txt');
  let fetches = 0;
  const fetchFn = (...a) => { fetches += 1; return fetchBase(...a); };
  const s1 = await tick(root, s0.id, { env: w.env, fetchFn });
  assert.deepEqual(s1.tickets.slice(1).map((t) => t.state), ['running', 'running']);
  assert.equal(fetches, 1);
  for (const t of s1.tickets.slice(1)) assert.equal(jobOf(root, t.job).baseCommit, ahead);

  const { root: root2, w: w2 } = sprintWorld();
  scriptAgent(root2, 'fa', []);
  scriptAgent(root2, 'fr', []);
  const d0 = await createSprint(root2, { name: 'y', tickets }, { cwd: w2.repo });
  const raw2 = loadSprint(root2, d0.id);
  raw2.tickets[0].state = 'merged';
  saveSprint(root2, raw2);
  w2.git(w2.repo, 'remote', 'set-url', 'origin', path.join(tempRoot(), 'gone.git'));
  fetches = 0;
  const d1 = await tick(root2, d0.id, { env: w2.env, fetchFn });
  assert.deepEqual(d1.tickets.slice(1).map((t) => t.state), ['parked', 'parked']);
  assert.equal(fetches, 1, 'the failure is not tried again for the second dependant');
  assert.match(d1.tickets[2].reason, /^Podium couldn't get the latest main from origin, so ABC-13 can't start yet\./);
});

// A merge from the pane or the tool, or a refresh that finds one, asks for a runner, so a dependant doesn't wait for
// the pane's minute check.
async function prOpenWorld() {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ write: 'a.txt' }, { write: 'b.txt' }]);
  scriptAgent(root, 'fr', [{ say: 'VERDICT: pass' }, { say: 'VERDICT: pass' }]);
  const s0 = await createSprint(root, { name: 'x', tickets: [T(), T({ key: 'ABC-12', title: 'Signup', after: ['ABC-11'] })] }, { cwd: w.repo });
  const s1 = await run(root, s0.id, w.env, (s) => s.tickets[0].state === 'pr-open');
  const answer = (response) => {
    const spec = JSON.parse(fs.readFileSync(w.env.PODIUM_FAKE_GH, 'utf8'));
    spec.responses.unshift(response);
    fs.writeFileSync(w.env.PODIUM_FAKE_GH, JSON.stringify(spec));
  };
  const ghCli = async (argv, spawned) => {
    let out = '';
    const stdout = new Writable({ write(c, _e, cb) { out += c; cb(); } });
    const code = await main(argv, { stdout, env: { ...w.env, PODIUM_DATA_DIR: root }, spawn: (_f, args) => spawned.push(args) });
    return { code, body: JSON.parse(out) };
  };
  return { root, id: s0.id, latest: s1.tickets[0].latest, answer, ghCli };
}

test('podium pr merge of a sprint ticket\'s PR asks for a runner, so its dependant starts soon', async () => {
  const { root, id, latest, answer, ghCli } = await prOpenWorld();
  answer({ match: ['pr', 'merge'], stdout: '' });
  const spawned = [];
  const r = await ghCli(['pr', 'merge', '--id', latest], spawned);
  assert.equal(r.code, 0);
  assert.equal(r.body.job.status, 'merged');
  assert.deepEqual(spawned, [[root, id]]);
});

test('podium pr refresh that finds the PR merged asks for a runner; one that finds it open does not', async () => {
  const { root, id, latest, answer, ghCli } = await prOpenWorld();
  const view = (state) => ({ match: ['pr', 'view'], stdout: { state, mergeable: 'MERGEABLE', reviewDecision: '', statusCheckRollup: [], comments: [], reviews: [] } });
  answer(view('OPEN'));
  const spawned = [];
  const open = await ghCli(['pr', 'refresh', '--id', latest], spawned);
  assert.equal(open.code, 0, JSON.stringify(open.body));
  assert.deepEqual(spawned, []);
  answer({ ...view('MERGED'), stdout: { ...view('MERGED').stdout, mergeCommit: { oid: 'abc123' } } });
  const r = await ghCli(['pr', 'refresh', '--id', latest], spawned);
  assert.equal(r.body.job.status, 'merged');
  assert.equal(r.body.job.pr.mergeCommit, 'abc123', 'the merge commit is recorded, for its dependants\' fetch');
  assert.deepEqual(spawned, [[root, id]]);
});

// A tick fetched the base once and reused it, so a dependency that merged after that fetch let its dependant
// start from a base without the dependency's code. Which tickets may start is decided before the fetch; one whose
// dependency merges after it waits for the next tick, which fetches again.
test('a dependency that merges after the tick has fetched lets its dependant start only on the next tick, with its code', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ write: 'a.txt' }, { write: 'a2.txt' }, { write: 'c.txt', ms: 500 }, { write: 'b.txt', ms: 500 }]);
  scriptAgent(root, 'fr', [{ say: 'VERDICT: pass' }, { say: 'VERDICT: pass' }]);
  const s0 = await createSprint(root, { name: 'x', tickets: [T(), T({ key: 'ABC-12', title: 'Signup', after: ['ABC-11'] })] }, { cwd: w.repo });
  await run(root, s0.id, w.env, (s) => s.tickets[0].state === 'pr-open');
  // Two more tickets: ABC-10 has merged already, and ABC-13 waits for it, so this tick fetches for ABC-13 first.
  const raw = loadSprint(root, s0.id);
  const pending = raw.tickets[1];
  raw.tickets = [raw.tickets[0], { ...structuredClone(pending), key: 'ABC-10', title: 'Schema', after: [], state: 'merged' },
    { ...structuredClone(pending), key: 'ABC-13', title: 'Export', after: ['ABC-10'] }, pending];
  saveSprint(root, raw);
  const latest = raw.tickets[0].latest;
  let fetches = 0;
  // ABC-11's PR merges on GitHub just after the fetch, and the PR watcher records it.
  const fetchFn = async (...a) => {
    const ref = await fetchBase(...a);
    if (++fetches === 1) {
      w.git(w.remote, 'update-ref', 'refs/heads/main', 'refs/heads/feat/abc-11-login-form');
      updateJob(root, findJobDir(root, latest), { status: 'merged' });
    }
    return ref;
  };
  const s1 = await tick(root, s0.id, { env: w.env, fetchFn });
  const byKey = (s, k) => s.tickets.find((t) => t.key === k);
  assert.equal(byKey(s1, 'ABC-13').state, 'running');
  assert.equal(byKey(s1, 'ABC-12').state, 'pending', 'its dependency merged after the fetch: it waits for the next one');
  assert.deepEqual(authorsOf(root, 'ABC-12'), []);
  const s2 = await tick(root, s0.id, { env: w.env, fetchFn });
  assert.equal(byKey(s2, 'ABC-12').state, 'running');
  const job = jobOf(root, byKey(s2, 'ABC-12').job);
  assert.equal(job.baseCommit, w.git(w.remote, 'rev-parse', 'main'));
  assert.ok(fs.existsSync(path.join(job.worktree, 'a.txt')), 'it holds ABC-11\'s merged work');
});

// When the dependency's merge commit is known, the fetched base must contain it; GitHub may say merged before
// the fetch sees the commit. The dependant waits (not parks) until a fetch has it.
test('a dependant waits while the fetched base lacks its dependency\'s recorded merge commit', async () => {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ write: 'a.txt' }, { write: 'a2.txt' }, { write: 'b.txt', ms: 500 }]);
  scriptAgent(root, 'fr', [{ say: 'VERDICT: pass' }, { say: 'VERDICT: pass' }]);
  const s0 = await createSprint(root, { name: 'x', tickets: [T(), T({ key: 'ABC-12', title: 'Signup', after: ['ABC-11'] })] }, { cwd: w.repo });
  const s1 = await run(root, s0.id, w.env, (s) => s.tickets[0].state === 'pr-open');
  const head = w.git(w.remote, 'rev-parse', 'refs/heads/feat/abc-11-login-form');
  const dir = findJobDir(root, s1.tickets[0].latest);
  updateJob(root, dir, { status: 'merged', pr: { ...readJob(dir).pr, state: 'MERGED', mergeCommit: head } });
  const s2 = await tick(root, s0.id, { env: w.env });
  assert.equal(s2.tickets[1].state, 'pending', 'the fetched main does not have the merge yet');
  assert.equal(s2.tickets[1].reason, null);
  assert.deepEqual(authorsOf(root, 'ABC-12'), []);
  assert.equal(wantsRunner(root, s2), true, 'the runner tries again');
  w.git(w.remote, 'update-ref', 'refs/heads/main', head);
  const s3 = await tick(root, s0.id, { env: w.env });
  assert.equal(s3.tickets[1].state, 'running');
  assert.equal(jobOf(root, s3.tickets[1].job).baseCommit, head);
});

// A refresh that found the PR closed woke no runner, and a closed PR drops out of the watcher's checks, so its
// dependant never parked. A refresh that records a merge or a close asks for a runner.
test('podium pr refresh that finds the PR closed asks for a runner, so its dependant parks soon', async () => {
  const { root, id, latest, answer, ghCli } = await prOpenWorld();
  answer({ match: ['pr', 'view'], stdout: { state: 'CLOSED', mergeable: 'MERGEABLE', reviewDecision: '', statusCheckRollup: [], comments: [], reviews: [] } });
  const spawned = [];
  const r = await ghCli(['pr', 'refresh', '--id', latest], spawned);
  assert.equal(r.body.job.status, 'closed');
  assert.deepEqual(spawned, [[root, id]]);
  const s = await tick(root, id, {});
  assert.equal(s.tickets[1].state, 'parked');
});
