import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PodiumError } from '../engine/errors.js';
import { readJson, writeJsonAtomic } from '../engine/fsutil.js';
import { newJobId } from '../engine/ids.js';
import { dataDir, slug, projectKey, ticketKey } from '../engine/paths.js';
import { DEFAULT_SETTINGS, loadSettings, setSetting } from '../engine/settings.js';
import { tempRoot, tempRepo } from './helpers.js';

test('PodiumError carries a code and details', () => {
  const e = new PodiumError('x-code', 'Message', { a: 1 });
  assert.equal(e.code, 'x-code');
  assert.equal(e.message, 'Message');
  assert.deepEqual(e.details, { a: 1 });
  assert.ok(e instanceof Error);
});

test('writeJsonAtomic then readJson round-trips; fallback on missing', () => {
  const root = tempRoot();
  const f = path.join(root, 'nested', 'a.json');
  writeJsonAtomic(f, { hello: 'world' });
  assert.deepEqual(readJson(f), { hello: 'world' });
  assert.deepEqual(readJson(path.join(root, 'missing.json'), { d: 1 }), { d: 1 });
  assert.throws(() => readJson(path.join(root, 'missing.json')), /ENOENT/);
  assert.deepEqual(fs.readdirSync(path.join(root, 'nested')), ['a.json']);
});

test('newJobId is sortable and unique-ish', () => {
  const id = newJobId(new Date(Date.UTC(2026, 9, 4, 13, 5, 9)));
  assert.match(id, /^20261004-130509-[0-9a-f]{4}$/);
  assert.notEqual(newJobId(), newJobId());
});

test('dataDir honours override and platform defaults', () => {
  assert.equal(dataDir({ PODIUM_DATA_DIR: '/x/y' }), '/x/y');
  assert.equal(dataDir({ LOCALAPPDATA: 'C:\\L' }, 'win32'), path.join('C:\\L', 'Podium'));
  assert.match(dataDir({}, 'darwin'), /Library[\\/]Application Support[\\/]Podium$/);
  assert.equal(dataDir({ XDG_DATA_HOME: '/d' }, 'linux'), path.join('/d', 'podium'));
});

test('slug, ticketKey and projectKey', () => {
  assert.equal(slug('My Repo!!'), 'my-repo');
  assert.equal(slug('***'), 'unnamed');
  assert.equal(ticketKey('abc-2'), 'ABC-2');
  assert.equal(ticketKey(null), 'NO-TICKET');
  const repo = tempRepo();
  fs.mkdirSync(path.join(repo, 'sub'));
  assert.equal(projectKey(path.join(repo, 'sub')), slug(path.basename(repo)));
  const plain = tempRoot();
  assert.equal(projectKey(plain), slug(path.basename(plain)));
});

test('settings merge defaults and persist dotted keys', () => {
  const root = tempRoot();
  assert.deepEqual(loadSettings(root), DEFAULT_SETTINGS);
  setSetting(root, 'retention.compressDays', 7);
  setSetting(root, 'defaultPermission.codex', 'read-only');
  const s = loadSettings(root);
  assert.equal(s.retention.compressDays, 7);
  assert.equal(s.retention.deleteDays, 90);
  assert.equal(s.defaultPermission.codex, 'read-only');
  assert.throws(() => setSetting(root, 'nope', 1), (e) => e.code === 'unknown-setting');
});
