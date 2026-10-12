import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS, engineCall, formatToolResult } from '../mod/tools.js';
import { threads, sprintLines, sprintNewsHeadline, sprintNewsNotes, isOpenSprint, ticketSteps } from '../mod/view.js';
import { slimJob, sprintCard } from '../mod/client.js';

const SUM = {
  id: 's1', name: 'Oct week 2', paused: false, finishedAt: null, autoMerge: false,
  tickets: [
    { key: 'ABC-11', title: 'Login form', state: 'merged', task: 2, of: 2, phase: null, agent: 'codex', reason: null, findings: null, pr: { number: 20, url: 'u' }, reviews: 2 },
    { key: 'ABC-12', title: 'Payout rounding', state: 'running', task: 4, of: 6, phase: 'author', agent: 'codex', reason: null, findings: null, pr: null, reviews: 3 },
    { key: 'ABC-13', title: 'Settings screen', state: 'parked', task: 2, of: 3, phase: null, agent: 'claude', reason: 'Review failed twice on task 2', findings: 'x', pr: null, reviews: 1 },
    { key: 'ABC-14', title: 'Export', state: 'waiting', task: 1, of: 2, phase: null, agent: 'codex', reason: 'Codex hit a usage limit; trying again at 14:05', findings: null, pr: null, reviews: 0 },
    { key: 'ABC-15', title: 'Import', state: 'pending', task: 1, of: 2, phase: null, agent: 'codex', reason: null, findings: null, pr: null, reviews: 0 },
  ],
};

test('sprintLines read like the board', () => {
  assert.deepEqual(sprintLines(SUM), [
    'Sprint · Oct week 2 · 1 of 5 tickets done · 1 needs you · 1 of 3 running, 1 waiting: Codex working on ABC-12 task 4',
    'ABC-11  Login form  ✓ PR #20 merged',
    'ABC-12  Payout rounding  Task 4/6 · Codex working · reviews 3 ✓',
    'ABC-13  Settings screen  ✋ Review failed twice on task 2',
    'ABC-14  Export  Codex hit a usage limit; trying again at 14:05',
    'ABC-15  Import  waiting to start',
  ]);
  const paused = sprintLines({ ...SUM, paused: true, tickets: [{ ...SUM.tickets[1], phase: 'review', agent: 'claude' }] });
  assert.equal(paused[0], 'Sprint · Oct week 2 · 0 of 1 tickets done · paused · 1 of 3 running: Claude reviewing ABC-12 task 4');
  assert.equal(paused[1], 'ABC-12  Payout rounding  Task 4/6 · Claude reviewing · reviews 3 ✓');
});

test('sprint jobs stay out of the lanes, and slim jobs keep the sprint field', () => {
  const jobs = [{ id: 'a', createdAt: '2026-10-06T10:00:00Z', status: 'done' }, { id: 'b', createdAt: '2026-10-06T10:00:00Z', status: 'needs-review', sprint: { id: 's1' } }];
  assert.deepEqual(threads(jobs).map((t) => t.id), ['a']);
  assert.deepEqual(slimJob({ id: 'b', sprint: { id: 's1', ticket: 'ABC-11', task: 1, role: 'author' } }).sprint, { id: 's1', ticket: 'ABC-11', task: 1, role: 'author' });
});

test('the sprint tool maps to the CLI', () => {
  assert.ok(TOOLS.find((t) => t.name === 'sprint'));
  const draft = engineCall('sprint', { action: 'draft', name: 'Oct', tickets: [{ key: 'ABC-11', plan: 'p.md', agent: 'codex', reviewer: 'claude' }], mergeWhenGreen: true });
  assert.deepEqual(draft.args, ['sprint', 'draft', '--json', '-']);
  assert.deepEqual(JSON.parse(draft.stdin), { name: 'Oct', tickets: [{ key: 'ABC-11', plan: 'p.md', agent: 'codex', reviewer: 'claude' }], mergeWhenGreen: true });
  assert.deepEqual(engineCall('sprint', { action: 'start', id: 's1' }).args, ['sprint', 'start', '--id', 's1']);
  assert.deepEqual(engineCall('sprint', { action: 'discard', id: 's1' }).args, ['sprint', 'discard', '--id', 's1']);
  assert.throws(() => engineCall('sprint', { action: 'start', name: 'Oct', tickets: [] }), { message: 'Say which sprint to start (its id). To make a new sprint, use action "draft".' });
  assert.deepEqual(engineCall('sprint', { action: 'status' }).args, ['sprint', 'status', '--here']);
  assert.deepEqual(engineCall('sprint', { action: 'pause', id: 's1' }).args, ['sprint', 'pause', '--id', 's1']);
  assert.deepEqual(engineCall('sprint', { action: 'retry', id: 's1', ticket: 'ABC-13', agent: 'claude' }).args, ['sprint', 'retry', '--id', 's1', '--ticket', 'ABC-13', '--agent', 'claude']);
  assert.deepEqual(engineCall('sprint', { action: 'assign', id: 's1', ticket: 'ABC-12', task: 5, reviewer: 'codex' }).args, ['sprint', 'assign', '--id', 's1', '--ticket', 'ABC-12', '--task', '5', '--reviewer', 'codex']);
  assert.throws(() => engineCall('sprint', { action: 'explode' }), /Unknown sprint action/);
});

test('sprint tool results read as the board', () => {
  assert.match(formatToolResult('sprint', { ok: true, value: { sprint: SUM } }), /^Sprint s1:\nSprint · Oct week 2 · 1 of 5 tickets done/);
  assert.equal(formatToolResult('sprint', { ok: true, value: { sprints: [] } }), 'No sprints in this project yet.');
  assert.match(formatToolResult('sprint', { ok: false, error: { code: 'no-plan', message: 'ABC-11 has no plan.' } }), /ABC-11 has no plan\./);
});

test('sprint news is one line to see and full notes for Claude', () => {
  const one = [{ id: 's1:1', sprint: 'Oct', text: 'ABC-13 (Settings screen) needs you: Review failed twice on task 2\nMissing test.' }];
  assert.equal(sprintNewsHeadline(one), 'Podium: ABC-13 (Settings screen) needs you: Review failed twice on task 2');
  // Smoke run 2026-10-08: "Podium: 2 sprint updates" read as a notice without the updates. Each one is in the headline.
  assert.equal(sprintNewsHeadline([...one, { id: 's1:2', sprint: 'Oct', text: 'Sprint "Oct" is done.\n- ABC-13 Settings screen: PR #4' }]), 'Podium: ABC-13 (Settings screen) needs you: Review failed twice on task 2 · Sprint "Oct" is done');
  const notes = sprintNewsNotes(one);
  assert.match(notes, /^\[Podium\] Sprint updates:/);
  assert.match(notes, /Missing test\./);
  assert.match(notes, /podium sprint tool/);
});

test('a batch of sprint news puts each update\'s first sentence in the headline, and says how many more when long', () => {
  const news = (text) => ({ id: 's1:1', sprint: 'Oct', text });
  // The first sentence ends at a full stop outside brackets and quotes: a file name or the person's quoted notes stay whole.
  assert.equal(sprintNewsHeadline([
    news('ABC-12 (Payouts) needs you: Claude changed files other than the plan: a.txt. Ask for changes to keep only the plan, or stop the ticket.'),
    news('SMK-11\'s plan was changed after your notes ("One paragraph. No headings") and is ready to approve.\nThe plan is docs/x.md'),
    news('SMK-12 (Add CONTRIBUTING.md): its plan is ready to approve.'),
  ]), 'Podium: ABC-12 (Payouts) needs you: Claude changed files other than the plan: a.txt · SMK-11\'s plan was changed after your notes ("One paragraph. No headings") and is ready to approve · SMK-12 (Add CONTRIBUTING.md): its plan is ready to approve');
  // A long update is cut short, and a long batch ends with how many are left out.
  const long = sprintNewsHeadline([news(`ABC-1 (${'x'.repeat(200)}) needs you: stuck`), news('ABC-2 (B) needs you: stuck')]);
  assert.match(long, /^Podium: ABC-1 \(x+… · ABC-2 \(B\) needs you: stuck$/);
  const many = Array.from({ length: 8 }, (_, i) => news(`ABC-${i + 10} (Settings screen number ${i}) needs you: Review failed twice on task 2`));
  const head = sprintNewsHeadline(many);
  assert.ok(head.length <= 280, head);
  assert.match(head, /^Podium: ABC-10 \(Settings screen number 0\) needs you: Review failed twice on task 2 · ABC-11 .* · and \d more$/);
  const shown = head.split(' · ').length - 1;
  assert.ok(head.endsWith(`and ${8 - shown} more`), head);
});

test('the sprint tool can stop a ticket, and says so in its description', () => {
  const tool = TOOLS.find((t) => t.name === 'sprint');
  assert.ok(tool.inputSchema.properties.action.enum.includes('stop'));
  assert.match(tool.description, /"stop" \(id, ticket\): end a ticket the user has given up on; its branch is kept/);
  assert.deepEqual(engineCall('sprint', { action: 'stop', id: 's1', ticket: 'ABC-13' }).args, ['sprint', 'stop', '--id', 's1', '--ticket', 'ABC-13']);
  assert.throws(() => engineCall('sprint', { action: 'stop', id: 's1' }), { message: 'Say which ticket.' });
  assert.match(sprintNewsNotes([{ text: 'x' }]), /stop one the person has given up on/);
});

test('a stopped ticket reads as stopped, and the headline counts it apart from the finished ones', () => {
  const stopped = { ...SUM.tickets[2], state: 'stopped', reason: null };
  const done = SUM.tickets[0];
  assert.deepEqual(sprintLines({ ...SUM, tickets: [done, stopped] }), [
    'Sprint · Oct week 2 · 1 of 2 tickets done, 1 stopped',
    'ABC-11  Login form  ✓ PR #20 merged',
    'ABC-13  Settings screen  stopped',
  ]);
  assert.equal(sprintLines({ ...SUM, tickets: [done, { ...done, key: 'ABC-16' }] })[0], 'Sprint · Oct week 2 · 2 of 2 tickets done');
});

test('the visible variant of the sprint notes drops the line about what the person saw, and keeps the tool hint', () => {
  const list = [{ text: 'x' }];
  assert.match(sprintNewsNotes(list), /Do not repeat their line\./);
  const visible = sprintNewsNotes(list, true);
  assert.doesNotMatch(visible, /Do not repeat their line/);
  assert.match(visible, /podium sprint tool/);
});

// Smoke run 2026-10-08: Claude passed only the title as a plan-less ticket's summary; the draft's answer says so.
test('the draft\'s notes on a ticket with only its title to plan from reach Claude', () => {
  const draft = { ...SUM, draft: true, discarded: false };
  const note = 'SMK-11 has only its title to plan from. If the person told you more about it, throw this draft away (action "discard") and draft it again with that text as its summary.';
  const text = formatToolResult('sprint', { ok: true, value: { sprint: draft, notes: [note] } });
  assert.ok(text.endsWith(`\n\n${note}`), text);
  assert.match(text, /This is a draft: nothing runs yet\./);
  assert.doesNotMatch(formatToolResult('sprint', { ok: true, value: { sprint: draft, notes: [] } }), /only its title/);
  const tool = TOOLS.find((t) => t.name === 'sprint');
  assert.match(tool.inputSchema.properties.tickets.description, /summary: the ticket's text exactly as the user or the tracker gave it, never just its title\./);
});

test('a draft reads as one, and the tool tells Claude nothing runs until Start', () => {
  const draft = { ...SUM, draft: true, discarded: false };
  assert.equal(sprintLines(draft)[0], 'Sprint · Oct week 2 · draft, not started · 5 tickets');
  const text = formatToolResult('sprint', { ok: true, value: { sprint: draft } });
  assert.match(text, /This is a draft: nothing runs yet./);
  assert.match(text, /press Start, or ask you to start it/);
  const thrown = { ...draft, discarded: true };
  assert.equal(sprintLines(thrown)[0], 'Sprint · Oct week 2 · draft discarded');
  assert.doesNotMatch(formatToolResult('sprint', { ok: true, value: { sprint: thrown } }), /nothing runs yet/);
  const tool = TOOLS.find((t) => t.name === 'sprint');
  assert.match(tool.description, /propose in the chat a writer and a reviewer for each task/);
  assert.match(tool.description, /"start" \(id\): start a draft, only when the user asks/);
  assert.deepEqual(tool.inputSchema.properties.action.enum.slice(0, 3), ['draft', 'start', 'discard']);
});

test('the sprint tool makes the draft board\'s changes', () => {
  assert.deepEqual(engineCall('sprint', { action: 'move', id: 's1', ticket: 'ABC-12', to: 'up' }).args, ['sprint', 'move', '--id', 's1', '--ticket', 'ABC-12', '--to', 'up']);
  assert.throws(() => engineCall('sprint', { action: 'move', id: 's1', ticket: 'ABC-12' }), { message: 'Say which way to move it: up or down.' });
  assert.throws(() => engineCall('sprint', { action: 'remove', id: 's1' }), { message: 'Say which ticket.' });
  assert.deepEqual(engineCall('sprint', { action: 'remove', id: 's1', ticket: 'ABC-12' }).args, ['sprint', 'remove', '--id', 's1', '--ticket', 'ABC-12']);
  assert.deepEqual(engineCall('sprint', { action: 'options', id: 's1', mergeWhenGreen: false, atOnce: 2 }).args, ['sprint', 'options', '--id', 's1', '--merge-when-green', 'false', '--at-once', '2']);
  assert.throws(() => engineCall('sprint', { action: 'options', id: 's1' }), { message: 'Say what to change: mergeWhenGreen or atOnce.' });
  const tool = TOOLS.find((t) => t.name === 'sprint');
  for (const a of ['move', 'remove', 'options']) assert.ok(tool.inputSchema.properties.action.enum.includes(a), a);
  assert.match(tool.description, /"options" \(mergeWhenGreen and\/or atOnce/);
  assert.match(tool.description, /"stop" \(id, ticket\): end a ticket the user has given up on; its branch is kept/);
});

test('a draft\'s rows say who writes and reviews; an unreadable sprint reads as such', () => {
  const tasks = (a, r) => [{ n: 1, title: 'A', agent: a, reviewer: r, status: 'to-do', canAssign: true }, { n: 2, title: 'B', agent: a, reviewer: r, status: 'to-do', canAssign: true }];
  const mixed = [tasks('codex', 'claude')[0], tasks('muse', 'claude')[1]];
  const draft = { ...SUM, draft: true, tickets: [{ ...SUM.tickets[4], tasks: tasks('codex', 'claude') }, { ...SUM.tickets[3], state: 'pending', tasks: mixed }] };
  assert.deepEqual(sprintLines(draft).slice(1), [
    'ABC-15  Import  2 tasks · written by Codex · reviewed by Claude',
    'ABC-14  Export  2 tasks · written by several agents · reviewed by Claude',
  ]);
  const card = { id: 's9', name: null, unreadable: "The sprint's saved state x is damaged.", tickets: [] };
  assert.deepEqual(sprintLines(card), ["Sprint s9: Podium can't read this sprint's saved state", "The sprint's saved state x is damaged."]);
  assert.equal(formatToolResult('sprint', { ok: true, value: { sprints: [card] } }), "Sprint s9: Podium can't read this sprint's saved state\nThe sprint's saved state x is damaged.");
  const named = { ...card, name: 'Smoke 4' };
  assert.deepEqual(sprintLines(named), ["Sprint Smoke 4: Podium can't read this sprint's saved state", "The sprint's saved state x is damaged."]);
  assert.equal(formatToolResult('sprint', { ok: true, value: { sprints: [named] } }), "Sprint Smoke 4: Podium can't read this sprint's saved state\nThe sprint's saved state x is damaged.");
  assert.equal(isOpenSprint(card), true);
  assert.equal(isOpenSprint({ tickets: [{ state: 'merged' }, { state: 'stopped' }] }), false);
});

test('a sprint ticket\'s steps are its writers\' and reviewers\' jobs, newest first', () => {
  const at = (m) => `2026-10-07T10:0${m}:00Z`;
  const jobs = [
    { id: 'a', createdAt: at(1), sprint: { id: 's1', ticket: 'ABC-12', task: 1, role: 'author' } },
    { id: 'r', createdAt: at(2), sprint: { id: 's1', ticket: 'ABC-12', task: 1, role: 'reviewer' } },
    { id: 'o', createdAt: at(3), sprint: { id: 's1', ticket: 'ABC-11', task: 1, role: 'author' } },
    { id: 'x', createdAt: at(4) },
  ];
  assert.deepEqual(ticketSteps(jobs, { id: 's1', ticket: 'ABC-12' }).map((j) => j.id), ['r', 'a']);
});

test('plan rows: a plan being written or changed, waiting for approval, without tasks, and a ticket waiting for others', () => {
  const base = { reason: null, findings: null, pr: null, reviews: 0, task: 0, of: 0, phase: null, agent: 'codex' };
  const s = { id: 's1', name: 'Oct', paused: false, finishedAt: null, autoMerge: false, tickets: [
    { ...base, key: 'ABC-14', title: 'Export', state: 'running', phase: 'plan' },
    { ...base, key: 'ABC-15', title: 'Import', state: 'running', phase: 'revise', agent: 'claude' },
    { ...base, key: 'ABC-16', title: 'Reports', state: 'plan-ready' },
    { ...base, key: 'ABC-17', title: 'Audit', state: 'no-tasks', reason: "Couldn't find tasks in this plan" },
    { ...base, key: 'ABC-18', title: 'Totals', state: 'pending', task: 1, of: 2, waitingOn: ['ABC-16', 'ABC-17'] },
  ] };
  assert.deepEqual(sprintLines(s), [
    'Sprint · Oct · 0 of 5 tickets done · 2 needs you · 2 of 3 running: Codex planning ABC-14, Claude changing the plan for ABC-15',
    'ABC-14  Export  Writing the plan · Codex working',
    'ABC-15  Import  Changing the plan · Claude working',
    'ABC-16  Reports  Plan ready: approve?',
    "ABC-17  Audit  ✋ Couldn't find tasks in this plan",
    'ABC-18  Totals  waiting (after ABC-16, ABC-17)',
  ]);
  assert.equal(sprintLines({ ...s, tickets: [s.tickets[1]] })[0], 'Sprint · Oct · 0 of 1 tickets done · 1 of 3 running: Claude changing the plan for ABC-15');
});

test('a draft row says who plans a ticket with no plan, and what each ticket waits for, also as its card', () => {
  const draft = { id: 'd1', name: 'Oct', draft: true, discarded: false, paused: false, finishedAt: null, autoMerge: false, maxParallel: 3, news: 0, tickets: [
    { key: 'ABC-14', title: 'Export', state: 'pending', task: 0, of: 0, phase: null, agent: 'codex', writer: 'codex', reviewer: 'claude', tasks: [], after: [] },
    { key: 'ABC-15', title: 'Import', state: 'pending', task: 1, of: 1, phase: null, agent: 'codex', tasks: [{ n: 1, title: 'A', agent: 'codex', reviewer: 'claude', status: 'to-do', canAssign: true }], after: ['ABC-14'] },
  ] };
  assert.deepEqual(sprintLines(draft).slice(1), [
    'ABC-14  Export  no plan yet · Codex plans it · tasks reviewed by Claude',
    'ABC-15  Import  1 task · written by Codex · reviewed by Claude · after ABC-14',
  ]);
  assert.deepEqual(sprintLines(sprintCard(draft)), sprintLines(draft));
});

test('the sprint tool approves a plan, sends it back with notes, runs it as one task, and sets "after"', () => {
  assert.deepEqual(engineCall('sprint', { action: 'approve', id: 's1', ticket: 'ABC-14' }).args, ['sprint', 'approve', '--id', 's1', '--ticket', 'ABC-14']);
  assert.deepEqual(engineCall('sprint', { action: 'one-task', id: 's1', ticket: 'ABC-14' }).args, ['sprint', 'one-task', '--id', 's1', '--ticket', 'ABC-14']);
  const revise = engineCall('sprint', { action: 'revise', id: 's1', ticket: 'ABC-14', text: '  Split task 2.  ' });
  assert.deepEqual(revise.args, ['sprint', 'revise', '--id', 's1', '--ticket', 'ABC-14', '--text', '-']);
  assert.equal(revise.stdin, 'Split task 2.');
  assert.throws(() => engineCall('sprint', { action: 'revise', id: 's1', ticket: 'ABC-14' }), { message: 'Say what should change in the plan (text).' });
  assert.throws(() => engineCall('sprint', { action: 'approve', id: 's1' }), { message: 'Say which ticket.' });
  assert.deepEqual(engineCall('sprint', { action: 'after', id: 's1', ticket: 'ABC-15', after: ['ABC-14', 'abc-13'] }).args, ['sprint', 'after', '--id', 's1', '--ticket', 'ABC-15', '--keys', 'ABC-14,abc-13']);
  assert.deepEqual(engineCall('sprint', { action: 'after', id: 's1', ticket: 'ABC-15', after: [] }).args, ['sprint', 'after', '--id', 's1', '--ticket', 'ABC-15', '--keys', 'none']);
  assert.throws(() => engineCall('sprint', { action: 'after', id: 's1', ticket: 'ABC-15' }), { message: 'Say which tickets it waits for (after: a list of keys; [] for none).' });
  const tool = TOOLS.find((t) => t.name === 'sprint');
  for (const a of ['after', 'approve', 'revise', 'one-task']) assert.ok(tool.inputSchema.properties.action.enum.includes(a), a);
  assert.equal(tool.inputSchema.properties.after.type, 'array');
  assert.equal(tool.inputSchema.properties.text.type, 'string');
  assert.match(tool.description, /A ticket with no plan is planned first/);
  assert.match(tool.description, /"approve" makes its tasks the ticket's/);
  assert.match(tool.description, /only when the user says so/);
  assert.doesNotMatch(tool.description, /Every ticket needs a plan/);
  // Claude sums a ready plan up and asks, and acts only on the user's word; "summary" is the ticket's text.
  assert.match(tool.description, /when a ticket's plan is ready you get a message\. Sum it up for the user and ask whether to approve it or change it \(or, for a plan with no tasks, run it as one task\), and act only when the user says so/);
  assert.doesNotMatch(tool.description, /approve it, change it or run it as one task/);
  assert.match(tool.description, /A ticket with no plan is planned first by its writer, from its summary, so give it one\./);
  assert.doesNotMatch(tool.description, /asking you to sum the plan up/);
  assert.match(sprintNewsNotes([{ text: 'x' }]), /approve a plan or send it back with changes/);
});

// The "after" action checks its input's type before the engine sees it.
test('the sprint tool refuses an "after" that is not a list of ticket keys, plainly', () => {
  const refusal = { message: 'Say which tickets it waits for (after: a list of keys; [] for none).' };
  for (const after of ['ABC-14', 'ABC-14,ABC-13', 14, null, { key: 'ABC-14' }, true]) {
    assert.throws(() => engineCall('sprint', { action: 'after', id: 's1', ticket: 'ABC-15', after }), refusal, JSON.stringify(after));
  }
  for (const after of [[14], [null], ['ABC-14', { key: 'ABC-13' }], ['ABC-14', '  ']]) {
    assert.throws(() => engineCall('sprint', { action: 'after', id: 's1', ticket: 'ABC-15', after }), refusal, JSON.stringify(after));
  }
  assert.throws(() => engineCall('sprint', { action: 'after', id: 's1', after: [] }), { message: 'Say which ticket.' });
  assert.deepEqual(engineCall('sprint', { action: 'after', id: 's1', ticket: 'ABC-15', after: [' ABC-14 '] }).args.slice(-2), ['--keys', 'ABC-14']);
});
