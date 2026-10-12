import { runCaptured } from './launch.js';
import { loadAdapters } from './adapters/registry.js';
import { loadSettings } from './settings.js';
import { DEFAULT_PERMISSION } from './adapters/builtin.js';
import { listJobDirs, readJob } from './store.js';

export function agentStats(root) {
  const stats = {};
  for (const dir of listJobDirs(root)) {
    const job = readJob(dir);
    const s = (stats[job.agent] ??= { jobs: 0, used: 0 });
    s.jobs++;
    if (job.outcome === 'used') s.used++;
  }
  return stats;
}

export async function detectAgent(adapter, { timeoutMs = 15_000 } = {}) {
  const base = { name: adapter.name, label: adapter.label, verified: adapter.verified !== false };
  const v = await runCaptured(adapter.command, adapter.versionArgs ?? ['--version'], { timeoutMs });
  if (v.code !== 0) return { ...base, installed: false, version: null, signedIn: null };
  const version = (v.stdout || v.stderr).split(/\r?\n/).find((l) => l.trim())?.trim() ?? null;
  let signedIn = null;
  if (adapter.authCheckArgs) {
    const auth = await runCaptured(adapter.command, adapter.authCheckArgs, { timeoutMs });
    signedIn = auth.code === 0;
  }
  return { ...base, installed: true, version, signedIn };
}

export async function listAgents(root) {
  const { adapters, errors } = loadAdapters(root);
  const settings = loadSettings(root);
  const stats = agentStats(root);
  const agents = await Promise.all([...adapters.values()].map(async (a) => ({
    ...(await detectAgent(a)),
    source: a.source,
    enabled: !settings.disabledAgents.includes(a.name),
    defaultPermission: settings.defaultPermission[a.name] ?? DEFAULT_PERMISSION,
    stats: stats[a.name] ?? { jobs: 0, used: 0 },
  })));
  return { agents, errors };
}
