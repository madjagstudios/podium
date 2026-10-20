// Sync with base: the base as the remote has it now, merged into a ticket's copy between its steps.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createSprint, tick, syncTicket, answerCommits, retryTicket, revisePlan, sprintSummary, loadSprint } from '../engine/sprint.js';
import { listJobDirs, readJob, findJobDir } from '../engine/store.js';
import { setSetting } from '../engine/settings.js';
import { projectKey } from '../engine/paths.js';
import { waitFor, scriptAgent, sprintWorld, tempRoot } from './helpers.js';

const T = (over = {}) => ({ key: 'ABC-11', title: 'Login form', type: 'feat', plan: 'docs/plan.md', agent: 'fa', reviewer: 'fr', ...over });
const NOW = Date.parse('2026-10-07T10:00:00Z');
const run = (root, id, env, until, now = () => Date.now()) => waitFor(async () => { const s = await tick(root, id, { env, now: now() }); return until(s) ? s : null; }, { timeoutMs: 90_000, intervalMs: 150 });
const jobsBy = (root, role) => listJobDirs(root).map(readJob).filter((j) => j.sprint?.role === role).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
const copyOf = (root, t) => readJob(findJobDir(root, t.latest)).worktree;
const node = `"${process.execPath}"`;
// A check that passes only once the base's fix is in the copy.
const NEEDS_FIX = `${node} -e "console.log('basefix.txt is missing'); process.exit(require('fs').existsSync('basefix.txt') ? 0 : 1)"`;

// A sprint world whose remote base matches the local one, with a passing reviewer for each review.
function world({ check = NEEDS_FIX, reviews = 2 } = {}) {
  const { root, w } = sprintWorld();
  if (check) setSetting(root, 'repoCheck', { [projectKey(w.repo)]: check });
  scriptAgent(root, 'fr', Array.from({ length: reviews }, () => ({ say: 'VERDICT: pass' })));
  w.git(w.repo, 'push', '-q', 'origin', 'main');
  return { root, w };
}

// A commit that lands on the base on the remote after the sprint started, made in another clone. Returns its sha.
function landOnBase(w, files) {
  const clone = tempRoot();
  w.git(clone, 'clone', '-q', '-c', 'core.autocrlf=false', w.remote, '.');
  w.git(clone, 'config', 'user.name', 'Other');
  w.git(clone, 'config', 'user.email', 'other@example.com');
  w.git(clone, 'config', 'core.autocrlf', 'false');
  // null removes the file.
  for (const [file, content] of Object.entries(files)) {
    if (content === null) { w.git(clone, 'rm', '-q', file); continue; }
    fs.mkdirSync(path.dirname(path.join(clone, file)), { recursive: true });
    fs.writeFileSync(path.join(clone, file), content);
  }
  w.git(clone, 'add', '-A');
  w.git(clone, 'commit', '-q', '-m', 'a fix on the base');
  w.git(clone, 'push', '-q', 'origin', 'HEAD:main');
  return w.git(clone, 'rev-parse', 'HEAD');
}

const shippedFiles = (w, branch) => w.git(w.remote, 'diff', '--name-only', `${branch}^`, branch).split('\n').filter(Boolean).sort();

test('a fix that lands on the base after the full check failed reaches the ticket through Sync with base, and its PR carries only its own work', async () => {
  const { root, w } = world();
  scriptAgent(root, 'fa', [{ write: 'a.txt' }, { write: 'b.txt' }]);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  const parked = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  // It fails on the base too (the fix hasn't landed yet): the base's to fix, then Sync with base.
  assert.equal(parked.tickets[0].reason, "The full check fails on main too, before this ticket's change: fix it on main, then Sync with base (Retry asks the writer to fix it here anyway)");
  assert.equal(sprintSummary(root, parked).tickets[0].canSync, true);
  const fix = landOnBase(w, { 'basefix.txt': 'fixed\n' });
  const { sprint, commits } = await syncTicket(root, s0.id, 'ABC-11');
  assert.equal(commits, 1);
  const t = sprint.tickets[0];
  assert.deepEqual([t.state, t.resume], ['waiting', 'check'], 'the full check runs again, not the writer');
  assert.match(t.reason, /^Synced with main \(1 new commit\)/);
  assert.equal(t.from, fix, "the ticket's one commit is made on the base it now has");
  assert.ok(fs.existsSync(path.join(copyOf(root, t), 'basefix.txt')));
  const s = await run(root, s0.id, w.env, (x) => ['pr-open', 'parked'].includes(x.tickets[0].state));
  assert.equal(s.tickets[0].state, 'pr-open', s.tickets[0].reason);
  assert.equal(jobsBy(root, 'author').length, 2, 'no writer was asked to fix the base');
  const { branch } = jobsBy(root, 'author')[0];
  assert.equal(w.git(w.remote, 'rev-parse', `${branch}^`), fix);
  assert.deepEqual(shippedFiles(w, branch), ['a.txt', 'b.txt']);
});

test('a base that conflicts with the ticket changes nothing and names the files', async () => {
  const { root, w } = world();
  scriptAgent(root, 'fa', [{ write: 'a.txt' }, { write: 'b.txt' }]);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  const parked = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  const copy = copyOf(root, parked.tickets[0]);
  const head = w.git(copy, 'rev-parse', 'HEAD');
  landOnBase(w, { 'a.txt': 'the base wrote this\n' });
  await assert.rejects(syncTicket(root, s0.id, 'ABC-11'), (e) => e.code === 'sync-conflict' && /a\.txt/.test(e.message));
  assert.equal(w.git(copy, 'rev-parse', 'HEAD'), head);
  assert.equal(w.git(copy, 'status', '--porcelain'), '', 'no merge is left half done');
  const after = loadSprint(root, s0.id).tickets[0];
  assert.deepEqual([after.state, after.reason, after.from], ['parked', parked.tickets[0].reason, parked.tickets[0].from]);
});

test('sync is refused in the middle of a task, and when the base has nothing new', async () => {
  const { root, w } = world({ check: null, reviews: 0 });
  scriptAgent(root, 'fr', [{ say: 'Missing a test.\nVERDICT: fail' }, { say: 'Still missing.\nVERDICT: fail' }]);
  scriptAgent(root, 'fa', [{ write: 'a.txt' }, { write: 'a.txt', content: 'again\n' }]);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  const parked = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  assert.match(parked.tickets[0].reason, /^Review failed twice on task 1/);
  assert.equal(sprintSummary(root, parked).tickets[0].canSync, false);
  landOnBase(w, { 'basefix.txt': 'fixed\n' });
  await assert.rejects(syncTicket(root, s0.id, 'ABC-11'), (e) => e.code === 'mid-task' && /task 1/.test(e.message));

  const other = world();
  scriptAgent(other.root, 'fa', [{ write: 'a.txt' }, { write: 'b.txt' }]);
  const s1 = await createSprint(other.root, { name: 'y', tickets: [T()] }, { cwd: other.w.repo });
  await run(other.root, s1.id, other.w.env, (x) => x.tickets[0].state === 'parked');
  await assert.rejects(syncTicket(other.root, s1.id, 'ABC-11'), (e) => e.code === 'up-to-date');
});

test('sync is refused while the full check\'s fix stopped before it finished', async () => {
  const { root, w } = world();
  scriptAgent(root, 'fa', [{ write: 'a.txt' }, { write: 'b.txt' }, { err: 'boom', exit: 3 }]);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  await retryTicket(root, s0.id, 'ABC-11');
  const stopped = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked' && x.tickets[0].phase === 'check-fix');
  assert.equal(sprintSummary(root, stopped).tickets[0].canSync, false);
  landOnBase(w, { 'basefix.txt': 'fixed\n' });
  await assert.rejects(syncTicket(root, s0.id, 'ABC-11'), (e) => e.code === 'fix-unfinished');
});

test('a plan waiting for approval takes the base, and only what the plan changes after that counts as its change', async () => {
  const { root, w } = world({ check: null, reviews: 0 });
  const FILE = 'docs/plans/2026-10-07-abc-14-export-to-csv.md';
  const PLAN2 = '# Export\n\n### Task 1: Button\nAdd it.\n\n### Task 2: CSV\nWrite it.\n';
  const PLAN3 = '# Export\n\n### Task 1: Button\nAdd it.\n\n### Task 2: Header\nIt.\n\n### Task 3: Rows\nThem.\n';
  scriptAgent(root, 'fa', [{ write: FILE, content: PLAN2 }, { write: FILE, content: PLAN3 }]);
  const s0 = await createSprint(root, { name: 'x', tickets: [{ key: 'ABC-14', title: 'Export to CSV', type: 'feat', agent: 'fa', reviewer: 'fr' }] }, { cwd: w.repo });
  const ready = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'plan-ready', () => NOW);
  landOnBase(w, { 'basefix.txt': 'fixed\n' });
  const { sprint } = await syncTicket(root, s0.id, 'ABC-14');
  assert.equal(sprint.tickets[0].state, 'plan-ready', 'a plan waiting for the person still waits');
  assert.ok(fs.existsSync(path.join(copyOf(root, ready.tickets[0]), 'basefix.txt')));
  await revisePlan(root, s0.id, 'ABC-14', 'Split the CSV task.');
  const s = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked' || (x.tickets[0].state === 'plan-ready' && !x.tickets[0].asked), () => NOW);
  assert.equal(s.tickets[0].state, 'plan-ready', s.tickets[0].reason);
  assert.equal(s.tickets[0].proposed.length, 3);
});

test('a sync that changes the plan waiting for approval reads its tasks again and says so', async () => {
  const FILE = 'docs/plans/2026-10-07-abc-14-export-to-csv.md';
  const BASE_PLAN = '# Export\n\n### Task 1: Button\nAdd it.\n\n### Task 2: CSV\nWrite it.\n';
  const { root, w } = sprintWorld({ plans: { 'docs/plan.md': '# Plan\n', [FILE]: BASE_PLAN } });
  scriptAgent(root, 'fr', []);
  w.git(w.repo, 'push', '-q', 'origin', 'main');
  // The planner changes the title; the base later adds a task at the end. The two merge cleanly.
  scriptAgent(root, 'fa', [{ write: FILE, content: BASE_PLAN.replace('# Export', '# Export to CSV') }]);
  const s0 = await createSprint(root, { name: 'x', tickets: [{ key: 'ABC-14', title: 'Export to CSV', type: 'feat', agent: 'fa', reviewer: 'fr' }] }, { cwd: w.repo });
  const ready = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'plan-ready', () => NOW);
  assert.equal(ready.tickets[0].proposed.length, 2);
  landOnBase(w, { [FILE]: `${BASE_PLAN}\n### Task 3: Rows\nWrite them.\n` });
  const { sprint } = await syncTicket(root, s0.id, 'ABC-14');
  const t = sprint.tickets[0];
  assert.equal(t.state, 'plan-ready');
  assert.deepEqual(t.proposed.map((x) => x.title), ['Button', 'CSV', 'Rows']);
  assert.match(sprint.messages.at(-1).text, /^ABC-14's plan changed when main was merged into its copy\. Read it again at /);
});

test('a sync refused before it starts leaves a copy\'s leftovers alone; one that fails after saving them says where they went', async () => {
  const MESSY = `${node} -e "require('fs').writeFileSync('scratch.txt','check output');process.exit(1)"`;
  const { root, w } = world({ check: MESSY });
  scriptAgent(root, 'fa', [{ write: 'a.txt' }, { write: 'b.txt' }]);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  const parked = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  const copy = copyOf(root, parked.tickets[0]);
  await assert.rejects(syncTicket(root, s0.id, 'ABC-11'), (e) => e.code === 'up-to-date');
  assert.equal(w.git(w.repo, 'stash', 'list'), '', 'nothing was saved aside for a sync that never started');
  assert.ok(fs.existsSync(path.join(copy, 'scratch.txt')));
  landOnBase(w, { 'a.txt': 'the base wrote this\n' });
  await assert.rejects(syncTicket(root, s0.id, 'ABC-11'), (e) => e.code === 'sync-conflict' && /saved as a git stash \("Podium: ABC-11's uncommitted changes before syncing with main"\)/.test(e.message));
  assert.match(w.git(w.repo, 'stash', 'list'), /Podium: ABC-11's uncommitted changes before syncing with main/);
});

test('a sync that would remove the plan waiting for approval changes nothing', async () => {
  const FILE = 'docs/plans/2026-10-07-abc-14-export-to-csv.md';
  const PLAN = '# Export\n\n### Task 1: Button\nAdd it.\n';
  const { root, w } = sprintWorld({ plans: { 'docs/plan.md': '# Plan\n', [FILE]: PLAN } });
  scriptAgent(root, 'fr', []);
  w.git(w.repo, 'push', '-q', 'origin', 'main');
  scriptAgent(root, 'fa', [{ write: FILE, content: PLAN }]);
  const s0 = await createSprint(root, { name: 'x', tickets: [{ key: 'ABC-14', title: 'Export to CSV', type: 'feat', agent: 'fa', reviewer: 'fr' }] }, { cwd: w.repo });
  const ready = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'plan-ready', () => NOW);
  const copy = copyOf(root, ready.tickets[0]);
  const head = w.git(copy, 'rev-parse', 'HEAD');
  landOnBase(w, { [FILE]: null });
  await assert.rejects(syncTicket(root, s0.id, 'ABC-14'), (e) => e.code === 'sync-removes-plan');
  assert.equal(w.git(copy, 'rev-parse', 'HEAD'), head);
  assert.ok(fs.existsSync(path.join(copy, FILE)));
  assert.equal(loadSprint(root, s0.id).tickets[0].state, 'plan-ready');
});

test('a PR that failed to open after its squash still syncs: the squash is Podium\'s own commit', async () => {
  const { root, w } = world({ check: `${node} -e "process.exit(0)"` });
  scriptAgent(root, 'fa', [{ write: 'a.txt' }, { write: 'b.txt' }]);
  // GitHub refuses the PR the first time.
  const spec = w.env.PODIUM_FAKE_GH;
  const answers = JSON.parse(fs.readFileSync(spec, 'utf8'));
  fs.writeFileSync(spec, JSON.stringify({ ...answers, responses: [{ match: ['pr', 'create'], stderr: 'GitHub is down', code: 1 }] }));
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  const parked = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  assert.equal(parked.tickets[0].resume, 'pr', parked.tickets[0].reason);
  fs.writeFileSync(spec, JSON.stringify(answers));
  const fix = landOnBase(w, { 'basefix.txt': 'fixed\n' });
  const { sprint } = await syncTicket(root, s0.id, 'ABC-11');
  assert.deepEqual([sprint.tickets[0].state, sprint.tickets[0].foreign ?? null], ['waiting', null]);
  const s = await run(root, s0.id, w.env, (x) => ['pr-open', 'parked'].includes(x.tickets[0].state));
  assert.equal(s.tickets[0].state, 'pr-open', s.tickets[0].reason);
  const { branch } = jobsBy(root, 'author')[0];
  assert.equal(w.git(w.remote, 'rev-parse', `${branch}^`), fix);
  assert.deepEqual(shippedFiles(w, branch), ['a.txt', 'b.txt']);
});

test('a base merged into the copy by hand and kept is not squashed into the ticket\'s commit', async () => {
  const { root, w } = world();
  scriptAgent(root, 'fa', [{ write: 'a.txt' }, { write: 'b.txt' }]);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  const parked = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  const copy = copyOf(root, parked.tickets[0]);
  const fix = landOnBase(w, { 'basefix.txt': 'fixed\n' });
  w.git(copy, 'fetch', '-q', 'origin');
  w.git(copy, 'merge', '-q', '--no-edit', 'origin/main');
  await retryTicket(root, s0.id, 'ABC-11');
  const asked = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  assert.match(asked.tickets[0].reason, /^2 commits in this ticket's copy were not made by Podium/);
  await answerCommits(root, s0.id, 'ABC-11', { keep: true });
  const s = await run(root, s0.id, w.env, (x) => ['pr-open', 'parked'].includes(x.tickets[0].state));
  assert.equal(s.tickets[0].state, 'pr-open', s.tickets[0].reason);
  const { branch } = jobsBy(root, 'author')[0];
  assert.equal(w.git(w.remote, 'rev-parse', `${branch}^`), fix);
  assert.deepEqual(shippedFiles(w, branch), ['a.txt', 'b.txt']);
});
