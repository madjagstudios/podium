// A sprint ticket's PR: a plain body, a title Windows can pass, and one clean commit.
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createSprint, tick, retryTicket, loadSprint, saveSprint, locked } from '../engine/sprint.js';
import { listJobDirs, readJob, updateJob } from '../engine/store.js';
import { setSetting } from '../engine/settings.js';
import { projectKey } from '../engine/paths.js';
import { waitFor, scriptAgent, sprintWorld, tempRoot, tempRepo } from './helpers.js';

const T = (over = {}) => ({ key: 'ABC-11', title: 'Login form', type: 'feat', plan: 'docs/plan.md', agent: 'fa', reviewer: 'fr', summary: 'People sign in with their email.', ...over });
const run = (root, id, env, until) => waitFor(async () => { const s = await tick(root, id, { env }); return until(s) ? s : null; }, { timeoutMs: 90_000, intervalMs: 150 });
const created = (w) => w.calls().find((c) => c[0] === 'pr' && c[1] === 'create');
const copyOf = (root, s) => readJob(listJobDirs(root).find((d) => d.endsWith(s.tickets[0].latest))).worktree;
const BODY = 'People sign in with their email.\n\nChanges:\n- Add a.txt\n- Add b.txt';

function world() {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ write: 'a.txt', say: 'did a' }, { write: 'b.txt', say: 'did b' }]);
  scriptAgent(root, 'fr', [{ say: 'VERDICT: pass' }, { say: 'VERDICT: pass' }]);
  return { root, w };
}

test('a sprint PR\'s body is the ticket\'s text and task titles, with no steps section, agent names or step numbers added', async () => {
  const { root, w } = world();
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'pr-open');
  const create = created(w);
  const body = create[create.indexOf('--body-text') + 1];
  assert.equal(body, BODY);
  for (const bad of [/## Steps/, /\bcodex\b|\bclaude\b/i, /\b(Task|Step|Phase)\s+\d+\b/]) assert.doesNotMatch(body, bad);
});

test('a ticket titled with quotes reaches its PR, with a title Windows can pass', async () => {
  const { root, w } = world();
  const s0 = await createSprint(root, { name: 'x', tickets: [T({ title: 'Callable reports "no usable" & 100%' })] }, { cwd: w.repo });
  const s = await run(root, s0.id, w.env, (x) => ['pr-open', 'parked'].includes(x.tickets[0].state));
  assert.equal(s.tickets[0].state, 'pr-open', s.tickets[0].reason);
  const create = created(w);
  assert.equal(create[create.indexOf('--title') + 1], "ABC-11: Callable reports 'no usable' 100");
});

test('the PR has one commit named for the ticket, whose body is the PR body; the checkpoints stay readable', async () => {
  const { root, w } = world();
  const s0 = await createSprint(root, { name: 'x', tickets: [T({ title: 'Login "form"' })] }, { cwd: w.repo });
  const s = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'pr-open');
  const copy = copyOf(root, s);
  assert.deepEqual(w.git(copy, 'log', 'main..HEAD', '--format=%s').split('\n'), ['ABC-11: Login "form"']);
  assert.equal(w.git(copy, 'log', '-1', '--format=%b'), BODY);
  assert.deepEqual(w.git(w.remote, 'log', `${w.git(w.repo, 'rev-parse', 'main')}..feat/abc-11-login-form`, '--format=%s').split('\n'), ['ABC-11: Login "form"']);
  // Steps and diff read each step's checkpoint, which is still in the copy.
  const checkpointed = listJobDirs(root).map(readJob).filter((j) => j.sprint?.role === 'author' && j.checkpoint);
  assert.equal(checkpointed.length, 2);
  for (const j of checkpointed) assert.match(w.git(copy, 'log', '-1', '--format=%s', j.checkpoint), /^wip\(ABC-11\): task \d/);
  // The PR title is sanitized for gh's command line; the commit keeps the title as drafted.
  const create = created(w);
  assert.equal(create[create.indexOf('--title') + 1], "ABC-11: Login 'form'");
});

test('with repoSquash off, the PR keeps the ticket\'s checkpoints', async () => {
  const { root, w } = world();
  setSetting(root, 'repoSquash', { [projectKey(w.repo)]: false });
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  const s = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'pr-open');
  assert.deepEqual(w.git(copyOf(root, s), 'log', 'main..HEAD', '--format=%s').split('\n'), ['wip(ABC-11): task 2 Add b.txt', 'wip(ABC-11): task 1 Add a.txt']);
});

// Make gh's answer to "pr create" fail (or succeed again) between ticks: the fake reads its spec file on every call.
const ghCreate = (w, response) => {
  const file = w.env.PODIUM_FAKE_GH;
  const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
  spec.responses = [{ match: ['pr', 'create'], ...response }];
  fs.writeFileSync(file, JSON.stringify(spec));
};
const parkedOnPr = (x) => x.tickets[0].state === 'parked';
const BRANCH = 'feat/abc-11-login-form';

test('a PR that failed after the push is retried: the branch is squashed again and replaced, still one commit', async () => {
  const { root, w } = world();
  ghCreate(w, { code: 1, stderr: 'GitHub is down' });
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  const parked = await run(root, s0.id, w.env, parkedOnPr);
  assert.match(parked.tickets[0].reason, /GitHub is down/);
  const main = w.git(w.repo, 'rev-parse', 'main');
  assert.deepEqual(w.git(w.remote, 'log', `${main}..${BRANCH}`, '--format=%s').split('\n'), ['ABC-11: Login form'], 'the first push is already squashed');
  ghCreate(w, { stdout: 'https://github.com/o/r/pull/12\n' });
  retryTicket(root, s0.id, 'ABC-11');
  const s = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'pr-open');
  assert.equal(s.tickets[0].pr.number, 12);
  assert.deepEqual(w.git(w.remote, 'log', `${main}..${BRANCH}`, '--format=%s').split('\n'), ['ABC-11: Login form']);
  assert.equal(w.git(copyOf(root, s), 'rev-parse', 'HEAD'), w.git(w.remote, 'rev-parse', BRANCH), 'the remote holds what the copy holds');
});

// Someone else's branch of that name on the remote, with a commit Podium has never seen. Returns its commit.
function foreignBranch(w) {
  const other = tempRoot();
  w.git(other, 'clone', '-q', w.remote, 'other');
  const clone = path.join(other, 'other');
  w.git(clone, 'config', 'user.email', 'o@example.com');
  w.git(clone, 'config', 'user.name', 'Other');
  w.git(clone, 'switch', '-q', '-c', BRANCH);
  fs.writeFileSync(path.join(clone, 'theirs.txt'), 'not ours');
  w.git(clone, 'add', '-A');
  w.git(clone, 'commit', '-q', '-m', 'their work');
  w.git(clone, 'push', '-q', 'origin', BRANCH);
  return w.git(w.remote, 'rev-parse', BRANCH);
}

test('a branch of that name that Podium did not push is refused, not overwritten', async () => {
  const { root, w } = world();
  const theirs = foreignBranch(w);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  const s = await run(root, s0.id, w.env, parkedOnPr);
  assert.match(s.tickets[0].reason, /^Podium couldn't open the PR: git push:/);
  assert.equal(w.git(w.remote, 'rev-parse', BRANCH), theirs, 'their branch is untouched');
  assert.equal(created(w), undefined, 'no PR was created');
});

test('a foreign branch the person has already fetched is refused too: the lease expects only Podium\'s own push', async () => {
  const { root, w } = world();
  const theirs = foreignBranch(w);
  // The person's repo (whose remote-tracking refs the ticket's copy shares) fetched it, by hand or by an editor's autofetch.
  w.git(w.repo, 'fetch', '-q', 'origin');
  assert.equal(w.git(w.repo, 'rev-parse', `origin/${BRANCH}`), theirs);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  const s = await run(root, s0.id, w.env, parkedOnPr);
  assert.match(s.tickets[0].reason, /^Podium couldn't open the PR: git push:/);
  assert.equal(w.git(w.remote, 'rev-parse', BRANCH), theirs, 'their branch is untouched');
  assert.equal(created(w), undefined, 'no PR was created');
});

// A foreign commit made exactly as Podium's squash would be (built on the ticket's start commit,
// subject `KEY: title`) and fetched into the person's repo must not become the lease. Ownership is only ever the branch and
// commit Podium recorded pushing (t.pushed), never what a commit looks like.
test('a fetched foreign commit with the ticket\'s start commit as parent and its KEY: title subject is refused and untouched', async () => {
  const { root, w } = world();
  // The remote's main is the ticket's start commit, so the foreign commit can be built on it.
  w.git(w.repo, 'push', '-q', 'origin', 'main');
  const start = w.git(w.repo, 'rev-parse', 'main');
  const other = tempRoot();
  w.git(other, 'clone', '-q', w.remote, 'other');
  const clone = path.join(other, 'other');
  w.git(clone, 'config', 'user.email', 'o@example.com');
  w.git(clone, 'config', 'user.name', 'Other');
  w.git(clone, 'switch', '-q', '-c', BRANCH);
  fs.writeFileSync(path.join(clone, 'theirs.txt'), 'not ours');
  w.git(clone, 'add', '-A');
  w.git(clone, 'commit', '-q', '-m', 'ABC-11: Login form');
  w.git(clone, 'push', '-q', 'origin', BRANCH);
  const theirs = w.git(w.remote, 'rev-parse', BRANCH);
  assert.equal(w.git(w.remote, 'rev-parse', `${theirs}^`), start, 'built on the ticket\'s start commit');
  w.git(w.repo, 'fetch', '-q', 'origin');
  assert.equal(w.git(w.repo, 'rev-parse', `origin/${BRANCH}`), theirs);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  const s = await run(root, s0.id, w.env, parkedOnPr);
  assert.equal(s.tickets[0].from, start);
  assert.match(s.tickets[0].reason, /^Podium couldn't open the PR: git push:/);
  assert.equal(w.git(w.remote, 'rev-parse', BRANCH), theirs, 'their branch is untouched');
  assert.equal(w.git(w.remote, 'log', '-1', '--format=%s', BRANCH), 'ABC-11: Login form');
  assert.equal(created(w), undefined, 'no PR was created');
});

test('the ticket records the branch and commit Podium pushed, saved before the push, and a retry leases against it', async () => {
  const { root, w } = world();
  ghCreate(w, { code: 1, stderr: 'GitHub is down' });
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  const parked = await run(root, s0.id, w.env, parkedOnPr);
  const pushed = parked.tickets[0].pushed;
  assert.deepEqual(pushed, { branch: BRANCH, sha: w.git(w.remote, 'rev-parse', BRANCH) });
  // Saved with the sprint's state (a crash after the push still has it).
  assert.deepEqual(loadSprint(root, s0.id).tickets[0].pushed, pushed);
  ghCreate(w, { stdout: 'https://github.com/o/r/pull/12\n' });
  retryTicket(root, s0.id, 'ABC-11');
  const s = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'pr-open');
  assert.equal(s.tickets[0].pr.number, 12);
  assert.deepEqual(s.tickets[0].pushed, { branch: BRANCH, sha: w.git(w.remote, 'rev-parse', BRANCH) });
});

test('a recorded push of another branch is not a lease for this one', async () => {
  const { root, w } = world();
  ghCreate(w, { code: 1, stderr: 'GitHub is down' });
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  await run(root, s0.id, w.env, parkedOnPr);
  // Podium's record names a different branch: the commit on this one is not known to be Podium's, so it is not replaced.
  await locked(root, s0.id, ({ token }) => {
    const sprint = loadSprint(root, s0.id);
    sprint.tickets[0].pushed = { branch: 'feat/something-else', sha: sprint.tickets[0].pushed.sha };
    saveSprint(root, sprint, { token });
  });
  const before = w.git(w.remote, 'rev-parse', BRANCH);
  // Make the copy's next squash differ, so the push would have to replace the remote's commit.
  const copy = copyOf(root, loadSprint(root, s0.id));
  fs.writeFileSync(path.join(copy, 'c.txt'), 'more');
  w.git(copy, 'add', '-A');
  w.git(copy, 'commit', '-q', '-m', 'wip(ABC-11): more');
  ghCreate(w, { stdout: 'https://github.com/o/r/pull/12\n' });
  retryTicket(root, s0.id, 'ABC-11');
  const s = await run(root, s0.id, w.env, parkedOnPr);
  assert.match(s.tickets[0].reason, /^Podium couldn't open the PR: git push:/);
  assert.equal(w.git(w.remote, 'rev-parse', BRANCH), before, 'the remote branch is untouched');
});

test('the squashed commit\'s message is the PR body exactly, with no whitespace tidying', async () => {
  const { root, w } = world();
  const summary = 'First line  \n\n\n\nSecond line';
  const s0 = await createSprint(root, { name: 'x', tickets: [T({ summary })] }, { cwd: w.repo });
  const s = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'pr-open');
  const body = `${summary}\n\nChanges:\n- Add a.txt\n- Add b.txt`;
  assert.equal(w.git(copyOf(root, s), 'log', '-1', '--format=%B'), `ABC-11: Login form\n\n${body}`);
  const create = created(w);
  assert.equal(create[create.indexOf('--body-text') + 1], body);
});

test('a ticket whose copy is gone is parked with a plain reason, and no git command runs outside a copy', async () => {
  const { root, w } = world();
  ghCreate(w, { code: 1, stderr: 'GitHub is down' });
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  const first = await run(root, s0.id, w.env, parkedOnPr);
  // The latest step no longer has a copy (as when its PR was merged or closed).
  const dir = listJobDirs(root).find((d) => d.endsWith(first.tickets[0].latest));
  updateJob(root, dir, { worktree: null });
  // A regression would run git in the process's own folder: make that a throwaway repo, never the developer's checkout.
  const stray = tempRepo();
  fs.writeFileSync(path.join(stray, 'unsaved.txt'), 'work in progress');
  const state = (repo) => [w.git(repo, 'rev-parse', 'HEAD'), w.git(repo, 'status', '--porcelain'), w.git(repo, 'diff', '--cached', '--name-only')];
  const [strayBefore, mineBefore] = [state(stray), state(w.repo)];
  const cwd = process.cwd();
  process.chdir(stray);
  try {
    retryTicket(root, s0.id, 'ABC-11');
    const s = await run(root, s0.id, w.env, parkedOnPr);
    assert.equal(s.tickets[0].reason, 'Only work with changes waiting for review can become a PR.');
  } finally {
    process.chdir(cwd);
  }
  assert.deepEqual(state(stray), strayBefore, 'the process\'s own folder is unchanged and nothing in it is staged');
  assert.deepEqual(state(w.repo), mineBefore, 'so is the person\'s');
});
