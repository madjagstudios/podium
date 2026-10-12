import test from 'node:test';
import assert from 'node:assert/strict';
import { slimJob, slimSprints, keepBusy, keepShown, enqueue, NAV_ACTIONS, EDIT_ACTIONS, overlayFor, nextPost, unseen, RESEND, pageProblem, codeLines, CODE_LINES, fitModel, PROPS_BUDGET, FILE_ROWS, plainProblem, LINE_CHARS, lineCost, fileRows, ROW_CHARS, CARD_ROWS, capRows, listPage, cardCost, sprintOrder, safeList, LIST_TOO_LONG, LIST_ROWS, LIST_LINE_CHARS, SPRINT_PAGE_NODES, SPRINT_PAGE_CHARS, wordsDrawn, turnTickets, TURN_TICKETS, QUIET_ACTIONS, sprintCard } from '../mod/client.js';
import { organise, threads, sprintLines as sprintLinesOf } from '../mod/view.js';

test('slimJob keeps what the pane draws and drops runner internals', () => {
  const job = { id: 'j1', title: 'T', status: 'done', agent: 'codex', runnerPid: 4, agentPid: 5, baseCommit: 'abc', liveFile: '/x', pr: { number: 1 }, origin: { session: 's' } };
  const slim = slimJob(job);
  assert.equal(slim.id, 'j1');
  assert.deepEqual(slim.pr, { number: 1 });
  assert.deepEqual(slim.origin, { session: 's' });
  assert.equal('runnerPid' in slim, false);
  assert.equal('baseCommit' in slim, false);
  assert.equal('liveFile' in slim, false);
});

// A sprint whose tickets all ended is kept (it is listed in Done or Other chats, and its board opens).
test('slimSprints keeps a parked ticket\'s findings, cut short, drops the rest, and keeps finished sprints', () => {
  const tasks = [{ n: 1, title: `A long task title ${'x'.repeat(100)}`, agent: 'codex', reviewer: 'claude', status: 'current', canAssign: false }];
  const t = (key, state, findings = 'long review text') => ({ key, title: key, state, task: 1, of: 1, phase: null, agent: 'codex', reason: null, findings, pr: null, reviews: 0, tasks });
  const open = { id: 's1', name: 'Open', paused: false, finishedAt: null, autoMerge: false, tickets: [t('A-1', 'merged'), t('A-2', 'pr-open'), t('A-3', 'parked'), t('A-4', 'parked', 'y'.repeat(5000))] };
  const done = { id: 's2', name: 'Done', paused: false, finishedAt: 'x', autoMerge: false, tickets: [t('B-1', 'merged'), t('B-2', 'closed')] };
  const unreadable = { id: 's3', name: null, unreadable: 'damaged', paused: false, finishedAt: null, autoMerge: false, tickets: [] };
  const out = slimSprints([open, done, unreadable]);
  assert.deepEqual(out.map((s) => s.id), ['s1', 's2', 's3']);
  assert.deepEqual(out[0].tickets.map((x) => x.findings), [undefined, undefined, 'long review text', `${'y'.repeat(1199)}…`]);
  assert.equal(out[0].tickets[1].state, 'pr-open');
  assert.ok(out[0].tickets[0].tasks[0].title.length <= 80);
  assert.equal(open.tickets[3].findings.length, 5000, 'the input is untouched');
  assert.deepEqual(slimSprints(undefined), []);
});

test('the outbox keeps actions in order and coalesces edits', () => {
  let box = [];
  box = enqueue(box, { kind: 'act', id: '1', name: 'editDraft', args: [{ task: 'a' }] });
  box = enqueue(box, { kind: 'act', id: '2', name: 'showScreen', args: ['agents'] });
  box = enqueue(box, { kind: 'act', id: '3', name: 'editDraft', args: [{ task: 'ab' }] });
  assert.deepEqual(box.map((m) => m.id), ['2', '3']);
  assert.ok(NAV_ACTIONS.has('showScreen') && NAV_ACTIONS.has('openDetail') && !NAV_ACTIONS.has('act'));
});

test('every post carries all unreceived presses, so a replaced post loses none', () => {
  const a = { kind: 'act', id: '1', name: 'pushPr', args: ['j1'] };
  const b = { kind: 'act', id: '2', name: 'showScreen', args: ['list'] };
  let s = { syncDue: true, sentKey: '', sinceSend: 0 };
  let r = nextPost([a], s);
  assert.deepEqual(r.post, { kind: 'acts', acts: [a] });
  r = nextPost([a, b], r.s);
  assert.deepEqual(r.post.acts.map((m) => m.id), ['1', '2'], 'a later post still carries the first press');
  r = nextPost([a, b], r.s);
  assert.equal(r.post, null, 'unchanged: no resend at once');
  s = r.s;
  for (let i = 1; i < RESEND; i++) s = nextPost([a, b], s).s;
  assert.equal(nextPost([a, b], s).post.kind, 'acts', 'resent after a while');
  assert.deepEqual(unseen([a, b], ['1']), [b]);
  r = nextPost([], { syncDue: true, sentKey: '1,2', sinceSend: 0 });
  assert.deepEqual(r.post, { kind: 'sync' });
  assert.equal(nextPost([], r.s).post, null);
});

// Ended sprints are kept now (finished, listed in Done), archived after they ended too; a
// thrown-away one, or one with no tickets, is still left out.
test('slimSprints treats stopped tickets as ended, and keeps only sprints that are open or finished', () => {
  const t = (key, state) => ({ key, title: key, state, task: 1, of: 1, phase: null, agent: 'codex', reason: null, findings: null, pr: null, reviews: 0 });
  const ended = { id: 's1', name: 'Ended', paused: false, finishedAt: 'x', autoMerge: false, tickets: [t('A-1', 'merged'), t('A-2', 'stopped')] };
  const stoppedOnly = { id: 's2', name: 'Stopped', paused: false, finishedAt: 'x', autoMerge: false, tickets: [t('B-1', 'stopped')] };
  const open = { id: 's3', name: 'Open', paused: false, finishedAt: null, autoMerge: false, tickets: [t('C-1', 'stopped'), t('C-2', 'parked')] };
  const archived = { ...ended, id: 's4', archived: true };
  const empty = { ...ended, id: 's5', tickets: [] };
  const thrown = { ...ended, id: 's6', archived: true, discarded: true, draft: true };
  assert.deepEqual(slimSprints([ended, stoppedOnly, open, archived, empty, thrown]).map((s) => s.id), ['s1', 's2', 's3', 's4']);
});

test('keepShown keeps the open screen\'s sprint when an answer asked for before it opened left it out', () => {
  const view = (id, name) => ({ id, name, tickets: [] });
  const prev = [view('s1', 'One'), view('s2', 'Two')];
  const next = [view('s2', 'Two, renamed')];
  assert.deepEqual(keepShown(prev, next, 's1'), [view('s2', 'Two, renamed'), prev[0]], 'left out: its last view, at the end');
  assert.deepEqual(keepShown(prev, next, 's2'), next, 'in the answer: the answer stands');
  assert.deepEqual(keepShown(prev, next, null), next, 'no sprint on screen: nothing kept');
  assert.deepEqual(keepShown([{ id: 's1', busy: true }], next, 's1'), next, 'a marker is never kept');
  assert.deepEqual(keepShown(undefined, next, 's9'), next, 'never seen: nothing to keep');
});

test('keepBusy puts each sprint the engine could not read just now back as its last view, or drops it', () => {
  const view = (id, name) => ({ id, name, tickets: [] });
  const prev = [view('s1', 'One'), view('s2', 'Two')];
  const next = [{ id: 's1', busy: true }, view('s2', 'Two, renamed'), { id: 's3', busy: true }, view('s4', 'Four')];
  assert.deepEqual(keepBusy(prev, next), [prev[0], view('s2', 'Two, renamed'), view('s4', 'Four')]);
  assert.deepEqual(keepBusy(undefined, [{ id: 's1', busy: true }, view('s2', 'Two')]), [view('s2', 'Two')]);
  assert.deepEqual(keepBusy([{ id: 's1', busy: true }], [{ id: 's1', busy: true }]), [], 'a marker is never the last view');
  assert.deepEqual(keepBusy(prev, []), []);
  assert.equal(slimSprints(keepBusy(prev, [{ id: 's1', busy: true }])).length, 0, 'the kept view goes on to the pane like any other');
});

test('openBoard is a navigation press: the Client shows the board at once', () => {
  assert.ok(NAV_ACTIONS.has('openBoard'));
  assert.deepEqual(overlayFor('openBoard', ['s1']), { screen: 'sprint', id: 's1' });
  assert.deepEqual(overlayFor('openDetail', ['j1']), { screen: 'detail', id: 'j1' });
  assert.deepEqual(overlayFor('showScreen', ['agents']), { screen: 'agents', id: null });
  assert.ok(EDIT_ACTIONS.has('askConfirm') && EDIT_ACTIONS.has('editDraft'));
  assert.ok(NAV_ACTIONS.has('openTicket') && !EDIT_ACTIONS.has('openTicket'), 'a ticket opens its own screen');
  assert.deepEqual(overlayFor('openTicket', ['s1', 'ABC-12']), { screen: 'ticket', id: 's1', key: 'ABC-12' });
  assert.deepEqual(overlayFor('openTicket', ['s1', null]), { screen: 'sprint', id: 's1' });
  assert.ok(EDIT_ACTIONS.has('openPicker'), 'opening a board picker sets a value: no "Working…"');
});

// The "couldn't draw" note's Back to the list also closes the board's open row:
// reopening the same board kept the row that could not be drawn, so Back led straight back to the note.
test('backToList is a navigation press to the list', () => {
  assert.ok(NAV_ACTIONS.has('backToList'));
  assert.deepEqual(overlayFor('backToList', []), { screen: 'list', id: null });
});

// The desktop page's own rules for a Client's tree (a Code element blanked the pane).
// Trees are shaped as the Client builds them: { type, props, children }, a Button carrying its onPress.
const el = (type, props, ...children) => ({ type, props: props ?? {}, ...(children.length ? { children } : {}) });
const button = (key, label, more = {}) => ({ type: 'Button', props: { key, label, ...more }, onPress: () => {} });

test('pageProblem passes a tree the desktop page draws', () => {
  const tree = el('Box', { flexDirection: 'column', gap: 1 },
    el('Text', { bold: true, color: 'success' }, 'Podium'),
    el('Box', { borderStyle: 'round' }, button('new', ' + New job ', { variant: 'primary' })),
    button('more', '▸ More', { plain: true }),
    { type: 'Input', props: { key: 'task', placeholder: 'What should it do?', value: 'x' }, onEvent: () => {} },
    { type: 'Select', props: { key: 'pick', options: [{ value: 'a', label: 'A' }], value: 'a' }, onEvent: () => {} },
    { type: 'Svg', props: { source: '<svg/>', alt: 'bar', width: 300, height: 3, isInteractive: true } },
    el('span', {}, el('b', {}, 'bold'), ''));
  assert.equal(pageProblem(tree), null);
  assert.equal(pageProblem('just text'), null);
  // The kit's drawing of a Button carries a press handle instead of the function: the same tree to the page.
  assert.equal(pageProblem(el('Box', {}, { type: 'Button', props: { key: 'k', label: 'L' }, press: { plugin: 'podium', handle: 3 } })), null);
});

test('pageProblem refuses Code, Link and Markdown, which the desktop page cannot draw', () => {
  const inBox = (node) => el('Box', {}, el('Text', {}, 'before'), node);
  assert.equal(pageProblem(inBox(el('Code', { source: '+a', format: 'diff' }))), 'a Code element, which the desktop pane cannot draw');
  assert.equal(pageProblem(inBox(el('Link', { href: 'https://x.y' }, 'x'))), 'a Link element, which the desktop pane cannot draw');
  assert.equal(pageProblem(inBox(el('Markdown', { text: '# hi' }))), 'a Markdown element, which the desktop pane cannot draw');
  assert.equal(pageProblem(inBox({ props: {} })), 'an element without a type');
});

test('pageProblem counts elements and texts against the page\'s 2,000', () => {
  const rows = (n) => el('Box', {}, ...Array.from({ length: n }, (_, i) => el('Text', {}, `line ${i}`)));
  assert.equal(pageProblem(rows(999)), null, 'a Box, 999 Texts and their 999 strings: 1,999');
  assert.equal(pageProblem(rows(1000)), '2,001 elements and texts, more than the desktop pane\'s 2,000');
  assert.equal(pageProblem(rows(1070)), '2,141 elements and texts, more than the desktop pane\'s 2,000');
});

// The runtime numbers each Button, Input and Select handle from a counter that grows for the pane's life (it
// redraws every second), so after an hour each handle is six or seven digits. Counted at its largest.
test('pageProblem counts each Button, Input and Select handle at its largest', () => {
  const buttons = Array.from({ length: 200 }, (_, i) => button(`b${i}`, 'x'));
  const oneDigit = (pad) => JSON.stringify({ type: 'Box', props: {}, children: [...buttons.map((b) => ({ type: 'Button', props: b.props, held: 1 })), { type: 'Text', props: {}, children: ['x'.repeat(pad)] }] }).length;
  const pad = 99_000 - oneDigit(0);
  assert.ok(oneDigit(pad) < 100_000, 'with one-digit handles it would fit');
  assert.match(pageProblem(el('Box', {}, ...buttons, el('Text', {}, 'x'.repeat(pad)))), /^a drawing of 10\d,\d{3} characters, more than the desktop pane's 100,000$/);
});

// The note leads with plain words; the checker's reason goes below it, dim.
test('plainProblem says in plain words why a screen cannot be shown', () => {
  const tooMuch = 'This screen has too much to show here. Close some open files, or ask Claude.';
  assert.equal(plainProblem('2,141 elements and texts, more than the desktop pane\'s 2,000'), tooMuch);
  assert.equal(plainProblem('a drawing of 120,000 characters, more than the desktop pane\'s 100,000'), tooMuch);
  assert.equal(plainProblem('elements nested 33 deep, more than the desktop pane\'s 32'), tooMuch);
  assert.equal(plainProblem('a Code element, which the desktop pane cannot draw'), 'Something on this screen can\'t be shown here.');
});

test('pageProblem refuses elements nested more than 32 deep', () => {
  const nest = (n) => { let node = el('Text', {}, 'deep'); for (let i = 1; i < n; i++) node = el('Box', {}, node); return node; };
  assert.equal(pageProblem(nest(32)), null);
  assert.equal(pageProblem(nest(33)), 'elements nested 33 deep, more than the desktop pane\'s 32');
});

test('pageProblem refuses a drawing longer than a Client tree\'s 100,000 characters', () => {
  assert.equal(pageProblem(el('Text', {}, 'x'.repeat(90000))), null);
  assert.match(pageProblem(el('Text', {}, 'x'.repeat(100000))), /^a drawing of 100,\d{3} characters, more than the desktop pane's 100,000$/);
});

test('pageProblem allows only text, numbers and true/false as a Box or Text prop', () => {
  assert.equal(pageProblem(el('Box', {}, el('Box', { color: null }))), 'a Box prop color that is null');
  assert.equal(pageProblem(el('Text', { style: { a: 1 } }, 'x')), 'a Text prop style that is an object');
  assert.equal(pageProblem(el('Text', { list: [1] }, 'x')), 'a Text prop list that is a list');
  assert.equal(pageProblem(el('Text', { width: Infinity }, 'x')), 'a Text prop width that is null', 'the Client sends a number that is not finite as null');
  assert.equal(pageProblem(el('Text', { onPress: () => {}, hidden: undefined }, 'x')), null, 'functions and undefined drop out on the way');
  let deep = {}; const top = deep; for (let i = 0; i < 70; i++) { deep.a = {}; deep = deep.a; }
  assert.match(pageProblem(el('Box', { data: top })), /^data nested \d+ deep, more than the desktop pane's 66$/);
});

test('pageProblem refuses a child that is neither text nor an element', () => {
  assert.equal(pageProblem(el('Box', {}, 3)), 'a child that is neither text nor an element (a number)');
  assert.equal(pageProblem(el('Box', {}, null)), 'a child that is neither text nor an element (null)');
  assert.equal(pageProblem(el('Box', {}, ['nested'])), 'a child that is neither text nor an element (a list)');
});

test('pageProblem checks a Button, an Input, a Select and an Svg as the page does', () => {
  assert.equal(pageProblem(button('', 'x')), 'a Button with no key');
  assert.equal(pageProblem(button('k'.repeat(257), 'x')), 'a Button key longer than 256 characters');
  assert.equal(pageProblem({ type: 'Button', props: { key: 'k' }, onPress: () => {} }), 'a Button k with no label');
  assert.equal(pageProblem(button('k', 'x', { plain: 'yes' })), 'a Button k whose plain is not true or false');
  assert.equal(pageProblem({ type: 'Input', props: { key: 'i', value: 'v'.repeat(16385) }, onEvent: () => {} }), 'an Input i whose value is longer than 16,384 characters');
  assert.equal(pageProblem({ type: 'Input', props: { key: 'i', label: 3 }, onEvent: () => {} }), 'an Input i whose label is not text');
  assert.equal(pageProblem({ type: 'Select', props: { key: 's', options: [] }, onEvent: () => {} }), 'a Select s with no options');
  assert.equal(pageProblem({ type: 'Select', props: { key: 's', options: [{ label: 'A' }] }, onEvent: () => {} }), 'a Select s with an option that has no value');
  const svg = (props) => ({ type: 'Svg', props: { source: '<svg/>', alt: 'bar', width: 10, height: 3, ...props } });
  assert.equal(pageProblem(svg({ alt: ' ' })), 'an Svg with no alt text');
  assert.equal(pageProblem(svg({ source: '' })), 'an Svg with no source');
  // The page's own Svg limit (131,072) is past a Client tree's 100,000 characters, so the tree's bound is what refuses it.
  assert.match(pageProblem(svg({ source: 'x'.repeat(131073) })), /^a drawing of 131,\d{3} characters, more than the desktop pane's 100,000$/);
  assert.equal(pageProblem(svg({ width: undefined })), 'an Svg whose width is not a number from 1 to 4,096');
  assert.equal(pageProblem(svg({ height: 5000 })), 'an Svg whose height is not a number from 1 to 4,096');
});

test('codeLines colours a diff\'s added and removed lines, keeps its start, and cuts it with a note', () => {
  const diff = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n same\n\n… 12 more characters not shown';
  assert.deepEqual(codeLines(diff, { format: 'diff' }), { used: 9, lines: [
    { text: 'diff --git a/x b/x', tone: 'head' }, { text: '--- a/x', tone: 'head' }, { text: '+++ b/x', tone: 'head' }, { text: '@@ -1 +1 @@', tone: 'head' },
    { text: '-old', tone: 'removed' }, { text: '+new', tone: 'added' }, { text: ' same', tone: 'plain' }, { text: ' ', tone: 'plain' },
    { text: '… 12 more characters not shown', tone: 'dim' },
  ] });
  const long = Array.from({ length: CODE_LINES + 40 }, (_, i) => `+line ${i}`).join('\n');
  const cut = codeLines(long, { format: 'diff' });
  assert.equal(cut.used, CODE_LINES);
  assert.equal(cut.lines.length, CODE_LINES + 1);
  assert.equal(cut.lines[0].text, '+line 0');
  assert.deepEqual(cut.lines.at(-1), { text: '… 40 more lines', tone: 'dim' });
});

test('codeLines draws source plainly and keeps its end (the newest output)', () => {
  assert.deepEqual(codeLines('+a\n-b', {}).lines, [{ text: '+a', tone: 'plain' }, { text: '-b', tone: 'plain' }]);
  const out = codeLines(Array.from({ length: 10 }, (_, i) => `out ${i}`).join('\n'), { max: 4 });
  assert.equal(out.used, 4);
  assert.deepEqual(out.lines.map((l) => l.text), ['… 6 earlier lines', 'out 6', 'out 7', 'out 8', 'out 9']);
  assert.deepEqual(codeLines('a\nb', { max: 0 }), { used: 0, lines: [{ text: '… 2 earlier lines', tone: 'dim' }] }, 'no room left: only the note');
});

// The screen's code is bounded in characters too (a Client tree's 100,000), not only
// in lines: a long line is cut (the pane cuts it on screen anyway), and a block stops at its share of characters.
test('codeLines cuts a long line and stops at maxChars of drawing, keeping a diff\'s start and output\'s end', () => {
  const wide = codeLines(`+${'x'.repeat(1000)}`, { format: 'diff' });
  assert.equal(wide.lines[0].text.length, LINE_CHARS);
  assert.ok(wide.lines[0].text.endsWith('…'));
  const rows = Array.from({ length: 100 }, (_, i) => `${String(i).padStart(3, '0')}${'y'.repeat(117)}`);
  const diff = codeLines(rows.map((r) => `+${r}`).join('\n'), { format: 'diff', maxChars: 10_000 });
  assert.ok(diff.used > 40 && diff.used < 100, `${diff.used} lines`);
  assert.ok(diff.lines.slice(0, diff.used).reduce((n, l) => n + lineCost(l.text), 0) <= 10_000);
  assert.equal(diff.lines[0].text, `+${rows[0]}`);
  assert.deepEqual(diff.lines.at(-1), { text: `… ${100 - diff.used} more lines`, tone: 'dim' });
  const out = codeLines(rows.join('\n'), { maxChars: 10_000 });
  assert.equal(out.lines.at(-1).text, rows[99]);
  assert.deepEqual(out.lines[0], { text: `… ${100 - out.used} earlier lines`, tone: 'dim' });
});

test('fileRows draws up to FILE_ROWS files, fewer when long paths would outgrow the drawing', () => {
  const files = (n, path) => Array.from({ length: n }, (_, i) => ({ path: path(i) }));
  assert.equal(fileRows(files(400, (i) => `src/file${i}.ts`)), FILE_ROWS);
  assert.equal(fileRows(files(20, (i) => `src/file${i}.ts`)), 20);
  const long = (i) => `packages/payouts/src/components/rounding/half-even/${'deep/'.repeat(8)}case-${i}.test.tsx`;
  const n = fileRows(files(400, long));
  assert.ok(n > 10 && n < FILE_ROWS, `${n} rows`);
  assert.ok(n * (3 * (long(0).length + 2) + 270) <= ROW_CHARS);
});

// ---- fitModel: the desktop Client gets only the jobs it can show (its props count toward a tree's 100,000) ----

const size = (v) => JSON.stringify(v).length;
const at = (minute) => new Date(Date.UTC(2026, 8, 1) + minute * 60_000).toISOString();
const fjob = (id, over = {}) => ({
  id, title: `Job ${id}: tidy the payout rounding and its tests`, project: 'podium-smoke', ticket: 'ABC-4', agent: 'codex', model: null,
  permission: 'edit-worktree', status: 'kept', createdAt: at(0), startedAt: at(0), endedAt: at(1), isLong: false, delivered: true,
  hasChanges: false, changes: { files: 2, added: 10, removed: 3 }, outcome: 'used', outcomeSource: 'user', error: null, base: 'main',
  worktree: `/home/me/.local/share/podium/worktrees/${id}`, origin: { session: 'chat-1' },
  committed: { branch: `podium/${id}`, head: 'abc1234', count: 2, commits: [{ sha: 'a1b2c3d', subject: 'Round payouts half-even' }, { sha: 'e4f5a6b', subject: 'Test the rounding' }] },
  ...over,
});
const finished = (n) => Array.from({ length: n }, (_, i) => fjob(`f${i}`, { createdAt: at(i * 10), startedAt: at(i * 10), endedAt: at(i * 10 + 5) }));
const paneModelWith = (jobs, over = {}) => ({
  view: { screen: 'list', id: null }, notice: null, jobs, live: {}, detail: null, agents: [], agentsLoaded: true, settings: { tellClaudeWhenDone: true },
  draft: { agent: 'codex', task: '', permission: 'edit-worktree', includeUncommitted: false, model: '', ticket: '', base: '' },
  draftAdapter: null, palette: 'dark', askFor: null, cleared: null, showAllDone: false, checks: null, whatsNew: null, removing: null,
  sprints: [], board: { sprint: null, open: null, confirm: null, picking: null }, session: 'chat-1', acked: [], seen: [], ...over,
});
const ids = (m) => new Set(m.jobs.map((j) => j.id));

test('fitModel hands a model that fits back whole, with no jobs hidden', () => {
  const model = paneModelWith(finished(5));
  const { sprintPaging, ...rest } = fitModel(model);
  assert.deepEqual(rest, { ...model, hiddenJobs: 0, hiddenAtWork: 0 });
  assert.deepEqual(sprintPaging, { ids: [], page: 0, pages: 0, from: 1, to: 0, total: 0, rows: CARD_ROWS }, 'and which sprints are on the list page (none)');
});

test('fitModel keeps 500 finished jobs under the budget, newest first, and counts the rest as hidden', () => {
  const model = paneModelWith(finished(500));
  assert.ok(size(model) > 200_000, 'the whole history is far over the bound');
  const out = fitModel(model);
  assert.ok(size(out) <= PROPS_BUDGET, `${size(out)} characters`);
  assert.ok(out.jobs.length > 20, 'still shows a good part of the history');
  assert.equal(out.hiddenJobs, 500 - out.jobs.length);
  const oldestKept = Math.min(...out.jobs.map((j) => Date.parse(j.endedAt)));
  const newestHidden = Math.max(...model.jobs.filter((j) => !ids(out).has(j.id)).map((j) => Date.parse(j.endedAt)));
  assert.ok(oldestKept > newestHidden, 'the kept ones are the newest');
  assert.equal(model.jobs.length, 500, 'the input is untouched');
  const small = fitModel(model, { budget: 20_000 });
  assert.ok(size(small) <= 20_000);
  assert.ok(small.jobs.length < out.jobs.length);
});

test('fitModel keeps every job still at work, waiting on the person or in review, however old', () => {
  const active = ['queued', 'running', 'needs-review', 'in-review'].flatMap((status, s) => Array.from({ length: 5 }, (_, i) => fjob(`a${s}-${i}`, { status, endedAt: null, createdAt: at(-1000 - i) })));
  const model = paneModelWith([...finished(500), ...active]);
  const out = fitModel(model);
  assert.ok(size(out) <= PROPS_BUDGET);
  for (const j of active) assert.ok(ids(out).has(j.id), `${j.id} (${j.status}) kept`);
  // A thread whose latest step is at work comes whole: the card counts its steps and shows its first title.
  const thread = [fjob('t1', { threadId: 't1', step: 1, createdAt: at(-5000), endedAt: at(-4990) }), fjob('t2', { threadId: 't1', step: 2, status: 'running', endedAt: null, createdAt: at(-4000) })];
  const both = fitModel(paneModelWith([...finished(500), ...thread]));
  assert.ok(ids(both).has('t1') && ids(both).has('t2'));
});

test('fitModel keeps the whole thread of the open detail, however old', () => {
  const old = [1, 2, 3].map((n) => fjob(`o${n}`, { threadId: 'o1', step: n, createdAt: at(-9000 + n), endedAt: at(-8990 + n) }));
  const model = paneModelWith([...finished(500), ...old], { view: { screen: 'detail', id: 'o2' } });
  const out = fitModel(model);
  assert.ok(size(out) <= PROPS_BUDGET);
  for (const j of old) assert.ok(ids(out).has(j.id), `${j.id} kept`);
});

test('fitModel keeps every step of the open board\'s sprint, and of an open sprint step\'s ticket', () => {
  const step = (id, sprint, ticket, minute) => fjob(id, { sprint: { id: sprint, ticket, task: 1, role: 'writer' }, createdAt: at(minute), endedAt: at(minute + 1) });
  const steps = [step('s1a', 's1', 'A-1', -9000), step('s1b', 's1', 'A-2', -8000), step('s2a', 's2', 'B-1', -9000), step('s2b', 's2', 'B-2', -9100)];
  const board = fitModel(paneModelWith([...finished(500), ...steps], { view: { screen: 'sprint', id: 's1' } }));
  assert.ok(size(board) <= PROPS_BUDGET);
  assert.ok(ids(board).has('s1a') && ids(board).has('s1b'));
  assert.ok(!ids(board).has('s2a'), 'another sprint\'s finished steps make room');
  assert.equal(board.hiddenJobs, 500 - board.jobs.filter((j) => !j.sprint).length, 'sprint steps never show in the lanes, so they are not counted');
  const detail = fitModel(paneModelWith([...finished(500), ...steps], { view: { screen: 'detail', id: 's2b' } }));
  assert.ok(ids(detail).has('s2b') && !ids(detail).has('s2a'), 'the open step\'s ticket only');
});

test('fitModel cuts a giant diff in the open detail: closed files lose their patch, an open one is cut with a note', () => {
  const big = '@@ -0,0 +1,20000 @@\n' + Array.from({ length: 20000 }, (_, i) => `+  line ${i} of a generated file`).join('\n');
  const files = [{ path: 'gen/big.js', added: 20000, removed: 0, patch: big, isTruncated: false },
    ...Array.from({ length: 400 }, (_, i) => ({ path: `src/file-${i}.js`, added: 30, removed: 2, patch: `@@ -1 +1 @@\n${'+x\n'.repeat(30)}`, isTruncated: false }))];
  const detail = { id: 'f499', summary: 'Generated the bundle.', output: null, changes: { files, added: 32000, removed: 800 }, open: ['gen/big.js'] };
  const model = paneModelWith(finished(500), { view: { screen: 'detail', id: 'f499' }, detail });
  const out = fitModel(model);
  assert.ok(size(out) <= PROPS_BUDGET, `${size(out)} characters`);
  const shown = out.detail.changes.files;
  assert.equal(shown.length, FILE_ROWS, 'only the rows the screen draws');
  assert.equal(out.detail.changes.more, 401 - FILE_ROWS, 'and how many it left out');
  assert.match(shown[0].patch, /more characters not shown$/);
  assert.ok(shown[0].patch.startsWith('@@ -0,0 +1,20000 @@\n+  line 0'));
  assert.ok(shown.slice(1).every((f) => f.patch === ''), 'closed files are drawn without their patch');
  assert.ok(ids(out).has('f499'));
  // Many open files: cut further until it fits.
  const allOpen = fitModel({ ...model, detail: { ...detail, open: files.map((f) => f.path) } });
  assert.ok(size(allOpen) <= PROPS_BUDGET, `${size(allOpen)} characters`);
  assert.ok(allOpen.detail.changes.files.some((f) => /not shown$/.test(f.patch)));
  assert.equal(files[0].patch, big, 'the input is untouched');
});

test('fitModel shortens long text when the jobs it must keep are over the budget, and never returns one over it', () => {
  const active = Array.from({ length: 60 }, (_, i) => fjob(`r${i}`, { status: 'running', endedAt: null, title: `Run ${i} ${'x'.repeat(3000)}` }));
  const out = fitModel(paneModelWith(active));
  assert.ok(size(out) <= PROPS_BUDGET, `${size(out)} characters`);
  assert.equal(out.jobs.length, 60, 'every running job still shows');
  assert.ok(out.jobs.every((j) => j.title.length < 3000 && j.title.endsWith('…')));
  for (const budget of [40_000, 10_000, 3_000]) {
    const tight = fitModel(paneModelWith([...active, ...finished(200)], { detail: { id: 'r1', summary: 'y'.repeat(50_000), output: 'z'.repeat(8000), changes: null, open: [] } }), { budget });
    assert.ok(size(tight) <= budget, `${size(tight)} characters for a budget of ${budget}`);
  }
});

// The list's own lanes come first, so other chats' work never pushes this chat's Done lane out, and an ask form stays
// while the person types.
const doneLane = (m, now, showAll = false) => organise(threads(m.jobs), { session: 'chat-1', now, showAll }).done.map((t) => t.id);
const othersLane = (m, now) => organise(threads(m.jobs), { session: 'chat-1', now }).others.map((t) => t.id);

test('fitModel keeps this chat\'s Done lane, however many newer jobs other chats finished', () => {
  const now = Date.parse('2026-10-07T12:00:00Z');
  const mine = (n) => Array.from({ length: n }, (_, i) => fjob(`m${i}`, { createdAt: at(i * 10), startedAt: at(i * 10), endedAt: at(i * 10 + 5) }));
  const others = Array.from({ length: 300 }, (_, i) => fjob(`x${i}`, { origin: { session: 'chat-2' }, createdAt: at(5000 + i * 10), startedAt: at(5000 + i * 10), endedAt: at(5005 + i * 10) }));
  const model = paneModelWith([...mine(8), ...others]);
  assert.ok(size(model) > PROPS_BUDGET);
  const out = fitModel(model, { now });
  assert.ok(size(out) <= PROPS_BUDGET, `${size(out)} characters`);
  assert.equal(doneLane(model, now).length, 5);
  assert.deepEqual(doneLane(out, now), doneLane(model, now), 'this chat\'s Done lane is as it would be with every job');
  assert.deepEqual(othersLane(out, now), othersLane(model, now), 'other chats\' lane keeps its 30 newest');
  // With Show more on, every one of this chat's finished jobs.
  const all = paneModelWith([...mine(40), ...others], { showAllDone: true });
  const outAll = fitModel(all, { now });
  assert.ok(size(outAll) <= PROPS_BUDGET);
  assert.equal(doneLane(outAll, now, true).length, 40);
});

test('fitModel keeps the thread an open ask form is on, however old', () => {
  const others = finished(500).map((j) => ({ ...j, origin: { session: 'chat-2' } }));
  const old = [1, 2].map((n) => fjob(`q${n}`, { threadId: 'q1', step: n, origin: { session: 'chat-2' }, createdAt: at(-9000 + n), endedAt: at(-8990 + n) }));
  const out = fitModel(paneModelWith([...others, ...old], { askFor: { threadId: 'q1', agent: 'codex', task: 'make the heading bigg', mode: 'change' } }));
  assert.ok(size(out) <= PROPS_BUDGET);
  for (const j of old) assert.ok(ids(out).has(j.id), `${j.id} kept`);
});

test('fitModel says how many jobs at work it left out, so the list does not call them finished', () => {
  const active = Array.from({ length: 60 }, (_, i) => fjob(`r${i}`, { status: 'running', endedAt: null, title: `Run ${i} ${'x'.repeat(3000)}` }));
  const bare = fitModel(paneModelWith([...active, ...finished(10)]), { budget: 3_000 });
  assert.ok(size(bare) <= 3_000);
  assert.equal(bare.jobs.length, 0);
  assert.equal(bare.hiddenJobs, 70);
  assert.equal(bare.hiddenAtWork, 60);
  const kept = fitModel(paneModelWith([...active.slice(0, 2), ...finished(500)]));
  assert.equal(kept.hiddenAtWork, 0, 'jobs at work are kept whenever they fit');
});

// A realistic 30-ticket sprint still leaves its sprint and the jobs on the list.
const bigSprint = (id, name, tickets = 30) => ({
  id, name, draft: false, discarded: false, paused: false, finishedAt: null, autoMerge: true, maxParallel: 3, news: 0,
  tickets: Array.from({ length: tickets }, (_, i) => {
    const key = `PAY-${100 + i}`;
    const state = i < 3 ? 'running' : i < 12 ? 'parked' : i < 18 ? 'pr-open' : 'pending';
    return {
      key, title: `Payouts ${i}: round half-even across every currency and keep the ledger totals in step with the reports`,
      state, task: 2, of: 8, phase: state === 'running' ? 'author' : null, agent: 'codex',
      reason: state === 'parked' ? `Review failed twice on task 2: ${'the rounding still drifts on negative amounts and the ledger test is missing. '.repeat(3)}` : null,
      findings: state === 'parked' ? `Findings for ${key}: ${'The reviewer found that the rounding drifts on negative amounts; add a ledger test. '.repeat(20)}` : null,
      pr: state === 'pr-open' ? { number: 200 + i, url: `https://github.com/o/r/pull/${200 + i}` } : null, reviews: 1, latest: `${id}-${key}-a2`,
      tasks: Array.from({ length: 8 }, (_, n) => ({ n: n + 1, title: `Task ${n + 1}: ${'make the payout rounding and the ledger agree on every currency '.repeat(2)}`, agent: 'codex', reviewer: 'claude', status: n < 1 ? 'done' : n === 1 ? 'current' : 'to-do', canAssign: n > 1 })),
      canRetry: state === 'parked', giveTo: state === 'parked' ? 'writer' : null, canStop: state !== 'pr-open',
    };
  }),
});
const sprintSteps = (s, n) => Array.from({ length: n }, (_, i) => {
  const t = s.tickets[i % s.tickets.length];
  return fjob(`${s.id}-st${i}`, { title: `${t.key} task ${1 + (i % 2)}: ${t.title}`, status: i < 3 ? 'running' : 'done', endedAt: i < 3 ? null : at(i), createdAt: at(i), sprint: { id: s.id, ticket: t.key, task: 1 + (i % 2), role: i % 3 ? 'author' : 'reviewer' } });
});

test('fitModel never drops a sprint: a 30-ticket sprint and 200 jobs fit, with every card and its controls', async () => {
  const { slimSprints: slim } = await import('../mod/client.js');
  const { sprintLines } = await import('../mod/view.js');
  const s = bigSprint('s-big', 'Payouts sprint');
  const other = bigSprint('s-two', 'Ledger sprint');
  const jobs = [...sprintSteps(s, 150), ...finished(50)];
  const model = paneModelWith(jobs, { sprints: slim([s, other]) });
  assert.ok(size(model) > PROPS_BUDGET, `${size(model)} characters: over the budget`);
  for (const view of [{ screen: 'list', id: null }, { screen: 'sprint', id: 's-big' }]) {
    const out = fitModel({ ...model, view });
    assert.ok(size(out) <= PROPS_BUDGET, `${size(out)} characters on ${view.screen}`);
    assert.deepEqual(out.sprints.map((x) => x.id), ['s-big', 's-two'], `every sprint is sent on ${view.screen}`);
    for (const x of out.sprints) {
      const lines = sprintLines(x);
      assert.match(lines[0], /^Sprint · (Payouts|Ledger) sprint · 6 of 30 tickets done · 9 needs you · 3 of 3 running: Codex working on PAY-100 task 2, Codex working on PAY-101 task 2, Codex working on PAY-102 task 2$/);
      assert.equal(x.paused, false, 'Pause is offered');
      if (view.screen === 'sprint' && x.id === 's-big') {
        // The open board: a row per ticket (key, title, state, why, PR).
        assert.equal(x.tickets.length, 30);
        assert.match(lines[1], /^PAY-100  Payouts 0: .* Task 2\/8 · Codex working · reviews 1 ✓$/);
        assert.match(lines[4], /^PAY-103  Payouts 3: .* ✋ Review failed twice on task 2/);
        assert.match(lines[13], /PR #212 open$/);
      } else {
        // On the list a sprint is its row: its status line, counted over every ticket, and no ticket rows.
        assert.equal(x.tickets.length, 0);
        assert.equal(x.more, 30);
        assert.equal(x.status, '6 of 30 done · 3 of 3 running: PAY-100, PAY-101, PAY-102');
      }
    }
    // The steps at work are always sent.
    for (const id of ['s-big-st0', 's-big-st1', 's-big-st2']) assert.ok(ids(out).has(id), `${id} kept on ${view.screen}`);
  }
  // Only the open board's sprint carries its tasks and review findings; the board says nothing is left out.
  const board = fitModel({ ...model, view: { screen: 'sprint', id: 's-big' } });
  const open = board.sprints.find((x) => x.id === 's-big');
  assert.equal(open.tickets[0].tasks.length, 8);
  assert.match(open.tickets[3].findings, /^Findings for PAY-103/);
  assert.ok(!open.brief, 'the open board is whole');
  const rest = board.sprints.find((x) => x.id === 's-two');
  assert.ok(rest.brief, 'a sprint sent as its card says so');
  assert.ok(rest.tickets.every((t) => t.tasks === undefined && t.findings === undefined));
  // Even a tiny budget keeps every sprint card.
  const tight = fitModel({ ...model, view: { screen: 'sprint', id: 's-big' } }, { budget: 20_000 });
  assert.ok(size(tight) <= 20_000, `${size(tight)} characters`);
  assert.deepEqual(tight.sprints.map((x) => x.id), ['s-big', 's-two']);
  // Each card keeps its first rows and says how many more it has (cards alone could be over the budget).
  assert.ok(tight.sprints.every((x) => x.tickets.length + (x.more ?? 0) === 30));
  assert.ok(tight.sprints.every((x) => /^Sprint · (Payouts|Ledger) sprint · 6 of 30 tickets done · 9 needs you/.test(sprintLines(x)[0])));
});

test('a draft sent as its card still says who writes and reviews each ticket', async () => {
  const { sprintCard } = await import('../mod/client.js');
  const { sprintLines } = await import('../mod/view.js');
  const task = (n, agent, reviewer) => ({ n, title: `Task ${n}`, agent, reviewer, status: 'to-do', canAssign: true });
  const draft = { id: 'd1', name: 'Draft', draft: true, discarded: false, paused: false, finishedAt: null, autoMerge: false, maxParallel: 3, news: 0, tickets: [
    { key: 'A-1', title: 'One', state: 'pending', task: 1, of: 2, phase: null, agent: 'codex', reason: null, findings: null, pr: null, reviews: 0, latest: null, tasks: [task(1, 'codex', 'claude'), task(2, 'codex', 'claude')] },
    { key: 'A-2', title: 'Two', state: 'pending', task: 1, of: 2, phase: null, agent: 'codex', reason: null, findings: null, pr: null, reviews: 0, latest: null, tasks: [task(1, 'codex', 'claude'), task(2, 'muse', 'claude')] },
  ] };
  const card = sprintCard(draft);
  assert.equal(card.brief, true);
  assert.ok(card.tickets.every((t) => t.tasks === undefined));
  assert.deepEqual(sprintLines(card), sprintLines(draft));
});

// 15 saved drafts of 30 ordinary tickets each made a model whose sprint cards alone were over the
// budget (about 111,783 characters): fitModel's last resort still sent it, the desktop refused the props and the
// pane went blank or stale. Past the budget each card now keeps a few rows and says how many it left out.
const draftSprint = (id, name, tickets = 30) => ({
  id, name, draft: true, discarded: false, paused: false, finishedAt: null, autoMerge: false, maxParallel: 3, news: 0,
  tickets: Array.from({ length: tickets }, (_, i) => ({
    key: `${id.toUpperCase()}-${100 + i}`, title: `Ticket ${i}: tidy the export screen and keep its totals in step`, state: 'pending',
    task: 1, of: 3, phase: null, agent: 'codex', reason: null, findings: null, pr: null, reviews: 0, latest: null,
    tasks: Array.from({ length: 3 }, (_, n) => ({ n: n + 1, title: `Task ${n + 1}: do the next part of the export`, agent: 'codex', reviewer: 'claude', status: 'to-do', canAssign: true })),
    canRetry: false, giveTo: null, canStop: false,
  })),
});
const qaDrafts = () => Array.from({ length: 15 }, (_, i) => draftSprint(`d${String(i).padStart(2, '0')}`, `Draft sprint ${i}`));

test('fitModel keeps 15 drafts of 30 tickets under the budget: every sprint, as its row on the list, and how many tickets it has', async () => {
  const { sprintLines } = await import('../mod/view.js');
  const drafts = qaDrafts();
  const active = Array.from({ length: 4 }, (_, i) => fjob(`r${i}`, { status: 'running', endedAt: null }));
  const model = paneModelWith([...active, ...finished(60)], { sprints: drafts });
  for (const view of [{ screen: 'list', id: null }, { screen: 'sprint', id: 'd07' }]) {
   // A page of the list's cards at a time; every draft is on a page.
   const sent = new Set();
   for (let page = 0; page < 15; page++) {
    const out = fitModel({ ...model, view, sprintPage: page });
    if (out.sprintPaging.page !== page) break;
    assert.ok(size(out) <= PROPS_BUDGET, `${size(out)} characters on ${view.screen}`);
    assert.deepEqual(out.sprints.map((x) => x.id), drafts.map((x) => x.id).filter((id) => out.sprintPaging.ids.includes(id) || id === view.id), `the page's sprints are sent on ${view.screen}`);
    assert.equal(out.sprintPaging.total, 15);
    assert.ok(!out.hiddenSprints, 'no sprint is left out');
    for (const x of out.sprints) sent.add(x.id);
    for (const x of out.sprints) {
      assert.equal(x.draft, true, 'Start and Discard are offered');
      assert.equal(x.paused, false);
      assert.match(sprintLines(x)[0], /^Sprint · Draft sprint \d+ · draft, not started · 30 tickets$/, 'the headline counts every ticket');
      if (view.screen === 'sprint' && x.id === 'd07') {
        assert.equal(x.tickets.length, 30, 'the open board keeps every row');
        assert.equal(x.tickets[29].tasks.length, 3, 'and its tasks');
        assert.ok(!x.more);
        continue;
      }
      // Sent as its list row (no ticket rows, how many it left out, its status line); the list draws the same.
      assert.equal(x.tickets.length, 0);
      assert.equal(x.more, 30, 'the row says how many tickets it left out');
      assert.equal(x.status, 'Draft · 30 tickets · not started');
      const drawn = listPage(out.sprints, 0, out.sprintPaging).sprints.find((y) => y.id === x.id);
      if (drawn) assert.equal(drawn.tickets.length, 0);
    }
    for (const id of ['r0', 'r1', 'r2', 'r3']) assert.ok(ids(out).has(id), `${id} (at work) kept on ${view.screen}`);
   }
   assert.equal(sent.size, 15, `every draft is on a page on ${view.screen}`);
  }
});

// A page of sprint rows holds about 30 sprints; sent as cards of a few ticket rows each they left no room
// for the jobs at work. The list's sprints go as rows, so every job at work is still sent.
test('fitModel sends the list\'s sprints as rows: 30 drafts of 30 tickets leave room for 50 jobs at work', () => {
  const drafts = Array.from({ length: 30 }, (_, i) => draftSprint(`d${String(i).padStart(2, '0')}`, `Draft sprint ${i}`));
  const active = Array.from({ length: 50 }, (_, i) => fjob(`r${i}`, { status: 'running', endedAt: null }));
  const out = fitModel(paneModelWith(active, { sprints: slimSprints(drafts) }));
  assert.ok(size(out) <= PROPS_BUDGET, `${size(out)} characters`);
  assert.equal(out.hiddenAtWork, 0);
  assert.equal(out.jobs.length, 50);
  assert.ok(out.sprintPaging.ids.length >= 15, `${out.sprintPaging.ids.length} sprints on the page`);
  assert.ok(out.sprints.every((s) => s.tickets.length === 0 && s.more === 30), 'each sprint as its row');
});

// Rows only past the budget. A model that fits sends the page's sprint whole, so a board or a ticket
// opened from the list draws at once from what the Client holds (no "no longer listed" flash before the next sync).
test('fitModel sends the list page\'s sprint whole when the model fits', () => {
  const s = draftSprint('d01', 'Draft sprint 1', 4);
  const out = fitModel(paneModelWith(finished(3), { sprints: [s] }));
  assert.equal(out.hiddenJobs, 0);
  assert.deepEqual(out.sprints.map((x) => x.id), ['d01']);
  assert.equal(out.sprints[0].tickets.length, 4, 'its tickets are sent');
  assert.ok(!out.sprints[0].brief, 'not as its card or row');
  assert.equal(out.sprints[0].tickets[0].tasks.length, 3);
});

test('fitModel keeps a capped card\'s parked and running rows first, and the open row of a capped board', () => {
  const s = bigSprint('s-big', 'Payouts sprint');
  const many = [s, ...Array.from({ length: 30 }, (_, i) => bigSprint(`s${i}`, `Sprint ${i}`))];
  const out = fitModel(paneModelWith([], { sprints: many, view: { screen: 'sprint', id: 's-big' }, board: { sprint: 's-big', open: 'PAY-129', confirm: null, picking: null } }), { budget: 30_000 });
  assert.ok(size(out) <= 30_000, `${size(out)} characters`);
  const board = out.sprints.find((x) => x.id === 's-big');
  assert.ok(board, 'the open board\'s sprint is kept');
  assert.ok(board.more > 0, 'its rows are capped too when it alone breaks the budget');
  assert.ok(board.tickets.some((t) => t.key === 'PAY-129'), 'the open row stays');
  const card = out.sprints.find((x) => x.id !== 's-big');
  assert.ok(card.tickets.every((t) => ['running', 'parked'].includes(t.state)), card.tickets.map((t) => t.state).join());
});

test('fitModel leaves out whole sprints only when even capped cards do not fit, and says how many', () => {
  const many = Array.from({ length: 400 }, (_, i) => ({ ...bigSprint(`s${String(i).padStart(3, '0')}`, `Sprint ${i}`), tickets: bigSprint('x', 'x').tickets.map((t, n) => ({ ...t, state: i % 5 === 0 && n === 0 ? 'running' : 'pending' })) }));
  // The list's page is sent, with the open board's sprint: a budget too small even for those.
  const out = fitModel(paneModelWith(finished(20), { sprints: many, view: { screen: 'sprint', id: 's123' } }), { budget: 10_000 });
  assert.ok(size(out) <= 10_000, `${size(out)} characters`);
  assert.ok(out.hiddenSprints > 0, 'some sprints are left out');
  assert.equal(out.sprints.length + out.hiddenSprints, new Set([...out.sprintPaging.ids, 's123']).size, 'the rest of the page are counted');
  assert.equal(out.sprintPaging.total, 400, 'and the other pages');
  assert.ok(out.sprints.some((x) => x.id === 's123'), 'the open board\'s sprint first');
  // Then those with a ticket running, newest first (80 of them: more than fit).
  const running = many.filter((x) => x.tickets[0].state === 'running').map((x) => x.id).reverse();
  const kept = out.sprints.map((x) => x.id).filter((id) => id !== 's123');
  assert.deepEqual([...kept].sort().reverse(), running.slice(0, kept.length), 'then the newest running ones');
  const order = out.sprints.map((x) => x.id);
  assert.deepEqual(order, [...order].sort(), 'drawn in the order Podium lists them');
});

test('fitModel never returns a model over its budget, whatever the sizes', () => {
  for (const sprintsN of [0, 1, 15, 60, 300]) {
    for (const ticketsN of [1, 30, 120]) {
      for (const jobsN of [0, 300]) {
        const sprints = Array.from({ length: sprintsN }, (_, i) => (i % 2 ? bigSprint(`s${i}`, `Sprint ${i} ${'n'.repeat(i % 7 ? 10 : 500)}`, ticketsN) : draftSprint(`d${i}`, `Draft ${i}`, ticketsN)));
        const jobs = [...finished(jobsN), ...Array.from({ length: Math.floor(jobsN / 10) }, (_, i) => fjob(`r${i}`, { status: 'running', endedAt: null, title: `Run ${i} ${'x'.repeat(2000)}` }))];
        for (const view of [{ screen: 'list', id: null }, { screen: 'sprint', id: sprints[0]?.id ?? null }, { screen: 'detail', id: 'r1' }]) {
          for (const budget of [PROPS_BUDGET, 20_000, 4_000]) {
            const out = fitModel(paneModelWith(jobs, { sprints, view }), { budget });
            const at = `${sprintsN} sprints × ${ticketsN} tickets, ${jobsN} jobs, ${view.screen}, budget ${budget}`;
            assert.ok(size(out) <= budget, `${size(out)} characters: ${at}`);
            // The list's page (and the open board's sprint) shown or counted; the other pages counted.
            const page = new Set([...out.sprintPaging.ids, ...(view.screen === 'sprint' && view.id ? [view.id] : [])]);
            assert.equal(out.sprints.length + (out.hiddenSprints ?? 0), page.size, `every sprint on the page shown or counted: ${at}`);
            assert.equal(out.sprintPaging.total, sprintsN, `every sprint counted: ${at}`);
          }
        }
      }
    }
  }
});

// ---- The list's sprint cards, a page at a time ----
// 60 saved drafts fit the model's budget, but 60 cards drawn were past the desktop page's bounds: the list drew the
// "couldn't draw" note, and its Back led to the same list.
const sixty = () => Array.from({ length: 60 }, (_, i) => draftSprint(`d${String(i).padStart(2, '0')}`, `Draft sprint ${i}`, 4));
const liveSprint = (id, state) => ({ ...bigSprint(id, `Sprint ${id}`, 3), tickets: bigSprint(id, 'x', 3).tickets.map((t) => ({ ...t, state })) });

test('sprintOrder puts running sprints first, then those that need you, then the rest newest first', () => {
  const list = [draftSprint('d01', 'a', 1), liveSprint('a-parked', 'parked'), draftSprint('d03', 'b', 1), liveSprint('a-run', 'running'), draftSprint('d02', 'c', 1)];
  assert.deepEqual(sprintOrder(list).map((i) => list[i].id), ['a-run', 'a-parked', 'd03', 'd02', 'd01']);
  assert.deepEqual(sprintOrder(list, 'd01').map((i) => list[i].id), ['d01', 'a-run', 'a-parked', 'd03', 'd02'], 'the open board\'s first when asked');
});

test('listPage cuts 60 drafts into pages inside the page budget, each draft on exactly one, and clamps the page', () => {
  const drafts = sixty();
  const first = listPage(drafts, 0);
  assert.ok(first.pages > 1);
  assert.equal(first.total, 60);
  assert.equal(first.from, 1);
  assert.equal(first.sprints[0].id, 'd59', 'newest first');
  const seen = [];
  for (let page = 0; page < first.pages; page++) {
    const at = listPage(drafts, page);
    assert.equal(at.page, page);
    assert.equal(at.from, seen.length + 1);
    assert.equal(at.to, seen.length + at.sprints.length);
    const cost = at.sprints.map(cardCost).reduce((n, c) => ({ nodes: n.nodes + c.nodes, chars: n.chars + c.chars }), { nodes: 0, chars: 0 });
    assert.ok(cost.nodes <= SPRINT_PAGE_NODES && cost.chars <= SPRINT_PAGE_CHARS, JSON.stringify(cost));
    seen.push(...at.sprints.map((s) => s.id));
  }
  assert.deepEqual([...seen].sort(), drafts.map((s) => s.id).sort());
  assert.equal(listPage(drafts, 999).page, first.pages - 1, 'past the end: the last page');
  assert.equal(listPage(drafts, -3).page, 0);
  assert.deepEqual(listPage([], 0), { sprints: [], page: 0, pages: 0, from: 1, to: 0, total: 0 });
});

test('a card alone always fits a page, however many rows and however long its lines', () => {
  const s = { ...draftSprint('dlong', 'n'.repeat(5000), 500), tickets: draftSprint('dlong', 'x', 500).tickets.map((t) => ({ ...t, title: 't'.repeat(5000) })) };
  const page = listPage([s], 0);
  assert.equal(page.sprints[0].tickets.length, LIST_ROWS);
  assert.equal(page.sprints[0].more, 500 - LIST_ROWS);
  const c = cardCost(page.sprints[0]);
  assert.ok(c.nodes < SPRINT_PAGE_NODES && c.chars < SPRINT_PAGE_CHARS, JSON.stringify(c));
});

test('on desktop fitModel sends the list\'s page of sprints, so 60 drafts leave room for the jobs at work', () => {
  const run = liveSprint('a-run', 'running');
  const active = Array.from({ length: 5 }, (_, i) => fjob(`r${i}`, { status: 'running', endedAt: null }));
  const model = paneModelWith([...active, ...finished(20)], { sprints: slimSprints([...sixty(), run]) });
  const out = fitModel(model);
  assert.ok(size(out) <= PROPS_BUDGET);
  for (const id of ['r0', 'r1', 'r2', 'r3', 'r4']) assert.ok(ids(out).has(id), `${id} (at work) kept`);
  assert.equal(out.hiddenJobs, 0);
  assert.equal(out.sprintPaging.total, 61);
  assert.equal(out.sprintPaging.ids[0], 'a-run', 'the running sprint first');
  assert.deepEqual(out.sprints.map((s) => s.id).sort(), [...out.sprintPaging.ids].sort());
  // The list draws what fitModel paged: the same sprints, a card's rows at most.
  assert.deepEqual(listPage(out.sprints, 0, out.sprintPaging).sprints.map((s) => s.id), out.sprintPaging.ids);
  // Another page; the open board's sprint is sent beside it.
  const last = fitModel({ ...model, sprintPage: out.sprintPaging.pages - 1, view: { screen: 'sprint', id: 'd30' } });
  assert.equal(last.sprintPaging.to, 61);
  assert.ok(last.sprintPaging.ids.includes('d00'));
  assert.ok(last.sprints.some((s) => s.id === 'd30' && !s.brief), 'the board\'s sprint, whole');
  assert.ok(!listPage(last.sprints, 0, last.sprintPaging).sprints.some((s) => s.id === 'd30'), 'but not drawn on that page of the list');
});

test('safeList is always the list: the header and the page of sprint cards, no job cards, and it says so', () => {
  const active = Array.from({ length: 3 }, (_, i) => fjob(`r${i}`, { status: 'running', endedAt: null }));
  const model = fitModel(paneModelWith([...active, ...finished(4)], { sprints: slimSprints([...sixty(), bigSprint('s-big', 'Payouts', 30)]), view: { screen: 'sprint', id: 's-big' }, notice: 'Saved.' }));
  const short = safeList(model);
  assert.deepEqual(short.view, { screen: 'list', id: null });
  assert.deepEqual(short.jobs, []);
  assert.equal(short.hiddenJobs, 7);
  assert.equal(short.hiddenAtWork, 3);
  assert.equal(short.notice, `Saved.\n${LIST_TOO_LONG}`);
  assert.equal(short.askFor, null);
  assert.ok(short.sprints.every((s) => s.tickets.length <= CARD_ROWS));
  assert.match(sprintLinesOf(short.sprints.find((s) => s.id === 's-big'))[0], /^Sprint · Payouts · 6 of 30 tickets done · 9 needs you/, 'a capped card keeps its headline');
  assert.deepEqual(short.sprintPaging, model.sprintPaging, 'the same page');
  assert.equal(safeList({ ...model, notice: null }).notice, LIST_TOO_LONG);
});

test('Show more sprints sets a value: a newer press replaces an unsent one', () => {
  assert.ok(EDIT_ACTIONS.has('showSprints'));
  const box = enqueue(enqueue([], { id: '1', name: 'showSprints', args: [1] }), { id: '2', name: 'showSprints', args: [2] });
  assert.deepEqual(box.map((m) => m.args[0]), [2]);
});

// A plan's task list rides on its row; the props budget must hold however long the plan is.
test('slimSprints sends a waiting plan\'s first 30 task titles, cut short, and how many more; cards carry what plan rows read', async () => {
  const { slimSprints, sprintCard } = await import('../mod/client.js');
  const proposed = Array.from({ length: 40 }, (_, i) => ({ n: i + 1, title: `Task ${i + 1} ${'y'.repeat(200)}` }));
  const s = { id: 's1', name: 'Oct', draft: false, discarded: false, paused: false, finishedAt: null, autoMerge: false, maxParallel: 3, news: 0, tickets: [
    { key: 'ABC-14', title: 'Export', state: 'plan-ready', task: 0, of: 0, phase: null, agent: 'codex', reason: null, findings: null, pr: null, reviews: 0, latest: 'j1', tasks: [],
      plan: 'docs/p.md', writer: 'codex', reviewer: 'claude', proposed, canApprove: true, canRevise: true, canOneTask: false, canAssignPlan: true, after: [], waitingOn: [] },
  ] };
  const [slim] = slimSprints([s], { sprint: 's1', open: 'ABC-14' });
  assert.equal(slim.tickets[0].proposed.length, 30);
  assert.equal(slim.tickets[0].proposedMore, 10);
  assert.ok(slim.tickets[0].proposed.every((x) => x.title.length <= 80));
  const card = sprintCard(slim).tickets[0];
  assert.equal(card.proposed, undefined, 'only the open board draws the tasks');
  assert.deepEqual([card.plan, card.writer, card.reviewer, card.canApprove, card.canRevise, card.canOneTask, card.canAssignPlan], ['docs/p.md', 'codex', 'claude', true, true, false, true]);
  assert.deepEqual([card.after, card.waitingOn], [[], []]);
});

test('a sprint with a plan waiting comes before quieter ones, and its row is kept on a capped card', async () => {
  const { sprintOrder, capRows } = await import('../mod/client.js');
  const t = (key, state) => ({ key, title: key, state, task: 1, of: 1, phase: null, agent: 'codex', reason: null, pr: null, reviews: 0 });
  const quiet = { id: 's9', tickets: [t('A-1', 'pending')] };
  const waiting = { id: 's1', tickets: [t('B-1', 'plan-ready')] };
  assert.deepEqual(sprintOrder([quiet, waiting]), [1, 0]);
  const many = { id: 's2', tickets: [...Array.from({ length: 6 }, (_, i) => t(`C-${i}`, 'pending')), t('C-9', 'no-tasks')] };
  assert.ok(capRows(many, 5).tickets.some((x) => x.key === 'C-9'));
});

// The list's capped cards (fitModel past the budget) keep the plan fields their rows read, and a
// plan's long task list never takes the model over the budget.
test('fitModel keeps a capped card\'s plan rows and holds the budget with long plans waiting', () => {
  const proposed = Array.from({ length: 200 }, (_, i) => ({ n: i + 1, title: `Task ${i + 1} ${'z'.repeat(400)}` }));
  const ticket = (key, over = {}) => ({ key, title: `${key} ${'t'.repeat(300)}`, state: 'pending', task: 1, of: 1, phase: null, agent: 'codex', reason: null, findings: null, pr: null, reviews: 0, latest: null, tasks: [], after: [], waitingOn: [], ...over });
  const sprint = (i) => ({
    id: `s${String(i).padStart(3, '0')}`, name: `Sprint ${i}`, draft: false, discarded: false, paused: false, finishedAt: null, autoMerge: false, maxParallel: 3, news: 0,
    tickets: [
      ...Array.from({ length: 8 }, (_, k) => ticket(`Q-${i}-${k}`)),
      ticket(`P-${i}`, { state: 'plan-ready', plan: `docs/${'p'.repeat(300)}.md`, writer: 'codex', reviewer: 'claude', proposed, canApprove: true, canRevise: true, canOneTask: false, canAssignPlan: true }),
      ticket(`N-${i}`, { state: 'no-tasks', reason: "Couldn't find tasks in this plan", canOneTask: true, canRevise: true }),
    ],
  });
  const sprints = slimSprints(Array.from({ length: 12 }, (_, i) => sprint(i)), { sprint: 's000', open: 'P-0' });
  // The open board's plan goes whole but slim: 30 titles of at most 80 characters, and how many more.
  const board = sprints[0].tickets.find((t) => t.key === 'P-0');
  assert.equal(board.proposed.length, 30);
  assert.equal(board.proposedMore, 170);
  for (const [view, budget] of [[{ screen: 'list', id: null }, 6_000], [{ screen: 'sprint', id: 's000' }, 20_000], [{ screen: 'list', id: null }, PROPS_BUDGET]]) {
    const out = fitModel(paneModelWith(finished(50), { sprints, view }), { budget });
    assert.ok(size(out) <= budget, `${size(out)} characters on ${view.screen}`);
    const cards = out.sprints.filter((s) => s.brief && !s.unreadable);
    assert.ok(cards.length > 0, `some sprint goes as its card on ${view.screen} (budget ${budget})`);
    for (const s of cards) {
      const lines = sprintLinesOf(s);
      assert.match(lines[0], /2 needs you/);
      if (s.tickets.length) {
        assert.ok(lines.some((l) => /Plan ready: approve\?$/.test(l)), lines.join('\n'));
        assert.ok(lines.some((l) => /✋ Couldn't find tasks in this plan$/.test(l)), lines.join('\n'));
      } else {
        // The list's sprints go as rows (no tickets), counted over every ticket.
        assert.equal(s.more, 10, 'a row says how many tickets it left out');
      }
      for (const t of s.tickets) assert.equal(t.proposed, undefined, 'a card never carries the plan\'s tasks');
    }
    for (const s of out.sprints) for (const t of s.tickets ?? []) assert.ok((t.proposed?.length ?? 0) <= 30);
  }
  // A capped card (fitModel's later fallbacks, safeList) keeps the plan rows first.
  const capped = sprintLinesOf(capRows(sprintCard(sprints[1]), CARD_ROWS));
  assert.ok(capped.some((l) => /Plan ready: approve\?$/.test(l)), capped.join('\n'));
  assert.ok(capped.some((l) => /✋ Couldn't find tasks in this plan$/.test(l)), capped.join('\n'));
});

test('a card says what a ticket waits for, however it is capped', async () => {
  const { sprintCard } = await import('../mod/client.js');
  const t = (key, over = {}) => ({ key, title: key, state: 'pending', task: 1, of: 1, phase: null, agent: 'codex', reason: null, pr: null, reviews: 0, ...over });
  const s = { id: 's1', name: 'Oct', paused: false, finishedAt: null, autoMerge: false, tickets: [t('A-1', { state: 'running', phase: 'plan' }), t('A-2', { after: ['A-1'], waitingOn: ['A-1'] })] };
  assert.deepEqual(sprintLinesOf(capRows(sprintCard(s, 8), 5)), sprintLinesOf(s));
  assert.equal(sprintLinesOf(sprintCard(s, 8))[2], 'A-2  A-2  waiting (after A-1)');
});

// Cards with plans are larger, so fitModel caps the open board sooner; safeList then makes that capped board a card.
test('a capped sprint made a card keeps its headline, how many rows it left out, and each row\'s place', async () => {
  const { sprintCard } = await import('../mod/client.js');
  const s = bigSprint('s-big', 'Payouts', 30);
  const capped = capRows(s, CARD_ROWS);
  const card = sprintCard(capped, 40);
  assert.equal(card.more, 25);
  assert.match(sprintLinesOf(card)[0], /^Sprint · Payouts · 6 of 30 tickets done · 9 needs you/);
  assert.deepEqual(card.tickets.map((t) => t.pos), capped.tickets.map((t) => t.pos));
  assert.deepEqual(sprintLinesOf(safeList({ sprints: [capped], jobs: [] }).sprints[0])[0], sprintLinesOf(capped)[0]);
});

// The page refuses a Client whose props hold undefined (the kit caught it): a ticket summary without the plan fields
// (an older engine, a card made from a card) still makes a card with none.
test('a card from a ticket without plan fields holds no undefined', async () => {
  const { sprintCard } = await import('../mod/client.js');
  const holes = (v, at = '') => (v === undefined ? [at] : v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => holes(x, `${at}.${k}`)) : []);
  const t = { key: 'A-1', title: 'A', state: 'pending', task: 1, of: 1, phase: null, agent: 'codex', reason: null, pr: null, reviews: 0, latest: null, canRetry: false, giveTo: null, canStop: true };
  const card = sprintCard({ id: 's1', name: 'Oct', draft: false, discarded: false, paused: false, finishedAt: null, autoMerge: false, maxParallel: 3, news: 0, tickets: [t] });
  assert.deepEqual(holes(card), []);
  assert.deepEqual(holes(sprintCard(card)), []);
});

test('typing the notes for a plan is a set-a-value press', async () => {
  const { EDIT_ACTIONS } = await import('../mod/client.js');
  assert.ok(EDIT_ACTIONS.has('editNote'));
});

// Only the open row draws a plan's task titles, so only it gets them in the props.
test("slimSprints sends a plan's task titles only for the open board's open row, and fitModel keeps them there", () => {
  const proposed = Array.from({ length: 30 }, (_, i) => ({ n: i + 1, title: `Task ${i + 1} ${'w'.repeat(60)}` }));
  const ticket = (key) => ({ key, title: key, state: 'plan-ready', task: 0, of: 0, phase: null, agent: 'codex', reason: null, findings: null, pr: null, reviews: 0, latest: 'j1', tasks: [],
    plan: 'docs/p.md', writer: 'codex', reviewer: 'claude', proposed, canApprove: true, canRevise: true, canOneTask: false, canAssignPlan: true, after: [], waitingOn: [] });
  const sprint = (id) => ({ id, name: id, draft: false, discarded: false, paused: false, finishedAt: null, autoMerge: false, maxParallel: 3, news: 0, tickets: Array.from({ length: 30 }, (_, i) => ticket(`P-${i}`)) });
  const list = [sprint('s1'), sprint('s2')];
  const sent = (out) => out.flatMap((s) => s.tickets.filter((t) => t.proposed).map((t) => `${s.id}:${t.key}`));
  assert.deepEqual(sent(slimSprints(list)), [], 'no row open: no titles');
  assert.deepEqual(sent(slimSprints(list, { sprint: 's1', open: null })), []);
  const board = { sprint: 's1', open: 'P-7', confirm: null, picking: null };
  const slim = slimSprints(list, board);
  assert.deepEqual(sent(slim), ['s1:P-7']);
  assert.equal(slim[0].tickets[7].proposed.length, 30);
  assert.ok(size(slim) < size(slimSprints(list.map((s) => ({ ...s, tickets: s.tickets.map((t) => ({ ...t, proposed: null })) })))) + 4000, "only one row's titles");
  const out = fitModel(paneModelWith([], { sprints: slim, board, view: { screen: 'sprint', id: 's1' } }));
  assert.deepEqual(sent(out.sprints), ['s1:P-7']);
  assert.equal(out.sprints.find((s) => s.id === 's1').tickets.find((t) => t.key === 'P-7').proposed.length, 30);
});

test('wordsDrawn counts the words a drawing shows: texts, button labels and an input\'s label and placeholder', () => {
  const tree = {
    type: 'Box', props: {}, children: [
      { type: 'Text', props: { color: 'inactive' }, children: ['Codex finished 2m ago · changes to review'] },
      { type: 'Button', props: { key: 'keep', label: ' Keep changes ' } },
      { type: 'Button', props: { key: 'open-j1', label: 'Add tests ›' } },
      { type: 'Input', props: { key: 'task', label: 'What should it do?', placeholder: 'e.g. add a dark mode', value: 'not counted' } },
      { type: 'Box', props: {}, children: [{ type: 'Text', props: {}, children: ['▸', ' ', '✓ 3'] }] },
    ],
  };
  // "Codex finished 2m ago changes to review" (7; "·" has no letter) + "Keep changes" (2) + "Add tests" (2; "›" is not a word)
  // + "What should it do?" (4) + "e.g. add a dark mode" (5) + "3" (1; "▸" and "✓" are not words)
  assert.equal(wordsDrawn(tree), 21);
  assert.equal(wordsDrawn(null), 0);
});

test('turnTickets lists every sprint ticket waiting on the person, across all sprints, capped with a count', () => {
  const t = (key, state, reason = null) => ({ key, title: `${key} title`, state, task: 1, of: 1, phase: null, agent: 'codex', reason, pr: null, reviews: 0 });
  const live = { id: 's1', name: 'Oct week 2', paused: false, finishedAt: null, autoMerge: false, news: 0, tickets: [t('A-1', 'running'), t('A-2', 'parked', 'Review failed twice on task 1'), t('A-3', 'plan-ready')] };
  const draft = { ...live, id: 's2', draft: true, tickets: [t('B-1', 'parked', 'x')] };
  const ended = { ...live, id: 's3', tickets: [t('C-1', 'merged')] };
  const broken = { id: 's4', name: null, unreadable: 'damaged', tickets: [] };
  const out = turnTickets([live, draft, ended, broken]);
  assert.deepEqual(out, { more: 0, tickets: [
    { sprint: 's1', sprintName: 'Oct week 2', key: 'A-2', title: 'A-2 title', state: 'parked', reason: 'Review failed twice on task 1' },
    { sprint: 's1', sprintName: 'Oct week 2', key: 'A-3', title: 'A-3 title', state: 'plan-ready', reason: '' },
  ] });
  const many = { ...live, tickets: Array.from({ length: TURN_TICKETS + 3 }, (_, i) => t(`M-${i}`, 'plan-ready')) };
  const capped = turnTickets([many]);
  assert.equal(capped.tickets.length, TURN_TICKETS);
  assert.equal(capped.more, 3);
  assert.deepEqual(turnTickets(undefined), { tickets: [], more: 0 });
});

test('opening an agent and sending a PR fix are navigation; a fold toggle never shows "Working…"; a job\'s question is an edit', () => {
  assert.ok(NAV_ACTIONS.has('openAgent') && NAV_ACTIONS.has('fixOpen'));
  assert.deepEqual(overlayFor('openAgent', ['codex']), { screen: 'agent', id: 'codex' });
  assert.deepEqual(overlayFor('fixOpen', ['t1', 'j3', 'codex', 'ci']), { screen: 'detail', id: 'j3' });
  assert.ok(QUIET_ACTIONS.has('toggleFold') && !EDIT_ACTIONS.has('toggleFold'), 'two different folds pressed quickly must both arrive');
  assert.ok(EDIT_ACTIONS.has('confirmJob'));
});

test('the smallest model the desktop is sent still has the fold state and Your turn', () => {
  const big = { view: { screen: 'list', id: null }, notice: null, jobs: [], live: {}, detail: null, agents: [], agentsLoaded: true, settings: null,
    draft: { agent: 'codex', task: '', permission: 'edit-worktree', includeUncommitted: false, model: '', ticket: '', base: '' }, draftAdapter: null,
    palette: 'dark', folds: ['list:done'], askFor: null, cleared: null, showAllDone: false, checks: null, whatsNew: null, removing: null,
    session: null, acked: [], seen: [], turn: { tickets: [{ sprint: 's1', sprintName: 'S', key: 'A-1', title: 'A-1 t', state: 'parked', reason: 'r' }], more: 0 },
    sprints: Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, name: `Sprint ${i} ${'n'.repeat(200)}`, paused: false, finishedAt: null, autoMerge: false, news: 0,
      tickets: Array.from({ length: 30 }, (_, k) => ({ key: `K-${k}`, title: 't'.repeat(200), state: 'pending', task: 1, of: 1, phase: null, agent: 'codex', reason: null, pr: null, reviews: 0 })) })) };
  const out = fitModel(big, { budget: 3000 });
  assert.ok(JSON.stringify(out).length <= 3000);
  assert.ok(Array.isArray(out.folds));
  assert.ok(out.turn && Array.isArray(out.turn.tickets));
});

test('a capped sprint keeps its status line counted over every ticket', () => {
  const t = (key, state) => ({ key, title: key, state, task: 1, of: 1, phase: null, agent: 'codex', reason: null, pr: state === 'merged' ? { number: 1 } : null, reviews: 0 });
  const s = { id: 's1', name: 'S', paused: false, finishedAt: null, autoMerge: false, news: 0, tickets: [t('A-1', 'merged'), t('A-2', 'merged'), ...Array.from({ length: 8 }, (_, i) => t(`B-${i}`, 'pending'))] };
  const capped = capRows(s, 3);
  assert.equal(capped.tickets.length, 3);
  assert.equal(capped.status, '2 of 10 done');
  assert.equal(sprintCard(capped).status, '2 of 10 done');
});

test('a capped sprint keeps its colour counted over every ticket, and a card carries it', () => {
  const t = (key, state) => ({ key, title: key, state, task: 1, of: 1, phase: null, agent: 'codex', reason: null, pr: null, reviews: 0 });
  const s = { id: 's1', name: 'S', paused: false, finishedAt: null, autoMerge: false, news: 0, tickets: [...Array.from({ length: 8 }, (_, i) => t(`B-${i}`, 'pending')), t('C-1', 'parked')] };
  const row = capRows(sprintCard(s), 0);
  assert.equal(row.tickets.length, 0);
  assert.equal(row.tone, 'needs');
  assert.equal(capRows(s, 3).tone, 'needs');
  assert.equal(sprintCard(capRows(s, 3)).tone, 'needs');
  assert.equal(capRows({ ...s, tickets: s.tickets.slice(0, 8) }, 3).tone, 'neutral');
});

// Every reduced form of a sprint keeps `archived`, so a board opened from a row never treats an
// archived sprint as live (Take them here reads it) before the board's whole sprint arrives.
test('an archived sprint stays archived as a card, a row, a capped card, the short list\'s card and the smallest model\'s', () => {
  const t = (key) => ({ key, title: key, state: 'merged', task: 1, of: 1, phase: null, agent: 'codex', reason: null, pr: { number: 1 }, reviews: 0 });
  const s = { id: 's1', name: 'Done sprint', draft: false, discarded: false, paused: false, finishedAt: at(5), autoMerge: false, news: 2, chat: 'chat-2', archived: true, tickets: Array.from({ length: 8 }, (_, i) => t(`A-${i}`)) };
  assert.equal(sprintCard(s).archived, true);
  assert.equal(capRows(sprintCard(s), 0).archived, true);
  assert.equal(capRows(s, 3).archived, true);
  assert.equal(capRows(sprintCard(s), CARD_ROWS).archived, true);
  assert.equal(sprintCard({ ...s, archived: false }).archived, undefined, 'only when archived');
  const model = paneModelWith(finished(3), { sprints: [s] });
  assert.equal(fitModel(model).sprints[0].archived, true, 'as the row fitModel sends');
  assert.equal(fitModel(paneModelWith(finished(500), { sprints: [s] })).sprints[0].archived, true, 'past the budget');
  assert.ok(safeList(fitModel(model)).sprints.every((x) => x.archived === true), 'the short list');
  const tiny = fitModel(paneModelWith(finished(50), { sprints: [s], turn: { tickets: [], more: 0 } }), { budget: 1_500 });
  assert.ok(tiny.sprints.every((x) => x.archived === true), 'the smallest model');
});

// ---- Finished sprints in Done and Other chats ----
const endedSprint = (id, chat, minute, states = ['merged', 'merged'], name = `Finished ${id}`) => ({
  id, name, draft: false, discarded: false, paused: false, finishedAt: at(minute), autoMerge: false, maxParallel: 1, news: 0, chat,
  tickets: states.map((state, i) => ({
    key: `${id.toUpperCase()}-${i}`, title: `Ticket ${i} of ${id}: round the payouts and keep the ledger in step`, state, task: 3, of: 3, phase: null, agent: 'codex',
    reason: null, findings: null, pr: state === 'stopped' ? null : { number: 100 + i, url: `https://github.com/o/r/pull/${100 + i}` }, reviews: 2, latest: `${id}-${i}-a3`,
    tasks: Array.from({ length: 3 }, (_, n) => ({ n: n + 1, title: `Task ${n + 1}: the next part`, agent: 'codex', reviewer: 'claude', status: 'done', canAssign: false })),
    canRetry: false, giveTo: null, canStop: false,
  })),
});
const sortedIds = (list) => list.map((s) => s.id).sort();

test('fitModel sends finished sprints as rows, at most FINISHED_SPRINTS per fold, with their tone, and counts the older ones', () => {
  const mine = Array.from({ length: 7 }, (_, i) => endedSprint(`m${i}`, 'chat-1', i * 10, i === 6 ? ['merged', 'stopped'] : ['merged', 'merged']));
  const others = Array.from({ length: 6 }, (_, i) => endedSprint(`o${i}`, 'chat-2', i * 10 + 1, i === 5 ? ['merged', 'closed'] : ['merged']));
  const running = { ...endedSprint('r1', 'chat-2', 0, ['running', 'pending']), finishedAt: null };
  const out = fitModel(paneModelWith(finished(3), { sprints: slimSprints([...mine, ...others, running]) }));
  assert.ok(size(out) <= PROPS_BUDGET);
  const rows = out.sprints.filter((s) => s.id !== 'r1');
  assert.deepEqual(sortedIds(rows.filter((s) => s.chat === 'chat-1')), ['m2', 'm3', 'm4', 'm5', 'm6'], "this chat's newest five");
  assert.deepEqual(sortedIds(rows.filter((s) => s.chat === 'chat-2')), ['o1', 'o2', 'o3', 'o4', 'o5'], "other chats' newest five");
  for (const s of rows) {
    assert.equal(s.tickets.length, 0, `${s.id} as its row`);
    assert.ok(s.brief && s.ended === true && s.more > 0, `${s.id} carries that it ended`);
    assert.equal(typeof s.status, 'string');
  }
  assert.equal(rows.find((s) => s.id === 'm6').tone, 'failed', 'a stopped ticket');
  assert.equal(rows.find((s) => s.id === 'o5').tone, 'failed', 'a closed PR');
  assert.equal(rows.find((s) => s.id === 'm5').tone, 'done');
  assert.equal(rows.find((s) => s.id === 'm6').status, '1 of 2 done · 1 stopped');
  assert.deepEqual(out.olderSprints, { mine: 2, others: 1 });
  assert.equal(out.sprints.find((s) => s.id === 'r1').tickets.length, 2, 'a running sprint on the list page is sent whole');
  // No finished sprints: no count is sent.
  assert.equal('olderSprints' in fitModel(paneModelWith(finished(3), { sprints: slimSprints([running]) })), false);
});

test("fitModel keeps an open finished sprint's board whole, even when it is older than the list shows or the model is full", () => {
  const mine = Array.from({ length: 7 }, (_, i) => endedSprint(`m${i}`, 'chat-1', i * 10));
  const view = { screen: 'sprint', id: 'm0' };
  const board = { sprint: 'm0', open: null, confirm: null, picking: null };
  const out = fitModel(paneModelWith(finished(3), { sprints: slimSprints(mine, board), view, board }));
  const m0 = out.sprints.find((s) => s.id === 'm0');
  assert.ok(m0 && !m0.brief, 'whole, not a row');
  assert.equal(m0.tickets.length, 2);
  assert.equal(m0.tickets[0].tasks.length, 3);
  assert.deepEqual(out.olderSprints, { mine: 1, others: 0 }, 'm1 only: m0 is sent');
  // Past the budget too.
  const full = fitModel(paneModelWith(finished(500), { sprints: slimSprints(mine, board), view, board }));
  assert.ok(size(full) <= PROPS_BUDGET);
  const kept = full.sprints.find((s) => s.id === 'm0');
  assert.ok(kept && !kept.brief && kept.tickets.length === 2, 'the board is whole past the budget');
  // A ticket screen of a finished sprint too.
  const ticket = fitModel(paneModelWith(finished(500), { sprints: slimSprints(mine, { ...board, open: 'M0-1' }), view: { screen: 'ticket', id: 'm0', key: 'M0-1' }, board: { ...board, open: 'M0-1' } }));
  assert.equal(ticket.sprints.find((s) => s.id === 'm0').tickets.length, 2);
});

test('with many finished sprints and a full model, fitModel stays under the budget and keeps them after the finished jobs', () => {
  const now = Date.parse('2026-10-07T12:00:00Z');
  const mineJobs = Array.from({ length: 8 }, (_, i) => fjob(`m${i}`, { createdAt: at(i * 10), startedAt: at(i * 10), endedAt: at(i * 10 + 5) }));
  const otherJobs = Array.from({ length: 300 }, (_, i) => fjob(`x${i}`, { origin: { session: 'chat-2' }, createdAt: at(5000 + i * 10), startedAt: at(5000 + i * 10), endedAt: at(5005 + i * 10) }));
  const long = 'a long sprint name '.repeat(20);
  const sprints = slimSprints([
    ...Array.from({ length: 40 }, (_, i) => endedSprint(`fm${String(i).padStart(2, '0')}`, 'chat-1', i, ['merged', 'merged', 'stopped'], `${long}${i}`)),
    ...Array.from({ length: 40 }, (_, i) => endedSprint(`fo${String(i).padStart(2, '0')}`, 'chat-2', i, ['merged'], `${long}${i}`)),
  ]);
  const model = paneModelWith([...mineJobs, ...otherJobs], { sprints });
  const out = fitModel(model, { now });
  assert.ok(size(out) <= PROPS_BUDGET, `${size(out)} characters`);
  assert.deepEqual(doneLane(out, now), doneLane(model, now), "this chat's Done lane comes first");
  assert.deepEqual(othersLane(out, now), othersLane(model, now), "then other chats' finished jobs");
  const rows = (chat) => out.sprints.filter((s) => s.chat === chat);
  assert.equal(rows('chat-1').length, 5);
  assert.equal(rows('chat-2').length, 5);
  assert.ok(out.sprints.every((s) => s.tickets.length === 0));
  assert.deepEqual(out.olderSprints, { mine: 35, others: 35 });
  for (const budget of [40_000, 20_000, 8_000, 4_000]) {
    const tight = fitModel(model, { now, budget });
    assert.ok(size(tight) <= budget, `${size(tight)} characters for a budget of ${budget}`);
    const kept = (chat) => tight.sprints.filter((s) => s.chat === chat).length;
    assert.ok(kept('chat-1') <= 5 && kept('chat-2') <= 5, `at most five a fold at ${budget}`);
    if (tight.olderSprints) assert.equal(tight.olderSprints.mine + kept('chat-1') + tight.olderSprints.others + kept('chat-2') + (tight.hiddenSprints ?? 0), 80, `every finished sprint shown or counted at ${budget}`);
  }
});
