// A sprint starts as a draft. Nothing runs until Start.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable, Readable } from 'node:stream';
import { draftSprint, startSprint, discardSprint, createSprint, loadSprint, saveSprint, listSprints, tick, wantsRunner, setPaused, stopTicket, sprintReport } from '../engine/sprint.js';
import { ensureSprints } from '../engine/sprint-run.js';
import { listJobDirs } from '../engine/store.js';
import { main } from '../engine/cli.js';
import { scriptAgent, sprintWorld } from './helpers.js';
import { loadSettings, repoSettings } from '../engine/settings.js';
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
async function cli(root, argv, { stdin = '', cwd } = {}) {
  let out = '';
  const stdout = new Writable({ write(c, _e, cb) { out += c; cb(); } });
  const code = await main(argv, { stdout, stdin: Readable.from([stdin]), env: { ...process.env, PODIUM_DATA_DIR: root }, cwd, spawn: NO_RUNNER });
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

test('a draft proposes the repo\'s commands and check, Start saves them and says so, and a repo with no check is noted', async () => {
  const { root, w } = world();
  const project = projectKey(w.repo);
  const none = { commands: [], check: null, squash: true, mergeMethod: null };
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
  assert.deepEqual(repoSettings(loadSettings(root), project), { commands: [], check: null, squash: true, mergeMethod: null });
  const plain = await draftSprint(root, { name: 'Nov', tickets: [T({ key: 'ABC-12', title: 'Payouts' })] }, { cwd: w.repo });
  const s = await startSprint(root, plain.id);
  assert.equal(s.applied, undefined);
  assert.deepEqual(repoSettings(loadSettings(root), project), { commands: [], check: null, squash: true, mergeMethod: null });
});

