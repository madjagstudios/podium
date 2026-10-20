import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PodiumError } from '../engine/errors.js';
import { readJson, writeJsonAtomic } from '../engine/fsutil.js';
import { newJobId } from '../engine/ids.js';
import { dataDir, worktreeDir, isFullPath, slug, projectKey, projectHere, inProject, ticketKey } from '../engine/paths.js';
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

test('projectKey keys a linked worktree by its main repo: a session worktree inside the repo or a copy outside it', () => {
  const repo = tempRepo();
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  const session = path.join(repo, '.claude', 'worktrees', 'lucid-cohen-0e659d');
  const copy = path.join(tempRoot(), 'worktrees', '20261015-120000-abcd');
  git(repo, 'worktree', 'add', '-q', '-b', 'session', session);
  git(repo, 'worktree', 'add', '-q', '--detach', copy);
  fs.mkdirSync(path.join(session, 'sub'));
  const key = slug(path.basename(repo));
  assert.equal(projectKey(repo), key);
  assert.equal(projectKey(session), key);
  assert.equal(projectKey(path.join(session, 'sub')), key);
  assert.equal(projectKey(copy), key);
  // A bare repo has no folder of its own around its git folder: its worktrees take its name without ".git".
  const bare = path.join(tempRoot(), 'shop.git');
  git(repo, 'clone', '-q', '--bare', repo, bare);
  const wt = path.join(tempRoot(), 'feature');
  git(bare, 'worktree', 'add', '-q', '--detach', wt);
  assert.equal(projectKey(wt), 'shop');
  // Here-lookups also read a worktree's own folder name (its key before), for work made inside that worktree only:
  // another repo may have that name. A main checkout has only its own key.
  assert.equal(projectHere(repo), key);
  const here = projectHere(path.join(session, 'sub'));
  assert.equal(here.key, key);
  assert.equal(here.older, 'lucid-cohen-0e659d');
  assert.equal(inProject(here, key, null), true);
  assert.equal(inProject(here, 'lucid-cohen-0e659d', path.join(session, 'sub')), true);
  assert.equal(inProject(here, 'lucid-cohen-0e659d', path.join(tempRoot(), 'lucid-cohen-0e659d')), false);
  assert.equal(inProject(here, 'lucid-cohen-0e659d', null), false);
  assert.equal(inProject(here, 'elsewhere', path.join(session, 'sub')), false);
  assert.equal(projectHere(copy).older, '20261015-120000-abcd');
  // A job's folder may be gone since, recorded through another path to the worktree (a link, a junction, an 8.3 name).
  const link = path.join(tempRoot(), 'link');
  fs.symlinkSync(session, link, 'junction');
  assert.equal(inProject(here, 'lucid-cohen-0e659d', path.join(link, 'gone', 'deeper')), true);
});

test('projectKey gives a main checkout and its linked worktrees one key when the git folder is named apart from the checkout', () => {
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  const commit = (cwd) => git(cwd, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init');
  // A submodule added under a name of its own: its git folder is <super>/.git/modules/sdk-storage, its checkout libs/sdk.
  const top = tempRoot();
  git(top, 'init', '-q', '-b', 'main', 'sdk');
  commit(path.join(top, 'sdk'));
  git(top, 'init', '-q', '-b', 'main', 'super');
  git(path.join(top, 'super'), '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', '--name', 'sdk-storage', path.join(top, 'sdk'), 'libs/sdk');
  const sub = path.join(top, 'super', 'libs', 'sdk');
  const subTree = path.join(tempRoot(), 'sdk-feature');
  git(sub, 'worktree', 'add', '-q', '--detach', subTree);
  assert.equal(projectKey(sub), 'sdk');
  assert.equal(projectKey(subTree), 'sdk');
  assert.equal(projectKey(path.join(top, 'super')), 'super');
  // A --separate-git-dir checkout: nothing in its git folder leads back to the checkout, so both take that folder's name.
  const other = tempRoot();
  git(other, 'init', '-q', '-b', 'main', '--separate-git-dir', path.join(other, 'shop-data'), 'shop');
  commit(path.join(other, 'shop'));
  const shopTree = path.join(tempRoot(), 'shop-feature');
  git(path.join(other, 'shop'), 'worktree', 'add', '-q', '--detach', shopTree);
  assert.equal(projectKey(path.join(other, 'shop')), projectKey(shopTree));
  assert.equal(projectKey(shopTree), 'shop-data');
  // A separate git folder that happens to be called .git, in a folder that is not the checkout: one key for both too.
  const odd = tempRoot();
  fs.mkdirSync(path.join(odd, 'metadata'));
  git(odd, 'init', '-q', '-b', 'main', '--separate-git-dir', path.join(odd, 'metadata', '.git'), 'shop');
  commit(path.join(odd, 'shop'));
  const oddTree = path.join(tempRoot(), 'odd-feature');
  git(path.join(odd, 'shop'), 'worktree', 'add', '-q', '--detach', oddTree);
  assert.equal(projectKey(path.join(odd, 'shop')), projectKey(oddTree));
});

test('worktreeDir on macOS puts copies in a folder under home when the data folder is its own (Application Support)', () => {
  const root = dataDir({}, 'darwin');
  const dir = worktreeDir(root, { worktreeRoot: null }, 'darwin');
  assert.equal(dir, path.join(os.homedir(), '.podium', 'worktrees'));
  // Only Podium's own part of the path is known here: a home folder may have a space of its own, which the doctor reports.
  assert.doesNotMatch(path.relative(os.homedir(), dir), /[\s%]/);
  // A data folder of the person's own choosing (PODIUM_DATA_DIR) or a test's keeps its copies, space or not.
  const chosen = path.join(path.parse(os.tmpdir()).root, 'Test Disk', 'podium');
  assert.equal(worktreeDir(chosen, { worktreeRoot: null }, 'darwin'), path.join(chosen, 'worktrees'));
});

// A data folder known to have no space or %: this machine's own temp folder may have one (a user folder like "Jane Smith").
const PLAIN_ROOT = path.join(path.parse(os.tmpdir()).root, 'podium-data');

test('worktreeDir keeps copies under a data folder with no space, on every platform', () => {
  const root = PLAIN_ROOT;
  for (const platform of ['darwin', 'linux', 'win32']) assert.equal(worktreeDir(root, { worktreeRoot: null }, platform), path.join(root, 'worktrees'), platform);
  assert.equal(worktreeDir(root, {}, 'darwin'), path.join(root, 'worktrees'));
});

test('worktreeDir uses a copies folder given as a full path and ignores anything else', () => {
  const root = PLAIN_ROOT;
  assert.equal(worktreeDir(root, { worktreeRoot: '/opt/copies' }, 'darwin'), '/opt/copies');
  assert.equal(worktreeDir(root, { worktreeRoot: 'D:\\copies' }, 'win32'), 'D:\\copies');
  for (const [bad, platform] of [['relative/copies', 'darwin'], ['relative/copies', 'linux'], ['\\copies', 'win32'], ['/copies', 'win32'], ['D:copies', 'win32'], ['\\\\server\\share\\copies', 'win32'], [42, 'linux']]) {
    assert.equal(worktreeDir(root, { worktreeRoot: bad }, platform), path.join(root, 'worktrees'), `${bad} on ${platform}`);
  }
});

test('isFullPath: on Windows a full path names a drive (a network share can\'t be an agent\'s working folder)', () => {
  assert.equal(isFullPath('/Users/me/copies', 'darwin'), true);
  assert.equal(isFullPath('C:\\copies', 'win32'), true);
  assert.equal(isFullPath('c:/copies', 'win32'), true);
  for (const value of ['\\copies', '/copies', 'C:copies', 'copies', '', null, '\\\\server\\share', '\\\\?\\C:copies', '\\\\?\\UNC\\server', '\\\\.\\pipe\\x']) assert.equal(isFullPath(value, 'win32'), false, String(value));
});

test('the copies folder setting must be a full path or empty for the default', () => {
  const root = tempRoot();
  assert.equal(loadSettings(root).worktreeRoot, null);
  assert.throws(() => setSetting(root, 'worktreeRoot', 'relative/copies'), (e) => e.code === 'bad-setting');
  if (process.platform === 'win32') assert.throws(() => setSetting(root, 'worktreeRoot', '\\copies'), (e) => e.code === 'bad-setting');
  assert.throws(() => setSetting(root, 'worktreeRoot', 42), (e) => e.code === 'bad-setting');
  assert.equal(loadSettings(root).worktreeRoot, null, 'nothing was saved');
  const copies = tempRoot();
  setSetting(root, 'worktreeRoot', copies);
  assert.equal(loadSettings(root).worktreeRoot, copies);
  setSetting(root, 'worktreeRoot', null);
  assert.equal(loadSettings(root).worktreeRoot, null);
  setSetting(root, 'worktreeRoot', copies);
  setSetting(root, 'worktreeRoot', '');
  assert.equal(loadSettings(root).worktreeRoot, null);
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
