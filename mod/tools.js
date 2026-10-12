import { jobLine, sprintLines, repoValuesText } from './view.js';

const PERMISSIONS = ['edit-worktree', 'read-only', 'own-config', 'full-access'];
const byId = { type: 'object', properties: { id: { type: 'string', description: 'The job id' } }, required: ['id'] };

export const TOOLS = [
  {
    name: 'dispatch',
    description: 'Hand a task to another coding agent installed on this machine (for example codex, muse, claude or gemini) to run in the background. Use it when the user asks another agent or model to do something. Permission: leave it out for the default, "edit-worktree" (the agent edits a separate copy of the repo and the user keeps or throws away its changes); use "read-only" for reviews, research and questions; use "own-config" or "full-access" only when the user explicitly asks. The task must be self-contained: the other agent cannot see this conversation. Returns a job id at once; the result arrives later as a message. If the agent should commit on a branch, say so in the task and use permission "own-config": the separate-copy level runs agents in sandboxes that block git. Its commits are then the result and there is nothing to keep. When the user wants changes to, a review of, or more work on a job whose work is still open, continue it with followUp instead of starting a new job. Leave agent as the last step\'s agent unless the user names another.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Agent name, e.g. codex, muse, claude, gemini' },
        task: { type: 'string', description: 'Complete, self-contained instructions for the agent' },
        followUp: { type: 'string', description: 'The id of a job to continue: the follow-up runs in that job\'s copy, after its changes, and resumes the agent\'s conversation when the agent is the same.' },
        permission: { type: 'string', enum: PERMISSIONS },
        model: { type: 'string', description: 'Optional model id or alias for that agent' },
        ticket: { type: 'string', description: 'Optional ticket key, e.g. ABC-123' },
        base: { type: 'string', description: 'Optional branch or commit to start the agent\'s copy from (e.g. feat/oc-11-chapter-3) instead of the current checkout. Use it when the work belongs on another branch.' },
        includeUncommitted: { type: 'boolean', description: "Edit jobs only: copy the user's uncommitted changes into the agent's copy" },
        pr: { type: 'number', description: "Review this pull request number instead of doing new work: a read-only job on the PR's code. Findings come back here; they reach GitHub only when the user asks (pr tool, action post-review). The task may be empty or say what to focus on." },
      },
      required: ['agent', 'task'],
    },
  },
  {
    name: 'pr',
    description: 'Work with a pull request for Podium work, only when the user asks. action "open": open a PR from a job whose changes are ready (id). "push": push a finished follow-up to its PR (id). "merge-when-green": turn merging on (on: true) or off for the PR of job id; Podium merges when every check passes. "post-review": post a finished review job (id) to its PR as one comment.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['open', 'push', 'merge-when-green', 'post-review'] },
        id: { type: 'string', description: 'A job id of the work (or of the review)' },
        on: { type: 'boolean' },
      },
      required: ['action', 'id'],
    },
  },
  { name: 'status', description: 'List Podium jobs in this project, newest first, or one job by id.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, ticket: { type: 'string' } } } },
  { name: 'result', description: "Read a job's summary, or its whole output with full: true.", inputSchema: { type: 'object', properties: { id: { type: 'string' }, full: { type: 'boolean' } }, required: ['id'] } },
  { name: 'cancel', description: 'Stop a running job.', inputSchema: byId },
  { name: 'keep', description: "Apply an edit job's changes to the user's files. Only when the user asks to keep them.", inputSchema: byId },
  { name: 'discard', description: "Throw away an edit job's changes. Only when the user asks.", inputSchema: byId },
  { name: 'agents', description: 'List the agents Podium can use here: installed or not, signed in or not, and each default permission.', inputSchema: { type: 'object' } },
  {
    name: 'sprint',
    description: [
      'Plan and run a sprint, only when the user asks for one: several tickets, each worked task by task by agents, with a reviewer agent checking every task, each ticket ending as a PR the user merges.',
      'Drafting: first read each ticket and its plan if it has one, and propose in the chat a writer and a reviewer for each task (the reviewer should be a different agent from the writer). Then action "draft" (name, tickets; optional base, default main, and mergeWhenGreen) saves it as a draft and opens its board in the Podium pane. A ticket with no plan is planned first by its writer, from its summary, so give it one. Optional commands and check: pass them only when the user has agreed to them in the chat. They are proposed with the draft and shown on its board, and take effect for this repo only when the user presses Start (Discard drops them); the reply says what was proposed. If the reply says the repo has no full check, propose one to the user before Start.',
      'Starting: nothing runs yet. Tell the user to look the draft over on its board and press Start, or ask you to start it. "start" (id): start a draft, only when the user asks.',
      'Changes to a draft before Start (id): "move" (ticket, to), "remove" (ticket), "options" (mergeWhenGreen and/or atOnce), "assign" without task (ticket, agent and/or reviewer: for every task of that ticket, or the writer and reviewer of a ticket with no plan), "after" (ticket, after), "discard" (throw the draft away).',
      'Once it runs: "status": the board. "pause" / "resume" (id). "retry" (id, ticket; optional agent to give the stuck step to). "stop" (id, ticket): end a ticket the user has given up on; its branch is kept, and it cannot be stopped while it is working. "assign" (id, ticket, task, agent and/or reviewer) for a task not yet run (task 0: the writer and reviewer of a ticket whose plan is not approved yet). "adopt" (id): only when the user asks, take a sprint whose own chat is gone into this chat, so its updates waiting for that chat (and all later ones) come here.',
      'Answering a plan: when a ticket\'s plan is ready you get a message. Sum it up for the user and ask whether to approve it or change it (or, for a plan with no tasks, run it as one task), and act only when the user says so (id, ticket): "approve" makes its tasks the ticket\'s, which then run; "revise" (text: what should change) sends it back to its writer, in the same conversation; "one-task" runs a plan with no tasks as one task.',
    ].join('\n\n'),
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['draft', 'start', 'discard', 'move', 'remove', 'options', 'status', 'pause', 'resume', 'retry', 'stop', 'assign', 'after', 'approve', 'revise', 'one-task', 'adopt'] },
        id: { type: 'string', description: 'The sprint id' },
        name: { type: 'string' },
        tickets: { type: 'array', items: { type: 'object' }, description: 'Action "draft": each ticket has key, title, type (feat, fix, chore…), plan, agent and reviewer, and optionally tasks, summary and after. plan: the repo path of its plan, e.g. docs/plans/2026-10-06-x.md, whose "### Task N:" sections become the tasks; leave it out for a ticket with no plan. agent and reviewer: the writer and the reviewer for its tasks. tasks: [{ n, agent, reviewer }] per-task overrides. summary: the ticket\'s text exactly as the user or the tracker gave it, never just its title. after: keys of tickets in this sprint that must be merged first; it then starts from the base branch as GitHub has it.' },
        base: { type: 'string' },
        mergeWhenGreen: { type: 'boolean' },
        ticket: { type: 'string', description: 'A ticket key in the sprint' },
        task: { type: 'number' },
        agent: { type: 'string' },
        reviewer: { type: 'string' },
        to: { type: 'string', enum: ['up', 'down'], description: 'Which way to move a draft ticket' },
        atOnce: { type: 'number', description: 'How many tickets run at the same time, 1 to 5 (default 3)' },
        after: { type: 'array', items: { type: 'string' }, description: 'Action "after": the keys of the tickets this one waits for ([] for none)' },
        text: { type: 'string', description: 'Action "revise": what should change in the plan, in the user\'s words' },
        commands: { type: 'array', items: { type: 'string' }, description: 'Action "draft": the commands agents may run in this repo while they edit, as plain names (e.g. ["dotnet"]); never a shell.' },
        check: { type: 'string', description: 'Action "draft": the repo\'s full check, run in each ticket\'s copy before its PR opens (e.g. "dotnet build && dotnet test").' },
      },
      required: ['action'],
    },
  },
];

export function engineCall(tool, input) {
  const id = input.id ? ['--id', String(input.id)] : [];
  switch (tool) {
    case 'dispatch':
      return {
        args: [
          'dispatch', '--agent', String(input.agent), '--prompt', '-',
          ...(input.permission ? ['--permission', String(input.permission)] : []),
          ...(input.model ? ['--model', String(input.model)] : []),
          ...(input.ticket ? ['--ticket', String(input.ticket)] : []),
          ...(input.base ? ['--base', String(input.base)] : []),
          ...(input.followUp ? ['--follow-up', String(input.followUp)] : []),
          ...(input.includeUncommitted === true ? ['--include-uncommitted'] : []),
          ...(input.pr ? ['--pr', String(input.pr)] : []),
        ],
        stdin: String(input.task ?? ''),
      };
    case 'status':
      return { args: ['status', '--here', ...id, ...(input.ticket ? ['--ticket', String(input.ticket).toUpperCase()] : [])] };
    case 'result':
      return { args: ['result', ...id, ...(input.full === true ? ['--full'] : [])] };
    case 'cancel':
    case 'keep':
    case 'discard':
      return { args: [tool, ...id] };
    case 'agents':
      return { args: ['agents'] };
    case 'pr': {
      const sub = { open: 'open', push: 'push', 'merge-when-green': 'auto', 'post-review': 'post' }[String(input.action)];
      if (!sub) throw new Error(`Unknown pr action "${input.action}"`);
      return { args: ['pr', sub, ...id, ...(sub === 'auto' ? ['--on', String(input.on !== false)] : [])] };
    }
    case 'sprint': {
      const action = String(input.action);
      if (action === 'draft') {
        const draft = { name: input.name, tickets: input.tickets };
        if (input.base) draft.base = input.base;
        if (input.mergeWhenGreen === true) draft.mergeWhenGreen = true;
        // The repo's commands and full check, proposed with the draft. Passed as given, of any type: the engine
        // refuses a bad one with its plain message rather than the value being dropped here without a word.
        if (input.commands !== undefined) draft.commands = input.commands;
        if (input.check !== undefined) draft.check = input.check;
        return { args: ['sprint', 'draft', '--json', '-'], stdin: JSON.stringify(draft) };
      }
      if (action === 'start' && !input.id) throw new Error('Say which sprint to start (its id). To make a new sprint, use action "draft".');
      if (action === 'status') return { args: ['sprint', 'status', '--here', ...id] };
      if (['start', 'discard', 'pause', 'resume'].includes(action)) return { args: ['sprint', action, ...id] };
      // "Take them here": the mod adds this chat's --session, as for every sprint call; --here asks for this repo's
      // sprints only.
      if (action === 'adopt') {
        if (!input.id) throw new Error('Say which sprint to take into this chat (its id).');
        return { args: ['sprint', 'adopt', ...id, '--here'] };
      }
      if (['retry', 'assign', 'stop', 'move', 'remove', 'after', 'approve', 'revise', 'one-task'].includes(action) && !input.ticket) throw new Error('Say which ticket.');
      const ticket = ['--ticket', String(input.ticket)];
      // A plan waiting for the user.
      if (action === 'approve' || action === 'one-task') return { args: ['sprint', action, ...id, ...ticket] };
      if (action === 'revise') {
        const text = String(input.text ?? '').trim();
        if (!text) throw new Error('Say what should change in the plan (text).');
        return { args: ['sprint', 'revise', ...id, ...ticket, '--text', '-'], stdin: text };
      }
      if (action === 'after') {
        // A list of ticket keys, or [] for none: anything else (a string, a number, a list with something other than a
        // key in it) is refused here, plainly, before the engine sees it. A comma would split a key on the command line.
        const isKey = (k) => typeof k === 'string' && k.trim() !== '' && !k.includes(',');
        if (!Array.isArray(input.after) || !input.after.every(isKey)) throw new Error('Say which tickets it waits for (after: a list of keys; [] for none).');
        const keys = input.after.map((k) => k.trim());
        return { args: ['sprint', 'after', ...id, ...ticket, '--keys', keys.length ? keys.join(',') : 'none'] };
      }
      if (action === 'stop') return { args: ['sprint', 'stop', ...id, ...ticket] };
      if (action === 'retry') return { args: ['sprint', 'retry', ...id, ...ticket, ...(input.agent ? ['--agent', String(input.agent)] : [])] };
      if (action === 'move') {
        if (input.to !== 'up' && input.to !== 'down') throw new Error('Say which way to move it: up or down.');
        return { args: ['sprint', 'move', ...id, ...ticket, '--to', input.to] };
      }
      if (action === 'remove') return { args: ['sprint', 'remove', ...id, ...ticket] };
      if (action === 'options') {
        const hasMerge = typeof input.mergeWhenGreen === 'boolean';
        const hasAtOnce = input.atOnce !== undefined && input.atOnce !== null && input.atOnce !== '';
        if (!hasMerge && !hasAtOnce) throw new Error('Say what to change: mergeWhenGreen or atOnce.');
        return { args: ['sprint', 'options', ...id, ...(hasMerge ? ['--merge-when-green', String(input.mergeWhenGreen)] : []), ...(hasAtOnce ? ['--at-once', String(input.atOnce)] : [])] };
      }
      if (action === 'assign') {
        // Without a task: every task of a draft ticket.
        const hasTask = input.task !== undefined && input.task !== null && input.task !== '';
        return { args: ['sprint', 'assign', ...id, ...ticket, ...(hasTask ? ['--task', String(input.task)] : []), ...(input.agent ? ['--agent', String(input.agent)] : []), ...(input.reviewer ? ['--reviewer', String(input.reviewer)] : [])] };
      }
      throw new Error(`Unknown sprint action "${input.action}"`);
    }
    default:
      throw new Error(`Unknown Podium tool "${tool}"`);
  }
}

// A job's one line in the status list.
const statusLine = (j) => { const l = jobLine(j); return `${l.icon} ${j.id} ${l.who}: ${l.what} (${l.when})`; };

// input: the tool's own input (status asked by id shows a sprint step, which the full list leaves out).
export function formatToolResult(tool, r, input = {}) {
  if (!r.ok) return `Podium could not do that (${r.error.code}): ${r.error.message}`;
  const v = r.value;
  if (tool === 'dispatch') {
    const warnings = (v.warnings ?? []).map((w) => `- ${w.message}`);
    return [`Started job ${v.job.id}. ${v.permissionText}.`, ...(warnings.length ? ['Warnings:', ...warnings] : []), 'The result will arrive as a message when it finishes.'].join('\n');
  }
  if (tool === 'status') {
    if (!v.jobs.length) return 'No Podium jobs in this project yet.';
    // Asked by id, a sprint step is shown, with where it belongs.
    const asked = input?.id ? v.jobs.find((j) => j.id === String(input.id)) : null;
    if (asked?.sprint) {
      const name = (v.sprints ?? []).find((s) => s.id === asked.sprint.id)?.name ?? asked.sprint.id;
      const what = asked.sprint.plan ? `${asked.sprint.ticket}'s plan` : `${asked.sprint.ticket} task ${asked.sprint.task}`;
      const role = asked.sprint.role === 'reviewer' ? 'reviewer' : 'writer';
      return `${statusLine(asked)} · part of sprint ${name}, ${what} (${role}). The sprint tool manages it (action status).`;
    }
    // Sprint steps are the sprint's to manage: the sprint tool shows them.
    const jobs = v.jobs.filter((j) => !j.sprint);
    if (!jobs.length) return 'No Podium jobs in this project yet. Sprints: use the sprint tool (action status).';
    return jobs.slice(0, 20).map(statusLine).join('\n');
  }
  if (tool === 'result') {
    return [
      `Job ${v.job.id}: ${v.job.status}.`,
      v.summary ? `Summary:\n${v.summary.trim()}` : 'No summary.',
      v.output ? `Full output:\n${v.output.slice(-50_000)}` : null,
      v.hasDiff ? 'It has changes waiting for review.' : null,
    ].filter(Boolean).join('\n\n');
  }
  if (tool === 'agents') {
    return v.agents.map((a) => `${a.name}: ${a.installed ? `installed (${a.version})` : 'not installed'}${a.signedIn === false ? ', not signed in' : ''}${a.enabled ? '' : ', switched off'}; default ${a.defaultPermission}`).join('\n');
  }
  if (tool === 'pr' && v.job?.pr) return `PR #${v.job.pr.number}: ${v.job.status}${v.job.pr.autoMerge ? ', merges when green' : ''}. ${v.job.pr.url}`;
  if (tool === 'sprint') {
    if (v.sprint) {
      const note = v.sprint.draft && !v.sprint.discarded
        ? '\n\nThis is a draft: nothing runs yet. Tell the person to look it over on its board in the Podium pane (they can change who writes and reviews each task, the order and the options there) and press Start, or ask you to start it.'
        : '';
      // The draft's notes (draftNotes): a plan-less ticket with only its title to plan from.
      const notes = (v.notes ?? []).map((n) => `\n\n${n}`).join('');
      // What the draft proposed for the repo, saved only at Start; and what Start saved.
      const proposed = repoValuesText(v.proposed);
      const applied = repoValuesText(v.applied);
      const repo = [
        proposed ? `\n\nProposed for this repo: ${proposed}. Nothing is saved yet: these take effect for the repo when the person presses Start (Discard drops them). They are shown on the draft's board.` : '',
        applied ? `\n\nSaved for this repo at Start: ${applied}.` : '',
      ].join('');
      return `Sprint ${v.sprint.id}:\n${sprintLines(v.sprint).join('\n')}${note}${notes}${repo}`;
    }
    // A sprint Podium could not read just now (busy) is left out; the next ask shows it.
    const list = (v.sprints ?? []).filter((s) => !s.busy);
    if (!list.length) return v.sprints?.length ? 'Podium could not read the sprint just now. Ask again in a moment.' : 'No sprints in this project yet.';
    return list.map((s) => (s.unreadable ? sprintLines(s).join('\n') : `Sprint ${s.id}:\n${sprintLines(s).join('\n')}`)).join('\n\n');
  }
  return `Job ${v.job.id} is now ${v.job.status}.`;
}
