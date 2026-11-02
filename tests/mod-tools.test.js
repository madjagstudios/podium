import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS, engineCall, formatToolResult, ignoredFields } from '../mod/tools.js';

test('nine tools, dispatch defaults explained', () => {
  assert.deepEqual(TOOLS.map((t) => t.name), ['dispatch', 'pr', 'status', 'result', 'cancel', 'keep', 'discard', 'agents', 'sprint']);
  const dispatch = TOOLS[0];
  assert.deepEqual(dispatch.inputSchema.required, ['agent', 'task']);
  assert.match(dispatch.description, /edit-worktree/);
  assert.match(dispatch.description, /cannot see this conversation/);
});

test('engineCall maps tool input to engine arguments; the task travels on stdin', () => {
  assert.deepEqual(engineCall('dispatch', { agent: 'codex', task: 'Do it', permission: 'read-only', ticket: 'abc-4', includeUncommitted: true }),
    { args: ['dispatch', '--agent', 'codex', '--prompt', '-', '--permission', 'read-only', '--ticket', 'abc-4', '--include-uncommitted'], stdin: 'Do it' });
  assert.deepEqual(engineCall('dispatch', { agent: 'muse', task: 'x' }), { args: ['dispatch', '--agent', 'muse', '--prompt', '-'], stdin: 'x' });
  assert.deepEqual(engineCall('status', { ticket: 'abc-4' }), { args: ['status', '--here', '--ticket', 'ABC-4'] });
  assert.deepEqual(engineCall('result', { id: 'j1', full: true }), { args: ['result', '--id', 'j1', '--full'] });
  assert.deepEqual(engineCall('keep', { id: 'j1' }), { args: ['keep', '--id', 'j1'] });
  assert.deepEqual(engineCall('agents', {}), { args: ['agents'] });
  assert.throws(() => engineCall('fly', {}), /Unknown Podium tool/);
});

test('formatToolResult speaks plainly', () => {
  assert.match(formatToolResult('dispatch', { ok: false, error: { code: 'preflight-failed', message: "Codex isn't signed in." } }), /Podium could not do that \(preflight-failed\): Codex isn't signed in\./);
  const started = formatToolResult('dispatch', { ok: true, value: { job: { id: 'j1' }, permissionText: 'Codex can edit files in a separate copy of your repo', warnings: [{ message: 'Big repo.' }] } });
  assert.match(started, /Started job j1\. Codex can edit files/);
  assert.match(started, /Warnings:\n- Big repo\./);
  assert.match(started, /arrive as a message/);
  assert.equal(formatToolResult('status', { ok: true, value: { jobs: [] } }), 'No Podium jobs in this project yet.');
  assert.match(formatToolResult('result', { ok: true, value: { job: { id: 'j1', status: 'done' }, summary: 'Fine.\n', output: null, hasDiff: false } }), /Job j1: done\.\n\nSummary:\nFine\./);
  assert.match(formatToolResult('agents', { ok: true, value: { agents: [{ name: 'codex', installed: true, version: 'codex-cli 1', signedIn: true, enabled: true, defaultPermission: 'edit-worktree' }] } }), /codex: installed \(codex-cli 1\); default edit-worktree/);
  assert.equal(formatToolResult('cancel', { ok: true, value: { job: { id: 'j1', status: 'cancelled' } } }), 'Job j1 is now cancelled.');
});

test('the status tool leaves sprint steps out and points to the sprint tool', () => {
  const at = '2026-10-06T10:00:00Z';
  const plain = { id: 'j1', agent: 'codex', title: 'Review it', status: 'done', createdAt: at, endedAt: at };
  const step = { id: 'j2', agent: 'codex', title: 'ABC-11 task 1: A', status: 'needs-review', createdAt: at, endedAt: at, sprint: { id: 's1', ticket: 'ABC-11', task: 1, role: 'author' } };
  const mixed = formatToolResult('status', { ok: true, value: { jobs: [step, plain] } });
  assert.match(mixed, /j1/);
  assert.doesNotMatch(mixed, /j2/);
  assert.equal(formatToolResult('status', { ok: true, value: { jobs: [step] } }), 'No Podium jobs in this project yet. Sprints: use the sprint tool (action status).');
});

test('the sprint tool asks for the ticket it needs', () => {
  assert.throws(() => engineCall('sprint', { action: 'stop', id: 's1' }), { message: 'Say which ticket.' });
  assert.throws(() => engineCall('sprint', { action: 'retry', id: 's1' }), { message: 'Say which ticket.' });
  assert.throws(() => engineCall('sprint', { action: 'assign', id: 's1', task: 2, agent: 'codex' }), { message: 'Say which ticket.' });
  assert.deepEqual(engineCall('sprint', { action: 'assign', id: 's1', ticket: 'ABC-11', agent: 'codex' }).args, ['sprint', 'assign', '--id', 's1', '--ticket', 'ABC-11', '--agent', 'codex']);
  assert.deepEqual(engineCall('sprint', { action: 'retry', id: 's1', ticket: 'ABC-11' }).args, ['sprint', 'retry', '--id', 's1', '--ticket', 'ABC-11']);
  assert.deepEqual(engineCall('sprint', { action: 'assign', id: 's1', ticket: 'ABC-11', task: 2, agent: 'codex' }).args, ['sprint', 'assign', '--id', 's1', '--ticket', 'ABC-11', '--task', '2', '--agent', 'codex']);
});

test('the sprint tool syncs a ticket with its base, and answers about commits Podium didn\'t make', () => {
  for (const action of ['sync', 'keep-commits', 'drop-commits']) {
    assert.throws(() => engineCall('sprint', { action, id: 's1' }), { message: 'Say which ticket.' }, action);
  }
  assert.deepEqual(engineCall('sprint', { action: 'sync', id: 's1', ticket: 'ABC-11' }).args, ['sprint', 'sync', '--id', 's1', '--ticket', 'ABC-11']);
  assert.deepEqual(engineCall('sprint', { action: 'keep-commits', id: 's1', ticket: 'ABC-11' }).args, ['sprint', 'commits', '--id', 's1', '--ticket', 'ABC-11', '--answer', 'keep']);
  assert.deepEqual(engineCall('sprint', { action: 'drop-commits', id: 's1', ticket: 'ABC-11' }).args, ['sprint', 'commits', '--id', 's1', '--ticket', 'ABC-11', '--answer', 'drop']);
  const sprint = { id: 's1', name: 'Oct', base: 'main', paused: false, finishedAt: null, autoMerge: false, news: 0, tickets: [] };
  assert.match(formatToolResult('sprint', { ok: true, value: { sprint, commits: 3 } }, { action: 'sync', ticket: 'abc-11' }), /ABC-11 took 3 new commits from main\./);
  assert.match(formatToolResult('sprint', { ok: true, value: { sprint, dropped: ['abc1234 Fixed by hand'] } }, { action: 'drop-commits', ticket: 'ABC-11' }), /Dropped \(git's reflog keeps them for a while\): abc1234 Fixed by hand\./);
  const kept = formatToolResult('sprint', { ok: true, value: { sprint, dropped: [] } }, { action: 'keep-commits', ticket: 'ABC-11' });
  assert.match(kept, /ABC-11 keeps the commits and carries on from them\./);
  assert.doesNotMatch(kept, /back where Podium left it/);
  const stashed = formatToolResult('sprint', { ok: true, value: { sprint, commits: 1, saved: "Podium: ABC-11's uncommitted changes before syncing with main" } }, { action: 'sync', ticket: 'ABC-11' });
  assert.match(stashed, /saved as a git stash \("Podium: ABC-11's uncommitted changes before syncing with main"\): git stash list shows it\./);
  const said = TOOLS.find((t) => t.name === 'sprint').description;
  assert.match(said, /Never commit in a ticket's copy yourself/);
});

test('the sprint tool\'s note goes by stdin, as does a retry\'s, and its reply says who reads it', () => {
  assert.throws(() => engineCall('sprint', { action: 'note', id: 's1', text: 'x' }), { message: 'Say which ticket.' });
  assert.throws(() => engineCall('sprint', { action: 'note', id: 's1', ticket: 'ABC-11', text: '  ' }), { message: 'Say what the note is (text).' });
  assert.deepEqual(engineCall('sprint', { action: 'note', id: 's1', ticket: 'ABC-11', text: ' Leave the date tests.\n' }),
    { args: ['sprint', 'note', '--id', 's1', '--ticket', 'ABC-11', '--text', '-'], stdin: 'Leave the date tests.' });
  assert.deepEqual(engineCall('sprint', { action: 'retry', id: 's1', ticket: 'ABC-11', agent: 'codex', text: 'Leave the date tests.' }),
    { args: ['sprint', 'retry', '--id', 's1', '--ticket', 'ABC-11', '--agent', 'codex', '--note', '-'], stdin: 'Leave the date tests.' });
  assert.deepEqual(engineCall('sprint', { action: 'retry', id: 's1', ticket: 'ABC-11', text: ' ' }), { args: ['sprint', 'retry', '--id', 's1', '--ticket', 'ABC-11'] });
  const sprint = { id: 's1', name: 'Oct', base: 'main', paused: false, finishedAt: null, autoMerge: false, news: 0, tickets: [] };
  assert.match(formatToolResult('sprint', { ok: true, value: { sprint, noted: { key: 'ABC-11', n: 1, running: false } } }, { action: 'note' }),
    /\n\nNoted on ABC-11\. Every later planner, writer and reviewer of ABC-11 reads it\.$/);
  assert.match(formatToolResult('sprint', { ok: true, value: { sprint, noted: { key: 'ABC-11', n: 2, running: true } } }, { action: 'note' }),
    /Noted on ABC-11\. The step running now won't see it; every later step of ABC-11 will\.$/);
  const said = TOOLS.find((t) => t.name === 'sprint');
  assert.ok(said.inputSchema.properties.action.enum.includes('note'));
  assert.match(said.description, /never add a note on your own/);
});

test('a retry keeps its note sent as note, and the reply says whether one went with it', () => {
  assert.deepEqual(engineCall('sprint', { action: 'retry', id: 's1', ticket: 'ABC-11', note: ' Restructure it. ' }),
    { args: ['sprint', 'retry', '--id', 's1', '--ticket', 'ABC-11', '--note', '-'], stdin: 'Restructure it.' });
  assert.deepEqual(engineCall('sprint', { action: 'retry', id: 's1', ticket: 'ABC-11', text: 'Restructure it.', note: ' Restructure it.' }),
    { args: ['sprint', 'retry', '--id', 's1', '--ticket', 'ABC-11', '--note', '-'], stdin: 'Restructure it.' });
  assert.throws(() => engineCall('sprint', { action: 'retry', id: 's1', ticket: 'ABC-11', text: 'One thing.', note: 'Another.' }), /Give the words once/);
  // The other actions that take the person's words read note too.
  for (const [action, sub] of [['note', 'note'], ['revise', 'revise'], ['accept', 'accept'], ['evidence', 'evidence']]) {
    assert.deepEqual(engineCall('sprint', { action, id: 's1', ticket: 'ABC-11', note: ' Their words. ' }),
      { args: ['sprint', sub, '--id', 's1', '--ticket', 'ABC-11', '--text', '-'], stdin: 'Their words.' }, action);
  }
  assert.throws(() => engineCall('sprint', { action: 'note', id: 's1', ticket: 'ABC-11', note: '  ' }), { message: 'Say what the note is (text).' });
  const sprint = { id: 's1', name: 'Oct', base: 'main', paused: false, finishedAt: null, autoMerge: false, news: 0, tickets: [] };
  assert.match(formatToolResult('sprint', { ok: true, value: { sprint, retried: { key: 'ABC-11', note: { n: 4, chars: 15 } } } }, { action: 'retry' }),
    /\n\nRetried ABC-11 with your note \(note 4, 15 characters\): the retried step reads it\.$/);
  assert.match(formatToolResult('sprint', { ok: true, value: { sprint, retried: { key: 'ABC-11', note: null } } }, { action: 'retry' }),
    /\n\nRetried ABC-11 with no note\. To give the retried step instructions, retry with text\.$/);
  assert.doesNotMatch(formatToolResult('sprint', { ok: true, value: { sprint } }, { action: 'retry' }), /Retried/);
  const said = TOOLS.find((t) => t.name === 'sprint').description;
  assert.ok(!said.includes('added as "note" adds one'));
  assert.ok(said.includes('the reply says whether a note went with the retry'));
});

test('every tool names the fields it ignored, and its schema allows no others', () => {
  assert.deepEqual(ignoredFields('sprint', { tool: 'mcp__podium__sprint', action: 'retry', note: 'x', foo: 1, bar: 2 }), ['bar', 'foo']);
  assert.deepEqual(ignoredFields('dispatch', { agent: 'codex', task: 'x', note: 'y' }), ['note']);
  assert.deepEqual(ignoredFields('agents', { tool: 'mcp__podium__agents' }), []);
  assert.deepEqual(ignoredFields('fly', { a: 1 }), []);
  assert.deepEqual(ignoredFields('status', null), []);
  const cancelled = { ok: true, value: { job: { id: 'j1', status: 'cancelled' } } };
  assert.ok(formatToolResult('cancel', cancelled, { id: 'j1', reason: 'x' }).endsWith("\n\nPodium ignored a field this tool doesn't have: reason."));
  assert.equal(formatToolResult('cancel', cancelled, { id: 'j1' }), 'Job j1 is now cancelled.');
  assert.equal(formatToolResult('cancel', cancelled, { tool: 'mcp__podium__cancel', id: 'j1' }), 'Job j1 is now cancelled.');
  assert.equal(formatToolResult('cancel', cancelled), 'Job j1 is now cancelled.');
  assert.match(formatToolResult('cancel', { ok: false, error: { code: 'not-found', message: 'No such job.' } }, { id: 'j9', why: 1, reason: 'x' }),
    /^Podium could not do that \(not-found\): No such job\.\n\nPodium ignored fields this tool doesn't have: reason, why\.$/);
  for (const t of TOOLS) assert.equal(t.inputSchema.additionalProperties, false, t.name);
  // Declared, so a host that checks the schema lets it through to the handler; its description steers callers to text.
  const props = TOOLS.find((t) => t.name === 'sprint').inputSchema.properties;
  assert.deepEqual(props.note, { type: 'string', description: 'Another name for text (send text).' });
  assert.ok(props.text);
});

test('dispatch passes a starting branch', () => {
  const call = engineCall('dispatch', { agent: 'codex', task: 'Review', base: 'feat/oc-11-chapter-3' });
  const i = call.args.indexOf('--base');
  assert.equal(call.args[i + 1], 'feat/oc-11-chapter-3');
  assert.ok(TOOLS.find((t) => t.name === 'dispatch').inputSchema.properties.base);
});

test('dispatch can continue a job', () => {
  const call = engineCall('dispatch', { agent: 'codex', task: 'Fix it', followUp: 'job-1' });
  assert.equal(call.args[call.args.indexOf('--follow-up') + 1], 'job-1');
  assert.ok(TOOLS.find((t) => t.name === 'dispatch').inputSchema.properties.followUp);
});

test('dispatch says a PR review and a follow-up do not go together', () => {
  const props = TOOLS.find((t) => t.name === 'dispatch').inputSchema.properties;
  assert.match(props.followUp.description, /pr/);
  assert.match(props.followUp.description, /can'?t be continued/);
  assert.match(props.pr.description, /followUp/);
  assert.match(props.pr.description, /can'?t be continued/);
});

test('the pr tool maps actions; dispatch can review a PR', () => {
  assert.deepEqual(engineCall('pr', { action: 'merge-when-green', id: 'j1', on: true }).args, ['pr', 'auto', '--id', 'j1', '--on', 'true']);
  assert.deepEqual(engineCall('pr', { action: 'open', id: 'j1' }).args, ['pr', 'open', '--id', 'j1']);
  assert.deepEqual(engineCall('pr', { action: 'post-review', id: 'r1' }).args, ['pr', 'post', '--id', 'r1']);
  const review = engineCall('dispatch', { agent: 'claude', task: '', pr: 7 });
  assert.equal(review.args[review.args.indexOf('--pr') + 1], '7');
  assert.equal(formatToolResult('pr', { ok: true, value: { job: { id: 'j1', status: 'in-review', pr: { number: 12, autoMerge: true, url: 'u' } } } }), 'PR #12: in-review, merges when green. u');
});

test('the sprint tool leaves a sprint Podium could not read just now out of the status list', () => {
  const busy = { id: 's1', busy: true };
  const ok = { id: 's2', name: 'Oct', draft: false, discarded: false, paused: false, finishedAt: null, autoMerge: false, maxParallel: 3, news: 0, tickets: [] };
  const only = formatToolResult('sprint', { ok: true, value: { sprints: [busy] } });
  assert.doesNotMatch(only, /s1|undefined|can't read/);
  assert.match(only, /moment/);
  const mixed = formatToolResult('sprint', { ok: true, value: { sprints: [busy, ok] } });
  assert.match(mixed, /Sprint s2:/);
  assert.doesNotMatch(mixed, /s1|undefined|can't read/);
});

test('badly typed commands or check go to the engine as given, so it refuses them plainly', () => {
  for (const [commands, check] of [['dotnet', undefined], [undefined, 42], [{ a: 1 }, ['x']], [null, null]]) {
    const call = engineCall('sprint', { action: 'draft', name: 'Oct', tickets: [], commands, check });
    const sent = JSON.parse(call.stdin);
    if (commands !== undefined) assert.deepEqual(sent.commands, commands);
    else assert.equal('commands' in sent, false);
    if (check !== undefined) assert.deepEqual(sent.check, check);
    else assert.equal('check' in sent, false);
  }
});

test('the Start reply names the commit the sprint\'s copies start from; a status reply does not', () => {
  const s = { id: 's1', name: 'Oct', draft: false, discarded: false, paused: false, finishedAt: null, autoMerge: false, maxParallel: 3, news: 0, base: 'main', tickets: [],
    startedFrom: { commit: '1ecac46aaaabbbbccccddddeeeeffff000011112', remote: 'origin', checked: true } };
  const line = 'Copies start from main at 1ecac46 (checked against origin/main at Start).';
  const started = formatToolResult('sprint', { ok: true, value: { sprint: s, applied: { check: 'npm test' } } }, { action: 'start', id: 's1' });
  assert.ok(started.endsWith(`Saved for this repo at Start: full check "npm test".\n\n${line}`), started);
  assert.ok(!formatToolResult('sprint', { ok: true, value: { sprint: s } }, { action: 'status', id: 's1' }).includes('Copies start from'));
  const older = { ...s, startedFrom: undefined };
  assert.ok(!formatToolResult('sprint', { ok: true, value: { sprint: older, applied: {} } }, { action: 'start', id: 's1' }).includes('Copies start from'));
});

test('the sprint draft carries the repo\'s commands and check, and the reply says they are proposed until Start', () => {
  const call = engineCall('sprint', { action: 'draft', name: 'Oct', tickets: [], commands: ['dotnet'], check: 'dotnet build && dotnet test' });
  assert.deepEqual(JSON.parse(call.stdin), { name: 'Oct', tickets: [], commands: ['dotnet'], check: 'dotnet build && dotnet test' });
  const props = TOOLS.find((t) => t.name === 'sprint').inputSchema.properties;
  assert.ok(props.commands && props.check);
  const draft = { id: 's1', name: 'Oct', draft: true, discarded: false, paused: false, finishedAt: null, autoMerge: false, maxParallel: 3, news: 0, tickets: [] };
  const text = formatToolResult('sprint', { ok: true, value: { sprint: draft, notes: [], proposed: { commands: ['dotnet'], check: 'dotnet build && dotnet test' } } });
  assert.match(text, /Proposed for this repo: commands dotnet; full check "dotnet build && dotnet test"\. Nothing is saved yet: these take effect for the repo when the person presses Start/);
  assert.doesNotMatch(text, /Saved for this repo/);
  assert.doesNotMatch(formatToolResult('sprint', { ok: true, value: { sprint: draft, notes: [], proposed: {} } }), /Proposed for this repo/);
  // Start says what it saved.
  const started = formatToolResult('sprint', { ok: true, value: { sprint: { ...draft, draft: false }, applied: { commands: ['dotnet'], check: 'dotnet test' } } });
  assert.match(started, /Saved for this repo at Start: commands dotnet; full check "dotnet test"\./);
  assert.doesNotMatch(formatToolResult('sprint', { ok: true, value: { sprint: { ...draft, draft: false }, applied: {} } }), /Saved for this repo/);
  // The tool's text: proposed, take effect at Start, only with the person's agreement.
  const sprintTool = TOOLS.find((t) => t.name === 'sprint');
  assert.match(sprintTool.description, /only when the user has agreed to them in the chat/);
  assert.match(sprintTool.description, /take effect for this repo only when the user presses Start/);
});

test('the sprint draft carries the repo\'s plans folder, passed through for the engine to refuse plainly', () => {
  const call = engineCall('sprint', { action: 'draft', name: 'Oct', tickets: [], planDir: 'docs/custom/plans' });
  assert.deepEqual(JSON.parse(call.stdin), { name: 'Oct', tickets: [], planDir: 'docs/custom/plans' });
  assert.ok(TOOLS.find((t) => t.name === 'sprint').inputSchema.properties.planDir);
  const bad = engineCall('sprint', { action: 'draft', name: 'Oct', tickets: [], planDir: 42 });
  assert.deepEqual(JSON.parse(bad.stdin).planDir, 42);
});

test('the sprint draft carries whether the repo\'s PRs keep their plan, passed through for the engine to refuse plainly', () => {
  const call = engineCall('sprint', { action: 'draft', name: 'Oct', tickets: [], keepPlan: true });
  assert.deepEqual(JSON.parse(call.stdin), { name: 'Oct', tickets: [], keepPlan: true });
  const sprintTool = TOOLS.find((t) => t.name === 'sprint');
  assert.equal(sprintTool.inputSchema.properties.keepPlan.type, 'boolean');
  assert.match(sprintTool.description, /planDir and keepPlan/);
  const bad = engineCall('sprint', { action: 'draft', name: 'Oct', tickets: [], keepPlan: 'yes' });
  assert.equal(JSON.parse(bad.stdin).keepPlan, 'yes');
  assert.equal('keepPlan' in JSON.parse(engineCall('sprint', { action: 'draft', name: 'Oct', tickets: [] }).stdin), false);
});

test('status by id shows a sprint step and which sprint it belongs to; the full list still leaves it out', () => {
  const at = '2026-10-06T10:00:00Z';
  const step = { id: 'j2', agent: 'codex', title: 'ABC-11 task 2: A', status: 'running', createdAt: at, endedAt: null, sprint: { id: 's1', ticket: 'ABC-11', task: 2, role: 'author' } };
  const text = formatToolResult('status', { ok: true, value: { jobs: [step], sprints: [{ id: 's1', name: 'Oct week 2', tickets: [] }] } }, { id: 'j2' });
  assert.match(text, /j2/);
  assert.match(text, /part of sprint Oct week 2, ABC-11 task 2 \(writer\)/);
  const review = { ...step, id: 'j3', sprint: { ...step.sprint, role: 'reviewer' } };
  assert.match(formatToolResult('status', { ok: true, value: { jobs: [review] } }, { id: 'j3' }), /part of sprint s1, ABC-11 task 2 \(reviewer\)/);
  const plan = { ...step, id: 'j4', sprint: { id: 's1', ticket: 'ABC-11', task: 0, role: 'author', plan: true } };
  assert.match(formatToolResult('status', { ok: true, value: { jobs: [plan] } }, { id: 'j4' }), /part of sprint s1, ABC-11's plan \(writer\)/);
  assert.equal(formatToolResult('status', { ok: true, value: { jobs: [step] } }), 'No Podium jobs in this project yet. Sprints: use the sprint tool (action status).');
});

test('the sprint tool says how many run at once, names every running ticket, and why a ticket waits', () => {
  const tk = (key, over = {}) => ({ key, title: `Ticket ${key}`, state: 'pending', task: 1, of: 2, phase: null, agent: 'codex', reason: null, pr: null, reviews: 0, ...over });
  const sum = { id: 's1', name: 'Oct', draft: false, discarded: false, paused: false, finishedAt: null, autoMerge: false, maxParallel: 3, news: 0, tickets: [
    tk('A-1', { state: 'running', phase: 'author' }), tk('A-2', { slot: 'free' }), tk('A-3', { slot: 'free' }),
  ] };
  const text = formatToolResult('sprint', { ok: true, value: { sprint: sum } });
  assert.match(text, /1 of 3 running: Codex working on A-1 task 1/);
  assert.match(text, /A-2  Ticket A-2  starting/);
  const full = { ...sum, maxParallel: 1, tickets: [sum.tickets[0], tk('A-2', { slot: 'full' })] };
  assert.match(formatToolResult('sprint', { ok: true, value: { sprint: full } }), /A-2  Ticket A-2  waiting for a free slot/);
  const props = TOOLS.find((t) => t.name === 'sprint').inputSchema.properties;
  assert.match(props.atOnce.description, /default 3/);
});

// "Take them here", asked of Claude. The mod adds this chat's --session, as for every sprint call.
test('sprint action adopt takes a sprint into this chat by id', () => {
  const sprint = TOOLS.find((t) => t.name === 'sprint');
  assert.ok(sprint.inputSchema.properties.action.enum.includes('adopt'));
  assert.match(sprint.description, /"adopt" \(id\)/);
  assert.deepEqual(engineCall('sprint', { action: 'adopt', id: 's1' }).args, ['sprint', 'adopt', '--id', 's1', '--here']);
  assert.throws(() => engineCall('sprint', { action: 'adopt' }), { message: /Say which sprint/ });
});

test('the sprint tool accepts a ticket\'s test results with the user\'s reason, by stdin', () => {
  assert.throws(() => engineCall('sprint', { action: 'accept', id: 's1', text: 'x' }), { message: 'Say which ticket.' });
  assert.throws(() => engineCall('sprint', { action: 'accept', id: 's1', ticket: 'ABC-11' }), { message: 'Say why the test results are fine (text).' });
  assert.deepEqual(engineCall('sprint', { action: 'accept', id: 's1', ticket: 'ABC-11', text: ' Fails on main too. ' }),
    { args: ['sprint', 'accept', '--id', 's1', '--ticket', 'ABC-11', '--text', '-'], stdin: 'Fails on main too.' });
  const tool = TOOLS.find((t) => t.name === 'sprint');
  assert.ok(tool.inputSchema.properties.action.enum.includes('accept'));
  assert.match(tool.description, /"accept" \(id, ticket, text: why the results are fine/);
});

test('the sprint tool sends a failed review back with the user\'s evidence, by stdin', () => {
  assert.throws(() => engineCall('sprint', { action: 'evidence', id: 's1', ticket: 'ABC-11' }), { message: 'Say what the reviewer should weigh (text).' });
  assert.deepEqual(engineCall('sprint', { action: 'evidence', id: 's1', ticket: 'ABC-11', text: ' CI passed. ' }),
    { args: ['sprint', 'evidence', '--id', 's1', '--ticket', 'ABC-11', '--text', '-'], stdin: 'CI passed.' });
  const tool = TOOLS.find((t) => t.name === 'sprint');
  assert.ok(tool.inputSchema.properties.action.enum.includes('evidence'));
  assert.match(tool.description, /"evidence" \(id, ticket, text: what the reviewer should weigh/);
});

test('approve and one-task pass acknowledge only when it is true', () => {
  assert.deepEqual(engineCall('sprint', { action: 'approve', id: 's1', ticket: 'ABC-1' }).args, ['sprint', 'approve', '--id', 's1', '--ticket', 'ABC-1']);
  assert.deepEqual(engineCall('sprint', { action: 'approve', id: 's1', ticket: 'ABC-1', acknowledge: true }).args, ['sprint', 'approve', '--id', 's1', '--ticket', 'ABC-1', '--acknowledge']);
  assert.deepEqual(engineCall('sprint', { action: 'one-task', id: 's1', ticket: 'ABC-1', acknowledge: 'yes' }).args, ['sprint', 'one-task', '--id', 's1', '--ticket', 'ABC-1']);
  const sprint = TOOLS.find((x) => x.name === 'sprint');
  assert.equal(sprint.inputSchema.properties.acknowledge.type, 'boolean');
  assert.match(sprint.description, /needs your attention runs production commands/);
});
