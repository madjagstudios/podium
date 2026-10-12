// Finished sprints are archived after their news is delivered. The pane still lists the newest finished sprints.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { createSprint, loadSprint, saveSprint, listSprints, locked, tick, markMessages } from '../engine/sprint.js';
import { createJob, updateJob } from '../engine/store.js';
import { main } from '../engine/cli.js';
import { scriptAgent, sprintWorld } from './helpers.js';

const T = (over = {}) => ({ key: 'ABC-11', title: 'Login form', type: 'feat', plan: 'docs/plan.md', agent: 'fa', reviewer: 'fr', ...over });

// A finished sprint whose tickets have PRs: the first ticket's PR is `first`, the second's is open.
async function shipped({ first = 'merged', second = null } = {}) {
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', []);
  scriptAgent(root, 'fr', []);
  const keys = second ? [T(), T({ key: 'ABC-12', title: 'Payouts' })] : [T()];
  const s0 = await createSprint(root, { name: 'x', tickets: keys }, { cwd: w.repo });
  const stored = loadSprint(root, s0.id);
  stored.tickets.forEach((t, i) => {
    const { job, dir } = createJob(root, { project: s0.project, ticket: t.key, agent: 'fa', permission: 'edit-worktree', cwd: w.repo, prompt: `${t.key} task 2: B` });
    updateJob(root, dir, { status: i === 0 ? first : second, sprint: { id: s0.id, ticket: t.key, task: 2, role: 'author' } });
    Object.assign(t, { state: 'pr-open', task: 2, thread: job.id, latest: job.id, pr: { number: 12 + i, url: `https://github.com/o/r/pull/${12 + i}` } });
  });
  stored.finishedAt = new Date().toISOString();
  saveSprint(root, stored);
  return { root, w, id: s0.id };
}

async function cli(root, argv, cwd) {
  let out = '';
  const stdout = new Writable({ write(c, _e, cb) { out += c; cb(); } });
  await main(argv, { stdout, env: { ...process.env, PODIUM_DATA_DIR: root }, cwd });
  return JSON.parse(out);
}

test('a tick records merged and closed PRs and archives the sprint when every ticket has ended', async () => {
  const { root, w, id } = await shipped({ first: 'merged', second: 'closed' });
  const s = await tick(root, id, { env: w.env });
  assert.deepEqual(s.tickets.map((t) => t.state), ['merged', 'closed']);
  assert.equal(s.archived, true);
  assert.equal(listSprints(root).length, 0, 'archived sprints are left out');
  assert.equal(listSprints(root, { includeArchived: true }).length, 1);
});

test('a tick does not archive a sprint with a PR still open', async () => {
  const { root, w, id } = await shipped({ first: 'merged', second: 'in-review' });
  const s = await tick(root, id, { env: w.env });
  assert.deepEqual(s.tickets.map((t) => t.state), ['merged', 'pr-open']);
  assert.equal(s.archived, undefined);
});

// `status --here` (the pane) still lists it, as finished and archived; sprint status does not.
test('status --here archives a sprint whose tickets all merged, and then lists it only as a finished, archived sprint', async () => {
  const { root, w, id } = await shipped();
  const first = await cli(root, ['status', '--here'], w.repo);
  assert.equal(first.sprints.length, 1);
  assert.equal(first.sprints[0].tickets[0].state, 'merged');
  const stored = loadSprint(root, id);
  assert.equal(stored.archived, true);
  assert.equal(stored.tickets[0].state, 'merged');
  assert.deepEqual((await cli(root, ['status', '--here'], w.repo)).sprints.map((s) => [s.id, s.archived]), [[id, true]]);
  assert.deepEqual((await cli(root, ['sprint', 'status', '--here'], w.repo)).sprints, []);
  assert.equal((await cli(root, ['sprint', 'status', '--id', id], w.repo)).sprints.length, 1, 'asked for by id, it still shows');
});

test('status --here does not wait on a busy sprint: it archives on a later call', async () => {
  const { root, w, id } = await shipped();
  const holder = locked(root, id, () => new Promise((r) => setTimeout(r, 1500)));
  const started = Date.now();
  assert.equal((await cli(root, ['status', '--here'], w.repo)).sprints.length, 1);
  assert.ok(Date.now() - started < 1200, 'did not wait for the holder');
  assert.equal(loadSprint(root, id).archived, undefined);
  await holder;
  await cli(root, ['status', '--here'], w.repo);
  assert.equal(loadSprint(root, id).archived, true);
});

test('sprint status archives too, and leaves a sprint with an open PR listed', async () => {
  const done = await shipped();
  await cli(done.root, ['sprint', 'status', '--here'], done.w.repo);
  assert.equal(loadSprint(done.root, done.id).archived, true);
  const open = await shipped({ first: 'in-review' });
  await cli(open.root, ['sprint', 'status', '--here'], open.w.repo);
  assert.equal(loadSprint(open.root, open.id).archived, undefined);
  assert.equal((await cli(open.root, ['status', '--here'], open.w.repo)).sprints.length, 1);
});

// Give a sprint one news message the chat has not taken yet.
function addNews(root, id) {
  const stored = loadSprint(root, id);
  stored.messages.push({ id: String(stored.messages.length + 1), at: new Date().toISOString(), text: 'Sprint "x" is done.', delivered: false, claimedAt: null });
  saveSprint(root, stored);
  return `${id}:${stored.messages.length}`;
}

test('status --here keeps a finished sprint listed while its news is undelivered, then archives it', async () => {
  const { root, w, id } = await shipped();
  const mid = addNews(root, id);
  assert.equal((await cli(root, ['status', '--here'], w.repo)).sprints.length, 1);
  assert.equal(loadSprint(root, id).archived, undefined, 'not archived with news waiting');
  assert.equal((await cli(root, ['status', '--here'], w.repo)).sprints.length, 1, 'still listed');
  await markMessages(root, [mid]);
  await cli(root, ['status', '--here'], w.repo);
  assert.equal(loadSprint(root, id).archived, true);
  // The pane still lists it, as finished and archived (not as live work).
  assert.deepEqual((await cli(root, ['status', '--here'], w.repo)).sprints.map((s) => [s.id, s.archived]), [[id, true]]);
});

// ---- Finished sprints stay listed after they are archived ----
// A sprint is archived once every ticket has ended and its news is delivered, seconds after it finishes; the pane's Done and
// Other chats folds list it, so `status --here` returns the newest finished ones that were archived because they ended.
// `finished` (created at `at`, the id's time) and `session` (its chat) can be set apart.
async function shippedIn(root, w, at, key, { finished = at, session = null } = {}) {
  const s0 = await createSprint(root, { name: `Sprint ${key}`, tickets: [T({ key })] }, { cwd: w.repo, now: at, session });
  const stored = loadSprint(root, s0.id);
  const t = stored.tickets[0];
  const { job, dir } = createJob(root, { project: s0.project, ticket: t.key, agent: 'fa', permission: 'edit-worktree', cwd: w.repo, prompt: `${t.key} task 2: B` });
  updateJob(root, dir, { status: 'merged', sprint: { id: s0.id, ticket: t.key, task: 2, role: 'author' } });
  Object.assign(t, { state: 'pr-open', task: 2, thread: job.id, latest: job.id, pr: { number: 12, url: 'https://github.com/o/r/pull/12' } });
  stored.finishedAt = finished ? finished.toISOString() : null;
  saveSprint(root, stored);
  return s0.id;
}

test('the pane is sent FINISHED_SPRINTS + 1 finished archived sprints of each fold', async () => {
  const { PANE_FINISHED } = await import('../engine/sprint.js');
  const { FINISHED_SPRINTS } = await import('../mod/view.js');
  assert.equal(PANE_FINISHED, FINISHED_SPRINTS + 1);
});

test('status --here still returns a finished sprint archived after its news was delivered, marked archived and finished', async () => {
  const { isFinishedSprint } = await import('../mod/view.js');
  const { sprintSummaries } = await import('../engine/sprint.js');
  const { root, w, id } = await shipped();
  const mid = addNews(root, id);
  await cli(root, ['status', '--here'], w.repo);
  await markMessages(root, [mid]);
  await cli(root, ['status', '--here'], w.repo);
  assert.equal(loadSprint(root, id).archived, true, 'archived once its news was delivered');
  const out = await cli(root, ['status', '--here'], w.repo);
  assert.deepEqual(out.sprints.map((s) => s.id), [id], 'still listed for the pane');
  assert.equal(out.sprints[0].archived, true);
  assert.equal(out.sprints[0].news, 0);
  assert.equal(isFinishedSprint(out.sprints[0]), true);
  assert.deepEqual(out.olderFinished, { mine: 0, others: 0 });
  // Without the option (the tool's sprint status, listSprints) an archived sprint is left out.
  assert.deepEqual(sprintSummaries(root, { project: loadSprint(root, id).project }), []);
  assert.deepEqual((await cli(root, ['sprint', 'status', '--here'], w.repo)).sprints, []);
});

test('a discarded draft is never returned as finished', async () => {
  const { sprintSummaries, draftSprint, discardSprint } = await import('../engine/sprint.js');
  const { isFinishedSprint } = await import('../mod/view.js');
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', []);
  scriptAgent(root, 'fr', []);
  const d = await draftSprint(root, { name: 'thrown away', tickets: [T()] }, { cwd: w.repo });
  await discardSprint(root, d.id);
  assert.deepEqual(sprintSummaries(root, { finished: 11 }), []);
  assert.deepEqual((await cli(root, ['status', '--here'], w.repo)).sprints, []);
  // Even one whose tickets all ended: discarded is never finished.
  const stored = loadSprint(root, d.id);
  stored.tickets.forEach((t) => { t.state = 'stopped'; });
  saveSprint(root, stored);
  assert.deepEqual(sprintSummaries(root, { finished: 11 }), []);
  assert.equal(isFinishedSprint({ draft: false, discarded: true, archived: true, tickets: [{ state: 'stopped' }] }), false);
});

test('only the newest N finished archived sprints come back, by finish time; the rest are counted; an open sprint is always listed', async () => {
  const { sprintSummaries } = await import('../engine/sprint.js');
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', []);
  scriptAgent(root, 'fr', []);
  const ids = [];
  for (let i = 0; i < 4; i += 1) ids.push(await shippedIn(root, w, new Date(Date.UTC(2026, 9, 1, 10, i)), `ABC-${20 + i}`));
  await cli(root, ['status', '--here'], w.repo);
  for (const id of ids) assert.equal(loadSprint(root, id).archived, true);
  const open = await createSprint(root, { name: 'still going', tickets: [T({ key: 'ABC-30' })] }, { cwd: w.repo, now: new Date(Date.UTC(2026, 8, 1)) });
  const counts = {};
  const two = sprintSummaries(root, { finished: 2, counts });
  assert.deepEqual(two.map((s) => s.id), [ids[3], ids[2], open.id], 'the newest two archived, and the open one whatever its age');
  assert.deepEqual(counts.olderFinished, { mine: 2, others: 0 }, 'no session: all are this chat\'s');
  const out = await cli(root, ['status', '--here'], w.repo);
  assert.deepEqual(out.sprints.map((s) => s.id), [...[...ids].reverse(), open.id]);
  assert.deepEqual(out.olderFinished, { mine: 0, others: 0 });
  assert.ok(out.sprints.filter((s) => s.archived).every((s) => s.news === 0));
});

// Picking the newest by creation id across every chat hid this chat's most recently finished sprint
// behind newer-created sprints of another chat. The pick is per chat, by finish time.
test('finished archived sprints are picked per chat by finish time: 20 across two chats, the oldest-created finished last', async () => {
  const { sprintSummaries, PANE_FINISHED } = await import('../engine/sprint.js');
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', []);
  scriptAgent(root, 'fr', []);
  const at = (day, h = 10) => new Date(Date.UTC(2026, 9, day, h));
  // This chat: 8 sprints. m0 was created first of all but finished last of all.
  const mine = [];
  mine.push(await shippedIn(root, w, at(1), 'ME-0', { session: 'me', finished: at(28) }));
  for (let i = 1; i < 8; i += 1) mine.push(await shippedIn(root, w, at(2 + i), `ME-${i}`, { session: 'me', finished: at(10 + ((i * 5) % 8)) }));
  // Another chat: 12 sprints created after all of this chat's, finished in a mixed order; one finished with no time recorded.
  const theirs = [];
  for (let i = 0; i < 12; i += 1) theirs.push(await shippedIn(root, w, at(12 + i), `TH-${i}`, { session: 'other', finished: i === 4 ? null : at(13 + ((i * 7) % 12), 12) }));
  await cli(root, ['status', '--here'], w.repo);
  for (const id of [...mine, ...theirs]) assert.equal(loadSprint(root, id).archived, true);
  // The expected pick, worked out from the stored sprints: newest finishedAt first, a missing one last, ties by id.
  const order = (ids) => ids.map((id) => loadSprint(root, id)).sort((a, b) => (Date.parse(b.finishedAt ?? '') || 0) - (Date.parse(a.finishedAt ?? '') || 0) || b.id.localeCompare(a.id)).map((s) => s.id);
  const want = [...order(mine).slice(0, PANE_FINISHED), ...order(theirs).slice(0, PANE_FINISHED)].sort().reverse();
  const counts = {};
  const got = sprintSummaries(root, { finished: PANE_FINISHED, session: 'me', counts });
  assert.deepEqual(got.map((s) => s.id), want);
  assert.ok(got.some((s) => s.id === mine[0]), 'this chat\'s most recently finished sprint is there, though created first');
  assert.ok(!got.some((s) => s.id === theirs[4]), 'one with no finish time is the oldest');
  assert.deepEqual(counts.olderFinished, { mine: 8 - PANE_FINISHED, others: 12 - PANE_FINISHED });
  assert.ok(got.every((s) => s.chat === (mine.includes(s.id) ? 'me' : 'other')), 'each carries its chat');
  // The CLI path the pane uses, with its chat.
  const out = await cli(root, ['status', '--here', '--session', 'me'], w.repo);
  assert.deepEqual(out.sprints.map((s) => s.id), want);
  assert.deepEqual(out.olderFinished, { mine: 2, others: 6 });
  // Seen from the other chat, the buckets swap; with no chat, all 20 are one bucket.
  assert.deepEqual((await cli(root, ['status', '--here', '--session', 'other'], w.repo)).olderFinished, { mine: 6, others: 2 });
  const none = await cli(root, ['status', '--here'], w.repo);
  assert.deepEqual(none.olderFinished, { mine: 14, others: 0 });
  assert.deepEqual(none.sprints.map((s) => s.id), order([...mine, ...theirs]).slice(0, PANE_FINISHED).sort().reverse());
});

// An open board's sprint archived behind six newer finished ones fell out of the list, and its board
// said "That sprint is no longer listed". The pane names it (`--sprint`), and it comes back beside the newest, never instead.
test('a named finished archived sprint is returned beside the newest 6, never instead of one, and counted once', async () => {
  const { sprintSummaries, draftSprint, discardSprint, PANE_FINISHED } = await import('../engine/sprint.js');
  const { root, w } = sprintWorld();
  scriptAgent(root, 'fa', []);
  scriptAgent(root, 'fr', []);
  const at = (day) => new Date(Date.UTC(2026, 9, day, 10));
  // 8 of this chat's: old0 finished first of all, old1 next; the newest 6 are n2…n7.
  const ids = [];
  for (let i = 0; i < 8; i += 1) ids.push(await shippedIn(root, w, at(1 + i), `ON-${i}`, { session: 'me', finished: at(10 + i) }));
  const thrown = await draftSprint(root, { name: 'thrown away', tickets: [T({ key: 'ON-99' })] }, { cwd: w.repo, session: 'me' });
  await discardSprint(root, thrown.id);
  await cli(root, ['status', '--here'], w.repo);
  for (const id of ids) assert.equal(loadSprint(root, id).archived, true);
  const newest = [...ids].slice(2).reverse();
  const run = (sprint) => { const counts = {}; return { got: sprintSummaries(root, { finished: PANE_FINISHED, session: 'me', sprint, counts }).map((s) => s.id), older: counts.olderFinished }; };
  // Not named: the newest 6, and 2 more counted.
  assert.deepEqual(run(null), { got: newest, older: { mine: 2, others: 0 } });
  // Named and older than the 6: returned beside them, and not counted among the older ones (the pane counts what it lists).
  assert.deepEqual(run(ids[0]), { got: [...newest, ids[0]].sort().reverse(), older: { mine: 1, others: 0 } });
  // Named and one of the 6: the 6 are still the newest 6 of the rest, so it never takes another's place; 1 left over.
  assert.deepEqual(run(ids[7]), { got: [ids[7], ...[...ids].slice(1, 7).reverse()], older: { mine: 1, others: 0 } });
  // Every one either listed or counted, exactly once, both ways.
  for (const named of [null, ids[0], ids[7]]) { const r = run(named); assert.equal(r.got.length + r.older.mine, 8); }
  // A thrown-away sprint is never returned, named or not.
  assert.deepEqual(run(thrown.id), { got: newest, older: { mine: 2, others: 0 } });
  // The CLI path the pane uses.
  const out = await cli(root, ['status', '--here', '--session', 'me', '--sprint', ids[0]], w.repo);
  assert.ok(out.sprints.some((s) => s.id === ids[0] && s.archived === true));
  assert.deepEqual(out.olderFinished, { mine: 1, others: 0 });
  assert.ok(!(await cli(root, ['status', '--here', '--session', 'me'], w.repo)).sprints.some((s) => s.id === ids[0]));
});

// A tick on an archived sprint with no finishedAt recorded made new news, which the inbox then claimed.
async function archivedNoFinish() {
  const { root, w, id } = await shipped();
  await cli(root, ['status', '--here'], w.repo);
  const s = loadSprint(root, id);
  assert.equal(s.archived, true);
  s.finishedAt = null;
  saveSprint(root, s);
  return { root, w, id };
}

test('a tick on an archived sprint changes nothing and makes no news', async () => {
  const { root, w, id } = await archivedNoFinish();
  const before = loadSprint(root, id);
  const after = await tick(root, id, { env: w.env });
  assert.deepEqual(after.messages, [], 'no news');
  assert.equal(after.finishedAt, null);
  assert.deepEqual(loadSprint(root, id), before, 'nothing saved');
});

test('an archived or discarded sprint never wants its runner', async () => {
  const { wantsRunner } = await import('../engine/sprint.js');
  const { root, id } = await archivedNoFinish();
  const s = loadSprint(root, id);
  s.tickets[0].state = 'pending';
  assert.equal(wantsRunner(root, s), false);
  assert.equal(wantsRunner(root, { ...s, archived: false }), true, 'the same sprint unarchived would');
  assert.equal(wantsRunner(root, { ...s, archived: false, discardedAt: '2026-10-01T00:00:00Z' }), false);
});

test('the inbox never claims news from an archived sprint, even one archived after it was listed', async () => {
  const { claimMessages, setReadHook } = await import('../engine/sprint.js');
  const { root, id } = await archivedNoFinish();
  addNews(root, id);
  assert.deepEqual((await claimMessages(root, 'chat-1')).messages, [], 'archived when listed');
  // Unarchived when the inbox lists it, archived by the time it holds the lock.
  const s = loadSprint(root, id);
  s.archived = false;
  saveSprint(root, s);
  let armed = true;
  setReadHook((file) => {
    if (!armed || !file.includes(id)) return;
    armed = false;
    const now = loadSprint(root, id);
    now.archived = true;
    saveSprint(root, now);
  });
  try {
    assert.deepEqual((await claimMessages(root, 'chat-1')).messages, [], 'checked again under the lock');
  } finally {
    setReadHook(null);
  }
  assert.ok(loadSprint(root, id).messages.every((m) => !m.claimedAt), 'nothing marked claimed');
});

test('archiveEnded passes over a sprint that is already archived, taking no lock', async () => {
  const { archiveEnded, sprintSummaries } = await import('../engine/sprint.js');
  const { root, w, id } = await shipped();
  await cli(root, ['status', '--here'], w.repo);
  assert.equal(loadSprint(root, id).archived, true);
  const listed = sprintSummaries(root, { finished: 11 });
  assert.equal(listed.length, 1);
  // Held lock: archiveEnded would wait on it (and give up) if it tried; it must not try at all.
  const holder = locked(root, id, () => new Promise((r) => setTimeout(r, 1500)));
  const started = Date.now();
  await archiveEnded(root, listed);
  assert.ok(Date.now() - started < 150, `${Date.now() - started} ms: it did not try the lock`);
  await holder;
});

test('a tick does not archive a finished sprint with undelivered news, and does once it is delivered', async () => {
  const { root, w, id } = await shipped();
  const mid = addNews(root, id);
  const s = await tick(root, id, { env: w.env });
  assert.deepEqual(s.tickets.map((t) => t.state), ['merged']);
  assert.equal(s.archived, undefined);
  assert.equal(listSprints(root).length, 1);
  await markMessages(root, [mid]);
  assert.equal((await tick(root, id, { env: w.env })).archived, true);
});
