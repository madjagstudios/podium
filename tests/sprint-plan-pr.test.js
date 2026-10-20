// A ticket's plan stays in Podium's record (its copy's history, the board) but leaves its PR, unless the repo keeps it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createSprint, tick, sprintSummary, retryTicket, approvePlan } from '../engine/sprint.js';
import { listJobDirs, readJob } from '../engine/store.js';
import { setSetting } from '../engine/settings.js';
import { projectKey } from '../engine/paths.js';
import { waitFor, scriptAgent, sprintWorld } from './helpers.js';

const NOW = Date.parse('2026-10-07T10:00:00Z');
const FILE = 'docs/plans/2026-10-07-abc-14-export-to-csv.md';
const OWN = 'docs/custom/plans/2026-10-07-abc-14-export-to-csv.md';
const BRANCH = 'feat/abc-14-export-to-csv';
const PLAN2 = '# Export to CSV\n\n### Task 1: Add the export button\nAdd it.\n\n### Task 2: Write the CSV\nWrite it.\n';
const P = (over = {}) => ({ key: 'ABC-14', title: 'Export to CSV', type: 'feat', agent: 'fa', reviewer: 'fr', summary: 'Users want their payouts as CSV.', ...over });
// Tick until `until(sprint)` holds, at a fixed clock (the plan's file name carries the day it was started).
const run = (root, id, env, until) => waitFor(async () => {
  const s = await tick(root, id, { env, now: NOW });
  return until(s) ? s : null;
}, { timeoutMs: 90_000, intervalMs: 150 });
const stateIs = (...states) => (s) => states.includes(s.tickets[0].state);
const jobsBy = (root, role) => listJobDirs(root).map(readJob).filter((j) => j.sprint?.role === role).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
// The files the PR changes: the remote branch against the base it was made from.
const prFiles = (w, branch) => w.git(w.remote, 'diff', '--name-only', w.git(w.repo, 'rev-parse', 'main'), branch).split('\n').filter(Boolean).sort();
const subjects = (w, branch) => w.git(w.remote, 'log', '--format=%s', `${w.git(w.repo, 'rev-parse', 'main')}..${branch}`).split('\n');

// Make gh's answer to "pr create" fail (or succeed again) between ticks: the fake reads its spec file on every call.
const ghCreate = (w, response) => {
  const file = w.env.PODIUM_FAKE_GH;
  const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
  spec.responses = [{ match: ['pr', 'create'], ...response }];
  fs.writeFileSync(file, JSON.stringify(spec));
};

// A ticket planned by its writer, approved, and worked to its PR (or until `until`).
async function planned({ plan = FILE, settings = (_root, _project) => {}, until = stateIs('pr-open'), before = () => {} } = {}) {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ write: plan, content: PLAN2 }, { write: 'a.txt' }, { write: 'b.txt' }]);
  scriptAgent(root, 'fr', [{ say: 'VERDICT: pass' }, { say: 'VERDICT: pass' }]);
  settings(root, projectKey(w.repo));
  before(w);
  const s0 = await createSprint(root, { name: 'Oct', tickets: [P()] }, { cwd: w.repo });
  await run(root, s0.id, w.env, stateIs('plan-ready'));
  await approvePlan(root, s0.id, 'ABC-14');
  const s = await run(root, s0.id, w.env, until);
  return { root, w, s, id: s0.id };
}

test('by default the PR leaves the plan out; its checkpoint and the board keep it', async () => {
  const { root, w, s } = await planned();
  assert.equal(s.tickets[0].state, 'pr-open', s.tickets[0].reason);
  assert.deepEqual(prFiles(w, BRANCH), ['a.txt', 'b.txt']);
  const [planJob] = jobsBy(root, 'author');
  assert.equal(w.git(planJob.worktree, 'show', `${planJob.checkpoint}:${FILE}`), PLAN2.trimEnd());
  assert.equal(sprintSummary(root, s).tickets[0].plan, FILE);
  assert.equal(fs.existsSync(path.join(planJob.worktree, FILE)), false, 'the copy no longer holds it');
});

test('a repo that keeps plans gets the plan in its PR, under its own plans folder', async () => {
  const { w, s } = await planned({
    plan: OWN,
    settings: (root, project) => {
      setSetting(root, 'repoPlanDir', { [project]: 'docs/custom/plans' });
      setSetting(root, 'repoKeepPlan', { [project]: true });
    },
  });
  assert.equal(s.tickets[0].state, 'pr-open', s.tickets[0].reason);
  const files = prFiles(w, BRANCH);
  assert.deepEqual(files, ['a.txt', 'b.txt', OWN]);
  assert.ok(!files.some((f) => f.startsWith('docs/plans/')));
});

test('with the ticket\'s commits kept, the plan leaves the final diff in a commit of its own', async () => {
  const { w, s } = await planned({ settings: (root, project) => setSetting(root, 'repoSquash', { [project]: false }) });
  assert.equal(s.tickets[0].state, 'pr-open', s.tickets[0].reason);
  assert.deepEqual(prFiles(w, BRANCH), ['a.txt', 'b.txt']);
  const log = subjects(w, BRANCH);
  assert.equal(log[0], 'wip(ABC-14): leave the plan out of the PR');
  assert.ok(log.includes('wip(ABC-14): plan'), 'the history still has the plan');
});

test('a retried PR with commits kept and a full check is not stopped by Podium\'s own leave-out commit', async () => {
  const { root, w, s: parked, id } = await planned({
    settings: (root, project) => {
      setSetting(root, 'repoSquash', { [project]: false });
      setSetting(root, 'repoCheck', { [project]: 'node -e ""' });
    },
    before: (w) => ghCreate(w, { code: 1, stderr: 'GitHub is down' }),
    until: stateIs('parked', 'pr-open'),
  });
  assert.equal(parked.tickets[0].state, 'parked');
  assert.match(parked.tickets[0].reason, /GitHub is down/);
  ghCreate(w, { stdout: 'https://github.com/o/r/pull/12\n' });
  retryTicket(root, id, 'ABC-14');
  const s = await run(root, id, w.env, stateIs('parked', 'pr-open'));
  assert.equal(s.tickets[0].state, 'pr-open', s.tickets[0].reason);
  assert.deepEqual(prFiles(w, BRANCH), ['a.txt', 'b.txt']);
  assert.equal(subjects(w, BRANCH).filter((x) => x === 'wip(ABC-14): leave the plan out of the PR').length, 1);
});

// The plan's path as given, or spelled with "./" and "x/../" parts that git itself would not name it by, or (where the
// file system ignores case, as on Windows and macOS) in other letters' case.
const caseBlind = fs.existsSync(path.resolve('PACKAGE.JSON'));
for (const plan of ['docs/plan.md', 'docs/./plan.md', './docs/x/../plan.md', 'DOCS/Plan.MD']) {
  const skip = plan === 'DOCS/Plan.MD' && !caseBlind ? 'this file system tells letter case apart' : false;
  test(`a plan the base already has is never deleted by the PR (given as ${plan})`, { skip }, async () => {
    const { root, w } = sprintWorld();
    scriptAgent(root, 'fa', [{ write: 'a.txt', say: 'did a' }, { write: 'b.txt', say: 'did b' }]);
    scriptAgent(root, 'fr', [{ say: 'VERDICT: pass' }, { say: 'VERDICT: pass' }]);
    const s0 = await createSprint(root, { name: 'x', tickets: [{ key: 'ABC-11', title: 'Login form', type: 'feat', plan, agent: 'fa', reviewer: 'fr', summary: 'People sign in with their email.' }] }, { cwd: w.repo });
    const s = await run(root, s0.id, w.env, stateIs('pr-open', 'parked'));
    assert.equal(s.tickets[0].state, 'pr-open', s.tickets[0].reason);
    const files = prFiles(w, 'feat/abc-11-login-form');
    assert.ok(!files.includes('docs/plan.md'), files.join(', '));
    assert.ok(w.git(w.remote, 'show', 'feat/abc-11-login-form:docs/plan.md'));
  });
}
