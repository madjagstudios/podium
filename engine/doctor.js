// First-run and update checks. Podium makes no network calls: it
// looks at the machine (Node, git, gh), its settings, and its own files.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCaptured } from './launch.js';
import { loadSettings } from './settings.js';
import { readJson, writeJsonAtomic } from './fsutil.js';

export const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url));

export function atLeast(version, min) {
  const a = String(version).split('.').map((n) => parseInt(n, 10) || 0);
  const b = String(min).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < b.length; i++) {
    if ((a[i] ?? 0) !== b[i]) return (a[i] ?? 0) > b[i];
  }
  return true;
}

const VERSION = /(\d+\.\d+(?:\.\d+)?)/;

async function versionOf(command, args) {
  const r = await runCaptured(command, args, { timeoutMs: 10_000 });
  if (r.code !== 0) return null;
  return (r.stdout + r.stderr).match(VERSION)?.[1] ?? null;
}

// The text under "## <version>" (a date or brackets around the version are fine), up to the next "## ".
export function changelogSection(text, version) {
  const lines = String(text).split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s/.test(l) && l.replace(/[[\]]/g, '').split(/\s+/)[1] === version);
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^##\s/.test(l));
  const body = (end < 0 ? rest : rest.slice(0, end)).join('\n').trim();
  return body || null;
}

export async function doctor(root) {
  const nodeVersion = process.versions.node;
  const gitVersion = await versionOf('git', ['--version']);
  const ghVersion = await versionOf('gh', ['--version']);
  const signedIn = ghVersion ? (await runCaptured('gh', ['auth', 'status'], { timeoutMs: 10_000 })).code === 0 : false;
  return {
    node: { ok: atLeast(nodeVersion, '22'), version: nodeVersion },
    git: { ok: gitVersion ? atLeast(gitVersion, '2.28') : false, version: gitVersion },
    gh: { installed: Boolean(ghVersion), signedIn, version: ghVersion },
    tellClaude: loadSettings(root).tellClaudeWhenDone !== false,
    welcomed: fs.existsSync(path.join(root, 'welcome.json')),
  };
}

export function markWelcomed(root) {
  writeJsonAtomic(path.join(root, 'welcome.json'), { at: new Date().toISOString() });
  return { welcomed: true };
}

const pluginVersion = (pluginRoot) => readJson(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), {}).version ?? '0.0.0';

export function versionInfo(root, pluginRoot = PLUGIN_ROOT) {
  const version = pluginVersion(pluginRoot);
  const previous = readJson(path.join(root, 'version.json'), null)?.version ?? null;
  const file = path.join(pluginRoot, 'CHANGELOG.md');
  const notes = previous && previous !== version && fs.existsSync(file) ? changelogSection(fs.readFileSync(file, 'utf8'), version) : null;
  return { version, previous, notes };
}

export function markSeen(root, pluginRoot = PLUGIN_ROOT) {
  const info = versionInfo(root, pluginRoot);
  writeJsonAtomic(path.join(root, 'version.json'), { version: info.version, at: new Date().toISOString() });
  return info;
}
