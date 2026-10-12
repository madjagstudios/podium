import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDenyEntries, repairMuseSandbox } from '../engine/repair.js';

const SAMPLE = [
  'C:\\Users\\me\\.config\\muse TheImplication\\MuseSandboxUsers:(DENY)(R)',
  '                            TheImplication\\MuseSandboxUsers:(OI)(CI)(IO)(DENY)(R,GR)',
  '                            TheImplication\\MuseSandboxUsers:(DENY)(R)',
  '                            NT AUTHORITY\\SYSTEM:(OI)(CI)(F)',
  '                            TheImplication\\me:(OI)(CI)(F)',
  '',
  'Successfully processed 1 files; Failed processing 0 files',
].join('\r\n');

test('parseDenyEntries finds the Muse sandbox identity and counts its deny entries', () => {
  assert.deepEqual(parseDenyEntries(SAMPLE), { identity: 'TheImplication\\MuseSandboxUsers', count: 3 });
  assert.deepEqual(parseDenyEntries('C:\\x NT AUTHORITY\\SYSTEM:(F)'), { identity: null, count: 0 });
});

test('repair removes only that identity\'s deny entries, and only when they piled up', async () => {
  const calls = [];
  let listing = SAMPLE;
  const run = async (args) => {
    calls.push(args);
    if (args.includes('/remove:d')) listing = 'C:\\Users\\me\\.config\\muse NT AUTHORITY\\SYSTEM:(OI)(CI)(F)';
    return { stdout: listing };
  };
  const r = await repairMuseSandbox({ home: 'C:\\Users\\me', platform: 'win32', run, minimum: 2 });
  assert.deepEqual(r, { repaired: true, removed: 3, folder: 'C:\\Users\\me\\.config\\muse' });
  assert.deepEqual(calls[1], ['C:\\Users\\me\\.config\\muse', '/remove:d', 'TheImplication\\MuseSandboxUsers']);
});

test('repair does nothing off Windows or when there is nothing to repair', async () => {
  const run = async () => ({ stdout: 'C:\\x NT AUTHORITY\\SYSTEM:(F)' });
  assert.equal((await repairMuseSandbox({ home: '/home/me', platform: 'linux', run })).reason, 'windows-only');
  assert.equal((await repairMuseSandbox({ home: 'C:\\Users\\me', platform: 'win32', run })).reason, 'nothing-to-repair');
});
