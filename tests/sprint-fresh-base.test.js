// Start fetches the base, refuses one that trails its remote or lacks a ticket's plan, and pins the commit copies start from.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { draftSprint, startSprint, loadSprint, sprintSummary, tick } from '../engine/sprint.js';
import { readJob, findJobDir } from '../engine/store.js';
import { fetchBase } from '../engine/worktree.js';
import { scriptAgent, sprintWorld, tempRoot, tempRepo, PLAN } from './helpers.js';

const T = (over = {}) => ({ key: 'ABC-11', title: 'Login form', type: 'feat', plan: 'docs/plan.md', agent: 'fa', reviewer: 'fr', ...over });

function agents(root) {
  scriptAgent(root, 'fa', [{ write: 'a.txt' }]);
  scriptAgent(root, 'fr', [{ say: 'VERDICT: pass' }]);
}

function world() {
  const { root, w } = sprintWorld();
  agents(root);
  return { root, w };
}

// A commit on origin's main made from a second clone, so the world's local main trails it.
function pushFromElsewhere(w, name) {
  const other = path.join(tempRoot(), 'other');
  w.git(path.dirname(other), 'clone', '-q', w.remote, other);
  fs.writeFileSync(path.join(other, name), `${name}\n`);
  w.git(other, 'add', '-A');
  w.git(other, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', name);
  w.git(other, 'push', '-q', 'origin', 'main');
}

const commitHere = (w, name) => {
  fs.writeFileSync(path.join(w.repo, name), `${name}\n`);
  w.git(w.repo, 'add', '-A');
  w.git(w.repo, 'commit', '-q', '-m', name);
};

test('Start refuses a local base behind its remote and stays a draft; updated, it starts from the checked commit', async () => {
  const { root, w } = world();
  const d = await draftSprint(root, { name: 'Oct', tickets: [T()] }, { cwd: w.repo });
  assert.equal('startedFrom' in sprintSummary(root, d), false, 'a draft names no commit');
  pushFromElsewhere(w, 'theirs.txt');
  await assert.rejects(startSprint(root, d.id), (e) => e.code === 'base-behind'
    && e.message === "Your local main is 1 commit behind origin/main, so the sprint's copies would start without them. Update main (for example, git pull in its checkout) and press Start again.");
  assert.equal(loadSprint(root, d.id).draft, true);
  w.git(w.repo, 'merge', '-q', '--no-edit', 'origin/main');
  const s = await startSprint(root, d.id);
  const local = w.git(w.repo, 'rev-parse', 'main');
  assert.deepEqual(s.startedFrom, { commit: local, remote: 'origin', checked: true });
  assert.deepEqual(sprintSummary(root, s).startedFrom, { commit: local, remote: 'origin', checked: true });
});

test('Start refuses a plan that is not committed on the base, and a ticket without a plan is not checked', async () => {
  const { root, w } = world();
  fs.writeFileSync(path.join(w.repo, 'docs', 'new.md'), PLAN);
  const d = await draftSprint(root, { name: 'Oct', tickets: [T({ plan: 'docs/new.md' }), T({ key: 'ABC-12', title: 'Payouts' })] }, { cwd: w.repo });
  const short = w.git(w.repo, 'rev-parse', 'main').slice(0, 7);
  await assert.rejects(startSprint(root, d.id), (e) => e.code === 'plan-not-at-base'
    && e.message === `Plans not in main at ${short}, the commit the sprint's copies start from: ABC-11 (docs/new.md). Commit them to main and press Start again.`);
  assert.equal(loadSprint(root, d.id).draft, true);
  const planless = await draftSprint(root, { name: 'Nov', tickets: [T({ key: 'ABC-13', title: 'Export', plan: undefined })] }, { cwd: w.repo });
  const s = await startSprint(root, planless.id);
  assert.equal(s.draft, false);
});

test('a remote that cannot be reached never refuses Start; a repo with no remote starts unchecked', async () => {
  const { root, w } = world();
  const d = await draftSprint(root, { name: 'Oct', tickets: [T()] }, { cwd: w.repo });
  const fetchFn = async () => { throw Object.assign(new Error('git fetch: unable to access'), { remote: 'origin' }); };
  const s = await startSprint(root, d.id, { fetchFn });
  assert.deepEqual(s.startedFrom, { commit: w.git(w.repo, 'rev-parse', 'main'), remote: 'origin', checked: false, fetchError: 'unable to access' });
  assert.deepEqual(sprintSummary(root, s).startedFrom, { commit: s.startedFrom.commit, remote: 'origin', checked: false });

  const root2 = tempRoot();
  agents(root2);
  const repo = tempRepo();
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim();
  fs.mkdirSync(path.join(repo, 'docs'));
  fs.writeFileSync(path.join(repo, 'docs', 'plan.md'), PLAN);
  git('add', '-A');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'plan');
  const d2 = await draftSprint(root2, { name: 'Oct', tickets: [T()] }, { cwd: repo });
  const s2 = await startSprint(root2, d2.id);
  assert.deepEqual(s2.startedFrom, { commit: git('rev-parse', 'main'), remote: null, checked: false });
});

test('a remote that never answers ends the fetch at its limit, and Start still starts from the local base', async () => {
  const { root, w } = world();
  const d = await draftSprint(root, { name: 'Oct', tickets: [T()] }, { cwd: w.repo });
  w.git(w.repo, 'config', 'protocol.ext.allow', 'always');
  w.git(w.repo, 'remote', 'set-url', 'origin', 'ext::node -e setTimeout(()=>{},20000)');
  const t0 = Date.now();
  // The freshness fetch's own limit, shortened for the test.
  const s = await startSprint(root, d.id, { fetchFn: (r, b) => fetchBase(r, b, { timeoutMs: 2000 }) });
  // The fetch's wording depends on the machine (a loaded one can end the helper before the limit): only the outcome counts.
  assert.ok(Date.now() - t0 < 2000 + 20_000, `Start took ${Date.now() - t0} ms`);
  assert.equal(s.draft, false);
  const { fetchError, ...rest } = s.startedFrom;
  assert.deepEqual(rest, { commit: w.git(w.repo, 'rev-parse', 'main'), remote: 'origin', checked: false });
  assert.ok(fetchError, 'the fetch failed');
});

test('a ticket without "after" is cut from the commit Start checked, not from a later local base', async () => {
  const { root, w } = world();
  const d = await draftSprint(root, { name: 'Oct', tickets: [T()] }, { cwd: w.repo });
  const s = await startSprint(root, d.id);
  commitHere(w, 'later.txt');
  const ticked = await tick(root, d.id, { env: w.env });
  const t = ticked.tickets[0];
  assert.equal(t.state, 'running');
  const job = readJob(findJobDir(root, t.latest));
  assert.equal(job.baseCommit, s.startedFrom.commit);
  assert.notEqual(job.baseCommit, w.git(w.repo, 'rev-parse', 'main'));
  assert.equal(fs.existsSync(path.join(job.worktree, 'later.txt')), false);
});
