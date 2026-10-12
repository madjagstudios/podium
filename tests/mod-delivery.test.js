// The order in which finished work reaches Claude. The kit cannot answer $.session.append (a test's
// on('session.append') is never called: it always fails), so the hidden-row success path is tested here,
// on the pure helper; the kit tests cover the fallback into the visible message.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handOver, sprintNewsPass, keepFresh } from '../mod/delivery.js';

// A hand-over world: what the hidden row and the visible message received.
function world({ appendFails = false, appendAnswer, submitFails = false } = {}) {
  const w = { order: [], rows: 0, submitted: [] };
  w.deps = {
    headline: 'Podium: Codex finished: "Add a file"',
    details: '[Podium] Codex finished.\n\nSummary:\nAdded a file.',
    append: async () => { if (appendFails) throw new Error('no session.append'); w.rows++; w.order.push('details'); return appendAnswer; },
    submit: async (text) => { if (submitFails) throw new Error('reloaded'); w.submitted.push(text); w.order.push('message'); },
  };
  return w;
}

test('handOver sends the details as a hidden row, then the bare headline, and says it went in', async () => {
  const w = world();
  assert.equal(await handOver(w.deps), true);
  assert.deepEqual(w.order, ['details', 'message']);
  assert.deepEqual(w.submitted, [w.deps.headline]);
});

test('when the hidden row fails, one message holds the headline first and the details after it', async () => {
  const w = world({ appendFails: true });
  assert.equal(await handOver(w.deps), true);
  assert.equal(w.submitted.length, 1);
  assert.ok(w.submitted[0].startsWith(w.deps.headline));
  assert.ok(w.submitted[0].includes(w.deps.details));
  assert.equal(w.submitted[0], `${w.deps.headline}\n\n${w.deps.details}`);
  assert.equal(w.rows, 0);
});

test('when the host has no session.append at all, the details still go in the visible message', async () => {
  const w = world();
  w.deps.append = () => { const $ = {}; return $.session.append({}); }; // TypeError, as with a missing noun
  assert.equal(await handOver(w.deps), true);
  assert.ok(w.submitted[0].startsWith(w.deps.headline) && w.submitted[0].includes(w.deps.details));
});

test('handOver says nothing went in when the message fails, with or without the hidden row', async () => {
  assert.equal(await handOver(world({ submitFails: true }).deps), false);
  assert.equal(await handOver(world({ appendFails: true, submitFails: true }).deps), false);
});

test('a row a plugin refused on purpose is respected: headline only, no details forced into the chat', async () => {
  const w = world({ appendAnswer: { deny: 'policy' } });
  assert.equal(await handOver(w.deps), true);
  assert.deepEqual(w.submitted, [w.deps.headline]);
});

test('a prompt a hook dropped on purpose still counts as handled', async () => {
  const w = world();
  w.deps.submit = async () => ({ drop: 'blocked by a hook' });
  assert.equal(await handOver(w.deps), true);
});

// A sprint news world: an inbox, a log of what went in, and a mark that fails `markFails` times.
function newsWorld({ markFails = 0, sendOk = true } = {}) {
  const w = { announced: new Set(), inFlight: new Set(), inbox: [], sent: [], marks: [], markFails };
  w.deps = {
    announced: w.announced,
    inFlight: w.inFlight,
    hasNews: async () => true,
    claim: async () => { const l = w.inbox; w.inbox = []; return l; },
    tellClaude: async () => true,
    send: async (list) => { if (!sendOk) return false; w.sent.push(list.map((m) => m.id)); return true; },
    toast: () => { throw new Error('not told by toast here'); },
    mark: async (ids) => { w.marks.push(ids); if (w.markFails > 0) { w.markFails--; return null; } return { failed: [] }; },
  };
  return w;
}
const NEWS = { id: 's1:1', sprint: 'Oct week 2', text: 'ABC-12 (Payouts) needs you' };

test('sprint news goes in once and is marked delivered', async () => {
  const w = newsWorld();
  w.inbox = [NEWS];
  await sprintNewsPass(w.deps);
  assert.deepEqual(w.sent, [['s1:1']]);
  assert.deepEqual(w.marks, [['s1:1']]);
  assert.equal(w.announced.size, 0);
});

test('sprint news whose message cannot go in is neither announced nor marked', async () => {
  const w = newsWorld({ sendOk: false });
  w.inbox = [NEWS];
  await sprintNewsPass(w.deps);
  assert.deepEqual(w.marks, []);
  assert.equal(w.announced.size, 0);
});

test('a failed delivered mark is tried again first, and the news is never announced twice', async () => {
  const w = newsWorld({ markFails: 2 });
  w.inbox = [NEWS];
  await sprintNewsPass(w.deps);
  assert.deepEqual(w.sent, [['s1:1']]);
  assert.deepEqual([...w.announced], ['s1:1'], 'announced, not yet confirmed');
  // Next pass: its claim has expired, so the inbox hands it back.
  w.inbox = [NEWS];
  await sprintNewsPass(w.deps);
  assert.deepEqual(w.sent, [['s1:1']], 'the headline is not sent again');
  assert.deepEqual(w.marks, [['s1:1'], ['s1:1'], ['s1:1']]);
  assert.equal(w.announced.size, 0);
});

test('a mark that answers some ids failed keeps only those to try again', async () => {
  const w = newsWorld();
  w.deps.mark = async (ids) => { w.marks.push(ids); return { failed: ids.filter((id) => id === 's2:1') }; };
  w.inbox = [NEWS, { id: 's2:1', sprint: 'Other', text: 'x' }];
  await sprintNewsPass(w.deps);
  assert.deepEqual([...w.announced], ['s2:1']);
});

test('a second pass while the first is still sending sends nothing; the notice is marked once', { timeout: 2000 }, async () => {
  const w = newsWorld();
  let release, calls = 0;
  // Only the first send waits; any later send records and resolves at once, so wrong code fails instead of hanging.
  w.deps.send = (list) => {
    if (calls++ > 0) { w.sent.push(list.map((m) => m.id)); return Promise.resolve(true); }
    return new Promise((resolve) => { release = () => { w.sent.push(list.map((m) => m.id)); resolve(true); }; });
  };
  w.inbox = [NEWS];
  const first = sprintNewsPass(w.deps);
  await new Promise((r) => setImmediate(r));
  // The 2-minute claim ran out while the send waited behind a busy turn: the inbox hands the same notice back.
  w.inbox = [NEWS];
  await sprintNewsPass(w.deps);
  assert.deepEqual(w.sent, [], 'the second pass sends nothing');
  release();
  await first;
  assert.deepEqual(w.sent, [['s1:1']]);
  assert.deepEqual(w.marks, [['s1:1']]);
  assert.equal(w.inFlight.size, 0);
});

test('one pass at a time: a pass that finds one running returns at once and asks nothing', { timeout: 2000 }, async () => {
  const w = newsWorld();
  const busy = { on: false };
  let release, asked = 0;
  w.deps.hasNews = async () => { asked++; return true; };
  w.deps.send = (list) => new Promise((resolve) => { release = () => { w.sent.push(list.map((m) => m.id)); resolve(true); }; });
  w.inbox = [NEWS];
  const first = sprintNewsPass({ ...w.deps, busy });
  await new Promise((r) => setImmediate(r));
  assert.equal(busy.on, true, 'the first pass holds it while its send waits');
  w.inbox = [NEWS];
  await sprintNewsPass({ ...w.deps, busy });
  assert.equal(asked, 1, 'the second pass asked nothing');
  release();
  await first;
  assert.equal(busy.on, false);
  assert.deepEqual(w.sent, [['s1:1']]);
  assert.deepEqual(w.marks, [['s1:1']]);
});

test('a pass that throws lets go, so the next pass runs', async () => {
  const w = newsWorld();
  const busy = { on: false };
  w.deps.claim = async () => { throw new Error('engine gone'); };
  await assert.rejects(sprintNewsPass({ ...w.deps, busy }), /engine gone/);
  assert.equal(busy.on, false);
  w.deps.claim = async () => [NEWS];
  await sprintNewsPass({ ...w.deps, busy });
  assert.deepEqual(w.sent, [['s1:1']]);
});

test('a send that fails clears the in-flight mark, so the notice is tried again', async () => {
  const w = newsWorld({ sendOk: false });
  w.inbox = [NEWS];
  await sprintNewsPass(w.deps);
  assert.equal(w.inFlight.size, 0);
  w.deps.send = async (list) => { w.sent.push(list.map((m) => m.id)); return true; };
  w.inbox = [NEWS];
  await sprintNewsPass(w.deps);
  assert.deepEqual(w.sent, [['s1:1']]);
});

test('keepFresh refreshes while the work waits, and stops once it is done', async () => {
  const wakes = [];
  const sleep = () => new Promise((r) => wakes.push(r));
  let refreshed = 0;
  let finish;
  const work = new Promise((r) => { finish = r; });
  const tick = () => new Promise((r) => setImmediate(r));
  const result = keepFresh(() => work, { sleep, refresh: async () => { refreshed++; } });
  await tick();
  wakes.shift()(); await tick();
  wakes.shift()(); await tick();
  assert.equal(refreshed, 2);
  finish(true);
  assert.equal(await result, true);
  wakes.shift()(); await tick();
  assert.equal(refreshed, 2, 'no refresh after the work is done');
});

// The old heartbeat stopped after 180 beats (an hour at 20 s), and a submit can wait longer; the lock then
// went stale and another chat could claim the job. It now beats until the work settles.
test('keepFresh keeps renewing a delivery still pending past 180 beats, and stops once it settles', async () => {
  const wakes = [];
  const sleep = () => new Promise((r) => wakes.push(r));
  const tick = () => new Promise((r) => setImmediate(r));
  let refreshed = 0;
  let finish;
  const work = new Promise((r) => { finish = r; });
  const result = keepFresh(() => work, { sleep, refresh: async () => { refreshed++; } });
  await tick();
  for (let i = 0; i < 250; i++) {
    assert.equal(wakes.length, 1, `beat ${i + 1} is waiting to wake`);
    wakes.shift()();
    await tick();
  }
  assert.equal(refreshed, 250);
  finish('sent');
  assert.equal(await result, 'sent');
  if (wakes.length) { wakes.shift()(); await tick(); }
  assert.equal(refreshed, 250, 'no refresh after it settled');
});

test('a renewal that fails does not end the heartbeat: the next beat renews again', async () => {
  const wakes = [];
  const sleep = () => new Promise((r) => wakes.push(r));
  const tick = () => new Promise((r) => setImmediate(r));
  const calls = [];
  const refresh = async () => {
    calls.push(calls.length + 1);
    if (calls.length === 1) throw new Error('podium claim --refresh failed');
    if (calls.length === 2) return Promise.reject(new Error('busy'));
  };
  let finish;
  const work = new Promise((r) => { finish = r; });
  const result = keepFresh(() => work, { sleep, refresh });
  await tick();
  for (let i = 0; i < 4; i++) { wakes.shift()(); await tick(); }
  assert.deepEqual(calls, [1, 2, 3, 4]);
  assert.equal(wakes.length, 1, 'still beating');
  finish(true);
  assert.equal(await result, true);
});

test('keepFresh waits for a refresh still in flight, so it cannot land after the caller releases', async () => {
  const wakes = [];
  const sleep = () => new Promise((r) => wakes.push(r));
  const tick = () => new Promise((r) => setImmediate(r));
  let landRefresh;
  const events = [];
  const refresh = () => new Promise((r) => { landRefresh = () => { events.push('refresh landed'); r(); }; });
  let finish;
  const work = new Promise((r) => { finish = r; });
  const result = keepFresh(() => work, { sleep, refresh }).then((v) => { events.push('keepFresh returned'); return v; });
  await tick();
  wakes.shift()(); await tick();
  assert.ok(landRefresh, 'a refresh is in flight');
  finish('sent'); await tick();
  assert.deepEqual(events, [], 'keepFresh holds back while the refresh is in flight');
  landRefresh();
  assert.equal(await result, 'sent');
  assert.deepEqual(events, ['refresh landed', 'keepFresh returned']);
});
