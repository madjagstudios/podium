// Plain-language view of engine jobs for the pane, the status line and chat messages.

const WORKING = new Set(['queued', 'running']);
const NEEDS_YOU = new Set(['needs-review', 'failed', 'lost']);
const ICON = { working: '⏳', 'needs-you': '✋', done: '✅' };
const DONE_WORDS = { done: 'Done', kept: 'Kept', discarded: 'Thrown away', cancelled: 'Cancelled' };
// Mirrors engine/adapters/build.js; the mod cannot import engine code (hooks run without Node).
const PERMISSION_WORDS = {
  'read-only': 'could only read files',
  'edit-worktree': 'could edit files in a separate copy',
  'own-config': 'used its own settings',
  'full-access': 'had full access',
};
const FINISHED_VERB = {
  done: 'finished',
  'needs-review': 'finished with changes to review',
  failed: 'stopped with an error',
  lost: 'stopped unexpectedly',
};

export function jobState(job) {
  if (job.status === 'in-review') return job.pr?.attention ? 'needs-you' : 'done';
  if (WORKING.has(job.status)) return job.isLong ? 'needs-you' : 'working';
  return NEEDS_YOU.has(job.status) ? 'needs-you' : 'done';
}

export function agentLabel(name) {
  const s = String(name ?? '');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function shorten(text, max = 60) {
  const line = String(text ?? '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.round(m / 60)} h`;
}

export function jobLine(job, now = Date.now()) {
  const state = jobState(job);
  const since = (iso) => duration(now - Date.parse(iso));
  let when;
  if (WORKING.has(job.status)) {
    const ran = since(job.startedAt ?? job.createdAt);
    when = job.isLong ? `Still running after ${ran}. Keep going or cancel?` : `${ran} so far`;
  } else if (job.status === 'needs-review') when = 'Changes ready to review';
  else if (job.status === 'failed') when = 'Stopped with an error';
  else if (job.status === 'lost') when = 'Stopped unexpectedly';
  else when = `${DONE_WORDS[job.status] ?? 'Done'} ${since(job.endedAt ?? job.createdAt)} ago`;
  return {
    id: job.id,
    state,
    icon: ICON[state],
    who: `${agentLabel(job.agent)}${state === 'needs-you' ? ' — needs you' : ''}`,
    what: shorten(job.title || 'Untitled job'),
    when,
    ticket: job.ticket,
  };
}

export function statusText(jobs) {
  const working = jobs.filter((j) => jobState(j) === 'working').length;
  const needs = jobs.filter((j) => jobState(j) === 'needs-you').length;
  if (!working && !needs) return undefined;
  const parts = [working ? `${working} working` : null, needs ? `${needs} needs you` : null].filter(Boolean);
  return `🎼 Podium: ${parts.join(' · ')}`;
}

export function newlyFinished(jobs) {
  return jobs.filter((j) => !j.delivered && ['done', 'needs-review', 'failed', 'lost', 'in-review', 'merged', 'closed'].includes(j.status));
}

// took: false where the line already says how long it took (the detail card).
export function detailLines(job, { took: withTook = true } = {}) {
  const ticket = job.ticket === 'NO-TICKET' ? 'No ticket' : `Ticket ${job.ticket}`;
  const took = withTook && job.startedAt && job.endedAt ? `took ${duration(Date.parse(job.endedAt) - Date.parse(job.startedAt))}` : null;
  const perm = `${agentLabel(job.agent)} ${PERMISSION_WORDS[job.permission] ?? `used "${job.permission}"`}`;
  return [ticket, took, perm].filter(Boolean).join(' · ');
}

export function committedText(job) {
  const c = job.committed;
  if (!c) return null;
  const where = c.branch ? `Committed to ${c.branch}` : 'Committed on a detached HEAD';
  return `${where} · ${c.count} commit${c.count === 1 ? '' : 's'}`;
}

// A PR opened, merged or closed: a message of its own, with no summary to write.
const PR_VERB = { 'in-review': 'opened', merged: 'merged', closed: 'was closed' };

export function isPrEvent(job) {
  return Boolean(PR_VERB[job.status] && job.pr);
}

// What Claude is asked to do with a message the person sees only one line of: a short answer that ends with
// the decision, never the line again, and the mechanics only when asked.
export const REPLY_RULE = 'The person sees only Podium\'s one-line message, not this note. Reply in one or two short sentences: what it means for them, ending with the decision if there is one (for example "Keep it?" or "Approve it?"). Do not repeat their line. Leave out paths, ids, branches, timings and how follow-ups work unless they ask.';

// `visible` is for the fallback, where the person sees the whole note: the closing line about what the
// person saw would then be untrue, so it is left out (the tool hints stay; Claude still needs them).
function prMessage(job, visible = false) {
  const ticket = job.ticket && job.ticket !== 'NO-TICKET' ? ` for ${job.ticket}` : '';
  const pr = job.pr;
  const what = job.status === 'in-review'
    ? `PR #${pr.number} (${pr.url}) is open on ${pr.branch}${ticket}. Podium watches its checks; Merge when green is ${pr.autoMerge ? 'on' : 'off'}.`
    : job.status === 'merged'
      ? `PR #${pr.number} (${pr.url}) merged into ${pr.base}${ticket}. Podium removed its copy and the branch.`
      : `PR #${pr.number} (${pr.url}) was closed without merging${ticket}. Podium removed its copy.`;
  const process = job.status === 'in-review'
    ? 'If this project has a close-out process for an opened PR (for example moving the ticket to In Review), follow it now.'
    : job.status === 'merged' ? 'If this project has a post-merge close-out (ticket done with evidence, docs, lessons), follow it now.' : null;
  return [`[Podium] ${what}`, process, `Job ${job.id}.`, visible ? null : REPLY_RULE]
    .filter(Boolean).join('\n\n');
}

// What the person sees in the transcript: one line, what happened and where to act. The details ride along as
// a note only Claude reads (finishedMessage), so the reply does not repeat a wall of text.
export function finishedHeadline(job) {
  // Named for the PR, not the step that ended it ("CI failed on PR #2 …" read as the work).
  if (isPrEvent(job)) return `Podium: PR #${job.pr.number} ${PR_VERB[job.status]}: "${shorten(job.pr.title ?? job.title, 60)}".`;
  const who = agentLabel(job.agent);
  const title = `"${shorten(job.title, 60)}"`;
  if (job.status === 'needs-review') return `Podium: ${who} finished ${title}: ${job.pr ? `new changes for PR #${job.pr.number}, to push in the pane` : 'changes to review in the pane'}.`;
  if (job.status === 'failed') return `Podium: ${who} stopped with an error on ${title}.`;
  if (job.status === 'lost') return `Podium: ${who} stopped unexpectedly on ${title}.`;
  if (job.committed) return `Podium: ${who} finished ${title}: committed to ${job.committed.branch ?? 'a detached HEAD'}.`;
  return `Podium: ${who} finished ${title}.`;
}

export function finishedMessage(job, summary, visible = false) {
  if (isPrEvent(job)) return prMessage(job, visible);
  const lines = [`[Podium] ${agentLabel(job.agent)} ${FINISHED_VERB[job.status] ?? 'finished'}: "${shorten(job.title, 80)}" (${detailLines(job)}).`];
  if (summary && summary.trim()) lines.push('', 'Summary:', summary.trim());
  else if (job.error) lines.push('', job.error);
  if (job.warning) lines.push('', `${job.warning.message}${job.warning.repair ? ' Podium can repair this: open the job in the Podium pane and press Repair.' : ''}`);
  if (job.committed) {
    const extra = job.leftovers ? " The agent also left uncommitted edits in Podium's copy." : '';
    lines.push('', `${committedText(job)}. The commits are already on that branch; there is nothing to keep.${extra}`);
  } else if (job.status === 'needs-review' && job.pr) {
    lines.push('', `These changes are for PR #${job.pr.number} and are waiting in Podium's copy${job.worktree ? ` at ${job.worktree}` : ''}. Push them to the PR from the pane (Push to PR) or with the pr tool (action push), or ask for more changes.`);
  } else if (job.status === 'needs-review') {
    const where = job.worktree ? ` at ${job.worktree}` : '';
    lines.push('', `Its changes are waiting in the Podium pane. Keep or throw them away there, or ask me to. Until they are kept they live only in Podium's separate copy${where}, not in the person's folder: read them there, not in the folder.`);
  }
  if (job.threadId && !['kept', 'discarded'].includes(job.status)) {
    lines.push('', `Thread ${job.threadId} · step ${job.step ?? 1}. To change this work: dispatch with followUp: ${job.id}.`);
  }
  lines.push('', `Job ${job.id}. Use podium_result with full: true if you need the whole output.`);
  if (!visible) lines.push('', REPLY_RULE);
  return lines.join('\n');
}

// ---- Pane UX ----

const LANE = { 'needs-review': 'needs', queued: 'working', running: 'working' };
const FAILED = new Set(['failed', 'lost', 'cancelled']);
const DONE_LIMIT = 30;
const QUIET_MS = 10_000;

export function laneOf(job) {
  if (job.status === 'in-review') return job.pr?.attention ? 'needs' : 'review';
  return LANE[job.status] ?? 'done';
}

export function toneOf(job) {
  const lane = laneOf(job);
  if (lane === 'review') return 'neutral';
  return lane === 'done' && FAILED.has(job.status) ? 'failed' : lane;
}

export function lanes(jobs) {
  const out = { needs: [], working: [], done: [] };
  for (const job of jobs) out[laneOf(job)].push(job);
  out.done = out.done.slice(0, DONE_LIMIT);
  return out;
}

export function clock(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

export function elapsedText(job, now = Date.now()) {
  return clock(now - Date.parse(job.startedAt ?? job.createdAt));
}

export function doneText(job, now = Date.now()) {
  const took = job.startedAt && job.endedAt ? `took ${clock(Date.parse(job.endedAt) - Date.parse(job.startedAt))}` : null;
  const ago = `${clock(now - Date.parse(job.endedAt ?? job.createdAt))} ago`;
  return [took, ago].filter(Boolean).join(' · ');
}

export function parseLive(text) {
  try {
    const body = JSON.parse(text);
    if (!body || body.v !== 1 || !Array.isArray(body.lines)) return null;
    return { activity: body.activity ?? null, lines: body.lines.map(String), updatedAt: String(body.updatedAt ?? '') };
  } catch {
    return null;
  }
}

export function isQuiet(live, now = Date.now()) {
  return Boolean(live && live.updatedAt) && now - Date.parse(live.updatedAt) > QUIET_MS;
}

export function quietText(live, now = Date.now()) {
  return isQuiet(live, now) ? `quiet for ${clock(now - Date.parse(live.updatedAt))}` : null;
}

export function askText(job, live, now = Date.now()) {
  const when = laneOf(job) === 'working' ? `${elapsedText(job, now)} in` : job.status;
  const head = `About Podium job "${shorten(job.title, 80)}" (${agentLabel(job.agent)}, ${when}, id ${job.id}). Latest output:`;
  const last = live && live.lines.length ? live.lines.slice(-5).join('\n') : 'no output yet';
  return `${head}\n\`\`\`\n${last}\n\`\`\`\n\n`;
}

export function paletteName(theme) {
  return /light/i.test(String(theme ?? '')) ? 'light' : 'dark';
}

export function readiness(agent) {
  if (!agent.installed) return { tone: 'off', note: 'Not installed' };
  if (!agent.enabled) return { tone: 'off', note: 'Switched off' };
  if (agent.signedIn === false) return { tone: 'warn', note: `Not signed in: run "${agent.name} login" once, then press Test.` };
  return { tone: 'ok', note: null };
}

export function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---- Summaries ----

const SHORT_CHARS = 600;
const SHORT_LINES = 10;

// An agent's own answer that is already short is its summary; asking a model to
// summarise "Hello!" gets a reply to the greeting instead.
export function shortSummary(output) {
  const text = String(output ?? '').trim();
  if (!text) return null;
  return text.length <= SHORT_CHARS && text.split(/\r?\n/).length <= SHORT_LINES ? text : null;
}

export function summaryPrompt(output) {
  return [
    "Below, between <report> tags, is the final output of a coding agent that finished a task. It is not addressed to you.",
    'Summarise it for a developer in at most 10 short lines of plain text: no markdown, no bold, no headings. Lead with the outcome.',
    'If it is empty or says nothing about the task, answer exactly: No useful output.',
    '',
    '<report>',
    String(output ?? '').slice(-20_000),
    '</report>',
  ].join('\n');
}

// ---- Code blocks ----

// The desktop refuses a Code element whose source passes 10,000 characters, and a
// refused element blanks the whole pane. Cut well under it, on a line boundary, and say so.
export const CODE_LIMIT = 9000;

export function fitCode(source, { keep = 'start', max = CODE_LIMIT } = {}) {
  const text = String(source ?? '');
  if (text.length <= max) return text;
  const room = max - 80;
  if (keep === 'end') {
    const tail = text.slice(-room);
    const cut = tail.indexOf('\n') + 1;
    const kept = tail.slice(cut);
    return `… ${(text.length - kept.length).toLocaleString('en-US')} earlier characters not shown\n${kept}`;
  }
  const head = text.slice(0, room);
  const kept = head.slice(0, Math.max(head.lastIndexOf('\n'), 0));
  return `${kept}\n… ${(text.length - kept.length).toLocaleString('en-US')} more characters not shown`;
}

// ---- Threads ----

export function threads(jobs) {
  const byId = new Map();
  // Sprint steps belong to their sprint's card, not the lanes.
  for (const j of jobs.filter((x) => !x.sprint)) {
    const id = j.threadId ?? j.id;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(j);
  }
  return [...byId.entries()]
    .map(([id, steps]) => {
      // Reviews join a thread but are never the step to continue.
      const work = steps.filter((s) => s.kind !== 'review').sort((a, b) => (b.step ?? 1) - (a.step ?? 1));
      const all = work.length === steps.length ? work : [...steps].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      return { id, latest: work[0] ?? all[0], steps: all };
    })
    .sort((a, b) => Date.parse(b.latest.createdAt) - Date.parse(a.latest.createdAt));
}

// A sprint ticket's steps, newest first: its writers' steps and its reviews. The detail
// screen lists them as it lists a thread's.
export function ticketSteps(jobs, sprint) {
  return jobs
    .filter((j) => j.sprint && j.sprint.id === sprint.id && j.sprint.ticket === sprint.ticket)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || String(b.id).localeCompare(String(a.id)));
}

// A sprint step's row in Steps and diff says what the step did ("Claude wrote task 1", "Codex reviewed task 1 ·
// passed"), not its place in a follow-up chain: every review is a job of its own and an author's steps count on,
// so that number means nothing here. `steps` is the ticket's steps (ticketSteps), which tell what a review led
// to. Podium records no verdict on the job, so a review is passed or failed only when a later step shows it: the
// next task's writer means it passed, a fix of the same task means it failed. Otherwise the outcome is left off.
// A step's own record wins over any inference: a step run again (Retry, a usage-limit wait) is followed up
// by the new one, which marks it `continued` with its real end in `endStatus`, so a failed step still says it failed.
const FIX_TITLE = /fix what the reviewer found/i;
// The writer's fix after a failed full check: it follows the last task, but no review sent it back.
const CHECK_FIX_TITLE = /fix what the full check found/i;
const CHANGE_TITLE = /change the plan/i;
const STEP_FAILED = new Set(['failed', 'lost', 'cancelled']);
const startedBefore = (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || String(a.id).localeCompare(String(b.id));
const stepEnd = (step) => (step.status === 'continued' ? (step.endStatus ?? 'done') : step.status);

function isFix(step, steps) {
  if (FIX_TITLE.test(step.title ?? '')) return true;
  // Only a review that ran to its end can send its task back for a fix.
  return steps.some((x) => x.sprint?.role === 'reviewer' && x.sprint.task === step.sprint.task && !STEP_FAILED.has(stepEnd(x)) && startedBefore(x, step) < 0);
}

function reviewOutcome(step, steps) {
  const later = steps.filter((x) => x.sprint?.role === 'author' && !x.sprint.plan && !CHECK_FIX_TITLE.test(x.title ?? '') && startedBefore(step, x) < 0);
  if (later.some((x) => x.sprint.task === step.sprint.task)) return 'failed';
  if (later.some((x) => x.sprint.task > step.sprint.task)) return 'passed';
  return null;
}

export function sprintStepLine(step, steps, now = Date.now()) {
  const who = agentLabel(step.agent) || 'No agent';
  const n = step.sprint.task;
  const reviewer = step.sprint.role === 'reviewer';
  // A ticket's plan: written, or changed with the person's notes. The step says so (sprint.plan); its task
  // number (0) does not, as a plan may number a real task 0.
  const planning = !reviewer && step.sprint.plan === true;
  const checkFix = !reviewer && !planning && CHECK_FIX_TITLE.test(step.title ?? '');
  const fix = !reviewer && !planning && !checkFix && isFix(step, steps);
  const verbs = reviewer ? ['reviewed', 'reviewing'] : planning && CHANGE_TITLE.test(step.title ?? '') ? ['changed', 'changing'] : fix || checkFix ? ['fixed', 'fixing'] : ['wrote', 'writing'];
  const what = planning ? 'the plan' : checkFix ? 'what the full check found' : `task ${n}`;
  const ago = step.endedAt ? `${clock(now - Date.parse(step.endedAt))} ago` : null;
  const status = stepEnd(step);
  if (['running', 'queued'].includes(status)) return `${who} ${verbs[1]} ${what} · ${status === 'running' ? 'working' : 'queued'}`;
  if (STEP_FAILED.has(status)) {
    const word = status === 'lost' ? 'stopped' : status;
    return [`${who} couldn't ${reviewer ? 'review' : 'finish'} ${what}`, word, ago].filter(Boolean).join(' · ');
  }
  return [`${who} ${verbs[0]} ${what}`, reviewer ? reviewOutcome(step, steps) : null, ago].filter(Boolean).join(' · ');
}

// ---- Organising jobs ----

const DONE_MIN = 5;
const OTHERS_LIMIT = 30;

export function finishedAt(thread) {
  return Date.parse(thread.latest.endedAt ?? thread.latest.createdAt);
}

function sameDay(a, b) {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

// A thread is another chat's when no step of it was started in this one. With no chat id (it could not be read) none is.
export const fromAnotherChat = (steps, session) => Boolean(session) && !(steps ?? []).some((s) => s.origin?.session === session);

// A thread is this chat's when any step was started here. With no chat id
// (it could not be read) everything is this chat's: the list as it was.
export function organise(list, { session = null, now = Date.now(), clearedAt = null, showAll = false } = {}) {
  const out = { needs: [], working: [], review: [], done: [], doneHidden: 0, others: [] };
  const mineDone = [];
  for (const t of list) {
    const item = { ...t, isMine: !fromAnotherChat(t.steps, session) };
    const lane = laneOf(t.latest);
    if (lane !== 'done') out[lane].push(item);
    else if (item.isMine) mineDone.push(item);
    else out.others.push(item);
  }
  const newestFirst = (a, b) => finishedAt(b) - finishedAt(a);
  mineDone.sort(newestFirst);
  out.others = out.others.sort(newestFirst).slice(0, OTHERS_LIMIT);
  if (showAll) {
    out.done = mineDone;
    return out;
  }
  const cleared = clearedAt ? Date.parse(clearedAt) : -Infinity;
  out.done = mineDone.filter((t) => finishedAt(t) > cleared).filter((t, i) => i < DONE_MIN || sameDay(finishedAt(t), now));
  out.doneHidden = mineDone.length - out.done.length;
  return out;
}

// ---- Install path ----

// The welcome card's rows: ok true (✓), false (✋, needs fixing) or null (a neutral note).
export function checkRows(report, agentList) {
  const rows = [];
  rows.push(report.node.ok
    ? { ok: true, text: `Node ${report.node.version}` }
    : { ok: false, text: `Node ${report.node.version ?? 'not found'}: Podium needs Node 22 or newer (nodejs.org)` });
  rows.push(report.git.ok
    ? { ok: true, text: `git ${report.git.version}` }
    : { ok: false, text: report.git.version ? `git ${report.git.version}: Podium needs git 2.28 or newer (git-scm.com)` : 'git not found: install it from git-scm.com' });
  if (agentList === null) rows.push({ ok: null, text: 'Looking for agents…' });
  else {
    const found = agentList.filter((a) => a.installed);
    rows.push(found.length
      ? { ok: true, text: `Agents: ${found.map((a) => `${a.label} ${a.version ?? ''}`.trim()).join(' · ')}` }
      : { ok: false, text: 'No agents found: install Codex, Muse, Gemini or another agent CLI, then press Check again' });
    for (const a of agentList.filter((x) => !x.installed)) rows.push({ ok: null, text: `${a.label} not installed` });
  }
  rows.push(!report.gh.installed
    ? { ok: null, text: 'GitHub CLI not installed: needed for PRs (cli.github.com)' }
    : report.gh.signedIn
      ? { ok: true, text: `GitHub CLI ${report.gh.version}` }
      : { ok: null, text: 'GitHub CLI not signed in: needed for PRs (sign in with gh auth login)' });
  rows.push(report.tellClaude
    ? { ok: true, text: 'Claude is told when jobs finish' }
    : { ok: false, text: "Claude isn't told when jobs finish: turn it on in Settings" });
  return rows;
}

export function sizeText(bytes) {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export function removalText(plan) {
  const parts = [`This deletes ${sizeText(plan.bytes)} of Podium's data${plan.copies ? `, including ${plural(plan.copies, 'copy', 'copies')}` : ''}.`];
  if (plan.unkept) parts.push(`${plural(plan.unkept, 'job', 'jobs')} with unkept changes will be lost.`);
  if (plan.running) parts.push(`${plural(plan.running, 'running job', 'running jobs')} will be stopped.`);
  return parts.join(' ');
}

// ---- PR cards ----

export const REVIEW_WORDS = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes requested', REVIEW_REQUIRED: 'waiting' };

// ---- Sprints ----

// Safe for anything (a number or an object from malformed sprint data draws as text, never throws).
const named = (a) => agentLabel(a);
const isReviewing = (phase) => phase === 'review' || phase === 'fix-review';
const SHIPPED_STATES = new Set(['pr-open', 'merged', 'closed']);
// A ticket with nothing left to do: its PR is merged or closed, or the person stopped it.
export const SPRINT_ENDED = new Set(['merged', 'closed', 'stopped']);
// A ticket waiting for the person: parked, or its plan waiting for an answer.
export const NEEDS_YOU_STATES = new Set(['parked', 'plan-ready', 'no-tasks']);
// How many tickets run at once when a sprint does not say: the engine's default (settings.sprintParallel).
export const AT_ONCE_DEFAULT = 3;
// A pending ticket that may start: whether a slot is free for it (the summary's `slot`).
const slotWords = (t) => (t.slot === 'full' ? 'waiting for a free slot' : t.slot === 'free' ? 'starting' : null);
const isPlanning = (phase) => phase === 'plan' || phase === 'revise';

// A sprint card stays while any ticket is still going, and always when the sprint's state can't be read. A capped card
// (`more`) was open when it was cut, so it stays too; a finished sprint's row (`ended`) does not.
export function isOpenSprint(s) {
  if (s.unreadable) return true;
  if (s.ended === true) return false;
  return s.more > 0 || (s.tickets ?? []).some((t) => !SPRINT_ENDED.has(t.state));
}

// A finished sprint: started, not thrown away, readable, and every ticket ended. Its list row sits in the
// Done fold (this chat's) or the Other chats fold. One archived because it ended (its news delivered; `podium status --here`
// still lists the newest) is finished; one archived because it was discarded never is. A sprint with no tickets has not
// finished anything.
export function isFinishedSprint(s) {
  if (!s || s.draft || s.discarded || s.unreadable) return false;
  if (s.ended === true) return true;
  return (s.tickets ?? []).length > 0 && !isOpenSprint(s);
}

// A finished sprint's tone: failed if any ticket was stopped or its PR closed, otherwise done.
export function finishedSprintTone(s) {
  if (typeof s.tone === 'string') return s.tone;
  return (s.tickets ?? []).some((t) => t.state === 'stopped' || t.state === 'closed') ? 'failed' : 'done';
}

// How a row says it was started in another chat: a job's (workingRowLine, turnItems, In review) and a sprint's.
export const FROM_OTHER_CHAT = 'from another chat';

// A sprint is this chat's when it was started here (`chat`), or when either side's chat is unknown: with no
// session everything is this chat's (as organise), and a sprint with no chat takes news from any chat, so it is not labelled.
export const isSprintMine = (s, session) => !session || !s?.chat || s.chat === session;

// Finished sprints split into this chat's (Done) and other chats' (Other chats), each newest first by finishedAt. The
// list shows FINISHED_SPRINTS of each, and fitModel sends no more.
export const FINISHED_SPRINTS = 5;
const finishedMs = (s) => Date.parse(s?.finishedAt ?? '') || 0;
// The engine orders and picks them the same way (engine/sprint.js keepNewest), so the pane's newest are the true newest.
export const olderSprintsLine = (n) => (n === 1 ? '1 older sprint is not shown here; ask Claude for it.' : `${n} older sprints are not shown here; ask Claude for them.`);
export function finishedSprints(list, session = null) {
  const all = (list ?? []).filter(isFinishedSprint).sort((a, b) => finishedMs(b) - finishedMs(a) || String(b.id).localeCompare(String(a.id)));
  return { mine: all.filter((s) => isSprintMine(s, session)), others: all.filter((s) => !isSprintMine(s, session)) };
}

// State colours: the tone of a row or screen head, a key of hooks/theme.ts. A sprint's is counted over its
// tickets (a capped card carries its own: capRows).
export function sprintTone(s) {
  if (s.unreadable) return 'failed';
  if (typeof s.tone === 'string') return s.tone;
  const tickets = s.tickets ?? [];
  return tickets.some((t) => NEEDS_YOU_STATES.has(t.state)) ? 'needs' : tickets.some((t) => t.state === 'running') ? 'working' : 'neutral';
}

// A ticket's: its board line, and the head of its own screen.
export function ticketTone(state) {
  if (NEEDS_YOU_STATES.has(state)) return 'needs';
  if (state === 'running') return 'working';
  if (state === 'pr-open' || state === 'merged') return 'done';
  return state === 'stopped' || state === 'closed' ? 'failed' : 'neutral';
}

// A finished job's row (Done, Other chats): failed, lost or cancelled work is `failed`, the rest `done`.
export const finishedTone = (job) => (FAILED.has(job.status) ? 'failed' : 'done');

// A job screen's head: the job's tone, and a PR that needs attention needs the person whatever the job's own status.
export const jobTone = (job) => (job.pr?.state === 'OPEN' && job.pr.attention ? 'needs' : toneOf(job));

export function sprintRow(t, draft = false) {
  if (draft) {
    // A draft's row: how many tasks, and who writes and reviews them, and what it waits for.
    // A card (sprintCard) carries the tasks' writers and reviewers instead.
    const after = t.after?.length ? ` · after ${t.after.join(', ')}` : '';
    if (!t.of) return `no plan yet · ${named(t.writer)} plans it · tasks reviewed by ${named(t.reviewer)}${after}`;
    const listed = (k) => (t.tasks ? t.tasks.map((x) => x[k]) : (k === 'agent' ? t.writers : t.reviewers) ?? []);
    const who = (k) => { const names = [...new Set(listed(k))]; return names.length === 1 ? named(names[0]) : 'several agents'; };
    return `${t.of} task${t.of === 1 ? '' : 's'} · written by ${who('agent')} · reviewed by ${who('reviewer')}${after}`;
  }
  switch (t.state) {
    case 'pending': return t.waitingOn?.length ? `waiting (after ${t.waitingOn.join(', ')})` : slotWords(t) ?? 'waiting to start';
    case 'running':
      if (isPlanning(t.phase)) return `${t.phase === 'revise' ? 'Changing the plan' : 'Writing the plan'} · ${named(t.agent)} working`;
      if (t.phase === 'check') return 'Full check before the PR · running';
      if (t.phase === 'check-fix') return `Fixing what the full check found · ${named(t.agent)} working`;
      return `Task ${t.task}/${t.of} · ${named(t.agent)} ${isReviewing(t.phase) ? 'reviewing' : t.phase === 'fix' ? 'fixing' : 'working'}${t.reviews ? ` · reviews ${t.reviews} ✓` : ''}`;
    case 'waiting': return t.reason ?? 'waiting';
    case 'parked': return `✋ ${t.reason}`;
    case 'plan-ready': return 'Plan ready: approve?';
    case 'no-tasks': return "✋ Couldn't find tasks in this plan";
    case 'pr-open': return `PR #${t.pr?.number} open`;
    case 'merged': return `✓ PR #${t.pr?.number} merged`;
    case 'closed': return `PR #${t.pr?.number} closed`;
    case 'stopped': return 'stopped';
    default: return t.state;
  }
}

// What a running ticket is doing, in a few words (the sprint's headline in the tool's text). The board's status line names
// running tickets by key only (sprintStatusLine).
export function doingText(t) {
  if (isPlanning(t.phase)) return `${named(t.agent)} ${t.phase === 'revise' ? 'changing the plan for' : 'planning'} ${t.key}`;
  if (t.phase === 'check') return `full check on ${t.key}`;
  if (t.phase === 'check-fix') return `${named(t.agent)} fixing ${t.key} for its full check`;
  return `${named(t.agent)} ${isReviewing(t.phase) ? 'reviewing' : 'working on'} ${t.key} task ${t.task}`;
}

export function sprintHeadline(s) {
  // A capped card carries its own (capRows).
  if (typeof s.headline === 'string') return s.headline;
  const count = `${s.tickets.length} ticket${s.tickets.length === 1 ? '' : 's'}`;
  if (s.discarded) return `Sprint · ${s.name} · draft discarded`;
  if (s.draft) return `Sprint · ${s.name} · draft, not started · ${count}`;
  const done = s.tickets.filter((t) => SHIPPED_STATES.has(t.state)).length;
  const stopped = s.tickets.filter((t) => t.state === 'stopped').length;
  const needs = s.tickets.filter((t) => NEEDS_YOU_STATES.has(t.state)).length;
  // How many run at once, and what each one does (naming only the first leads Claude to say one runs at a time).
  return [
    `Sprint · ${s.name}`,
    `${done} of ${s.tickets.length} tickets done${stopped ? `, ${stopped} stopped` : ''}`,
    needs ? `${needs} needs you` : null,
    s.paused ? 'paused' : null,
    runsText(s, (t) => doingText(t)),
  ].filter(Boolean).join(' · ');
}

// "N of M running", naming each running ticket with `name`. A ticket waiting out a usage limit holds a slot too, so
// the count adds ", N waiting": it never reads as a free slot beside a ticket "waiting for a free slot".
function runsText(s, name) {
  const running = s.tickets.filter((t) => t.state === 'running');
  const waiting = s.tickets.filter((t) => t.state === 'waiting').length;
  if (!running.length && !waiting) return null;
  const names = running.length ? `: ${running.map(name).join(', ')}` : '';
  return `${running.length} of ${s.maxParallel ?? AT_ONCE_DEFAULT} running${waiting ? `, ${waiting} waiting` : ''}${names}`;
}

export function sprintLines(s) {
  // The name comes from an older state file when the newest can't be read; the id stands in only when none is known.
  if (s.unreadable) return [`Sprint ${s.name || s.id}: Podium can't read this sprint's saved state`, s.unreadable];
  return [sprintHeadline(s), ...s.tickets.map((t) => `${t.key}  ${t.title}  ${sprintRow(t, s.draft)}`)];
}

// An update's first sentence: its first line, up to a full stop (or ! or ?) followed by a space that is outside
// brackets and quotes, so a file name or the person's quoted notes stay whole. Its own closing stop is left off.
export function firstSentence(text) {
  const line = shorten(text, Infinity);
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (!quoted && c === '(') depth += 1;
    else if (!quoted && c === ')') depth = Math.max(0, depth - 1);
    else if (!quoted && !depth && /[.!?]/.test(c) && /\s/.test(line[i + 1] ?? '')) return line.slice(0, i);
  }
  return line.replace(/\.$/, '');
}

const NEWS_HEADLINE = 280;
const NEWS_PART = 120;

// The transcript line for sprint news. It must make sense on its own ("Podium: 2 sprint
// updates" reads as a notice without the updates, and sends Claude to the board): one update shows its first line,
// several show each one's first sentence, joined with " · ", and "and N more" once the line is long.
export function sprintNewsHeadline(messages) {
  if (messages.length === 1) return `Podium: ${shorten(messages[0].text, NEWS_PART)}`;
  const parts = messages.map((m) => shorten(firstSentence(m.text), NEWS_PART));
  const shown = [];
  for (const part of parts) {
    const left = parts.length - shown.length - 1;
    const line = `Podium: ${[...shown, part, ...(left ? [`and ${left} more`] : [])].join(' · ')}`;
    if (shown.length && line.length > NEWS_HEADLINE) break;
    shown.push(part);
  }
  const left = parts.length - shown.length;
  return `Podium: ${[...shown, ...(left ? [`and ${left} more`] : [])].join(' · ')}`;
}

export function sprintNewsNotes(messages, visible = false) {
  return [
    '[Podium] Sprint updates:',
    ...messages.map((m) => m.text),
    'Each sprint ticket ends as a PR the person merges. The podium sprint tool shows the board (action status) and can retry a parked ticket, stop one the person has given up on, give a task to another agent, approve a plan or send it back with changes, pause or resume.',
    visible ? null : REPLY_RULE,
  ].filter(Boolean).join('\n\n');
}

// ---- Pane clarity ----

// Whether a folded section is open. `folds` (pane state) lists the sections whose state differs from their default, so a
// section that opens by default (setup checks with something wrong) closes when listed.
export function isFoldOpen(folds, id, byDefault = false) {
  return (folds ?? []).includes(id) !== byDefault;
}

// The folds left when leaving `view` from the couldn't-draw note (Back to the list): that screen's own folds go, so it
// does not reopen with the same folds open (and the same failure). Every other screen's folds stay.
export function foldsLeaving(folds, view) {
  const v = view ?? {};
  const prefix = !v.id ? null
    : v.screen === 'detail' ? `job:${v.id}:`
    : v.screen === 'ticket' ? (v.key ? `ticket:${v.id}:${v.key}:` : `board:${v.id}:`)
    : v.screen === 'sprint' ? `board:${v.id}:`
    : v.screen === 'agent' ? `agent:${v.id}:`
    : null;
  return (folds ?? []).filter((f) => !prefix || !f.startsWith(prefix));
}

const ACCESS_WORDS = { 'read-only': 'read only', 'edit-worktree': 'separate copy', 'own-config': "agent's own settings", 'full-access': 'full access' };
export const accessWord = (permission) => ACCESS_WORDS[permission] ?? String(permission ?? '');

const agoText = (job, now) => `${clock(now - Date.parse(job.endedAt ?? job.createdAt))} ago`;

export function prChecks(pr) {
  const c = pr.checks ?? { total: 0 };
  if (!c.total) return 'no checks';
  return [`${c.passed} of ${c.total} checks passed`, c.failed ? `${c.failed} failed` : null, c.running ? `${c.running} running` : null].filter(Boolean).join(' · ');
}

export const prSub = (pr) => `${prChecks(pr)} · review: ${REVIEW_WORDS[pr.review] ?? 'none yet'}`;

export function attentionLine(pr) {
  if (pr.attention === 'ci-failed') return `checks failed${pr.checks?.failing?.length ? `: ${pr.checks.failing.join(', ')}` : ''}`;
  if (pr.attention === 'changes-requested') return 'a reviewer asked for changes';
  if (pr.attention === 'conflict') return 'it conflicts with the base branch';
  if (pr.attention === 'blocked') return `GitHub refused the merge${pr.blocked ? `: ${pr.blocked}` : ''}`;
  return String(pr.attention ?? '');
}

// The line under a job's title on its screen.
export function jobStatusLine(job, now = Date.now()) {
  const who = agentLabel(job.agent);
  const ago = agoText(job, now);
  const pr = job.pr;
  if (job.status === 'queued') return `${who} · queued · ${accessWord(job.permission)}`;
  if (job.status === 'running') return `${who} · working ${elapsedText(job, now)} · ${accessWord(job.permission)}`;
  if (job.status === 'needs-review') return `${who} finished ${ago} · ${pr ? `new changes for PR #${pr.number}` : 'changes to review'}`;
  if (job.status === 'in-review' && pr) return pr.attention ? `PR #${pr.number} · ${attentionLine(pr)}` : `PR #${pr.number} · ${prSub(pr)}`;
  if ((job.status === 'merged' || job.status === 'closed') && pr) return `PR #${pr.number} ${job.status} ${ago}`;
  if (job.status === 'failed') return `${who} stopped with an error ${ago}`;
  if (job.status === 'lost') return `${who} stopped unexpectedly ${ago}`;
  if (job.status === 'cancelled') return `Stopped ${ago}`;
  if (job.status === 'kept') return `Kept ${ago}`;
  if (job.status === 'discarded') return `Thrown away ${ago}`;
  const c = job.committed;
  return `${who} finished ${ago}${c ? ` · ${c.count} commit${c.count === 1 ? '' : 's'} on ${c.branch ?? 'a detached HEAD'}` : ''}`;
}

// A Working row's second line: who and for how long. The live line under it says what it is doing.
export function workingRowLine(job, now = Date.now(), live = null, fromOther = false) {
  return [`${agentLabel(job.agent)}`, elapsedText(job, now), quietText(live, now), fromOther ? FROM_OTHER_CHAT : null].filter(Boolean).join(' · ');
}

const DONE_ROW_WORDS = { done: 'finished', kept: 'kept', discarded: 'thrown away', cancelled: 'stopped', failed: 'stopped with an error', lost: 'stopped unexpectedly', merged: 'merged', closed: 'closed' };

// A Done row's second line: who, and what happened when.
export function doneRowLine(job, now = Date.now()) {
  const word = job.pr && (job.status === 'merged' || job.status === 'closed') ? `PR #${job.pr.number} ${job.status}`
    : job.committed && job.status === 'done' ? `committed to ${job.committed.branch ?? 'a detached HEAD'}`
    : DONE_ROW_WORDS[job.status] ?? job.status;
  return `${agentLabel(job.agent)} · ${word} ${agoText(job, now)}`;
}

// A sprint ticket's Your turn button: a parked one shows why it stopped; a plan waiting is reviewed.
export const turnLabel = (state) => (state === 'parked' ? 'See why' : 'Review plan');

const FAILED_TURN = new Set(['failed', 'lost']);
// A failed or lost job waits on the person (Your turn) until it is cleared, followed up or thrown away.
export const isFailedTurn = (thread) => FAILED_TURN.has(thread.latest.status);
const firstTitle = (t) => t.steps[t.steps.length - 1]?.title || t.latest.title || 'Untitled job';

// Everything waiting on the person (Your turn): changes to review and PRs that need attention, failed jobs,
// then sprint tickets (turnTickets). Each has one button: `act` names the pane action it calls, `open` where its title leads.
// A job started in another chat says so (isMine false, from organise), as its Working row does.
export function turnItems(org, tickets = []) {
  const items = [];
  const from = (t) => (t.isMine === false ? ` · ${FROM_OTHER_CHAT}` : '');
  for (const t of org.needs) {
    const job = t.latest;
    const who = agentLabel(job.agent);
    const open = { name: 'openDetail', args: [job.id] };
    const base = { id: job.id, title: firstTitle(t), open };
    if (job.status === 'needs-review') {
      items.push({ ...base, reason: `${who} finished · ${job.pr ? `new changes for PR #${job.pr.number}` : 'changes to review'}${from(t)}`, label: 'Review', act: open });
    } else if (job.pr) {
      const reason = `PR #${job.pr.number} · ${attentionLine(job.pr)}${from(t)}`;
      if (job.pr.attention === 'ci-failed') items.push({ ...base, reason, label: `Send fix to ${who}`, act: { name: 'fixOpen', args: [t.id, job.id, job.agent, 'ci'] } });
      else if (job.pr.comments > 0) items.push({ ...base, reason, label: 'Answer comments', act: { name: 'fixOpen', args: [t.id, job.id, job.agent, 'comments'] } });
      else items.push({ ...base, reason, label: 'Open', act: open });
    }
  }
  for (const t of org.done.filter(isFailedTurn)) {
    const job = t.latest;
    const open = { name: 'openDetail', args: [job.id] };
    items.push({ id: job.id, title: firstTitle(t), open, reason: `${agentLabel(job.agent)} ${job.status === 'lost' ? 'stopped unexpectedly' : 'stopped with an error'}${from(t)}`, label: 'See what happened', act: open });
  }
  for (const x of tickets) {
    const open = { name: 'openTicket', args: [x.sprint, x.key] };
    const why = x.state === 'plan-ready' ? 'plan ready' : x.state === 'no-tasks' ? 'no tasks found in the plan' : (x.reason || 'needs you');
    items.push({ id: `${x.sprint}-${x.key}`, title: `${x.key} ${x.title}`, open, reason: `${x.sprintName} · ${why}`, label: turnLabel(x.state), act: open });
  }
  return items;
}

// "2026-10-05 11:56 UTC" from an ISO time.
const when = (iso) => `${String(iso).slice(0, 10)} ${String(iso).slice(11, 16)} UTC`;

// The job screen's Details fold: everything about the job that is not what happened. `fromOther`: its thread
// was started in another chat (fromAnotherChat).
export function jobDetails(job, fromOther = false) {
  const took = job.startedAt && job.endedAt ? ` · took ${clock(Date.parse(job.endedAt) - Date.parse(job.startedAt))}` : '';
  const branch = job.pr?.branch ? `Branch: ${job.pr.branch}` : job.committed?.branch ? `Branch: ${job.committed.branch}` : job.base ? `Started from: ${job.base}` : null;
  return [
    `Ticket: ${job.ticket && job.ticket !== 'NO-TICKET' ? job.ticket : 'none'}`,
    `Access: ${agentLabel(job.agent)} ${PERMISSION_WORDS[job.permission] ?? `used "${job.permission}"`}`,
    `Agent: ${agentLabel(job.agent)}${job.model ? ` (${job.model})` : ''}`,
    fromOther ? 'Origin: another chat' : null,
    `Started ${when(job.startedAt ?? job.createdAt)}${took}`,
    branch,
    job.pr?.url ? `PR: ${job.pr.url}` : null,
    job.worktree ? `Podium's copy: ${job.worktree}` : null,
    `Job id: ${job.id}`,
  ].filter(Boolean);
}

// "ABC-11", "ABC-11 and ABC-12", "ABC-11, ABC-12 and ABC-13".
export const andList = (keys) => (keys.length < 2 ? keys.join('') : `${keys.slice(0, -1).join(', ')} and ${keys[keys.length - 1]}`);

// A sprint's row title on the list: the list draws it and cardCost (mod/client.js) measures it.
export const sprintRowTitle = (s) => (s?.unreadable ? `Sprint ${s?.name || s?.id}` : `Sprint · ${s?.name ?? s?.id}`);

// A sprint's one line: on its list row and under its name on the board (a capped card carries its own).
export function sprintStatusLine(s) {
  if (typeof s.status === 'string') return s.status;
  if (s.unreadable) return "Podium can't read this sprint's saved state";
  const n = s.tickets.length;
  if (s.draft) return `Draft · ${n} ticket${n === 1 ? '' : 's'} · not started`;
  const done = s.tickets.filter((t) => SHIPPED_STATES.has(t.state)).length;
  const stopped = s.tickets.filter((t) => t.state === 'stopped').length;
  // How many run at once, naming each. The ticket rows say what each one does.
  return [`${done} of ${n} done`, stopped ? `${stopped} stopped` : null, s.paused ? 'paused' : null, runsText(s, (t) => t.key)].filter(Boolean).join(' · ');
}

// A sprint's Working row line: its status line, and, when another chat started it, the words a job row has.
export const sprintWorkingLine = (s, fromOther = false) => `${sprintStatusLine(s)}${fromOther ? ` · ${FROM_OTHER_CHAT}` : ''}`;

// A finished sprint's row line (Done, Other chats): its status line and how long ago it finished, as a Done job's row.
export function finishedSprintLine(s, now = Date.now()) {
  const at = Date.parse(s?.finishedAt ?? '');
  return `${sprintStatusLine(s)}${Number.isFinite(at) ? ` · finished ${clock(now - at)} ago` : ''}`;
}

const tasksWord = (n) => `${n} task${n === 1 ? '' : 's'}`;

// A ticket's row on the board: where it stands, in a few words.
export function ticketState(t, draft = false) {
  if (draft) {
    const after = t.after?.length ? ` · after ${t.after.join(', ')}` : '';
    return `${t.of ? tasksWord(t.of) : 'no plan yet'}${after}`;
  }
  switch (t.state) {
    case 'pending': return t.waitingOn?.length ? `starts after ${andList(t.waitingOn)}` : slotWords(t) ?? 'waiting to start';
    case 'running':
      if (isPlanning(t.phase)) return `${named(t.agent)} ${t.phase === 'revise' ? 'changing' : 'writing'} the plan`;
      if (t.phase === 'check') return 'running the full check';
      if (t.phase === 'check-fix') return `${named(t.agent)} fixing what the full check found`;
      return `task ${t.task} of ${t.of} · ${named(t.agent)} ${isReviewing(t.phase) ? 'reviewing' : t.phase === 'fix' ? 'fixing' : 'working'}`;
    case 'waiting': return t.reason ?? 'waiting';
    case 'parked': return 'needs you';
    case 'plan-ready': return 'plan ready';
    case 'no-tasks': return 'no tasks found in the plan';
    case 'pr-open': return `PR #${t.pr?.number} open`;
    case 'merged': return `PR #${t.pr?.number} merged`;
    case 'closed': return `PR #${t.pr?.number} closed`;
    case 'stopped': return 'stopped';
    default: return String(t.state);
  }
}

// A ticket's own screen: the line under its key and title, saying what happens next.
export function ticketStatusLine(t, draft = false) {
  if (draft) return t.of ? `${tasksWord(t.of)} · nothing runs until the sprint starts` : `No plan yet · ${named(t.writer ?? t.agent)} plans it first`;
  switch (t.state) {
    case 'plan-ready': return 'Plan ready · check it, then approve';
    case 'no-tasks': return 'No tasks found in the plan · run it as one task, or ask for changes';
    case 'parked': return t.reason || 'Stopped · needs you';
    case 'running':
      if (isPlanning(t.phase)) return `${named(t.agent)} is ${t.phase === 'revise' ? 'changing' : 'writing'} the plan`;
      if (t.phase === 'check') return 'Running the full check before the PR';
      if (t.phase === 'check-fix') return `${named(t.agent)} is fixing what the full check found`;
      return `Task ${t.task} of ${t.of} · ${named(t.agent)} ${isReviewing(t.phase) ? 'reviewing' : t.phase === 'fix' ? 'fixing' : 'working'}`;
    case 'pending': return t.waitingOn?.length ? `Starts when ${andList(t.waitingOn)} ${t.waitingOn.length === 1 ? 'is' : 'are'} merged on GitHub`
      : t.slot === 'full' ? 'Waiting for a free slot' : t.slot === 'free' ? 'Starting' : 'Waiting to start';
    case 'waiting': return t.reason || 'Waiting';
    case 'pr-open': return `PR #${t.pr?.number} open`;
    case 'merged': return `PR #${t.pr?.number} merged`;
    case 'closed': return `PR #${t.pr?.number} closed without merging`;
    case 'stopped': return 'Stopped';
    default: return String(t.state);
  }
}

// Who writes and who reviews a ticket, in one line. A ticket with no plan names its planner; a card (sprintCard)
// carries the tasks' writers and reviewers.
export function whoLine(t) {
  const listed = (k) => (t.tasks?.length ? t.tasks.map((x) => x[k]) : (k === 'agent' ? t.writers : t.reviewers) ?? []);
  const writers = (t.of ?? 0) === 0 && t.writer ? [t.writer] : [...new Set(listed('agent'))];
  const reviewers = (t.of ?? 0) === 0 && t.writer ? [t.reviewer] : [...new Set(listed('reviewer'))];
  if (writers.length !== 1 || reviewers.length !== 1) return 'several agents';
  return writers[0] === reviewers[0] ? `${named(writers[0])} writes and reviews` : `${named(writers[0])} writes, ${named(reviewers[0])} reviews`;
}

export const optionsLine = (s) => `${s.maxParallel ?? AT_ONCE_DEFAULT} at once${s.autoMerge ? ' · merge when green' : ''}`;

// An agent's row on Agents.
export const agentState = (a) => (!a.installed ? 'not installed' : !a.enabled ? 'switched off' : a.signedIn === false ? 'not signed in' : 'ready');
export const agentLine = (a) => `${a.label} · ${agentState(a)}`;
export const agentNeedsFix = (a) => Boolean(a.installed && a.enabled && a.signedIn === false);

export function setupSummary(rows) {
  const n = (rows ?? []).filter((r) => r.ok === false).length;
  return n ? `${n} thing${n === 1 ? '' : 's'} to fix` : 'all good';
}

export const instructionsSummary = (s) => (String(s?.instructions ?? '').trim() || Object.values(s?.repoInstructions ?? {}).some((x) => String(x ?? '').trim()) ? 'set' : 'none');
export const storageSummary = (s) => `${s.retention.compressDays} / ${s.retention.deleteDays} days`;
export const limitsSummary = (s) => `${s.worktreeWarnMB} MB, ${s.longJobMinutes} min`;

const MERGE_WORDS = ['merge', 'squash', 'rebase'];
// Settings → This repo: its heading says what is set for the repo this chat is in.
export function repoSummary(s, project) {
  if (!project) return 'nothing set';
  // The settings file may have been edited by hand: a value of the wrong kind reads as not set.
  const listed = s?.repoCommands?.[project];
  const commands = Array.isArray(listed) ? listed.filter((c) => typeof c === 'string') : [];
  const check = s?.repoCheck?.[project];
  const method = String(s?.repoMergeMethod?.[project] ?? '').toLowerCase();
  const parts = [
    commands.length ? commands.join(' ') : null,
    typeof check === 'string' && check.trim() ? 'full check set' : null,
    s?.repoSquash?.[project] === false ? 'commits kept' : null,
    MERGE_WORDS.includes(method) ? `${method} merges` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'nothing set';
}

// A draft's proposed commands and check (saved for the repo at Start): the board's This repo fold heading, short.
export function proposedSummary(p) {
  const commands = Array.isArray(p?.commands) ? p.commands : null;
  const parts = [
    commands ? (commands.length ? commands.join(' ') : 'no commands') : null,
    typeof p?.check === 'string' ? (p.check ? 'full check' : 'no full check') : null,
  ].filter(Boolean);
  return parts.join(' · ');
}

// The same values in a sentence's words, exact (the tool's reply and Start's notice): "commands dotnet; full check "…"".
export function repoValuesText(v) {
  const parts = [
    Array.isArray(v?.commands) ? `commands ${v.commands.join(', ') || 'none'}` : null,
    typeof v?.check === 'string' ? (v.check ? `full check "${v.check}"` : 'no full check') : null,
  ].filter(Boolean);
  return parts.join('; ');
}

// The pane's notice after Start: what it saved for the repo from the draft's proposal, if anything.
export const startedNotice = (applied) => {
  const text = repoValuesText(applied);
  return text ? `Started. Saved for this repo: ${text}.` : 'Started.';
};

// The board's warning while the sprint's repo has no full check.
export const NO_CHECK_LINE = 'No full check for this repo: PRs open without one';
// The board in a chat other than the sprint's: news waits for the sprint's own chat.
export const waitingNews = (n) => `${n} update${n === 1 ? '' : 's'} waiting for this sprint's chat`;

const ACCESS_LINES = {
  'edit-worktree': 'Works in a separate copy · you review before keeping',
  'read-only': 'Only reads files · changes nothing',
  'own-config': "Uses the agent's own settings · may edit your files directly",
  'full-access': 'Full access · can change anything on this computer',
};
export const accessLine = (permission) => ACCESS_LINES[permission] ?? String(permission ?? '');

// New job's More options heading: what is set there.
export const moreSummary = (d) => [accessWord(d.permission), d.ticket.trim() || null, d.base.trim() ? `from ${d.base.trim()}` : null, d.model || null].filter(Boolean).join(' · ');
