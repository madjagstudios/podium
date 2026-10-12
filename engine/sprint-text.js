// Pure text for sprints: a plan's tasks, the prompt each step gets, a
// reviewer's verdict, and whether an agent stopped on a usage limit.
import { slugOf } from './pr.js';

export const DIFF_LIMIT = 60_000;
// A fence longer than any run of backticks in the text, so fences inside a diff (a changed
// Markdown file) cannot close it, and verdictOf keeps the whole diff inside it.
const fenceFor = (text) => '`'.repeat([...String(text).matchAll(/`+/g)].reduce((n, m) => Math.max(n, m[0].length + 1), 3));

// "### Task N: title" sections; the last one ends at the next level-2 heading.
export function parseTasks(plan) {
  const text = String(plan ?? '').replace(/\r\n/g, '\n');
  const heads = [...text.matchAll(/^### Task (\d+):[ \t]*(.*)$/gm)];
  return heads.map((m, i) => {
    const next = heads[i + 1]?.index;
    const section = text.indexOf('\n## ', m.index);
    const ends = [next, section === -1 ? undefined : section].filter((x) => x !== undefined);
    const end = ends.length ? Math.min(...ends) : text.length;
    return { n: Number(m[1]), title: m[2].trim() || `Task ${m[1]}`, text: text.slice(m.index, end).trim() };
  });
}

// Only the reviewer's final word counts: the last line of its answer must be the verdict, and nothing but
// it. Agents such as Codex echo the prompt (which names the verdict) before answering, and a reviewer that
// stops early may still have written a verdict above its last words. A line in a fenced code block
// (``` or ~~~) or a quote (>) is an example, not an answer, so it is left out first; so is the footer an
// agent CLI prints after the answer ("tokens used" and its count, "hook: ..." lines).
const VERDICT = /^[ \t]*[*_]*VERDICT:[ \t*_`]*(pass|fail)[ \t*_`.]*$/i;
const FENCE_LINE = /^[ \t]*(`{3,}|~{3,})(.*)$/;
const FOOTER = /^(?:tokens used\b.*|[\d,]+|hook: .*)$/i;

// The lines of an agent's answer outside fenced code blocks and quotes (examples or echoes, never its own word), each
// with where it starts in the text. verdictOf and testsOf both read through it.
function* outsideFences(text) {
  let fence = null;
  let at = 0;
  for (const raw of text.split('\n')) {
    const start = at;
    at += raw.length + 1;
    const line = raw.replace(/\r$/, '');
    const f = line.match(FENCE_LINE);
    if (fence) {
      // A fence closes on the same character, at least as long, with nothing after it.
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !f[2].trim()) fence = null;
      continue;
    }
    if (f && !(f[1][0] === '`' && f[2].includes('`'))) { fence = f[1]; continue; }
    if (/^[ \t]*>/.test(line)) continue;
    yield { line, start };
  }
}

export function verdictOf(output) {
  const text = String(output ?? '');
  let last = null; // the last line outside fences and quotes that is not footer noise
  for (const at of outsideFences(text)) {
    const trimmed = at.line.trim();
    if (!trimmed || FOOTER.test(trimmed)) continue;
    last = at;
  }
  const m = last?.line.match(VERDICT);
  if (!m) return { verdict: null, findings: text.trim().slice(-4000) };
  return { verdict: m[1].toLowerCase(), findings: text.slice(0, last.start).trim().slice(-4000) };
}

// What a writer says about its tests: the writer and fix prompts end with TESTS_LINE, and testsOf reads the last
// such line outside code fences and quotes, as verdictOf reads a verdict, so an echoed prompt or a quoted report never
// counts. It need not be the very last line (a CLI footer may follow). The line starts with TESTS: (a list bullet or bold
// marks are fine) and any words may follow the result ("TESTS: passed (12/12)"); a none-needed reason follows a colon,
// dash or bracket. A line that names two results (`TESTS: passed`, `TESTS: failed`) is the instruction echoed or listed,
// never the writer's own word.
export const TESTS_LINE = 'Finish with one line: `TESTS: passed`, `TESTS: failed`, `TESTS: not-run`, or `TESTS: none-needed: <why>`.';
const TESTS = /^[ \t]*(?:[-*+][ \t]+)?[*_`]*TESTS[*_`]*:[ \t*_`]*(passed|failed|not-run|none-needed)\b(.*)$/i;
// TESTS: with a result after it; "unit tests: 12" in the writer's own words is not one.
const TESTS_NAMED = /TESTS[*_`]*:[ \t*_`]*(?:passed|failed|not-run|none-needed)\b/gi;
export const REPORT_CHARS = 4000;

// A none-needed reason, without the colon, dash or bracket before it. Only a reason given in brackets loses its closing
// one: "docs only (README)" keeps its own.
function whyOf(rest) {
  const lead = rest.match(/^[ \t*_`]*(?:([:—–(-])[ \t]*)?/);
  const end = lead[1] === '(' ? /[ \t*_`.]*\)?[ \t*_`.]*$/ : /[ \t*_`.]*$/;
  return rest.slice(lead[0].length).replace(end, '').trim() || null;
}

export function testsOf(output) {
  let found = null;
  for (const { line } of outsideFences(String(output ?? ''))) {
    if ((line.match(TESTS_NAMED) ?? []).length > 1) continue;
    const m = line.match(TESTS);
    if (m) {
      const result = m[1].toLowerCase();
      found = { result, why: result === 'none-needed' ? whyOf(m[2]) : null };
    }
  }
  return found ?? { result: null, why: null };
}

// Why a writer's step parks instead of going to review, or null when it may go on: only "passed", or
// "none-needed" with a reason (a none-needed with no reason parks; the reviewer can't weigh a reason never given).
// tests: testsOf's answer; who: the writer's name; n: the task's number.
export function testsParkReason(tests, who, n) {
  const { result, why } = tests ?? {};
  if (result === 'passed') return null;
  if (result === 'none-needed') return why && /[\p{L}\p{N}]/u.test(why) ? null : `${who} said no tests were needed for task ${n} but gave no reason`;
  if (result === 'failed') return `Task ${n}'s tests failed`;
  if (result === 'not-run') return `${who} didn't run task ${n}'s tests`;
  return `${who} didn't say whether task ${n}'s tests ran`;
}

// Quoted output in a prompt goes in a fence of its own, so an agent echoing the prompt never seems to say it.
const fenced = (text) => `${fenceFor(text)}\n${text}\n${fenceFor(text)}`;

const LIMIT = /usage limit|rate[ -]?limit(?:ed|s? (?:reached|exceeded|hit))|too many requests|\b(?:HTTP|status|error)[: ]+429\b|quota (?:exceeded|reached)|exceeded your (?:current )?quota|out of credits/i;
export function isUsageLimit(text) {
  return LIMIT.test(String(text ?? ''));
}

export function ticketBranch(type, key, title) {
  const kind = String(type ?? '').toLowerCase();
  return `${/^[a-z]+$/.test(kind) ? kind : 'feat'}/${String(key).toLowerCase()}-${slugOf(title)}`;
}

export function authorPrompt(ticket, task) {
  return [
    `${ticket.key} task ${task.n}: ${task.title}`,
    '',
    `This is one task of ${ticket.key} (${ticket.title}), worked one task at a time from its plan. Do only this task, and run the tests it names. A reviewer checks it before the next one starts.`,
    "Do not commit: Podium commits this task's changes itself. If the task below has a commit step, skip it.",
    '',
    // Fenced, so a TESTS line or a stray fence in the plan's text is never read as the writer's own line, nor hides it.
    fenced(task.text),
    '',
    TESTS_LINE,
  ].join('\n');
}

export function fixPrompt(ticket, task, findings) {
  const said = findings && findings.trim() ? findings.trim() : '(no details)';
  return [
    `${ticket.key} task ${task.n}: fix what the reviewer found`,
    '',
    `A reviewer checked the work on task ${task.n} (${task.title}) and found problems. Fix them, keep the change small, and run the tests again.`,
    "Do not commit: Podium commits this task's changes itself. If the plan has a commit step, skip it.",
    '',
    '## The reviewer said',
    fenced(said),
    '',
    TESTS_LINE,
  ].join('\n');
}

// report: the writer's output (its last REPORT_CHARS characters are shown); tests: what it said about its tests (testsOf).
export function reviewerPrompt(ticket, task, diff, copy, { report = '', tests = null } = {}) {
  const text = String(diff ?? '');
  const shown = text.length > DIFF_LIMIT ? `${text.slice(0, DIFF_LIMIT)}\n… (cut: the whole change is in the copy)` : text;
  const reported = String(report ?? '').trim().slice(-REPORT_CHARS) || '(the writer said nothing)';
  return [
    `Review ${ticket.key} task ${task.n}: ${task.title}`,
    '',
    `Another agent just did this task. The code, with its change, is at ${copy}. Do not change any files.`,
    "Judge the task's change (the diff) against the task. Ignore commit messages, commit steps and how the change was committed: Podium makes the commits, so never fail a task for them.",
    'Check the change against the task: is it complete and correct, and does it have the tests the task asks for? List problems by severity (high, medium, low), each with file:line.',
    'Say pass only if nothing needs fixing before the next task.',
    "The writer's report is below. Fail the task if its tests did not run or failed.",
    ...(tests?.result === 'none-needed' ? [`The writer said this task needed no tests: ${tests.why ?? '(no reason given)'}. Fail the task if it needed tests.`] : []),
    'End your answer with the verdict as the very last line, on its own: VERDICT: <pass or fail>. Put your findings above it.',
    '',
    '## The task',
    task.text,
    '',
    '## The writer reported',
    fenced(reported),
    '',
    '## The change',
    text.trim() ? `${fenceFor(shown)}diff\n${shown.trimEnd()}\n${fenceFor(shown)}` : '(no changes)',
  ].join('\n');
}

// ---- Planning steps ----

// Where a ticket's plan goes: dated (UTC) the day its planning starts, so a revision keeps the same file.
export function planPath(ticket, now = Date.now()) {
  return `docs/plans/${new Date(now).toISOString().slice(0, 10)}-${String(ticket.key).toLowerCase()}-${slugOf(ticket.title)}.md`;
}

export function planPrompt(ticket) {
  return [
    `${ticket.key}: write the plan`,
    '',
    `Write an implementation plan for ${ticket.key} (${ticket.title}) and save it as ${ticket.plan} in this folder. If you have a planning skill, use it within the rules below.`,
    'Start with a title and a short paragraph on the approach. Then split the work into tasks headed "### Task N: <title>" (### Task 1:, ### Task 2:, and so on). Podium runs them one at a time, each by an agent that sees only its own task, with a reviewer agent checking each one, so every task must stand on its own: its files, its code and its tests.',
    'Podium commits each task itself once the task is done and reviewed, so the plan must not have commit steps, commit messages or co-author lines. Each task ends when its change and its checks are in place.',
    'Write only the plan: change no other file, and leave it uncommitted. Podium commits it, and the person reads and approves it before any task starts.',
    '',
    '## The ticket',
    `${ticket.key}: ${ticket.title}`,
    ...(ticket.summary && String(ticket.summary).trim() ? ['', String(ticket.summary).trim()] : []),
  ].join('\n');
}

export function revisePrompt(ticket, notes) {
  return [
    `${ticket.key}: change the plan`,
    '',
    `The person read the plan at ${ticket.plan} and asked for changes. Change the plan to answer them, keep its "### Task N:" headings, change no other file, and leave it uncommitted.`,
    'Podium commits each task itself, so the plan must not have commit steps, commit messages or co-author lines: take out any that are there.',
    '',
    '## The person asked',
    notes && String(notes).trim() ? String(notes).trim() : '(no details)',
  ].join('\n');
}

const NEWS_TASKS = 30;

const QUOTE_CHARS = 60;

// The person's notes, quoted briefly on one line; their double quotes become single ones so the quote stays whole.
function quoteOf(notes) {
  const text = String(notes ?? '').replace(/\s+/g, ' ').trim().replace(/"/g, "'");
  return text.length > QUOTE_CHARS ? `${text.slice(0, QUOTE_CHARS - 1).trimEnd()}…` : text;
}

// What Claude is told when a plan waits for the person. Its first line is all the person sees in the transcript (what
// happened, in one line). `where` is the plan in Podium's copy: Claude must read it there, not in the person's folder.
// `asked`: the person's notes when the plan was changed after Ask for changes (the same "ready"
// message twice read as a change the person never asked for).
export function planNews(sprintId, ticket, where, { asked = null } = {}) {
  const changed = asked && String(asked).trim() ? `${ticket.key}'s plan was changed after your notes ("${quoteOf(asked)}")` : null;
  const about = `The ticket is ${ticket.key} (${ticket.title}).`;
  const ids = `id ${sprintId}, ticket ${ticket.key}`;
  const read = `The plan is ${ticket.plan} in Podium's copy of the repo, at ${where}. Read it there (it is not in the person's folder), sum it up for them in one or two sentences, and ask`;
  const change = `To change it: action "revise" (${ids}, text: what the person wants changed). They can also answer on the ticket's screen in the pane.`;
  if (ticket.state === 'no-tasks') {
    return [
      changed ? `${changed}, but Podium couldn't find tasks in it.` : `${ticket.key}'s plan is written, but Podium couldn't find tasks in it.`,
      about,
      `${read} whether to run the whole plan as one task or to change it. Podium splits a plan into tasks at its "### Task N:" headings.`,
      `To run it as one task: the sprint tool, action "one-task" (${ids}). ${change}`,
    ].join('\n');
  }
  const n = ticket.proposed.length;
  const count = `${n} task${n === 1 ? '' : 's'}`;
  const listed = ticket.proposed.slice(0, NEWS_TASKS).map((x) => `${x.n}. ${x.title}`).join('; ');
  const more = n > NEWS_TASKS ? `; and ${n - NEWS_TASKS} more` : '';
  return [
    changed ? `${changed}: ${count}.` : `${ticket.key}'s plan is ready: ${count}.`,
    about,
    `${read} whether to approve it.`,
    `Its tasks: ${listed}${more}.`,
    `To approve: the sprint tool, action "approve" (${ids}). ${change}`,
  ].join('\n');
}

// A sprint ticket's PR body: the ticket's text (or its title), then one line per task. No agent names or step numbers:
// people read it, and a repo's rules may refuse them.
export function ticketPrBody(ticket) {
  const text = String(ticket.summary ?? '').trim() || String(ticket.title ?? ticket.key).trim();
  return [text, '', 'Changes:', ...(ticket.tasks ?? []).map((x) => `- ${String(x.title).trim()}`)].join('\n');
}

// The writer's fix when the repo's full check failed before the PR: the check's command and the end of its log.
export function checkFixPrompt(ticket, command, log) {
  const text = String(log ?? '').trim() || '(the check printed nothing)';
  return [
    `${ticket.key}: fix what the full check found`,
    '',
    `Every task of ${ticket.key} (${ticket.title}) passed its review, but the repo's full check failed in this copy before the PR could open. Fix what it found and keep the change small. The check is: ${command ?? '(not set)'}`,
    'Do not commit: Podium commits your fixes itself, then runs the full check again.',
    '',
    '## The check printed (its last lines)',
    fenced(text),
  ].join('\n');
}
