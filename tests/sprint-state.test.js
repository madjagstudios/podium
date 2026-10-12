// A sprint's state is a numbered file per version, and a save commits the next
// number only if no one has taken it (compare-and-swap), so a writer working from old state can never
// overwrite newer state.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadSprint, saveSprint, listSprints, setPaused, retryTicket, setReadHook, setHardLinks, setCommitHook } from '../engine/sprint.js';
import { tempRoot } from './helpers.js';

const name = (n) => `${String(n).padStart(12, '0')}.json`;

function world() {
  const root = tempRoot();
  const id = 'state-test';
  saveSprint(root, { id, count: 0 });
  return { root, id, state: path.join(root, 'sprints', id, 'state') };
}
const versions = (state) => fs.readdirSync(state).filter((f) => /^\d{12}\.json$/.test(f)).sort();
const busy = (e) => e.code === 'sprint-busy';

test('a new sprint is committed as version 1', () => {
  const { root, id, state } = world();
  assert.deepEqual(versions(state), [name(1)]);
  assert.deepEqual(loadSprint(root, id), { id, count: 0 });
  assert.equal(fs.existsSync(path.join(root, 'sprints', id, 'sprint.json')), false, 'no sprint.json is written');
});

test('two copies loaded at the same version: the first save wins, the second is refused', () => {
  const { root, id } = world();
  const a = loadSprint(root, id);
  const b = loadSprint(root, id);
  a.count = 1;
  saveSprint(root, a);
  b.count = 99;
  assert.throws(() => saveSprint(root, b), busy);
  assert.equal(loadSprint(root, id).count, 1, 'the stored state is the first save');
});

test('saving the same copy twice commits consecutive versions', () => {
  const { root, id, state } = world();
  const s = loadSprint(root, id);
  s.count = 1;
  saveSprint(root, s);
  s.count = 2;
  saveSprint(root, s);
  assert.deepEqual(versions(state), [name(1), name(2), name(3)]);
  assert.equal(loadSprint(root, id).count, 2);
});

test('a refused save leaves no temp file and changes nothing', () => {
  const { root, id, state } = world();
  const stale = loadSprint(root, id);
  saveSprint(root, loadSprint(root, id));
  assert.throws(() => saveSprint(root, stale), busy);
  assert.deepEqual(fs.readdirSync(state).sort(), [name(1), name(2)]);
});

test('old versions are pruned: the newest 10 stay', () => {
  const { root, id, state } = world();
  const s = loadSprint(root, id);
  for (let i = 1; i <= 15; i++) { s.count = i; saveSprint(root, s); }
  assert.deepEqual(versions(state), Array.from({ length: 10 }, (_, i) => name(i + 7)));
  assert.equal(loadSprint(root, id).count, 15);
});

// Where hard links are refused, a commit writes the file in place, so a reader can meet it half written.
function noLinks(t) {
  setHardLinks(false);
  t.after(() => setHardLinks(true));
}

test('without hard links, an unparsable newest file is skipped: the version below it is read', (t) => {
  noLinks(t);
  const { root, id, state } = world();
  const s = loadSprint(root, id);
  s.count = 1;
  saveSprint(root, s);
  fs.writeFileSync(path.join(state, name(3)), '{"id": "state-te');
  assert.equal(loadSprint(root, id).count, 1);
  // It may be a write still in progress, so its number is not free: a save from what was read is refused.
  assert.throws(() => saveSprint(root, loadSprint(root, id)), busy);
});

test('without hard links, an unparsable newest file left long ago is a dead write: its number counts as used', (t) => {
  noLinks(t);
  const { root, id, state } = world();
  const dead = path.join(state, name(2));
  fs.writeFileSync(dead, '');
  const old = new Date(Date.now() - 120_000);
  fs.utimesSync(dead, old, old);
  const s = loadSprint(root, id);
  assert.equal(s.count, 0);
  s.count = 5;
  saveSprint(root, s);
  assert.equal(loadSprint(root, id).count, 5);
  assert.ok(versions(state).includes(name(3)));
});

test('a sprint with only a legacy sprint.json loads as version 0, and its first save writes version 1', () => {
  const root = tempRoot();
  const id = 'legacy';
  const dir = path.join(root, 'sprints', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'sprint.json'), JSON.stringify({ id, count: 7, project: 'p' }));
  const s = loadSprint(root, id);
  assert.equal(s.count, 7);
  assert.equal(listSprints(root, { project: 'p' }).length, 1);
  s.count = 8;
  saveSprint(root, s);
  assert.deepEqual(versions(path.join(dir, 'state')), [name(1)]);
  assert.equal(loadSprint(root, id).count, 8);
  assert.ok(fs.existsSync(path.join(dir, 'sprint.json')), 'the legacy file is left in place');
  // A second copy read from the legacy file (version 0) can no longer commit.
  const legacyCopy = JSON.parse(fs.readFileSync(path.join(dir, 'sprint.json'), 'utf8'));
  assert.throws(() => saveSprint(root, legacyCopy), busy);
});

test('listSprints reads the newest version of each sprint', () => {
  const { root, id } = world();
  const s = loadSprint(root, id);
  s.archived = true;
  saveSprint(root, s);
  assert.equal(listSprints(root).length, 0);
  assert.equal(listSprints(root, { includeArchived: true })[0].archived, true);
});

// A read error is not a dead write. Version 1 is unpaused, version 2 paused a minute ago.
function pausedWorld() {
  const root = tempRoot();
  const id = 'paused-test';
  const ticket = { key: 'ABC-1', state: 'parked', resume: 'pr', task: 0, tasks: [{ n: 1, agent: 'codex', reviewer: 'claude' }] };
  const s = { id, paused: false, tickets: [ticket], messages: [] };
  saveSprint(root, s);
  s.paused = true;
  saveSprint(root, s);
  const state = path.join(root, 'sprints', id, 'state');
  const old = new Date(Date.now() - 60_000);
  for (const f of versions(state)) fs.utimesSync(path.join(state, f), old, old);
  return { root, id, state };
}

// Reading the state file named `file` fails with `code` for the first `times` reads (Infinity: always).
function failReads(t, file, code, times) {
  let left = times;
  setReadHook((f) => {
    if (path.basename(f) === file && left-- > 0) throw Object.assign(new Error(`${code}: simulated`), { code });
  });
  t.after(() => setReadHook(null));
}

for (const code of ['EACCES', 'EPERM', 'EBUSY']) {
  test(`a read error (${code}) on the newest state is never taken for an older state: the save is refused`, async (t) => {
    const { root, id, state } = pausedWorld();
    failReads(t, name(2), code, Infinity);
    await assert.rejects(retryTicket(root, id, 'ABC-1'), busy);
    await assert.rejects(setPaused(root, id, true), busy);
    assert.throws(() => loadSprint(root, id), busy);
    setReadHook(null);
    assert.deepEqual(versions(state), [name(1), name(2)], 'nothing was committed');
    const now = loadSprint(root, id);
    assert.equal(now.paused, true, 'the pause stands');
    assert.equal(now.tickets[0].state, 'parked');
  });
}

test('a read error that clears within the retries still reads the newest state', async (t) => {
  const { root, id, state } = pausedWorld();
  failReads(t, name(2), 'EBUSY', 2);
  await retryTicket(root, id, 'ABC-1');
  setReadHook(null);
  assert.deepEqual(versions(state), [name(1), name(2), name(3)]);
  const now = loadSprint(root, id);
  assert.equal(now.paused, true, 'the pause stands');
  assert.equal(now.tickets[0].state, 'waiting', 'the retry went in');
});

for (const age of ['old', 'new']) {
  test(`with hard links, an invalid newest state (${age}) is damage: a loud error, never the older state`, async () => {
    const { root, id, state } = pausedWorld();
    const file = path.join(state, name(2));
    fs.writeFileSync(file, '{"id": "paused-te');
    if (age === 'old') { const old = new Date(Date.now() - 60_000); fs.utimesSync(file, old, old); }
    const damaged = (e) => e.code === 'sprint-damaged' && e.message.includes(file);
    assert.throws(() => loadSprint(root, id), damaged);
    await assert.rejects(retryTicket(root, id, 'ABC-1'), damaged);
    assert.deepEqual(versions(state), [name(1), name(2)], 'nothing was committed');
  });
}

// Without hard links, a delayed writer aiming at version 5 found 5 pruned by the time it
// committed, created it, and reported success while the current state (16) was unchanged.
for (const links of [false, true]) {
  test(`an obsolete version number is never committed, even once pruned (${links ? 'hard links' : 'no hard links'})`, (t) => {
    if (!links) noLinks(t);
    const { root, id, state } = world();
    const s = loadSprint(root, id);
    for (let i = 1; i <= 3; i++) { s.count = i; saveSprint(root, s); } // versions 2..4
    const delayed = loadSprint(root, id); // at version 4: aims at 5
    let others = false;
    setCommitHook(() => {
      if (others) return;
      others = true;
      const b = loadSprint(root, id);
      for (let i = 1; i <= 12; i++) { b.count = 100 + i; saveSprint(root, b); } // versions 5..16
      assert.equal(versions(state).includes(name(5)), false, 'version 5 was pruned');
    });
    t.after(() => setCommitHook(null));
    delayed.count = -1;
    assert.throws(() => saveSprint(root, delayed), busy);
    assert.equal(versions(state).includes(name(5)), false, 'version 5 does not remain');
    assert.equal(versions(state).at(-1), name(16));
    assert.equal(loadSprint(root, id).count, 112, 'the current state is unchanged');
    // Never aim at a number at or below the highest one: refused before anything is written.
    setCommitHook(() => assert.fail('a save from an obsolete version reached the commit'));
    assert.throws(() => saveSprint(root, delayed), busy);
  });
}
