// A sprint task's reviewer works in the ticket's own copy and may run the tests there; the person can give it evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { createSprint, tick, retryTicket, stopTicket, sprintSummary, reviewWithEvidence, setPaused } from '../engine/sprint.js';
import { listJobDirs, readJob, findJobDir } from '../engine/store.js';
import { dispatch } from '../engine/dispatch.js';
import { main } from '../engine/cli.js';
import { waitFor, scriptAgent, sprintWorld, tempRoot, PLAN } from './helpers.js';
import { holdFile } from './windows-file-lock.js';

const ONE = '# Plan\n\n### Task 1: Add a.txt\nWrite a.txt.\n';
const T = (over = {}) => ({ key: 'ABC-11', title: 'Login form', type: 'feat', plan: 'docs/one.md', agent: 'fa', reviewer: 'fr', ...over });
const run = (root, id, env, until) => waitFor(async () => { const s = await tick(root, id, { env }); return until(s) ? s : null; }, { timeoutMs: 90_000, intervalMs: 150 });
const settled = (s) => !['pending', 'running', 'waiting'].includes(s.tickets[0].state);
const jobsBy = (root, role) => listJobDirs(root).map(readJob).filter((j) => j.sprint?.role === role).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
const promptOf = (root, job) => fs.readFileSync(path.join(findJobDir(root, job.id), 'prompt.md'), 'utf8');
const outputOf = (root, job) => fs.readFileSync(path.join(findJobDir(root, job.id), 'output.md'), 'utf8');
const EVIDENCE = 'CI passed on this commit on Linux: https://github.com/o/r/actions/runs/1';

async function world(writer, reviewer) {
  const { root, w } = sprintWorld({ plans: { 'docs/one.md': ONE } });
  scriptAgent(root, 'fa', writer);
  scriptAgent(root, 'fr', reviewer);
  const s0 = await createSprint(root, { name: 'x', tickets: [T()] }, { cwd: w.repo });
  return { root, w, s0 };
}
const shipped = (w, root) => w.git(w.remote, 'ls-tree', '-r', '--name-only', jobsBy(root, 'author')[0].branch);

test('the reviewer works in the ticket\'s copy, may write there (its temp folder too), and what it wrote never ships', async () => {
  const { root, w, s0 } = await world([{ write: 'a.txt' }], [{ write: 'review-scratch.txt', env: 'TMPDIR', tests: false, say: 'Ran the tests.\nVERDICT: pass' }]);
  const s = await run(root, s0.id, w.env, settled);
  assert.equal(s.tickets[0].state, 'pr-open', s.tickets[0].reason);
  const [author] = jobsBy(root, 'author');
  const [review] = jobsBy(root, 'reviewer');
  assert.equal(review.permission, 'edit-worktree');
  assert.equal(review.worktree, author.worktree, 'the ticket\'s own copy, with whatever the writer installed');
  // Its own temp folder, in the job's folder: writable, outside any git repo (tests that make fixture repos expect that),
  // and gone once the job ends.
  const tmp = path.join(findJobDir(root, review.id), 'tmp');
  assert.ok(outputOf(root, review).includes(`ENV TMPDIR=${tmp} writable=true`), outputOf(root, review));
  assert.ok(path.relative(author.worktree, tmp).startsWith('..'), 'not inside the copy');
  assert.equal(fs.existsSync(tmp), false);
  assert.equal(fs.existsSync(path.join(author.worktree, '.review-tmp')), false);
  assert.match(promptOf(root, review), /You are working in the ticket's own copy of the repo/);
  assert.deepEqual([review.status, review.hasChanges], ['done', false], 'a review holds no work to keep');
  const files = shipped(w, root);
  assert.match(files, /^a\.txt$/m);
  assert.doesNotMatch(files, /review-scratch|probe/);
});

test('a locked external review temp file stays outside Git while the next task checkpoints', {
  skip: process.platform !== 'win32' ? 'Windows file sharing is required' : false,
}, async () => {
  const { root, w } = sprintWorld({ plans: { 'docs/one.md': PLAN } });
  scriptAgent(root, 'fa', [{ write: 'a.txt' }, { write: 'b.txt' }]);
  scriptAgent(root, 'fr', [{ write: 'review-scratch.txt', tests: false, say: 'VERDICT: pass' }, { say: 'VERDICT: pass' }]);
  const s0 = await createSprint(root, { name: 'locked temp', tickets: [T()] }, { cwd: w.repo });
  await run(root, s0.id, w.env, (s) => s.tickets[0].phase === 'review');
  await setPaused(root, s0.id, true);
  const [review] = jobsBy(root, 'reviewer');
  const dir = findJobDir(root, review.id);
  await waitFor(() => ['done', 'needs-review'].includes(readJob(dir).status), { timeoutMs: 90_000 });
  const tmp = path.join(dir, 'tmp');
  const held = path.join(tmp, 'held.dll');
  const contents = 'external locked analyzer fixture';
  fs.mkdirSync(tmp, { recursive: true });
  fs.writeFileSync(held, contents);
  const holder = await holdFile(held);
  try {
    assert.equal(fs.readFileSync(held, 'utf8'), contents, 'the held file remains readable');
    assert.throws(() => fs.unlinkSync(held), (e) => ['EPERM', 'EACCES', 'EBUSY'].includes(e.code));
    await setPaused(root, s0.id, false);
    await run(root, s0.id, w.env, (s) => s.tickets[0].task === 1 && s.tickets[0].phase === 'review');
    assert.doesNotThrow(() => process.kill(holder.pid, 0), 'holder survived the next checkpoint');
    const authors = jobsBy(root, 'author');
    assert.equal(authors.length, 2);
    assert.ok(readJob(findJobDir(root, authors[1].id)).checkpoint, 'the next task was checkpointed');
    const s = await run(root, s0.id, w.env, settled);
    assert.equal(s.tickets[0].state, 'pr-open', s.tickets[0].reason);
    assert.doesNotThrow(() => process.kill(holder.pid, 0));
    assert.equal(fs.readFileSync(held, 'utf8'), contents, 'cleanup tolerates the external lock');
    const copy = authors[0].worktree;
    assert.equal(fs.existsSync(path.join(copy, '.review-tmp')), false);
    assert.ok(path.relative(copy, tmp).startsWith('..'));
    const stashes = w.git(copy, 'stash', 'list', '--format=%gd').split('\n').filter(Boolean);
    assert.ok(stashes.length, 'reviewer scratch changes exercised the checkpoint stash');
    const evidence = [
      w.git(copy, 'status', '--porcelain', '--untracked-files=all'),
      w.git(copy, 'diff', 'HEAD'),
      w.git(copy, 'diff', authors[0].baseCommit, authors[0].branch),
      w.git(copy, 'ls-tree', '-r', '--name-only', authors[0].branch),
      shipped(w, root),
      ...stashes.map((stash) => w.git(copy, 'stash', 'show', '--include-untracked', '-p', stash)),
    ].join('\n');
    for (const forbidden of [tmp, tmp.replaceAll('\\', '/'), 'held.dll', contents, '.review-tmp']) {
      assert.ok(!evidence.includes(forbidden), `Git must not contain ${forbidden}`);
    }
    assert.match(shipped(w, root), /^b\.txt$/m);
  } finally {
    await holder.release();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  assert.equal(fs.existsSync(tmp), false, 'normal cleanup succeeds after releasing the handle');
});

test('a reviewer that stops after writing leaves nothing the retried review commits', async () => {
  const { root, w, s0 } = await world([{ write: 'a.txt' }], [{ write: 'junk.txt', tests: false, exit: 3 }, { say: 'VERDICT: pass' }]);
  const parked = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  assert.equal(parked.tickets[0].resume, 'review');
  await retryTicket(root, s0.id, 'ABC-11');
  const s = await run(root, s0.id, w.env, settled);
  assert.equal(s.tickets[0].state, 'pr-open', s.tickets[0].reason);
  assert.doesNotMatch(shipped(w, root), /junk\.txt/);
});

test('stopping after a review that didn\'t finish keeps the reviewer\'s leftovers off the branch', async () => {
  const { root, w, s0 } = await world([{ write: 'a.txt' }], [{ write: 'junk.txt', tests: false, exit: 3 }]);
  await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  const s = await stopTicket(root, s0.id, 'ABC-11');
  assert.equal(s.tickets[0].state, 'stopped');
  const branch = jobsBy(root, 'author')[0].branch;
  assert.doesNotMatch(w.git(w.repo, 'ls-tree', '-r', '--name-only', branch), /junk\.txt/);
  assert.match(w.git(w.repo, 'stash', 'list'), /ABC-11's uncommitted changes before stopping/, 'saved aside, never deleted');
});

test('a task that failed review twice can be reviewed again with the person\'s evidence, which only that review weighs', async () => {
  const { root, w, s0 } = await world([{ write: 'a.txt' }, { write: 'b.txt' }], [{ say: 'Broken.\nVERDICT: fail' }, { say: 'Still broken.\nVERDICT: fail' }, { say: 'VERDICT: pass' }]);
  const parked = await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  const sum = sprintSummary(root, parked).tickets[0];
  assert.deepEqual([sum.canEvidence, sum.canAccept], [true, false]);
  await assert.rejects(reviewWithEvidence(root, s0.id, 'ABC-11', ' '), (e) => e.code === 'nothing-to-note');
  const t = (await reviewWithEvidence(root, s0.id, 'abc-11', EVIDENCE)).tickets[0];
  assert.deepEqual([t.state, t.resume, t.fails, t.reason], ['waiting', 'fix-review', 1, 'Fr reviews task 1 again with your evidence']);
  assert.deepEqual(t.notes.map((x) => [x.kind, x.task, x.index]), [['evidence', 1, 0]]);
  const s = await run(root, s0.id, w.env, settled);
  assert.equal(s.tickets[0].state, 'pr-open', s.tickets[0].reason);
  assert.equal(jobsBy(root, 'author').length, 2, 'no new fix: the same work is reviewed again');
  const reviews = jobsBy(root, 'reviewer');
  const last = promptOf(root, reviews[2]);
  assert.match(last, /The person gave evidence about this change, quoted next\. Weigh it before failing the task for tests you could not run\./);
  assert.ok(last.includes(EVIDENCE));
  assert.ok(!promptOf(root, reviews[1]).includes(EVIDENCE), 'reviews before it never had it');
  await assert.rejects(reviewWithEvidence(root, s0.id, 'ABC-11', EVIDENCE), (e) => e.code === 'not-review-park');
});

test('sprint evidence takes its text on stdin', async () => {
  const { root, w, s0 } = await world([{ write: 'a.txt' }, { write: 'b.txt' }], [{ say: 'Broken.\nVERDICT: fail' }, { say: 'Still broken.\nVERDICT: fail' }]);
  await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  let out = '';
  const stdout = new Writable({ write(c, _e, cb) { out += c; cb(); } });
  const code = await main(['sprint', 'evidence', '--id', s0.id, '--ticket', 'ABC-11', '--text', '-'], { stdout, stdin: Readable.from([`${EVIDENCE}\n`]), env: { ...process.env, PODIUM_DATA_DIR: root }, spawn: () => {} });
  assert.equal(code, 0, out);
  assert.equal(JSON.parse(out).sprint.tickets[0].notes[0].text, EVIDENCE);
});

test('only a sprint\'s own review step may work in a ticket\'s copy', async () => {
  const root = tempRoot();
  scriptAgent(root, 'fr', []);
  await assert.rejects(dispatch(root, { agent: 'fr', permission: 'edit-worktree', cwd: tempRoot(), prompt: 'x', inCopy: { worktree: tempRoot(), repoRoot: tempRoot() } }), (e) => e.code === 'bad-copy');
});

test('a review run again saves the person\'s edits in the copy aside, never deletes them', async () => {
  const { root, w, s0 } = await world([{ write: 'a.txt' }], [{ write: 'junk.txt', tests: false, exit: 3 }, { say: 'VERDICT: pass' }]);
  await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  const copy = jobsBy(root, 'author')[0].worktree;
  fs.writeFileSync(path.join(copy, 'mine.txt'), 'the person\'s\n');
  await retryTicket(root, s0.id, 'ABC-11');
  const s = await run(root, s0.id, w.env, settled);
  assert.equal(s.tickets[0].state, 'pr-open', s.tickets[0].reason);
  assert.match(w.git(copy, 'stash', 'list'), /ABC-11's uncommitted changes before reviewing again/);
  assert.match(w.git(copy, 'stash', 'show', '--include-untracked', '--name-only', 'stash@{0}'), /mine\.txt/);
  assert.ok(s.messages.some((m) => /^ABC-11: before its review ran again, changes left in its copy were saved as a git stash \(".*"\)\.$/.test(m.text)));
  assert.doesNotMatch(shipped(w, root), /mine\.txt|junk\.txt/);
});

test('a reviewer that switches branches and commits leaves the copy back on the ticket\'s branch, and nothing of it ships', async () => {
  const { root, w, s0 } = await world([{ write: 'a.txt' }], [{ branch: 'scratch', write: 'r.txt', tests: false, commit: 'reviewer work', say: 'VERDICT: pass' }]);
  const s = await run(root, s0.id, w.env, settled);
  assert.equal(s.tickets[0].state, 'pr-open', s.tickets[0].reason);
  const [author] = jobsBy(root, 'author');
  assert.equal(w.git(author.worktree, 'rev-parse', '--abbrev-ref', 'HEAD'), author.branch);
  assert.doesNotMatch(shipped(w, root), /r\.txt/);
});

test('a test\'s fixture repo in the reviewer\'s temp folder never reaches the ticket, and goes with the job', async () => {
  const { root, w, s0 } = await world([{ write: 'a.txt' }], [{ repoInTmp: true, tests: false, say: 'VERDICT: pass' }]);
  const s = await run(root, s0.id, w.env, settled);
  assert.equal(s.tickets[0].state, 'pr-open', s.tickets[0].reason);
  assert.doesNotMatch(shipped(w, root), /fixture/);
  assert.equal(fs.existsSync(path.join(findJobDir(root, jobsBy(root, 'reviewer')[0].id), 'tmp')), false);
});

test('commits a reviewer makes off the ticket\'s branch (detached) are kept on a branch of their own, never in the ticket', async () => {
  const { root, w, s0 } = await world([{ write: 'a.txt' }], [{ detach: true, write: 'r.txt', tests: false, commit: 'reviewer detached', say: 'VERDICT: pass' }]);
  const s = await run(root, s0.id, w.env, settled);
  assert.equal(s.tickets[0].state, 'pr-open', s.tickets[0].reason);
  const [author] = jobsBy(root, 'author');
  assert.equal(w.git(author.worktree, 'rev-parse', '--abbrev-ref', 'HEAD'), author.branch);
  assert.doesNotMatch(shipped(w, root), /r\.txt/);
  const note = s.messages.find((m) => /kept on branch podium\/abc-11-review-/.test(m.text));
  assert.ok(note, JSON.stringify(s.messages.map((m) => m.text)));
  const aside = note.text.match(/branch (podium\/abc-11-review-[0-9a-f]+)/)[1];
  assert.match(w.git(w.repo, 'ls-tree', '-r', '--name-only', aside), /r\.txt/, 'the reviewer\'s commit is still there');
});

test('stopping after a reviewer committed off the branch says where that commit is, and claims nothing kept on the branch', async () => {
  const { root, w, s0 } = await world([{ write: 'a.txt' }], [{ detach: true, write: 'r.txt', tests: false, commit: 'reviewer detached', exit: 3 }]);
  await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  const s = await stopTicket(root, s0.id, 'ABC-11');
  const text = s.messages.find((m) => m.text.startsWith('ABC-11 (Login form) was stopped.')).text;
  assert.match(text, /Commits a reviewer made off ABC-11's branch are kept on branch podium\/abc-11-review-[0-9a-f]+; none of them is in the ticket\./);
  assert.doesNotMatch(text, /It also keeps/);
  assert.doesNotMatch(w.git(w.repo, 'ls-tree', '-r', '--name-only', jobsBy(root, 'author')[0].branch), /r\.txt/);
});

test('stopping after a review that committed keeps the commit on the branch, and says so', async () => {
  const { root, w, s0 } = await world([{ write: 'a.txt' }], [{ write: 'r.txt', tests: false, commit: 'reviewer commit', exit: 3 }]);
  await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  const s = await stopTicket(root, s0.id, 'ABC-11');
  const text = s.messages.find((m) => m.text.startsWith('ABC-11 (Login form) was stopped.')).text;
  assert.match(text, /It also keeps a commit made in its copy since its review began \(newest: [0-9a-f]+ reviewer commit\): check it before using the branch\./);
  assert.match(w.git(w.repo, 'ls-tree', '-r', '--name-only', jobsBy(root, 'author')[0].branch), /r\.txt/);
});

test('a merge a reviewer left half done is aborted, said so, and never ships', async () => {
  const { root, w, s0 } = await world([{ write: 'a.txt' }], [{ mergeConflict: true, tests: false, say: 'VERDICT: pass' }]);
  const s = await run(root, s0.id, w.env, settled);
  assert.equal(s.tickets[0].state, 'pr-open', s.tickets[0].reason);
  assert.ok(s.messages.some((m) => /A merge left in progress in ABC-11's copy was aborted\./.test(m.text)), JSON.stringify(s.messages.map((m) => m.text)));
  const [author] = jobsBy(root, 'author');
  assert.equal(w.git(w.remote, 'show', `${author.branch}:a.txt`), 'a.txt');
});

test('a review\'s temp folder left behind (a cancel, a lost runner) goes when the copy is put back', async () => {
  const { root, w, s0 } = await world([{ write: 'a.txt' }], [{ tests: false, exit: 3 }, { say: 'VERDICT: pass' }]);
  await run(root, s0.id, w.env, (x) => x.tickets[0].state === 'parked');
  const leftover = path.join(findJobDir(root, jobsBy(root, 'reviewer')[0].id), 'tmp');
  fs.mkdirSync(leftover, { recursive: true });
  fs.writeFileSync(path.join(leftover, 'big.bin'), 'x');
  await retryTicket(root, s0.id, 'ABC-11');
  await run(root, s0.id, w.env, settled);
  assert.equal(fs.existsSync(leftover), false);
});

test('a branch for a reviewer\'s commits never takes over one that exists', async () => {
  const { freeBranch } = await import('../engine/sprint.js');
  const { w } = sprintWorld({ plans: { 'docs/one.md': ONE } });
  assert.equal(await freeBranch(w.repo, 'podium/abc-11-review-1234567'), 'podium/abc-11-review-1234567');
  w.git(w.repo, 'branch', 'podium/abc-11-review-1234567');
  w.git(w.repo, 'branch', 'podium/abc-11-review-1234567-2');
  assert.equal(await freeBranch(w.repo, 'podium/abc-11-review-1234567'), 'podium/abc-11-review-1234567-3');
});

test('a rebase a reviewer left part way keeps its rewritten commit aside before the rebase is aborted', async () => {
  const { root, w, s0 } = await world([{ write: 'a.txt' }], [{ rebaseStuck: true, tests: false, say: 'VERDICT: pass' }]);
  const s = await run(root, s0.id, w.env, settled);
  assert.equal(s.tickets[0].state, 'pr-open', s.tickets[0].reason);
  const note = s.messages.find((m) => /A rebase left in progress in ABC-11's copy was aborted\./.test(m.text));
  assert.ok(note, JSON.stringify(s.messages.map((m) => m.text)));
  const aside = note.text.match(/kept on branch (podium\/abc-11-review-[0-9a-f]+)/)?.[1];
  assert.ok(aside, note.text);
  assert.match(w.git(w.repo, 'ls-tree', '-r', '--name-only', aside), /amended\.txt/, 'the amended commit is still there');
  assert.doesNotMatch(shipped(w, root), /amended\.txt/);
});
