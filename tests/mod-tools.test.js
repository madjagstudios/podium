import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS, engineCall, formatToolResult } from '../mod/tools.js';

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
