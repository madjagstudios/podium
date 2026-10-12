// The gh CLI, or a stand-in named by PODIUM_GH (a JSON array: command and leading args).
import { runCaptured } from './launch.js';
import { PodiumError } from './errors.js';

export function ghCommand(env = process.env) {
  if (env.PODIUM_GH) return JSON.parse(env.PODIUM_GH);
  return ['gh'];
}

export const GH_TIMEOUT_MS = 120_000;

const within = (ms) => {
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000} minute${ms === 60_000 ? '' : 's'}`;
  const s = Math.max(1, Math.round(ms / 1000));
  return `${s} second${s === 1 ? '' : 's'}`;
};

// No one is there to answer a prompt (Open PR runs from a detached sprint runner, under the sprint's lock), so gh and the
// git it runs never ask: a missing login is a plain failure, as for Podium's own git calls. A gh that does not answer
// within timeoutMs is stopped (its whole process tree) and fails plainly.
export async function runGh(args, { cwd, input, env = process.env, timeoutMs = GH_TIMEOUT_MS } = {}) {
  const [command, ...lead] = ghCommand(env);
  const quiet = { ...env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
  const r = await runCaptured(command, [...lead, ...args], { cwd, input, env: quiet, timeoutMs });
  if (r.timedOut) throw new PodiumError('gh-failed', `GitHub's gh tool didn't answer within ${within(timeoutMs)}.`);
  if (r.code !== 0) {
    const why = (r.stderr || r.stdout || '').split(/\r?\n/).find((l) => l.trim()) ?? `gh exited with code ${r.code}`;
    throw new PodiumError('gh-failed', why.trim());
  }
  return r.stdout;
}

export async function ghJson(args, opts) {
  return JSON.parse(await runGh(args, opts));
}
