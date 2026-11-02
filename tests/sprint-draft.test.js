// A sprint starts as a draft. Nothing runs until Start.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Writable, Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { draftSprint, startSprint, discardSprint, createSprint, loadSprint, saveSprint, listSprints, tick, wantsRunner, setPaused, stopTicket, sprintReport, baseNotes } from '../engine/sprint.js';
import { ensureSprints } from '../engine/sprint-run.js';
import { listJobDirs } from '../engine/store.js';
import { main } from '../engine/cli.js';
import { scriptAgent, sprintWorld, tempRoot, tempRepo, PLAN } from './helpers.js';
import { loadSettings, repoSettings, setSetting } from '../engine/settings.js';
import { projectKey } from '../engine/paths.js';

const T = (over = {}) => ({ key: 'ABC-11', title: 'Login form', type: 'feat', plan: 'docs/plan.md', agent: 'fa', reviewer: 'fr', ...over });

function world() {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', [{ write: 'a.txt' }]);
  scriptAgent(root, 'fr', [{ say: 'VERDICT: pass' }]);
  return { root, w };
}

// The CLI takes a spawn so Start never starts a real runner here.
const NO_RUNNER = () => { throw new Error('no runner in tests'); };
async function cli(root, argv, { stdin = '', cwd, env = {} } = {}) {
  let out = '';
  const stdout = new Writable({ write(c, _e, cb) { out += c; cb(); } });
  // The test's own data folder always wins, over a passed env that copied process.env too.
  const code = await main(argv, { stdout, stdin: Readable.from([stdin]), env: { ...process.env, ...env, PODIUM_DATA_DIR: root }, cwd, spawn: NO_RUNNER });
  return { code, body: JSON.parse(out) };
}

test('a drafted sprint runs nothing: no runner, no step, no news, not done', async () => {
  const { root, w } = world();
  const d = await draftSprint(root, { name: 'Oct', tickets: [T()] }, { cwd: w.repo, session: 'chat-1' });
  assert.equal(d.draft, true);
  assert.equal(d.startedAt, null);
  assert.equal(d.session, 'chat-1');
  assert.equal(wantsRunner(root, d), false);
  assert.deepEqual(ensureSprints(root, { spawn: () => assert.fail('a draft never gets a runner') }).started, []);
  const after = await tick(root, d.id, { env: w.env });
  assert.equal(after.tickets[0].state, 'pending');
  assert.deepEqual(listJobDirs(root), [], 'no step was started');
  const stored = loadSprint(root, d.id);
  assert.deepEqual(stored.messages, []);
  assert.equal(stored.finishedAt, null);
});

test('Start checks again, then the runner takes the sprint', async () => {
  const { root, w } = world();
  const d = await draftSprint(root, { name: 'Oct', tickets: [T()] }, { cwd: w.repo });
  const s = await startSprint(root, d.id, { now: new Date('2026-10-07T10:00:00Z') });
  assert.equal(s.draft, false);
  assert.equal(s.startedAt, '2026-10-07T10:00:00.000Z');
  assert.equal(wantsRunner(root, s), true);
  const ticked = await tick(root, d.id, { env: w.env });
  assert.equal(ticked.tickets[0].state, 'running');
  await assert.rejects(startSprint(root, d.id), (e) => e.code === 'already-started' && e.message === 'This sprint has already started.');
});

test('Start refuses a branch made since the draft, or an agent that is gone, and the draft stays a draft', async () => {
  const { root, w } = world();
  const d = await draftSprint(root, { name: 'Oct', tickets: [T()] }, { cwd: w.repo });
  w.git(w.repo, 'branch', 'feat/abc-11-login-form');
  await assert.rejects(startSprint(root, d.id), (e) => e.code === 'branch-taken');
  assert.equal(loadSprint(root, d.id).draft, true);
  w.git(w.repo, 'branch', '-D', 'feat/abc-11-login-form');
  const s = loadSprint(root, d.id);
  s.tickets[0].tasks[1].reviewer = 'ghost';
  saveSprint(root, s);
  await assert.rejects(startSprint(root, d.id), (e) => e.code === 'unknown-agent' && e.message === 'No agent called "ghost" (ABC-11 task 2\'s reviewer).');
  assert.equal(loadSprint(root, d.id).draft, true);
});

test('Discard archives a draft; a started sprint cannot be discarded', async () => {
  const { root, w } = world();
  const d = await draftSprint(root, { name: 'Oct', tickets: [T()] }, { cwd: w.repo });
  const gone = await discardSprint(root, d.id, { now: new Date('2026-10-07T10:00:00Z') });
  assert.equal(gone.archived, true);
  assert.equal(gone.discardedAt, '2026-10-07T10:00:00.000Z');
  assert.equal(listSprints(root).length, 0, 'a discarded draft is no longer listed');
  await assert.rejects(startSprint(root, d.id), (e) => e.code === 'discarded' && e.message === 'This draft was thrown away.');
  await assert.rejects(discardSprint(root, d.id), (e) => e.code === 'discarded');
  const started = await createSprint(root, { name: 'Run', tickets: [T({ title: 'Other' })] }, { cwd: w.repo });
  await assert.rejects(discardSprint(root, started.id), (e) => e.code === 'not-a-draft');
});

test('Pause and Stop wait for Start', async () => {
  const { root, w } = world();
  const d = await draftSprint(root, { name: 'Oct', tickets: [T()] }, { cwd: w.repo });
  await assert.rejects(setPaused(root, d.id, true), (e) => e.code === 'not-started');
  await assert.rejects(stopTicket(root, d.id, 'ABC-11'), (e) => e.code === 'not-started');
});

test('the end-of-sprint report counts time from Start, not from the draft', () => {
  const s = { name: 'Oct', createdAt: '2026-10-07T08:00:00Z', startedAt: '2026-10-07T10:00:00Z', tickets: [] };
  assert.match(sprintReport(s, Date.parse('2026-10-07T10:30:00Z')), /It took 30 min\.$/);
});

test('the CLI drafts and discards; create is gone; start of a discarded draft is refused', async () => {
  const { root, w } = world();
  const made = await cli(root, ['sprint', 'draft', '--json', '-', '--session', 'chat-1'], { stdin: JSON.stringify({ name: 'Oct', tickets: [T()] }), cwd: w.repo });
  assert.equal(made.code, 0);
  assert.equal(made.body.sprint.draft, true);
  const id = made.body.sprint.id;
  assert.equal(loadSprint(root, id).session, 'chat-1');
  const gone = await cli(root, ['sprint', 'discard', '--id', id]);
  assert.equal(gone.code, 0);
  assert.equal(gone.body.sprint.discarded, true);
  const again = await cli(root, ['sprint', 'start', '--id', id]);
  assert.equal(again.body.error.code, 'discarded');
  const old = await cli(root, ['sprint', 'create'], { stdin: '{}' });
  assert.equal(old.body.error.code, 'unknown-command');
});

test('a draft notes a summary that only points at the tracker, in place of the title-only note', async () => {
  const { root, w } = world();
  const notesFor = async (ticket) => {
    const made = await cli(root, ['sprint', 'draft', '--json', '-'], { stdin: JSON.stringify({ name: 'Oct', tickets: [ticket] }), cwd: w.repo });
    assert.equal(made.code, 0, JSON.stringify(made.body));
    return made.body.notes;
  };
  const note = (quoted) => `ABC-11's summary only points at the tracker ("${quoted}"). The agents that write and review it may not be able to open the tracker. Throw this draft away (action "discard") and draft it again with the ticket's text pasted in as its summary.`;
  for (const summary of ['XYZ-60', 'https://example.atlassian.net/browse/ABC-11']) {
    const notes = await notesFor(T({ summary }));
    assert.ok(notes.includes(note(summary)), JSON.stringify(notes));
    assert.ok(!notes.some((n) => /only its title/.test(n)), JSON.stringify(notes));
  }
  const planless = await notesFor(T({ summary: 'see ABC-11', plan: undefined }));
  assert.ok(planless.includes(note('see ABC-11')), JSON.stringify(planless));
  assert.ok(!planless.some((n) => /only its title/.test(n)), JSON.stringify(planless));
  const real = await notesFor(T({ summary: 'Users sign in with email and get told when the password is wrong.' }));
  assert.ok(!real.some((n) => /only points at the tracker/.test(n)), JSON.stringify(real));
});

test('a draft proposes the repo\'s commands and check, Start saves them and says so, and a repo with no check is noted', async () => {
  const { root, w } = world();
  const project = projectKey(w.repo);
  const none = { commands: [], check: null, taskTest: null, squash: true, mergeMethod: null, prodPatterns: [], planDir: 'docs/plans', keepPlan: false, public: null, privateTerms: [] };
  const bare = await cli(root, ['sprint', 'draft', '--json', '-'], { stdin: JSON.stringify({ name: 'Oct', tickets: [T()] }), cwd: w.repo });
  assert.equal(bare.code, 0);
  assert.deepEqual(bare.body.proposed, {});
  assert.equal(bare.body.sprint.check, false);
  assert.equal(bare.body.sprint.proposed, null);
  assert.ok(bare.body.notes.some((n) => /no full check yet/.test(n)));
  const made = await cli(root, ['sprint', 'draft', '--json', '-'], { stdin: JSON.stringify({ name: 'Nov', tickets: [T({ key: 'ABC-12', title: 'Payouts' })], commands: ['dotnet'], check: 'dotnet build && dotnet test' }), cwd: w.repo });
  assert.equal(made.code, 0);
  const values = { commands: ['dotnet'], check: 'dotnet build && dotnet test' };
  assert.deepEqual(made.body.proposed, values);
  assert.equal('saved' in made.body, false);
  // Proposed, not saved: the board shows them, and the proposed check stands in for the missing one in the notes.
  assert.deepEqual(made.body.sprint.proposed, values);
  assert.equal(made.body.sprint.check, false);
  assert.ok(!made.body.notes.some((n) => /no full check/.test(n)));
  assert.deepEqual(repoSettings(loadSettings(root), project), none, 'nothing is saved at draft time');
  const started = await cli(root, ['sprint', 'start', '--id', made.body.sprint.id]);
  assert.equal(started.code, 0, JSON.stringify(started.body));
  assert.deepEqual(started.body.applied, values);
  assert.equal(started.body.sprint.proposed, null);
  assert.equal(started.body.sprint.check, true);
  assert.deepEqual(repoSettings(loadSettings(root), project), { ...none, ...values });
  const refused = await cli(root, ['sprint', 'draft', '--json', '-'], { stdin: JSON.stringify({ name: 'Dec', tickets: [T({ key: 'ABC-13', title: 'Export' })], commands: ['dot net'] }), cwd: w.repo });
  assert.equal(refused.code, 1);
  assert.equal(refused.body.error.code, 'bad-setting');
  for (const bad of [{ commands: 'dotnet' }, { check: 42 }, { commands: ['bash'] }]) {
    const r = await cli(root, ['sprint', 'draft', '--json', '-'], { stdin: JSON.stringify({ name: 'Dec', tickets: [T({ key: 'ABC-13', title: 'Export' })], ...bad }), cwd: w.repo });
    assert.equal(r.body.error?.code, 'bad-setting', JSON.stringify(bad));
  }
  assert.equal(listSprints(root).length, 2, 'a refused draft is not saved');
});

test('a discarded draft drops what it proposed for the repo, and a started one without a proposal saves nothing', async () => {
  const { root, w } = world();
  const project = projectKey(w.repo);
  const d = await draftSprint(root, { name: 'Oct', tickets: [T()], commands: ['npm'], check: 'npm test' }, { cwd: w.repo });
  const gone = await discardSprint(root, d.id);
  assert.equal(gone.proposed, null);
  assert.deepEqual(repoSettings(loadSettings(root), project), { commands: [], check: null, taskTest: null, squash: true, mergeMethod: null, prodPatterns: [], planDir: 'docs/plans', keepPlan: false, public: null, privateTerms: [] });
  const plain = await draftSprint(root, { name: 'Nov', tickets: [T({ key: 'ABC-12', title: 'Payouts' })] }, { cwd: w.repo });
  const s = await startSprint(root, plain.id);
  assert.equal(s.applied, undefined);
  assert.deepEqual(repoSettings(loadSettings(root), project), { commands: [], check: null, taskTest: null, squash: true, mergeMethod: null, prodPatterns: [], planDir: 'docs/plans', keepPlan: false, public: null, privateTerms: [] });
});

test('a draft proposes the repo\'s plans folder, Start saves it, and a bad one is refused', async () => {
  const { root, w } = world();
  const project = projectKey(w.repo);
  const made = await cli(root, ['sprint', 'draft', '--json', '-'], { stdin: JSON.stringify({ name: 'Oct', tickets: [T()], planDir: 'docs/custom/plans' }), cwd: w.repo });
  assert.equal(made.code, 0, JSON.stringify(made.body));
  assert.deepEqual(made.body.proposed, { planDir: 'docs/custom/plans' });
  assert.deepEqual(made.body.sprint.proposed, { planDir: 'docs/custom/plans' });
  assert.equal(repoSettings(loadSettings(root), project).planDir, 'docs/plans', 'nothing is saved at draft time');
  const started = await cli(root, ['sprint', 'start', '--id', made.body.sprint.id]);
  assert.equal(started.code, 0, JSON.stringify(started.body));
  assert.deepEqual(started.body.applied, { planDir: 'docs/custom/plans' });
  assert.equal(started.body.sprint.proposed, null);
  assert.equal(repoSettings(loadSettings(root), project).planDir, 'docs/custom/plans');
  const refused = await cli(root, ['sprint', 'draft', '--json', '-'], { stdin: JSON.stringify({ name: 'Nov', tickets: [T({ key: 'ABC-12', title: 'Payouts' })], planDir: '/absolute/path' }), cwd: w.repo });
  assert.equal(refused.code, 1);
  assert.equal(refused.body.error.code, 'bad-setting');
});

test('a draft proposes keeping plans in the repo\'s PRs, Start saves it, and a value that is not true or false is refused', async () => {
  const { root, w } = world();
  const project = projectKey(w.repo);
  const made = await cli(root, ['sprint', 'draft', '--json', '-'], { stdin: JSON.stringify({ name: 'Oct', tickets: [T()], keepPlan: true }), cwd: w.repo });
  assert.equal(made.code, 0, JSON.stringify(made.body));
  assert.deepEqual(made.body.proposed, { keepPlan: true });
  assert.deepEqual(made.body.sprint.proposed, { keepPlan: true });
  assert.equal(repoSettings(loadSettings(root), project).keepPlan, false, 'nothing is saved at draft time');
  const started = await cli(root, ['sprint', 'start', '--id', made.body.sprint.id]);
  assert.equal(started.code, 0, JSON.stringify(started.body));
  assert.deepEqual(started.body.applied, { keepPlan: true });
  assert.equal(repoSettings(loadSettings(root), project).keepPlan, true);
  const refused = await cli(root, ['sprint', 'draft', '--json', '-'], { stdin: JSON.stringify({ name: 'Nov', tickets: [T({ key: 'ABC-12', title: 'Payouts' })], keepPlan: 'yes' }), cwd: w.repo });
  assert.equal(refused.code, 1);
  assert.equal(refused.body.error.code, 'bad-setting');
});

test('a draft notes CI runs the full check does not cover and how GitHub will merge its PRs', async () => {
  const repoView = { match: ['repo', 'view'], stdout: JSON.stringify({ viewerDefaultMergeMethod: 'MERGE', mergeCommitAllowed: false, squashMergeAllowed: true, rebaseMergeAllowed: false }) };
  const { root, w } = (() => {
    const made = sprintWorld({ gh: [repoView] });
    scriptAgent(made.root, 'fa', [{ write: 'a.txt' }]);
    scriptAgent(made.root, 'fr', [{ say: 'VERDICT: pass' }]);
    return made;
  })();
  fs.mkdirSync(path.join(w.repo, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(w.repo, '.github', 'workflows', 'ci.yml'), [
    'name: CI',
    'jobs:',
    '  test:',
    '    steps:',
    '      - run: npm test',
    '      - run: node scripts/map-check.mjs',
    '',
  ].join('\n'));
  setSetting(root, 'repoCheck', { [projectKey(w.repo)]: 'npm test' });
  const made = await cli(root, ['sprint', 'draft', '--json', '-'], { stdin: JSON.stringify({ name: 'Oct', tickets: [T()] }), cwd: w.repo, env: w.env });
  assert.equal(made.code, 0, JSON.stringify(made.body));
  assert.ok(made.body.notes.some((n) => n.includes('`node scripts/map-check.mjs`')), JSON.stringify(made.body.notes));
  assert.ok(!made.body.notes.some((n) => n.includes('`npm test`')), JSON.stringify(made.body.notes));
  assert.ok(made.body.notes.some((n) => /will merge by squash, not merge/.test(n)), JSON.stringify(made.body.notes));
});

test('a draft compares CI runs against its proposed check, or none when it removes the check', async () => {
  const { root, w } = world();
  fs.mkdirSync(path.join(w.repo, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(w.repo, '.github', 'workflows', 'ci.yml'), [
    'name: CI',
    'jobs:',
    '  test:',
    '    steps:',
    '      - run: npm test',
    '      - run: node scripts/map-check.mjs',
    '',
  ].join('\n'));
  setSetting(root, 'repoCheck', { [projectKey(w.repo)]: 'npm test' });
  const covered = await cli(root, ['sprint', 'draft', '--json', '-'], { stdin: JSON.stringify({ name: 'Oct', tickets: [T()], check: 'npm test && node scripts/map-check.mjs' }), cwd: w.repo, env: w.env });
  assert.equal(covered.code, 0, JSON.stringify(covered.body));
  assert.ok(!covered.body.notes.some((n) => n.includes('`node scripts/map-check.mjs`')), JSON.stringify(covered.body.notes));
  const removed = await cli(root, ['sprint', 'draft', '--json', '-'], { stdin: JSON.stringify({ name: 'Nov', tickets: [T({ key: 'ABC-12', title: 'Payouts' })], check: '' }), cwd: w.repo, env: w.env });
  assert.equal(removed.code, 0, JSON.stringify(removed.body));
  assert.ok(!removed.body.notes.some((n) => /CI also runs/.test(n)), JSON.stringify(removed.body.notes));
});

test('a draft still returns quickly with no merge note when GitHub answers slowly', async () => {
  const repoView = { match: ['repo', 'view'], ms: 25_000, stdout: JSON.stringify({ viewerDefaultMergeMethod: 'MERGE', mergeCommitAllowed: false, squashMergeAllowed: true, rebaseMergeAllowed: false }) };
  const { root, w } = (() => {
    const made = sprintWorld({ gh: [repoView] });
    scriptAgent(made.root, 'fa', [{ write: 'a.txt' }]);
    scriptAgent(made.root, 'fr', [{ say: 'VERDICT: pass' }]);
    return made;
  })();
  const start = Date.now();
  const made = await cli(root, ['sprint', 'draft', '--json', '-'], { stdin: JSON.stringify({ name: 'Oct', tickets: [T()] }), cwd: w.repo, env: w.env });
  const elapsed = Date.now() - start;
  assert.equal(made.code, 0, JSON.stringify(made.body));
  assert.ok(!made.body.notes.some((n) => /will merge by/.test(n)), JSON.stringify(made.body.notes));
  assert.ok(elapsed < 25_000, `the draft took ${elapsed}ms waiting for a slow GitHub answer`);
});

test('a draft still succeeds with no merge note when GitHub cannot be asked', async () => {
  const { root, w } = world();
  fs.mkdirSync(path.join(w.repo, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(w.repo, '.github', 'workflows', 'ci.yml'), 'jobs:\n  test:\n    steps:\n      - run: node scripts/map-check.mjs\n');
  setSetting(root, 'repoCheck', { [projectKey(w.repo)]: 'npm test' });
  const made = await cli(root, ['sprint', 'draft', '--json', '-'], { stdin: JSON.stringify({ name: 'Oct', tickets: [T()] }), cwd: w.repo, env: w.env });
  assert.equal(made.code, 0, JSON.stringify(made.body));
  assert.ok(made.body.notes.some((n) => n.includes('`node scripts/map-check.mjs`')), JSON.stringify(made.body.notes));
  assert.ok(!made.body.notes.some((n) => /will merge by/.test(n)), JSON.stringify(made.body.notes));
});

// Commits pushed to origin from a second clone, so the world's local main trails it.
function pushFromElsewhere(w, ...names) {
  const other = path.join(tempRoot(), 'other');
  w.git(path.dirname(other), 'clone', '-q', w.remote, other);
  for (const n of names) {
    fs.writeFileSync(path.join(other, n), `${n}\n`);
    w.git(other, 'add', '-A');
    w.git(other, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', n);
  }
  w.git(other, 'push', '-q', 'origin', 'main');
}

test('the draft notes a base that trails its remote, and a fetch that failed', async () => {
  const { root, w } = world();
  const d = await draftSprint(root, { name: 'Oct', tickets: [T()] }, { cwd: w.repo });
  // Local main holds the plans and is ahead of origin, never behind.
  assert.deepEqual(await baseNotes(d), []);
  pushFromElsewhere(w, 'one.txt', 'two.txt');
  assert.deepEqual(await baseNotes(d), ["Your local main is 2 commits behind origin/main. The sprint's copies start from the local main, so Start refuses until it is updated (for example, git pull in its checkout)."]);
  const fetchFn = async () => { throw Object.assign(new Error('git fetch: unable to access'), { remote: 'origin' }); };
  assert.deepEqual(await baseNotes(d, { fetchFn }), ["Podium couldn't reach origin to check that main is current (unable to access). Start checks again, and starts from the local main if it still can't."]);
});

test('the draft notes a plan written in the folder but not committed on the base', async () => {
  const { root, w } = world();
  fs.writeFileSync(path.join(w.repo, 'docs', 'new.md'), PLAN);
  const short = w.git(w.repo, 'rev-parse', 'HEAD').slice(0, 7);
  const note = (key) => `Plans not committed on main at ${short}, where the sprint's copies start: ${key} (docs/new.md). Commit them to main before Start, or Start refuses.`;
  const d = await draftSprint(root, { name: 'Oct', tickets: [T({ plan: 'docs/new.md' }), T({ key: 'ABC-12', title: 'Payouts' })] }, { cwd: w.repo });
  assert.deepEqual(await baseNotes(d), [note('ABC-11')]);
  // Through the CLI too: the reply's notes carry it.
  const made = await cli(root, ['sprint', 'draft', '--json', '-'], { stdin: JSON.stringify({ name: 'Nov', tickets: [T({ key: 'ABC-13', title: 'Export', plan: 'docs/new.md' })] }), cwd: w.repo });
  assert.equal(made.code, 0);
  assert.ok(made.body.notes.includes(note('ABC-13')), JSON.stringify(made.body.notes));
});

test('the draft has no base notes in a repo with no remote', async () => {
  const root = tempRoot();
  scriptAgent(root, 'fa', [{ write: 'a.txt' }]);
  scriptAgent(root, 'fr', [{ say: 'VERDICT: pass' }]);
  const repo = tempRepo();
  const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' });
  fs.mkdirSync(path.join(repo, 'docs'));
  fs.writeFileSync(path.join(repo, 'docs', 'plan.md'), PLAN);
  git('add', '-A');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'plan');
  const d = await draftSprint(root, { name: 'Oct', tickets: [T()] }, { cwd: repo });
  assert.deepEqual(await baseNotes(d), []);
});

