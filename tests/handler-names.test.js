import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// The desktop Client posts actions by name; one missing from HANDLER_NAMES would be a dead button.
test('HANDLER_NAMES lists exactly the actions register.tsx defines', () => {
  const reg = fs.readFileSync(new URL('../hooks/register.tsx', import.meta.url), 'utf8');
  const body = reg.slice(reg.indexOf('function actions($: Engine)'), reg.indexOf('function handlers($: Engine)'));
  const defined = [...body.matchAll(/^ {4}(\w+): \(/gm)].map((m) => m[1]).sort();
  const scr = fs.readFileSync(new URL('../hooks/screens.tsx', import.meta.url), 'utf8');
  const from = scr.indexOf('export const HANDLER_NAMES');
  const list = scr.slice(from, scr.indexOf('] as const', from));
  const named = [...list.matchAll(/'(\w+)'/g)].map((m) => m[1]).sort();
  assert.ok(defined.length > 40);
  assert.deepEqual(named, defined);
});

// Opening a board picker is a pane action the Client posts.
test('HANDLER_NAMES has openPicker', () => {
  const scr = fs.readFileSync(new URL('../hooks/screens.tsx', import.meta.url), 'utf8');
  const from = scr.indexOf('export const HANDLER_NAMES');
  assert.match(scr.slice(from, scr.indexOf('] as const', from)), /'openPicker'/);
});

// No dropdowns in the pane: a redraw shut an open one, and dark mode hid its options.
test('the pane draws no Select', () => {
  const dir = new URL('../hooks/', import.meta.url);
  const files = fs.readdirSync(dir, { recursive: true }).filter((f) => /\.tsx?$/.test(String(f)) && !String(f).endsWith('.test.ts'));
  assert.ok(files.length > 3);
  for (const f of files) assert.doesNotMatch(fs.readFileSync(new URL(String(f).replace(/\\/g, '/'), dir), 'utf8'), /<Select\b/, String(f));
});
