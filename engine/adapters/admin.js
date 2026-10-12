import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCaptured, assertArg } from '../launch.js';
import { validateAdapter } from './registry.js';
import { buildInvocation } from './build.js';
import { slug } from '../paths.js';
import { PodiumError } from '../errors.js';

// Pre-fill the "Add agent" form from the tool's own --help. Every guess is shown to the
// user to confirm; nothing here is trusted until Test passes.
export async function suggestAdapter(command, { helpArgs = ['--help'] } = {}) {
  assertArg(command);
  const r = await runCaptured(command, helpArgs, { timeoutMs: 15_000 });
  if (r.code !== 0 && !r.stdout.trim()) throw new PodiumError('not-installed', `Couldn't run "${command} --help". Is it installed and on PATH?`);
  const help = `${r.stdout}\n${r.stderr}`;
  const stem = path.basename(command).replace(/\.(cmd|exe|bat)$/i, '');
  const adapter = {
    name: slug(stem).slice(0, 40),
    label: stem.charAt(0).toUpperCase() + stem.slice(1),
    command,
    baseArgs: [],
    promptVia: 'stdin',
    modelFlag: null,
    versionArgs: ['--version'],
    permissions: { 'read-only': [], 'edit-worktree': [], 'own-config': [], 'full-access': [] },
    verified: false,
  };
  const guessed = [];
  if (/^\s+exec\s/m.test(help)) { adapter.baseArgs = ['exec']; guessed.push('baseArgs'); }
  if (/--prompt-file\b/.test(help)) { adapter.promptVia = 'file'; adapter.promptFileFlag = '--prompt-file'; guessed.push('promptVia'); }
  if (/--model\b/.test(help)) { adapter.modelFlag = '--model'; guessed.push('modelFlag'); }
  else if (/(^|[\s,])-m[\s,]/m.test(help)) { adapter.modelFlag = '-m'; guessed.push('modelFlag'); }
  return { adapter, guessed, help: help.slice(0, 4000) };
}

export async function testAdapter(adapter, { permission = 'read-only', timeoutMs = 120_000 } = {}) {
  const errors = validateAdapter(adapter);
  if (errors.length) return { ok: false, errors };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'podium-adapter-test-'));
  try {
    const prompt = 'Reply with the single word: ready';
    const promptFile = path.join(dir, 'prompt.md');
    fs.writeFileSync(promptFile, prompt);
    const invocation = buildInvocation(adapter, { permission, promptFile });
    const started = Date.now();
    const r = await runCaptured(invocation.command, invocation.args, { cwd: dir, input: invocation.stdin ? prompt : '', timeoutMs });
    return {
      ok: r.code === 0 && /ready/i.test(r.stdout),
      exitCode: r.code,
      timedOut: r.timedOut,
      ms: Date.now() - started,
      output: r.stdout.slice(0, 2000),
      stderr: r.stderr.slice(0, 2000),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
