// One-click repair for Muse's Windows sandbox. Muse's sandbox leaves deny
// entries for its MuseSandboxUsers group on ~/.config/muse; once enough pile up,
// Windows refuses to update the folder's ACL (SetNamedSecurityInfoW 1340) and the
// sandbox cannot start. Removing that group's deny entries lets Muse add back the
// one it needs. Nothing else is touched.
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const icacls = (args) => exec('icacls', args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });

export function parseDenyEntries(text) {
  let identity = null;
  let count = 0;
  for (const raw of String(text).split(/\r?\n/)) {
    const m = /(\S+\\MuseSandboxUsers):(.*)$/.exec(raw);
    if (!m || !m[2].includes('(DENY)')) continue;
    identity ??= m[1];
    count++;
  }
  return { identity, count };
}

export async function repairMuseSandbox({ home = os.homedir(), platform = process.platform, run = icacls, minimum = 20 } = {}) {
  const folder = path.win32.join(home, '.config', 'muse');
  if (platform !== 'win32') return { repaired: false, removed: 0, reason: 'windows-only', folder };
  const before = parseDenyEntries((await run([folder])).stdout);
  if (!before.identity || before.count < minimum) return { repaired: false, removed: 0, reason: 'nothing-to-repair', folder };
  await run([folder, '/remove:d', before.identity]);
  const after = parseDenyEntries((await run([folder])).stdout);
  return { repaired: true, removed: before.count - after.count, folder };
}
