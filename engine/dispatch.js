import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadAdapters, getAdapter } from './adapters/registry.js';
import { PERMISSIONS, DEFAULT_PERMISSION } from './adapters/builtin.js';
import { permissionText, unattendedWarning } from './adapters/build.js';
import { detectAgent } from './discover.js';
import { loadSettings } from './settings.js';
import { projectKey, projectHere, ticketKey, worktreeDir } from './paths.js';
import { createJob, updateJob, readJob, findJobDir, listJobDirs } from './store.js';
import { agentLingers } from './status.js';
import { ghJson } from './gh.js';
import { reviewPrompt } from './pr.js';
import { threadSteps, contextBrief } from './thread.js';
import { isGitRepo, repoRoot, resolveBase, createWorktree, seedUncommitted, checkoutSize, gitIn, createReviewCopy } from './worktree.js';
import { assertArg, spawnDetachedNode } from './launch.js';
import { PodiumError, sprintJobError } from './errors.js';
import { readOutput } from './retention.js';
import { standingText, withInstructions } from './instructions.js';
import { pointerOnly } from './sprint-text.js';

const RUN_JOB = fileURLToPath(new URL('./run-job.js', import.meta.url));

export async function preflight(root, { agent, permission, model, cwd }) {
  const problems = [];
  const warnings = [];
  const adapter = loadAdapters(root).adapters.get(agent);
  if (!adapter) {
    return { ok: false, problems: [{ code: 'unknown-agent', message: `No agent called "${agent}".` }], warnings, permission: null, permissionText: null };
  }
  const settings = loadSettings(root);
  const requested = permission ?? settings.defaultPermission[agent];
  const inRepo = await isGitRepo(cwd);
  let level = requested ?? DEFAULT_PERMISSION;
  if (requested === undefined && level === 'edit-worktree' && !inRepo) {
    level = 'read-only';
    warnings.push({ code: 'fallback-read-only', message: "This folder isn't in a git repo, so Podium can't make a separate copy. The job will only read files." });
  }
  const knownLevel = PERMISSIONS.includes(level);

  if (settings.disabledAgents.includes(agent)) problems.push({ code: 'agent-disabled', message: `${adapter.label} is switched off in Podium's Agents tab.` });
  if (!knownLevel) problems.push({ code: 'bad-permission', message: `Unknown permission level "${level}".` });
  if (model) {
    try { assertArg(model); } catch (e) { problems.push({ code: 'bad-model', message: e.message }); }
    if (!adapter.modelFlag) problems.push({ code: 'no-model-flag', message: `${adapter.label} has no model option configured.` });
  }
  if (level === 'edit-worktree' && settings.worktreeForEdits) {
    if (!inRepo) {
      problems.push({ code: 'not-a-git-repo', message: 'Edit jobs run in a separate copy of a git repo, but this folder is not in one.' });
    } else {
      const size = await checkoutSize(cwd);
      if (size.lfs || size.bytes > settings.worktreeWarnMB * 1024 * 1024) {
        // LFS files count as tiny pointers here, so the byte total understates an LFS repo.
        const how = size.lfs
          ? 'This repo uses Git LFS, so each edit job makes a full copy that includes its large files.'
          : `Each edit job makes a full copy of this repo (about ${Math.round(size.bytes / (1024 * 1024))} MB).`;
        warnings.push({ code: 'large-repo', message: `${how} Use "Read only" where you can.` });
      }
    }
  }
  const found = await detectAgent(adapter);
  if (!found.installed) problems.push({ code: 'not-installed', message: `${adapter.label} isn't installed, or "${adapter.command}" isn't on PATH.` });
  else if (found.signedIn === false) problems.push({ code: 'not-signed-in', message: `${adapter.label} isn't signed in.` });

  if (knownLevel) {
    const unattended = unattendedWarning(adapter, level);
    if (unattended) warnings.push(unattended);
    if (level === 'full-access') warnings.push({ code: 'full-access', message: `${adapter.label} will run with no safety checks.` });
  }
  if (adapter.verified === false) warnings.push({ code: 'unverified-adapter', message: `${adapter.label}'s settings haven't been tested yet. Use Test in the Agents tab first.` });

  return { ok: problems.length === 0, problems, warnings, permission: level, permissionText: knownLevel ? permissionText(adapter, level) : null };
}

export async function dispatch(root, opts) {
  let { agent, permission, model = null, ticket = null, cwd, prompt, includeUncommitted = false, base = null, from = null, session = null, followUp = null, review = null, branch = null, meta = null, env = process.env, inCopy = null, project = null } = opts;
  // project: a sprint's steps are filed under the sprint's project (the key it was made with).
  // inCopy ({ worktree, repoRoot }): a sprint's reviewer works in its ticket's own copy, never one of its own.
  if (inCopy && (!meta?.sprint || followUp || review || base)) throw new PodiumError('bad-copy', "Only a sprint's own review step can work in a ticket's copy.");
  if (review && followUp) throw new PodiumError('review-follow-up', "A PR review starts its own copy of the PR, so it can't continue other work. Dispatch again with pr only.");
  let info = null;
  if (review) {
    // A review of PR #n: read-only, in its own copy of the PR's head.
    permission = 'read-only';
    info = { number: Number(review), ...(await ghJson(['pr', 'view', String(review), '--json', 'title,body,baseRefName,url'], { cwd, env })) };
    prompt = reviewPrompt(info, prompt);
  }
  let prev = null;
  if (followUp) {
    prev = readJob(findJobDir(root, followUp));
    if (prev.kind === 'review') throw new PodiumError('review-not-continuable', `Job ${followUp} is a PR review, and a review can't be continued. To review the PR again, dispatch with pr and say what to look at.`);
    // A sprint's work is continued only by the sprint (it passes its own meta).
    if (prev.sprint && !meta?.sprint) throw sprintJobError();
    const steps = threadSteps(root, prev);
    if (!steps.length) throw new PodiumError('not-continuable', `Job ${followUp} can't be continued.`);
    const latest = steps[steps.length - 1];
    if (latest.id !== prev.id) throw new PodiumError('not-latest', `Job ${followUp} is not the latest step of its thread; continue from ${latest.id}.`);
    if (['queued', 'running'].includes(prev.status)) throw new PodiumError('thread-busy', 'A step of this work is still running. Wait for it or cancel it first.');
    // Its runner is gone, but its agent may still be writing in the copy the next step would work in.
    if (agentLingers(prev)) throw new PodiumError('agent-still-running', `Job ${followUp} stopped unexpectedly, but its agent (process ${prev.agentPid}) is still running in its copy. Wait for it to finish, or end that process, then continue.`);
    if (['kept', 'discarded', 'merged', 'closed'].includes(prev.status)) throw new PodiumError('thread-closed', 'That work has left the thread; start a new job (it starts from your checkout).');
    if (permission && permission !== prev.permission) throw new PodiumError('permission-locked', `This work runs with "${prev.permission}". To change it, start a new job.`);
    permission = prev.permission;
    cwd = prev.cwd;
    ticket = ticket ?? (prev.ticket === 'NO-TICKET' ? null : prev.ticket);
  }
  if (!prompt || !prompt.trim()) throw new PodiumError('empty-prompt', 'The task description is empty.');
  const check = await preflight(root, { agent, permission, model, cwd });
  if (!check.ok) throw new PodiumError('preflight-failed', check.problems.map((p) => p.message).join(' '), { problems: check.problems });
  // A plain job's whole task is a key or a link: the agent may not be able to open the tracker it points at.
  const warnings = [
    ...check.warnings,
    ...(!review && !followUp && !meta?.sprint && pointerOnly(prompt)
      ? [{ code: 'ticket-pointer-only', message: "The task is only a ticket key or link. Most agents can't open a tracker, so paste the ticket's text into the task." }]
      : []),
  ];

  let top = null;
  let start = null;
  if (base) {
    if (String(base).startsWith('-')) throw new PodiumError('bad-base', `"${base}" is not a branch name.`);
    if (!(await isGitRepo(cwd))) throw new PodiumError('not-a-git-repo', 'A starting branch needs a git repo, but this folder is not in one.');
    if (includeUncommitted) throw new PodiumError('base-with-uncommitted', `Your uncommitted changes belong to your current branch, so they can't be copied onto ${base}.`);
    top = await repoRoot(cwd);
    // from (a sprint ticket that waited for others): the copy starts there, at the base as the remote
    // has it, while base stays the job's starting branch, which its PR targets.
    start = await resolveBase(top, from ?? base);
    if (!start) throw new PodiumError('unknown-base', `There is no branch or commit called "${from ?? base}" in this repo.`);
  }

  const settings = loadSettings(root);
  const { job, dir } = createJob(root, {
    // A follow-up stays in its thread's project, which may be an older key for the same folder.
    project: prev?.project ?? project ?? projectKey(cwd), ticket: ticketKey(ticket), agent, model, permission: check.permission, cwd: path.resolve(cwd), prompt,
  });
  updateJob(root, dir, { origin: session ? { session } : null });
  // Sprint steps carry their place in the sprint, set before the runner starts.
  if (meta) updateJob(root, dir, meta);
  const standing = standingText(settings, job.project);
  if (standing) fs.writeFileSync(path.join(dir, 'prompt.md'), withInstructions(prompt, standing));
  const adapter = getAdapter(root, agent);
  if (prev) {
    const steps = threadSteps(root, prev);
    const summaryFile = path.join(findJobDir(root, prev.id), 'summary.md');
    // No summary (it is written when a result is delivered): use the end of the last step's output.
    const lastOutput = readOutput(findJobDir(root, prev.id));
    const lastSummary = fs.existsSync(summaryFile) ? fs.readFileSync(summaryFile, 'utf8')
      : lastOutput && lastOutput.trim() ? `(its final output) ${lastOutput.trim().slice(-800)}` : null;
    const brief = withInstructions(contextBrief(steps, lastSummary, prompt), standing);
    const resumeFrom = prev.agentSession && prev.agentSession.agent === agent ? prev.agentSession.id : null;
    fs.writeFileSync(path.join(dir, 'prompt-brief.md'), brief);
    if (!resumeFrom) fs.writeFileSync(path.join(dir, 'prompt.md'), brief);
    updateJob(root, dir, {
      threadId: prev.threadId ?? prev.id, step: (prev.step ?? 1) + 1, followUpOf: prev.id, resumeFrom,
      agentSession: resumeFrom ? { agent, id: resumeFrom } : null,
    });
  }
  if (!prev?.agentSession || prev.agentSession.agent !== agent) {
    // A first step (or a new agent) that can name its conversation gets an id now.
    if (adapter.resume?.start) updateJob(root, dir, { agentSession: { agent, id: randomUUID() } });
  }
  if (review) {
    const top = await repoRoot(cwd);
    const worktree = path.join(worktreeDir(root, settings), job.id);
    const baseCommit = await createReviewCopy(top, worktree, info.number);
    await gitIn(top, ['fetch', '-q', 'origin', info.baseRefName]).catch(() => {});
    const host = listJobDirs(root, { project: projectHere(cwd) }).map(readJob).find((j) => j.pr?.number === info.number && j.kind !== 'review');
    updateJob(root, dir, {
      kind: 'review', reviewOf: { number: info.number, url: info.url }, step: null,
      repoRoot: top, worktree, branch: null, baseCommit, threadId: host ? (host.threadId ?? host.id) : job.id,
    }, 'worktree');
    spawnDetachedNode(RUN_JOB, [root, dir]);
    return { job: readJob(dir), dir, warnings, permissionText: check.permissionText };
  }
  if (inCopy) {
    // It gets a temp folder of its own (scratchTmp, runner.js), outside the repo; the sprint puts the copy
    // back to this commit once the review has been read.
    const baseCommit = await gitIn(inCopy.worktree, ['rev-parse', 'HEAD']);
    updateJob(root, dir, { repoRoot: inCopy.repoRoot, worktree: inCopy.worktree, branch: null, baseCommit, scratchTmp: true }, 'worktree');
    spawnDetachedNode(RUN_JOB, [root, dir]);
    return { job: readJob(dir), dir, warnings, permissionText: check.permissionText };
  }
  const reuse = prev && prev.worktree && fs.existsSync(prev.worktree);
  if (reuse) {
    // A PR's or a sprint's next step starts from the copy's HEAD, so its diff is only the new work.
    const baseCommit = prev.pr || prev.sprint ? await gitIn(prev.worktree, ['rev-parse', 'HEAD']) : prev.baseCommit;
    updateJob(root, dir, { repoRoot: prev.repoRoot, worktree: prev.worktree, branch: prev.branch, baseCommit, base: prev.base ?? null, pr: prev.pr ?? null }, 'worktree');
  } else {
    const fromCommitted = prev?.committed?.branch ?? null;
    if (fromCommitted) {
      top = await repoRoot(cwd);
      start = await resolveBase(top, fromCommitted);
    }
    if ((check.permission === 'edit-worktree' && settings.worktreeForEdits) || base || fromCommitted) {
      top ??= await repoRoot(cwd);
      const worktree = path.join(worktreeDir(root, settings), job.id);
      const name = branch ?? `podium/${job.id}`;
      let baseCommit = await createWorktree(top, worktree, name, start);
      let includedUncommitted = false;
      if (includeUncommitted && !prev) {
        const seeded = await seedUncommitted(top, worktree);
        if (seeded) { baseCommit = seeded; includedUncommitted = true; }
      }
      updateJob(root, dir, { repoRoot: top, worktree, branch: name, baseCommit, includedUncommitted, base: base ?? fromCommitted ?? null }, 'worktree');
    }
  }
  if (prev) updateJob(root, findJobDir(root, prev.id), { status: 'continued', endStatus: prev.status, continuedBy: job.id }, 'continued');
  spawnDetachedNode(RUN_JOB, [root, dir]);
  return { job: readJob(dir), dir, warnings, permissionText: check.permissionText };
}
