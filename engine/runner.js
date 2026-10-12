import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { finished } from 'node:stream/promises';
import { readJob, updateJob } from './store.js';
import { getAdapter } from './adapters/registry.js';
import { buildInvocation } from './adapters/build.js';
import { commandLine } from './launch.js';
import { diffWorktree, committedWork, hasLeftovers, removeWorktree } from './worktree.js';
import { extractSummary } from './summary.js';
import { outcomePatch } from './outcome.js';
import { createLiveWriter } from './live.js';
import { changeSummary } from './changes.js';
import { loadSettings, repoSettings } from './settings.js';

export const SANDBOX_BROKEN = /sandbox enforcement unavailable|SetNamedSecurityInfoW failed/i;

async function runAgent(root, job, adapter, dir, session) {
  const promptFile = path.join(dir, 'prompt.md');
  // The repo's commands, read as the step starts, so a change in Settings reaches the next step. Only for a job
  // in Podium's copy: with worktreeForEdits off an edit job works in the person's own folder, and gets no allow rule.
  const allow = job.worktree ? repoSettings(loadSettings(root), job.project).commands : [];
  const invocation = buildInvocation(adapter, { permission: job.permission, model: job.model, promptFile, session, allow });
  const line = commandLine(invocation.command, invocation.args);

  const out = fs.createWriteStream(path.join(dir, 'output.md'), { flags: 'a' });
  const err = fs.createWriteStream(path.join(dir, 'stderr.log'), { flags: 'a' });
  const started = Date.now();
  const child = spawn(line.file, line.argv, {
    cwd: job.worktree || job.cwd,
    env: { ...process.env, PODIUM_JOB_ID: job.id },
    windowsVerbatimArguments: line.verbatim,
    windowsHide: true,
  });
  updateJob(root, dir, { status: 'running', startedAt: new Date().toISOString(), runnerPid: process.pid, agentPid: child.pid ?? null }, 'started');

  const live = createLiveWriter(dir);
  child.stdout.on('data', (c) => live.feed('out', c));
  child.stderr.on('data', (c) => live.feed('err', c));
  child.stdout.pipe(out);
  child.stderr.pipe(err);
  child.stdin.on('error', () => {}); // the agent may exit before reading stdin
  child.stdin.end(invocation.stdin ? fs.readFileSync(promptFile, 'utf8') : '');

  let spawnError = null;
  const code = await new Promise((resolve) => {
    child.on('error', (e) => { spawnError = e.message; resolve(-1); });
    child.on('close', (c) => resolve(c ?? -1));
  });
  await Promise.all([finished(out).catch(() => {}), finished(err).catch(() => {})]);
  live.finish();
  return { code, spawnError, ms: Date.now() - started };
}

export async function runJob(root, dir) {
  const job = readJob(dir);
  const adapter = getAdapter(root, job.agent);
  const tail = (file) => {
    try {
      const buf = fs.readFileSync(path.join(dir, file));
      return buf.subarray(Math.max(0, buf.length - 65_536)).toString('utf8');
    } catch {
      return '';
    }
  };
  const outText = () => tail('output.md') + tail('stderr.log');
  const session = job.resumeFrom && adapter.resume?.continue ? { mode: 'continue', id: job.resumeFrom }
    : job.agentSession && job.agentSession.agent === job.agent && adapter.resume?.start ? { mode: 'start', id: job.agentSession.id }
    : null;
  const patch = {};
  if (job.resumeFrom && !adapter.resume?.continue) {
    fs.copyFileSync(path.join(dir, 'prompt-brief.md'), path.join(dir, 'prompt.md'));
    patch.resumeFrom = null;
  }
  const first = await runAgent(root, job, adapter, dir, session);
  // A cancel must also prevent a fresh run after a failed resume.
  if (readJob(dir).status === 'cancelled') return readJob(dir);
  let second = null;
  let activeSession = session;
  let resumeFailed = false;
  if (session?.mode === 'continue' && first.code !== 0 && first.ms < 20_000 && /session|conversation|resume/i.test(outText())) {
    fs.copyFileSync(path.join(dir, 'prompt-brief.md'), path.join(dir, 'prompt.md'));
    resumeFailed = true;
    const fresh = adapter.resume?.start ? { mode: 'start', id: randomUUID() } : null;
    second = await runAgent(root, { ...job, resumeFrom: null }, adapter, dir, fresh);
    activeSession = fresh;
    patch.agentSession = fresh ? { agent: job.agent, id: fresh.id } : null;
  }
  const { code, spawnError } = second ?? first;
  if (resumeFailed) Object.assign(patch, { resumeFailed: true, resumeFrom: null });
  if (adapter.resume?.capture && !activeSession) {
    // The last id wins: after a failed resume the log holds both runs, and only the fresh one is live.
    const found = [...outText().matchAll(new RegExp(adapter.resume.capture, 'g'))];
    if (found.length) patch.agentSession = { agent: job.agent, id: found[found.length - 1][1] };
  }

  // Re-read: a cancel may have landed while the agent ran.
  const current = readJob(dir);
  if (current.status === 'cancelled') return current;

  Object.assign(patch, { endedAt: new Date().toISOString(), exitCode: code });
  if (job.worktree) {
    const since = current.startedAt ? new Date(Date.parse(current.startedAt) - 2000).toISOString() : null;
    const committed = await committedWork(job.worktree, { baseCommit: job.baseCommit, branch: job.branch, since }).catch(() => null);
    if (committed) {
      // The agent's commits are the result: there is nothing to Keep.
      patch.committed = committed;
      if (await hasLeftovers(job.worktree).catch(() => true)) {
        patch.leftovers = true;
      } else if (!job.pr && !job.sprint) {
        // Done with the copy, unless a PR's or a sprint's: later steps work in it.
        await removeWorktree(job.repoRoot, job.worktree, committed.branch === job.branch ? null : job.branch);
        patch.worktree = null;
      }
    } else {
      const diff = await diffWorktree(job.worktree, job.baseCommit);
      if (diff.trim()) {
        fs.writeFileSync(path.join(dir, 'diff.patch'), diff);
        patch.hasChanges = true;
        patch.changes = changeSummary(diff);
      } else if ((job.step ?? 1) === 1 && !job.sprint) {
        await removeWorktree(job.repoRoot, job.worktree, job.branch);
        patch.worktree = null;
      }
    }
  }
  if (SANDBOX_BROKEN.test(outText())) {
    patch.warning = {
      code: 'sandbox-broken',
      message: `${adapter.label} couldn't run any commands: its own safety sandbox can't start on this computer.`,
      repair: adapter.name === 'muse' ? 'muse-sandbox' : null,
    };
  }
  const summary = extractSummary(fs.readFileSync(path.join(dir, 'output.md'), 'utf8'));
  if (summary) fs.writeFileSync(path.join(dir, 'summary.md'), summary + '\n');

  if (code === 0) {
    patch.status = patch.hasChanges ? 'needs-review' : 'done';
  } else {
    patch.status = 'failed';
    patch.error = spawnError ? `Could not start ${adapter.label}: ${spawnError}` : `${adapter.label} exited with code ${code}.`;
    Object.assign(patch, outcomePatch(current, 'unknown', 'auto') ?? {});
  }
  return updateJob(root, dir, patch, 'finished');
}

export function recordCrash(root, dir, error) {
  try {
    updateJob(root, dir, { status: 'failed', endedAt: new Date().toISOString(), error: `Podium's runner crashed: ${error.message}` }, 'finished');
  } catch {
    // Nothing left to record into; status reconciliation will mark the job lost.
  }
}
