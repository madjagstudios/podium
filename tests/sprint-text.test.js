import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTasks, verdictOf, isUsageLimit, ticketBranch, authorPrompt, fixPrompt, reviewerPrompt, DIFF_LIMIT, planPath, planPrompt, revisePrompt, planNews, ticketPrBody, testsOf, testsParkReason, TESTS_LINE, checkFixPrompt } from '../engine/sprint-text.js';

const PLAN = [
  '# Thing Implementation Plan', '', 'Intro.', '',
  '### Task 1: Add a.txt', '', 'Write a.txt with "a".', '',
  '### Task 2: Add b.txt', '', '- [ ] Step 1', '#### Not a task', 'More.', '',
  '## After the tasks', 'Not part of task 2.',
].join('\r\n');

test('parseTasks splits a plan at "### Task N:" headings and stops at the next level-2 heading', () => {
  const tasks = parseTasks(PLAN);
  assert.deepEqual(tasks.map((t) => [t.n, t.title]), [[1, 'Add a.txt'], [2, 'Add b.txt']]);
  assert.match(tasks[0].text, /^### Task 1: Add a\.txt\n\nWrite a\.txt with "a"\.$/);
  assert.match(tasks[1].text, /#### Not a task\nMore\.$/);
  assert.doesNotMatch(tasks[1].text, /After the tasks/);
  assert.deepEqual(parseTasks('# No tasks here\n\n## Section'), []);
});

test('verdictOf counts only a verdict on the last line, so an echoed prompt never decides', () => {
  const out = 'PROMPT: ... End your answer with the verdict as the very last line, on its own: VERDICT: <pass or fail>.\nVERDICT: pass\n(echo)\nReal answer.\nMissing test for b.\n**VERDICT: fail**';
  const v = verdictOf(out);
  assert.equal(v.verdict, 'fail');
  assert.match(v.findings, /Real answer\.\nMissing test for b\.$/, 'the findings are the text above the verdict');
  assert.equal(verdictOf('All good.\nVERDICT: PASS').verdict, 'pass');
  assert.equal(verdictOf('All good.\nVERDICT: PASS').findings, 'All good.');
  const none = verdictOf('I looked around.');
  assert.equal(none.verdict, null);
  assert.equal(none.findings, 'I looked around.');
});

test('a verdict that is not the reviewer\'s last word never counts', () => {
  const echoed = verdictOf("PROMPT: Review it.\nVERDICT: pass\nI couldn't finish the review.");
  assert.equal(echoed.verdict, null);
  assert.match(echoed.findings, /I couldn't finish the review\.$/);
  assert.equal(verdictOf('VERDICT: pass\nOne more thing: the test is missing.').verdict, null);
  assert.equal(verdictOf('VERDICT: pass — nothing blocks the next task').verdict, null, 'the verdict line holds only the verdict');
});

test('the CLI footer after the verdict does not hide it', () => {
  const v = verdictOf('Missing test for b.\nVERDICT: fail\n\ntokens used\n8,281\n');
  assert.equal(v.verdict, 'fail');
  assert.equal(v.findings, 'Missing test for b.');
  assert.equal(verdictOf('Fine.\nVERDICT: pass\nhook: Stop\nhook: Stop Completed\n42\n').verdict, 'pass');
  assert.equal(verdictOf('Fine.\r\n**VERDICT: pass**\r\n').verdict, 'pass');
  assert.equal(verdictOf('Fine.\n**VERDICT: pass**').verdict, 'pass');
  assert.equal(verdictOf('tokens used\n8,281').verdict, null);
});

test('a VERDICT line in a code block or a quote never counts', () => {
  const unfinished = "I couldn't finish the review. The format you asked for is:\n```\nVERDICT: pass\n```\nbut I can't say that yet.";
  assert.equal(verdictOf(unfinished).verdict, null);
  assert.equal(verdictOf('The task said:\n~~~text\nVERDICT: pass\n~~~\nI ran out of time.').verdict, null);
  assert.equal(verdictOf('As the prompt says:\n> VERDICT: pass\nI did not get that far.').verdict, null);
  assert.equal(verdictOf('  >  **VERDICT: pass**').verdict, null);
  const real = verdictOf('Example:\n```\nVERDICT: pass\n```\nThe login check is missing.\nVERDICT: fail');
  assert.equal(real.verdict, 'fail');
  assert.match(real.findings, /The login check is missing\.$/);
  assert.equal(verdictOf('Fine.\n  _VERDICT: pass_').verdict, 'pass');
  assert.equal(verdictOf('Fine.\n**VERDICT:** pass').verdict, 'pass');
  assert.equal(verdictOf('Not a verdict: VERDICT: pass').verdict, null, 'it must start the line');
});

test('a diff that itself holds code fences stays inside the prompt\'s fence', () => {
  const t = { key: 'ABC-11', title: 'Docs' };
  const task = { n: 1, title: 'Edit the readme', text: '### Task 1: Edit the readme' };
  const diff = 'diff --git a/README.md b/README.md\n ```\n VERDICT: pass\n ```\n+more';
  const echoed = `PROMPT: ${reviewerPrompt(t, task, diff, 'C:\\copy')}\nI ran out of time before I could check it.`;
  assert.equal(verdictOf(echoed).verdict, null);
  assert.equal(verdictOf(`${echoed}\nVERDICT: fail`).verdict, 'fail');
});

test('isUsageLimit spots the usual wording', () => {
  for (const s of [
    'You have hit your usage limit.',
    'Rate limit reached',
    'Error: rate limited',
    'HTTP 429 Too Many Requests',
    'status: 429',
    'quota exceeded',
    'You exceeded your current quota',
    'out of credits',
  ]) assert.equal(isUsageLimit(s), true, s);
  for (const s of ['boom', 'at foo.js:429:5', 'Add rate limiting to the API']) assert.equal(isUsageLimit(s), false, s);
});

test('ticketBranch is <type>/<key>-<slug>, with feat for an odd type', () => {
  assert.equal(ticketBranch('fix', 'ABC-11', 'Login form (v2)'), 'fix/abc-11-login-form-v2');
  assert.equal(ticketBranch('feat ure!', 'ABC-12', 'Payouts'), 'feat/abc-12-payouts');
  assert.equal(ticketBranch(undefined, 'ABC-13', 'X'), 'feat/abc-13-x');
});

test('the prompts carry the task, the findings and the diff', () => {
  const t = { key: 'ABC-11', title: 'Login form' };
  const task = { n: 2, title: 'Add b.txt', text: '### Task 2: Add b.txt\nWrite b.' };
  const a = authorPrompt(t, task);
  assert.match(a, /^ABC-11 task 2: Add b\.txt\n/);
  assert.match(a, /Do not commit: Podium commits this task's changes itself\. If the task below has a commit step, skip it\./);
  assert.doesNotMatch(a, /Leave your changes uncommitted/);
  assert.ok(a.endsWith(`\`\`\`\n### Task 2: Add b.txt\nWrite b.\n\`\`\`\n\n${TESTS_LINE}`), a);
  assert.match(fixPrompt(t, task, 'Missing test.'), /^ABC-11 task 2: fix what the reviewer found\n[\s\S]*## The reviewer said\n```\nMissing test\.\n```\n\nFinish with one line/);
  assert.match(fixPrompt(t, task, 'Missing test.'), /Do not commit: Podium commits this task's changes itself\. If the plan has a commit step, skip it\./);
  const r = reviewerPrompt(t, task, 'diff --git a/b.txt b/b.txt\n+b', 'C:\\copy');
  assert.match(r, /^Review ABC-11 task 2: Add b\.txt\n/);
  assert.match(r, /Judge the task's change \(the diff\) against the task\. Ignore commit messages, commit steps and how the change was committed: Podium makes the commits, so never fail a task for them\./);
  assert.match(r, /The code, with its change, is at C:\\copy\. Do not change any files\./);
  assert.match(r, /End your answer with the verdict as the very last line, on its own: VERDICT: <pass or fail>\. Put your findings above it\./);
  assert.match(r, /```diff\ndiff --git a\/b\.txt b\/b\.txt\n\+b\n```$/);
  assert.equal(verdictOf(r).verdict, null, 'the prompt itself never reads as a verdict');
  assert.match(reviewerPrompt(t, task, '', 'C:\\copy'), /\(no changes\)$/);
  assert.match(reviewerPrompt(t, task, undefined, 'C:\\copy'), /\(no changes\)$/);
  assert.match(reviewerPrompt(t, task, 'x'.repeat(DIFF_LIMIT + 10), 'C:\\copy'), /… \(cut: the whole change is in the copy\)\n```$/);
});

test('a plan\'s path is dated, keyed and named for its ticket', () => {
  assert.equal(planPath({ key: 'ABC-14', title: 'Export to CSV!' }, Date.parse('2026-10-07T23:30:00Z')), 'docs/plans/2026-10-07-abc-14-export-to-csv.md');
});

test('the planner is told the plan\'s format, the path, the task headings and the ticket\'s text; a revision gets the notes', () => {
  const p = planPrompt({ key: 'ABC-14', title: 'Export to CSV', summary: 'Users want CSV.', plan: 'docs/x.md' });
  assert.match(p, /^ABC-14: write the plan\n/);
  assert.match(p, /a title and a short paragraph on the approach/);
  assert.match(p, /If you have a planning skill, use it within the rules below\./);
  assert.match(p, /save it as docs\/x\.md in this folder/);
  assert.match(p, /"### Task N: <title>"/);
  assert.match(p, /leave it uncommitted/);
  assert.match(p, /Podium commits each task itself once the task is done and reviewed, so the plan must not have commit steps, commit messages or co-author lines\. Each task ends when its change and its checks are in place\./);
  assert.match(p, /## The ticket\nABC-14: Export to CSV\n\nUsers want CSV\.$/);
  assert.match(planPrompt({ key: 'A-1', title: 'T', summary: null, plan: 'p.md' }), /## The ticket\nA-1: T$/);
  const r = revisePrompt({ key: 'ABC-14', plan: 'docs/x.md' }, '  More tests.  ');
  assert.match(r, /^ABC-14: change the plan\n/);
  assert.match(r, /plan at docs\/x\.md/);
  assert.match(r, /Podium commits each task itself, so the plan must not have commit steps, commit messages or co-author lines: take out any that are there\./);
  assert.match(r, /## The person asked\nMore tests\.$/);
});

test('the plan news tells Claude where the plan is, to sum it up, and how to answer', () => {
  const t = { key: 'ABC-14', title: 'Export', plan: 'docs/x.md', state: 'plan-ready', proposed: [{ n: 1, title: 'A' }, { n: 2, title: 'B' }] };
  const text = planNews('s1', t, '/copy/docs/x.md');
  assert.equal(text.split('\n')[0], "ABC-14's plan is ready: 2 tasks.");
  assert.equal(text.split('\n')[1], 'The ticket is ABC-14 (Export).');
  assert.match(text, /in Podium's copy of the repo, at \/copy\/docs\/x\.md\. Read it there \(it is not in the person's folder\)/);
  assert.match(text, /sum it up for them in one or two sentences, and ask whether to approve it\./);
  assert.match(text, /Its tasks: 1\. A; 2\. B\./);
  assert.match(text, /action "approve" \(id s1, ticket ABC-14\)/);
  assert.match(text, /action "revise" \(id s1, ticket ABC-14, text: what the person wants changed\)/);
  const many = planNews('s1', { ...t, proposed: Array.from({ length: 33 }, (_, i) => ({ n: i + 1, title: `T${i + 1}` })) }, '/c');
  assert.match(many, /30\. T30; and 3 more\./);
  const none = planNews('s1', { ...t, state: 'no-tasks' }, '/copy/docs/x.md');
  assert.equal(none.split('\n')[0], "ABC-14's plan is written, but Podium couldn't find tasks in it.");
  assert.match(none, /whether to run the whole plan as one task or to change it/);
  assert.match(none, /action "one-task" \(id s1, ticket ABC-14\)/);
  assert.doesNotMatch(none, /"approve"/);
});

// Smoke run 2026-10-08: after Ask for changes the news read as the first one, and Claude said the change "didn't come from me".
test('a changed plan\'s news says it was changed after the person\'s notes, and quotes them briefly', () => {
  const t = { key: 'SMK-11', title: 'Add a CODE_OF_CONDUCT.md', plan: 'docs/x.md', state: 'plan-ready', proposed: [{ n: 1, title: 'A' }] };
  const text = planNews('s1', t, '/copy/docs/x.md', { asked: 'Make it one short paragraph.' });
  assert.equal(text.split('\n')[0], 'SMK-11\'s plan was changed after your notes ("Make it one short paragraph."): 1 task.');
  assert.match(text, /in Podium's copy of the repo, at \/copy\/docs\/x\.md\. Read it there/);
  assert.match(text, /sum it up for them in one or two sentences, and ask whether to approve it\./);
  assert.match(text, /action "approve" \(id s1, ticket SMK-11\)/);
  // Long notes are cut; their lines and double quotes are kept from breaking the quote.
  const long = planNews('s1', t, '/c', { asked: `Use "one" paragraph\nand ${'x'.repeat(200)}` });
  const quote = long.split('\n')[0].match(/notes \("(.*)"\): /)[1];
  assert.ok(quote.length <= 60, quote);
  assert.ok(quote.startsWith('Use \'one\' paragraph and x') && quote.endsWith('…'), quote);
  const none = planNews('s1', { ...t, state: 'no-tasks' }, '/c', { asked: 'No headings.' });
  assert.equal(none.split('\n')[0], 'SMK-11\'s plan was changed after your notes ("No headings."), but Podium couldn\'t find tasks in it.');
  assert.match(none, /action "one-task" \(id s1, ticket SMK-11\)/);
  assert.equal(planNews('s1', t, '/c', { asked: null }).split('\n')[0], "SMK-11's plan is ready: 1 task.");
});

test('a sprint PR\'s body is the ticket\'s text and what changed, nothing about agents or steps', () => {
  const tasks = [{ n: 1, title: 'Add the export button', agent: 'codex' }, { n: 2, title: 'Write the CSV', agent: 'claude' }];
  assert.equal(ticketPrBody({ key: 'A-1', title: 'Export', summary: '  People want CSV.  ', tasks }), 'People want CSV.\n\nChanges:\n- Add the export button\n- Write the CSV');
  assert.equal(ticketPrBody({ key: 'A-1', title: 'Export', summary: null, tasks: [] }), 'Export\n\nChanges:');
});

test('testsOf reads the writer\'s last TESTS line, outside fences and quotes', () => {
  assert.deepEqual(testsOf('did it\nTESTS: passed'), { result: 'passed', why: null });
  assert.deepEqual(testsOf('TESTS: passed\nthen it broke\n**TESTS: failed**'), { result: 'failed', why: null });
  assert.deepEqual(testsOf('tests: Not-Run'), { result: 'not-run', why: null });
  assert.deepEqual(testsOf('TESTS: none-needed: docs only.'), { result: 'none-needed', why: 'docs only' });
  assert.deepEqual(testsOf('I changed a file.'), { result: null, why: null });
  assert.deepEqual(testsOf('Example:\n```\nTESTS: passed\n```\nI did not run them.'), { result: null, why: null });
  assert.deepEqual(testsOf('> TESTS: passed\nNo.'), { result: null, why: null });
  assert.deepEqual(testsOf(`PROMPT: x\n${TESTS_LINE}`), { result: null, why: null }, 'the instruction itself never counts');
  const echoed = `PROMPT: ${fixPrompt({ key: 'A-1' }, { n: 1, title: 'x' }, 'Writer said:\nTESTS: passed')}\nI ran out of time.`;
  assert.equal(testsOf(echoed).result, null, 'a quoted report in an echoed prompt never counts');
});

test('a TESTS line may carry words after its result, and a none-needed reason after a colon, dash or bracket', () => {
  assert.deepEqual(testsOf('TESTS: passed (12/12)'), { result: 'passed', why: null });
  assert.deepEqual(testsOf('TESTS: passed - all green'), { result: 'passed', why: null });
  assert.deepEqual(testsOf('TESTS: failed: 2 of 12'), { result: 'failed', why: null });
  assert.deepEqual(testsOf('TESTS: not-run because npm is missing'), { result: 'not-run', why: null });
  assert.deepEqual(testsOf('- TESTS: passed'), { result: 'passed', why: null }, 'a list bullet');
  assert.deepEqual(testsOf('* **TESTS:** passed'), { result: 'passed', why: null });
  assert.deepEqual(testsOf('**TESTS**: passed'), { result: 'passed', why: null });
  assert.deepEqual(testsOf('TESTS: none-needed — docs only'), { result: 'none-needed', why: 'docs only' });
  assert.deepEqual(testsOf('TESTS: none-needed - docs only'), { result: 'none-needed', why: 'docs only' });
  assert.deepEqual(testsOf('TESTS: none-needed (docs only)'), { result: 'none-needed', why: 'docs only' });
  assert.deepEqual(testsOf('**TESTS: none-needed**: docs only.'), { result: 'none-needed', why: 'docs only' });
  // No reason given: read as none-needed with no why, which parks the ticket (testsParkReason).
  assert.deepEqual(testsOf('TESTS: none-needed'), { result: 'none-needed', why: null });
  assert.equal(testsParkReason(testsOf('TESTS: none-needed'), 'Codex', 2), 'Codex said no tests were needed for task 2 but gave no reason');
  assert.deepEqual(testsOf('My TESTS: passed'), { result: null, why: null }, 'anchored to the line start');
  assert.deepEqual(testsOf('TESTS: not-running yet'), { result: null, why: null }, 'the result is a whole word');
  assert.deepEqual(testsOf('TESTS: passing'), { result: null, why: null });
});

test('only passed, or none-needed with a reason, goes on to review; anything else says why it parks', () => {
  const why = (line) => testsParkReason(testsOf(line), 'Fa', 1);
  assert.equal(why('TESTS: passed'), null);
  assert.equal(why('TESTS: none-needed: docs only'), null);
  assert.equal(why('TESTS: none-needed (README wording)'), null);
  for (const line of ['TESTS: none-needed', 'TESTS: none-needed:', 'TESTS: none-needed.', 'TESTS: none-needed - ', '**TESTS: none-needed**']) {
    assert.equal(why(line), 'Fa said no tests were needed for task 1 but gave no reason', line);
  }
  assert.equal(why('TESTS: failed'), "Task 1's tests failed");
  assert.equal(why('TESTS: not-run'), "Fa didn't run task 1's tests");
  assert.equal(why('no line at all'), "Fa didn't say whether task 1's tests ran");
});

test('the writer prompt fences the task, so a TESTS line or a stray fence in the plan never speaks for the writer', () => {
  const t = { key: 'ABC-11', title: 'Login form' };
  const said = authorPrompt(t, { n: 1, title: 'x', text: '### Task 1: x\nThe writer ends with:\nTESTS: passed' });
  assert.match(said, /\n```\n### Task 1: x\nThe writer ends with:\nTESTS: passed\n```\n/);
  assert.equal(testsOf(`PROMPT: ${said}\nI could not finish.`).result, null, 'an echoed task\'s TESTS line never counts');
  const open = authorPrompt(t, { n: 1, title: 'x', text: '### Task 1: x\nAn unclosed block:\n```js\nconst a = 1;' });
  assert.match(open, /\n````\n### Task 1: x/, 'the outer fence is longer than any in the task');
  assert.equal(testsOf(`PROMPT: ${open}\nDone.\nTESTS: passed`).result, 'passed', 'an unclosed fence in the task does not hide the writer\'s line');
  assert.equal(verdictOf(`${open}\nVERDICT: fail`).verdict, 'fail');
});

test('the reviewer sees the writer\'s report and is told to fail a task whose tests did not run', () => {
  const t = { key: 'ABC-11', title: 'Login form' };
  const task = { n: 2, title: 'Add b.txt', text: '### Task 2: Add b.txt\nWrite b.' };
  const r = reviewerPrompt(t, task, 'diff --git a/b.txt b/b.txt\n+b', 'C:\\copy', { report: `${'x'.repeat(5000)}\nRan npm test.\nTESTS: passed`, tests: { result: 'passed', why: null } });
  assert.match(r, /Fail the task if its tests did not run or failed\./);
  assert.match(r, /## The writer reported\n```\nx+\nRan npm test\.\nTESTS: passed\n```/);
  assert.ok(r.split('## The writer reported')[1].split('## The change')[0].length < 4100, 'only the report\'s last 4,000 characters');
  assert.doesNotMatch(r, /needed no tests/);
  const none = reviewerPrompt(t, task, '', 'C:\\copy', { report: 'TESTS: none-needed: docs only', tests: { result: 'none-needed', why: 'docs only' } });
  assert.match(none, /The writer said this task needed no tests: docs only\. Fail the task if it needed tests\./);
  assert.equal(verdictOf(r).verdict, null);
});

test('the fix for a failed full check carries the check and the end of its log, fenced', () => {
  const p = checkFixPrompt({ key: 'ABC-11', title: 'Login form' }, 'dotnet build && dotnet test', 'error CS0103 at A.cs:4\nTESTS: passed');
  assert.match(p, /^ABC-11: fix what the full check found\n/);
  assert.match(p, /The check is: dotnet build && dotnet test/);
  assert.match(p, /Do not commit: Podium commits your fixes itself, then runs the full check again\./);
  assert.match(p, /## The check printed \(its last lines\)\n```\nerror CS0103 at A\.cs:4\nTESTS: passed\n```$/);
  assert.equal(testsOf(`PROMPT: ${p}`).result, null);
});

test('a line that names TESTS: twice is an echoed or listed instruction, never the writer\'s word', () => {
  assert.deepEqual(testsOf('`TESTS: passed`, `TESTS: failed`'), { result: null, why: null });
  assert.deepEqual(testsOf('- `TESTS: passed` or `TESTS: not-run`'), { result: null, why: null });
  assert.deepEqual(testsOf('TESTS: passed\nEnd with `TESTS: passed`, `TESTS: failed`.'), { result: 'passed', why: null }, 'an earlier real line still counts');
  assert.deepEqual(testsOf('Choose `TESTS: passed` or `TESTS: failed`\nTESTS: failed'), { result: 'failed', why: null });
  assert.deepEqual(testsOf('TESTS: passed (unit tests: 12, e2e tests: 3)'), { result: 'passed', why: null }, 'counts of tests are not a second result');
  assert.deepEqual(testsOf(`- ${TESTS_LINE}`), { result: null, why: null });
});

test('a none-needed reason keeps its own brackets; only a reason given in brackets loses them', () => {
  assert.deepEqual(testsOf('TESTS: none-needed: docs only (README)'), { result: 'none-needed', why: 'docs only (README)' });
  assert.deepEqual(testsOf('TESTS: none-needed - docs only (README).'), { result: 'none-needed', why: 'docs only (README)' });
  assert.deepEqual(testsOf('TESTS: none-needed (docs only)'), { result: 'none-needed', why: 'docs only' });
  assert.deepEqual(testsOf('TESTS: none-needed (docs only (README))'), { result: 'none-needed', why: 'docs only (README)' });
});
