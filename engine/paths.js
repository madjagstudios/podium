import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function dataDir(env = process.env, platform = process.platform) {
  if (env.PODIUM_DATA_DIR) return env.PODIUM_DATA_DIR;
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Podium');
  if (platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Podium');
  return path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'podium');
}

export function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unnamed';
}

export function projectKey(cwd) {
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return slug(path.basename(top));
  } catch {
    return slug(path.basename(path.resolve(cwd)));
  }
}

export function ticketKey(ticket) {
  return ticket ? slug(ticket).toUpperCase() : 'NO-TICKET';
}
