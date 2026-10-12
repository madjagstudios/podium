import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../engine/cli.js';
import { createJob } from '../engine/store.js';
import { tempRoot, tempRepo, fakeAdapter, waitFor } from './helpers.js';

const BIN = fileURLToPath(new URL('../bin/podium.js', import.meta.url));

function podium(root, args, { input, cwd } = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], { env: { ...process.env, PODIUM_DATA_DIR: root }, input, cwd, encoding: 'utf8' });
  return { code: r.status, body: JSON.parse(r.stdout.trim()) };
}

test('parseArgs handles options, flags and positionals', () => {
  assert.deepEqual(parseArgs(['settings', 'set', '--key', 'a', '--value', '1']), { command: 'settings', positional: ['set'], opts: { key: 'a', value: '1' } });
  assert.deepEqual(parseArgs(['result', '--id', 'x', '--full']), { command: 'result', positional: [], opts: { id: 'x', full: true } });
  assert.deepEqual(parseArgs(['dispatch', '--prompt', '-']).opts, { prompt: '-' });
});

test('unknown commands and missing options return structured errors', () => {
  const root = tempRoot();
  const bad = podium(root, ['fly']);
  assert.equal(bad.code, 1);
  assert.equal(bad.body.error.code, 'unknown-command');
  const missing = podium(root, ['result']);
  assert.equal(missing.body.error.code, 'missing-option');
  assert.match(missing.body.error.message, /--id/);
});

test('end to end: save adapter, dispatch from stdin, status, result, deliver, rate', async () => {
  const root = tempRoot();
  const adapterFile = path.join(root, 'fake.json');
  fs.writeFileSync(adapterFile, JSON.stringify(fakeAdapter('summary')));
  assert.equal(podium(root, ['adapter', 'save', '--file', adapterFile]).body.adapter.name, 'fake');

  const cwd = tempRoot();
  const sent = podium(root, ['dispatch', '--agent', 'fake', '--permission', 'read-only', '--ticket', 'ABC-3', '--prompt', '-'], { input: 'Summarise please', cwd });
  assert.equal(sent.code, 0);
  assert.equal(sent.body.permissionText, 'Fake will only read files');
  const id = sent.body.job.id;

  await waitFor(() => podium(root, ['status', '--id', id]).body.jobs[0].status === 'done');
  const res = podium(root, ['result', '--id', id, '--full']).body;
  assert.equal(res.summary, 'Did the thing.\nAll tests pass.\n');
  assert.match(res.output, /PROMPT: Summarise please/);

  assert.equal(podium(root, ['deliver', '--id', id]).body.job.outcome, 'used');
  const rated = podium(root, ['outcome', '--id', id, '--value', 'discarded']).body.job;
  assert.deepEqual([rated.outcome, rated.outcomeSource], ['discarded', 'user']);
});

test('dispatch --include-uncommitted reaches the engine', async () => {
  const root = tempRoot();
  const adapterFile = path.join(root, 'fake.json');
  fs.writeFileSync(adapterFile, JSON.stringify(fakeAdapter('ok')));
  podium(root, ['adapter', 'save', '--file', adapterFile]);
  const repo = tempRepo();
  fs.writeFileSync(path.join(repo, 'README.md'), 'dirty\n');
  const sent = podium(root, ['dispatch', '--agent', 'fake', '--permission', 'edit-worktree', '--include-uncommitted', '--prompt', 'x'], { cwd: repo });
  assert.equal(sent.code, 0, JSON.stringify(sent.body));
  assert.equal(sent.body.job.includedUncommitted, true);
  await waitFor(() => podium(root, ['status', '--id', sent.body.job.id]).body.jobs[0].status !== 'running');
});

test('settings, prune, agents and data-dir', () => {
  const root = tempRoot();
  assert.equal(podium(root, ['settings', 'set', '--key', 'longJobMinutes', '--value', '45']).body.longJobMinutes, 45);
  assert.equal(podium(root, ['settings']).body.longJobMinutes, 45);
  assert.deepEqual(podium(root, ['prune']).body, { compressed: 0, deleted: 0 });
  assert.ok(podium(root, ['agents']).body.agents.some((a) => a.name === 'codex'));
  assert.equal(podium(root, ['data-dir']).body.dataDir, root);
});

test('the bin is executable via node and prints one JSON line', () => {
  const out = execFileSync(process.execPath, [BIN, 'data-dir'], { env: { ...process.env, PODIUM_DATA_DIR: 'X' }, encoding: 'utf8' });
  assert.equal(out.trim().split('\n').length, 1);
});

test('status --here, summary and adapter save from stdin', async () => {
  const root = tempRoot();
  const saved = podium(root, ['adapter', 'save', '--json', '-'], { input: JSON.stringify(fakeAdapter('ok')) });
  assert.equal(saved.body.adapter.name, 'fake');
  const here = tempRoot();
  const elsewhere = tempRoot();
  const a = podium(root, ['dispatch', '--agent', 'fake', '--permission', 'read-only', '--prompt', '-'], { cwd: here, input: 'here job' }).body.job;
  podium(root, ['dispatch', '--agent', 'fake', '--permission', 'read-only', '--prompt', '-'], { cwd: elsewhere, input: 'other job' });
  const listed = podium(root, ['status', '--here'], { cwd: here }).body.jobs;
  assert.deepEqual(listed.map((j) => j.id), [a.id]);
  assert.equal(listed[0].title, 'here job');
  await waitFor(() => podium(root, ['status', '--id', a.id]).body.jobs[0].status === 'done');
  const s = podium(root, ['summary', '--id', a.id, '--text', '-'], { input: '  Short summary.  ' });
  assert.equal(s.code, 0);
  assert.equal(podium(root, ['result', '--id', a.id]).body.summary, 'Short summary.\n');
  assert.equal(podium(root, ['summary', '--id', a.id, '--text', '-'], { input: '   ' }).body.error.code, 'empty-summary');
});

test('changes returns an empty list for a job without a patch', async () => {
  const root = tempRoot();
  const { job } = createJob(root, { project: 'demo', ticket: 'NO-TICKET', agent: 'fake', permission: 'read-only', cwd: '/w', prompt: 'x' });
  const r = podium(root, ['changes', '--id', job.id]);
  assert.equal(r.code, 0);
  assert.deepEqual(r.body, { files: [], added: 0, removed: 0 });
});

test('a bare --id on sprint status is a missing option, not a list of every sprint', () => {
  const root = tempRoot();
  const bare = podium(root, ['sprint', 'status', '--id']);
  assert.equal(bare.code, 1);
  assert.equal(bare.body.error.code, 'missing-option');
  assert.match(bare.body.error.message, /--id/);
  assert.deepEqual(podium(root, ['sprint', 'status']).body, { sprints: [] }, 'no --id still lists');
});
