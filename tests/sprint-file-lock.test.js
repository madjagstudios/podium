import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { createSprint, tick, setPaused, retryTicket, loadSprint, saveSprint, sprintSummary } from '../engine/sprint.js';
import { listJobDirs, readJob, findJobDir } from '../engine/store.js';
import { main } from '../engine/cli.js';
import { waitFor, scriptAgent, sprintWorld, PLAN } from './helpers.js';
import { holdFile } from './windows-file-lock.js';

const jobs = (root, role) => listJobDirs(root).map(readJob).filter(j => j.sprint?.role === role);
const run = (root, id, env, until) => waitFor(async () => { const s = await tick(root, id, { env }); return until(s) && s; }, { timeoutMs: 90_000, intervalMs: 150 });

async function reviewing() {
  const { root, w } = sprintWorld({ plans: { 'docs/plan.md': PLAN } });
  scriptAgent(root, 'fa', [{ write: 'a.txt', content: 'original author work' }, { write: 'b.txt' }]);
  scriptAgent(root, 'fr', [{ say: 'VERDICT: pass' }, { say: 'VERDICT: pass' }, { say: 'VERDICT: pass' }]);
  const s = await createSprint(root, { name: 'locked checkpoint', tickets: [{ key: 'ABC-11', title: 'Save work', type: 'feat', plan: 'docs/plan.md', agent: 'fa', reviewer: 'fr' }] }, { cwd: w.repo });
  await run(root, s.id, w.env, s => s.tickets[0].phase === 'review');
  await setPaused(root, s.id, true);
  const review = jobs(root, 'reviewer')[0];
  await waitFor(() => ['done', 'needs-review'].includes(readJob(findJobDir(root, review.id)).status), { timeoutMs: 90_000 });
  const author = jobs(root, 'author')[0];
  return { root, w, s, copy: author.worktree, author };
}

async function cli(root, cwd, argv) {
  let text = '';
  const stdout = new Writable({ write(chunk, _enc, cb) { text += chunk; cb(); } });
  await main(argv, { stdout, cwd, env: { ...process.env, PODIUM_DATA_DIR: root }, spawn: () => null });
  return JSON.parse(text);
}

for (const [index, [file, hint]] of [
  ['.review-tmp/VBCSCompiler/AnalyzerAssemblyLoader/x/Microsoft.Interop.ComInterfaceGenerator.dll', 'dotnet'],
  ['ordinary held 雪.txt', null],
].entries()) test(`failed stash preserves work and Retry resumes review: ${file}`, { skip: process.platform !== 'win32', timeout: 300_000 }, async t => {
  const { root, w, s, copy, author } = await reviewing();
  fs.writeFileSync(path.join(copy, 'prior.txt'), 'prior saved work');
  w.git(copy, 'stash', 'push', '--include-untracked', '-m', 'prior saved work');
  const prior = w.git(copy, 'rev-parse', 'refs/stash');
  const checkpoint = readJob(findJobDir(root, author.id)).checkpoint;
  assert.ok(checkpoint);
  const held = path.join(copy, file);
  fs.mkdirSync(path.dirname(held), { recursive: true });
  fs.writeFileSync(held, 'held work');
  fs.writeFileSync(path.join(copy, 'a.txt'), 'source edit after checkpoint');
  const holder = await holdFile(held);
  t.after(() => holder.release());
  await setPaused(root, s.id, false);
  const parked = await run(root, s.id, w.env, s => s.tickets[0].state === 'parked');
  const ticket = parked.tickets[0];
  assert.equal(ticket.resume, 'review');
  assert.equal(ticket.task, 0);
  assert.equal(jobs(root, 'author').length, 1);
  assert.equal(jobs(root, 'reviewer').length, 1, 'no subsequent reviewer starts');
  const lock = ticket.checkpointLock;
  assert.ok(lock, ticket.reason);
  assert.equal(lock.file, file);
  assert.equal(lock.hint, hint);
  assert.equal(lock.stashBefore, prior);
  assert.equal(lock.stashAfter, w.git(copy, 'rev-parse', 'refs/stash'));
  assert.deepEqual(Object.keys(lock).sort(), ['file', 'hint', 'stashAfter', 'stashBefore'], 'no holder is stored');
  assert.match(ticket.reason, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(ticket.reason, /still open in a program/);
  assert.match(ticket.reason, /then Retry/);
  if (hint === 'dotnet') assert.match(ticket.reason, /dotnet build-server shutdown in this ticket's copy/);
  else assert.doesNotMatch(ticket.reason, /dotnet build-server shutdown/);
  assert.equal(fs.readFileSync(held, 'utf8'), 'held work');
  assert.doesNotThrow(() => process.kill(holder.pid, 0), 'diagnosis never shuts down the holder');
  assert.equal(w.git(copy, 'show', `${checkpoint}:a.txt`), 'original author work');
  assert.equal(w.git(copy, 'show', `${prior}^3:prior.txt`), 'prior saved work');
  const refs = w.git(copy, 'stash', 'list', '--format=%H').split('\n').filter(Boolean);
  for (const ref of refs) assert.doesNotThrow(() => w.git(copy, 'cat-file', '-e', `${ref}^{commit}`));
  const sources = [fs.readFileSync(path.join(copy, 'a.txt'), 'utf8'), ...refs.map(ref => w.git(copy, 'show', `${ref}:a.txt`))];
  assert.ok(sources.some(text => text.trim() === 'source edit after checkpoint'), 'source edit is recoverable');
  const status = await cli(root, w.repo, ['sprint', 'status', '--id', s.id]);
  assert.deepEqual(status.sprints[0].tickets[0].checkpointLock, lock);
  await holder.release();
  if (index === 0) await retryTicket(root, s.id, 'ABC-11');
  else {
    const result = await cli(root, w.repo, ['sprint', 'retry', '--id', s.id, '--ticket', 'ABC-11']);
    assert.equal(result.error, undefined, JSON.stringify(result));
  }
  assert.equal(loadSprint(root, s.id).tickets[0].resume, 'review');
  assert.equal(loadSprint(root, s.id).tickets[0].checkpointLock, undefined);
  await run(root, s.id, w.env, s => s.tickets[0].state === 'running' && s.tickets[0].phase === 'review');
  assert.equal(jobs(root, 'author').length, 1, 'completed writer did not rerun');
  const done = await run(root, s.id, w.env, s => !['pending', 'running', 'waiting'].includes(s.tickets[0].state));
  assert.equal(done.tickets[0].state, 'pr-open', done.tickets[0].reason);
  assert.equal(jobs(root, 'author').length, 2);
  for (const ref of refs) assert.ok(w.git(w.repo, 'stash', 'list', '--format=%H').includes(ref), 'prior stashes retained after Retry');
  assert.equal('checkpointLock' in sprintSummary(root, done).tickets[0], false);
});

test('an unrelated Git failure keeps the old generic park and all saved work', { timeout: 120_000 }, async t => {
  const { root, w, s, copy } = await reviewing();
  const stale = loadSprint(root, s.id);
  stale.tickets[0].checkpointLock = { file: 'old.txt', hint: null, stashBefore: null, stashAfter: null };
  saveSprint(root, stale);
  fs.writeFileSync(path.join(copy, 'a.txt'), 'unsaved edit');
  const lock = path.resolve(copy, w.git(copy, 'rev-parse', '--git-path', 'index.lock'));
  fs.writeFileSync(lock, 'fixture lock');
  t.after(() => fs.rmSync(lock, { force: true }));
  await setPaused(root, s.id, false);
  const parked = await run(root, s.id, w.env, s => s.tickets[0].state === 'parked');
  assert.equal(parked.tickets[0].checkpointLock, undefined);
  assert.match(parked.tickets[0].reason, /Podium couldn't save task 1's work and start its review: git stash:/);
  assert.equal(fs.readFileSync(path.join(copy, 'a.txt'), 'utf8'), 'unsaved edit');
  assert.equal(jobs(root, 'author').length, 1);
  assert.equal(jobs(root, 'reviewer').length, 1);
});
