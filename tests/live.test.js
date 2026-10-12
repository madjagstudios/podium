import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { LIVE_FILE, cleanLine, activityOf, createLiveWriter } from '../engine/live.js';
import { tempRoot } from './helpers.js';

const read = (dir) => JSON.parse(fs.readFileSync(path.join(dir, LIVE_FILE), 'utf8'));

test('cleanLine strips ANSI codes and trailing space', () => {
  assert.equal(cleanLine('\x1b[32mreading src/a.ts\x1b[0m   '), 'reading src/a.ts');
});

test('activityOf picks the newest line with letters or digits, cut to 120', () => {
  assert.equal(activityOf(['one', 'two', '⠋', '---']), 'two');
  assert.equal(activityOf(['', '…']), null);
  const long = 'x'.repeat(200);
  assert.equal(activityOf([long]).length, 120);
  assert.ok(activityOf([long]).endsWith('…'));
});

test('the writer keeps the last 20 lines across both streams and counts bytes', () => {
  const dir = tempRoot();
  const w = createLiveWriter(dir, { intervalMs: 10_000 });
  for (let i = 1; i <= 25; i++) w.feed(i % 2 ? 'out' : 'err', `line ${i}\n`);
  w.feed('err', 'partial without newline');
  w.finish();
  const live = read(dir);
  assert.equal(live.v, 1);
  assert.equal(live.lines.length, 20);
  assert.equal(live.lines[0], 'line 7');
  assert.equal(live.lines[19], 'partial without newline');
  assert.equal(live.activity, 'partial without newline');
  assert.ok(live.bytes > 150);
  assert.ok(!Number.isNaN(Date.parse(live.updatedAt)));
  assert.equal(fs.existsSync(path.join(dir, `${LIVE_FILE}.tmp`)), false);
});

test('carriage-return progress lines become separate lines', () => {
  const dir = tempRoot();
  const w = createLiveWriter(dir, { intervalMs: 10_000 });
  w.feed('err', '10%\r50%\rdone reading\n');
  w.finish();
  assert.deepEqual(read(dir).lines, ['10%', '50%', 'done reading']);
});

test('writes are throttled, and the last chunk always lands', async () => {
  const dir = tempRoot();
  const w = createLiveWriter(dir, { intervalMs: 80 });
  w.feed('out', 'first\n');
  w.feed('out', 'second\n');
  assert.equal(fs.existsSync(path.join(dir, LIVE_FILE)), false);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(read(dir).activity, 'second');
  w.finish();
});
