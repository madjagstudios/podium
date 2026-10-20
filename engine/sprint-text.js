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

// Commands that change something beyond the ticket's copy: a live service, a published package, a remote branch or
// database. A rule matches when its command's name is followed, later in the line, by its words in order (a list is any
// one of them). Whatever comes between them is passed over: options and their values, quoted or not, shell separators,
// and a path, version or Windows shim extension on the name. Only the end of a sentence (a word ending in a full stop,
// then a capitalised word) closes it. This reads generously on purpose: a line that only mentions a command is flagged
// too, which costs the person one question, where a missed one costs a production change nobody agreed to.
const PRODUCTION = [
  { cmd: 'supabase', sub: ['functions', ['delete', 'deploy']] },
  { cmd: 'supabase', sub: ['db', ['push', 'reset']] },
  { cmd: 'vercel', sub: ['--prod'] },
  { cmd: 'gh', sub: ['release', ['create', 'upload', 'delete', 'edit']] },
  { cmd: ['npm', 'pnpm', 'yarn', 'cargo'], sub: ['publish'] },
  { cmd: ['git', 'docker'], sub: ['push'] },
  { cmd: 'docker', sub: ['--push'] },
  { cmd: 'terraform', sub: [['apply', 'destroy']] },
  { cmd: 'kubectl', sub: [['apply', 'delete']] },
  { cmd: ['firebase', 'fly', 'flyctl'], sub: ['deploy'] },
  { cmd: 'twine', sub: ['upload'] },
  // Tools an agent may call by name (a server's), which change a live project.
  { cmd: ['apply_migration', 'deploy_edge_function'], sub: [] },
];
// SQL that drops or deletes counts on a line that also runs a database client, before or after it (`psql -c "DELETE …"`,
// `echo "DELETE …" | psql`), or anywhere in a code block one is run in (a heredoc fed to psql). SQL only written to a file
// is not run.
const DB_CLIENTS = ['psql', 'mysql', 'sqlcmd', 'execute_sql'];
const DESTRUCTIVE = ['drop', 'delete', 'truncate'];
const DB_RULES = [{ cmd: DB_CLIENTS, sub: [] }, { cmd: 'supabase', sub: ['db'] }];
// How many flagged commands a plan keeps (the rest are counted), and how much of each is shown.
export const ATTENTION_LINES = 20;
const ATTENTION_CHARS = 160;

// A line's words, each with where its kept part is in the line. A word is a run of letters, digits and . _ @ / \ : + - ;
// every other mark (quotes, brackets, $, *, =, ; & |, spaces) only parts words. A word is read in lower case without a
// path's folders, a package's version, a Windows shim's extension or trailing full stops and colons; where it is starts
// after its folders, so the name itself is what an excerpt keeps. A word that ends a sentence (a full stop after a
// letter, then a capitalised word) closes the command.
const TOKEN = /[\w.@/\\:+-]+/g;
const SHIMS = ['.cmd', '.exe', '.bat', '.ps1'];
function wordsOf(line) {
  const words = [];
  const raws = [...line.matchAll(TOKEN)];
  raws.forEach((m, i) => {
    const raw = m[0];
    let to = raw.length;
    while (to > 0 && (raw[to - 1] === '.' || raw[to - 1] === ':')) to -= 1;
    let w = raw.slice(0, to).toLowerCase();
    let from = 0;
    if (!w.startsWith('-')) {
      from = Math.max(w.lastIndexOf('/'), w.lastIndexOf('\\')) + 1;
      w = w.slice(from);
      const v = w.lastIndexOf('@');
      if (v > 0) w = w.slice(0, v);
      const shim = SHIMS.find((x) => w.endsWith(x));
      if (shim) w = w.slice(0, -shim.length);
      // A tool's name qualified by its server (mcp__supabase__execute_sql) is read as the tool's own.
      const q = w.lastIndexOf('__');
      if (q > 0 && q < w.length - 2) w = w.slice(q + 2);
    }
    if (w) words.push({ word: w, at: m.index + from, to: m.index + to });
    const next = raws[i + 1];
    const sentence = to < raw.length && raw[to] === '.' && /[a-z]/i.test(raw[to - 1] ?? '') && !raw.includes('=') && !raw.startsWith('-')
      && line[m.index + raw.length] === ' ' && next && /^[A-Z]/.test(next[0]);
    if (sentence) words.push({ end: true });
  });
  return words;
}

const is = (want, word) => (Array.isArray(want) ? want.includes(word) : want === word);

// Each place a rule matches in a line's words: { at, to }, from its command's name to its last word. Once a command's name
// is seen, its words are looked for after it, up to the command's end. A later name moves the start there (the command
// shown is the one that runs the words) and keeps the words found so far, so nothing found is lost. Each word is looked at
// once.
function ruleSpans(words, rule) {
  const spans = [];
  let from = null;
  let k = 0;
  for (const x of words) {
    if (x.end) { from = null; continue; }
    if (is(rule.cmd, x.word)) {
      if (!rule.sub.length) { spans.push({ at: x.at, to: x.to }); continue; }
      if (from === null) k = 0;
      from = x;
      continue;
    }
    if (from === null || !is(rule.sub[k], x.word)) continue;
    k += 1;
    if (k === rule.sub.length) { spans.push({ at: from.at, to: x.to }); from = null; }
  }
  return spans;
}

// A task's lines as commands are read: trimmed, a list marker or prompt in front left out, a line continued with a
// trailing "\", or " `" (PowerShell) or " ^" (cmd), joined to the next. Each says which code block it is in, if any.
function logicalLines(text) {
  const out = [];
  let fence = null;
  let block = 0;
  let parts = null;
  // Continued by a shell's mark; and, outside code blocks, backticks so far (odd while an inline code span is open: Markdown
  // wraps one onto the next line, and it reads as one).
  let continued = false;
  let ticks = 0;
  const flush = () => {
    if (parts !== null) out.push({ line: parts.join(' '), block: fence ? block : 0 });
    parts = null;
    continued = false;
    ticks = 0;
  };
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const trimmed = raw.trim();
    const f = /^(`{3,}|~{3,})/.exec(trimmed);
    if (f && !continued) {
      flush();
      if (!fence) { fence = f[1]; block += 1; } else if (f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      continue;
    }
    // A blank line ends a paragraph, and an inline code span with it.
    if (!trimmed && !continued) { flush(); continue; }
    const piece = parts === null ? trimmed.replace(/^(?:[-*+]|\d+[.)])\s+/, '').replace(/^[$>]\s+/, '') : trimmed;
    const cont = piece.endsWith('\\') ? 1 : / [`^]$/.test(piece.slice(-2)) ? 2 : 0;
    const kept = cont ? piece.slice(0, -cont).trimEnd() : piece;
    (parts ??= []).push(kept);
    continued = Boolean(cont);
    if (!fence) for (const c of kept) if (c === '`') ticks += 1;
    if (continued || (!fence && ticks % 2 === 1)) continue;
    flush();
  }
  flush();
  return out;
}

// What is shown of a flagged command: its whole line, or a window holding the whole command; a command too long for that
// shows its start and its end, so its name and its last word (the verb) are always there.
function excerpt(line, at, to) {
  if (line.length <= ATTENTION_CHARS) return line;
  const room = ATTENTION_CHARS - 2;
  if (to - at <= room) {
    const start = Math.max(0, Math.min(at - 20, line.length - room), to - room);
    const end = Math.min(line.length, start + room);
    return `${start > 0 ? '…' : ''}${line.slice(start, end)}${end < line.length ? '…' : ''}`;
  }
  const half = Math.floor((ATTENTION_CHARS - 5) / 2);
  return `${at > 0 ? '…' : ''}${line.slice(at, at + half)} … ${line.slice(to - half, to)}${to < line.length ? '…' : ''}`;
}

// The repo's own phrases found in a line: a phrase matches whatever the case and the spacing, at its place in the line.
function phraseSpans(line, phrases) {
  if (!phrases.length) return [];
  // The line with each run of spaces as one, lower case, and where each of its characters is in the line.
  const chars = [];
  const where = [];
  let space = false;
  for (let i = 0; i < line.length; i++) {
    const s = line[i] === ' ' || line[i] === '\t';
    if (s && space) continue;
    space = s;
    chars.push(s ? ' ' : line[i].toLowerCase());
    where.push(i);
  }
  const flat = chars.join('');
  const spans = [];
  // Every place each phrase is, not only the first: a long line shows each.
  for (const p of phrases) {
    for (let i = flat.indexOf(p); i >= 0; i = flat.indexOf(p, i + p.length)) spans.push({ at: where[i], to: where[i + p.length - 1] + 1 });
  }
  return spans;
}

// SQL that drops or deletes in a line: each such word, from it to the database client, on a line that runs one (either
// way round), or on its own in a code block one runs in.
function sqlSpans(x, dbBlocks) {
  const kills = x.words.filter((w) => !w.end && DESTRUCTIVE.includes(w.word));
  if (!kills.length) return [];
  // From the client when the line names one, so the excerpt shows what runs the SQL; else the words alone, in a block a
  // client runs in.
  const clients = x.words.filter((w) => !w.end && (DB_CLIENTS.includes(w.word) || w.word === 'supabase'));
  if (!clients.length) return dbBlocks.has(x.block) ? kills.map((w) => ({ at: w.at, to: w.to })) : [];
  const a = Math.min(clients[0].at, kills[0].at);
  const b = Math.max(clients[clients.length - 1].to, kills[kills.length - 1].to);
  return [{ at: a, to: b }];
}

// The production commands a plan's tasks run: { lines: [{ n, title, command, id }], more }, one entry a command (a long line
// with several shows each; id tells two apart whose excerpts read alike), in task order, at most ATTENTION_LINES, and how
// many more there are. Code blocks are read too: that is where commands are written. patterns: the repo's own plain-text
// phrases (repoProdPatterns).
export function productionSteps(tasks, patterns = []) {
  const phrases = (patterns ?? []).filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim().toLowerCase().replace(/\s+/g, ' '));
  const lines = [];
  let more = 0;
  (tasks ?? []).forEach((task, ti) => {
    const read = logicalLines(task.text).map((x) => ({ ...x, words: wordsOf(x.line) }));
    // Code blocks a database client runs in: what drops or deletes there counts too.
    const dbBlocks = new Set(read.filter((x) => x.block && DB_RULES.some((r) => ruleSpans(x.words, r).length)).map((x) => x.block));
    // A line repeated word for word in a task is one command; lines that differ are each one, however alike they read.
    const seen = new Set();
    read.forEach((x, li) => {
      if (!x.line || seen.has(x.line)) return;
      const spans = PRODUCTION.flatMap((r) => ruleSpans(x.words, r)).concat(sqlSpans(x, dbBlocks), phraseSpans(x.line, phrases));
      // Only a line already shown stands for its repeats: the same text unflagged elsewhere (SQL written to a file) does not.
      if (spans.length) seen.add(x.line);
      // A short line is shown whole: one entry says it all.
      const each = x.line.length <= ATTENTION_CHARS ? spans.slice(0, 1) : spans.sort((a, b) => a.at - b.at);
      // Two matches from the same place that end apart (a push, then the SQL run after it) are each shown.
      const done = new Set();
      for (const s of each) {
        const id = `${ti}:${li}:${s.at}:${s.to}`;
        if (done.has(id)) continue;
        done.add(id);
        if (lines.length < ATTENTION_LINES) lines.push({ n: task.n, title: task.title, command: excerpt(x.line, s.at, s.to), id });
        else more += 1;
      }
    });
  });
  return { lines, more };
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

// A text with its fenced blocks (and quoted lines) left out: what a reader takes as written, not quoted or shown as an
// example.
export const unfenced = (text) => [...outsideFences(String(text ?? ''))].map((x) => x.line).join('\n');

// Checks a plan leaves to the PR's CI: what only a CI run can show (a run on another system, a hosted runner's warnings).
// No task can pass one, since the PR opens (and its CI runs) only once every task has passed, so the plan lists them under
// CI_HEADING instead; Podium shows them in the PR's description and follows its CI for them. One line each.
export const CI_HEADING = "## Checked by the PR's CI";
export const CI_CHECKS = 10;
export const CI_CHECK_CHARS = 200;
const CI_HEAD = /^##[ \t]+checked by the pr['’]?s ci[ \t]*$/i;
// A list item's marker and its text (none for a bare marker).
const LIST_ITEM = /^(?:[-*+]|\d+[.)])(?:[ \t]+(.*))?$/;
const cutCheck = (text) => (text.length > CI_CHECK_CHARS ? `${text.slice(0, CI_CHECK_CHARS - 1)}…` : text);
// The section's list items, up to the next heading. A plain line right after an item continues it (Markdown wraps a long
// item onto the next line); a blank line ends it, and other lines are left out.
export function ciChecksOf(plan) {
  const lines = unfenced(String(plan ?? '').replace(/\r\n/g, '\n')).split('\n').map((l) => l.trim());
  const at = lines.findIndex((l) => CI_HEAD.test(l));
  if (at < 0) return [];
  const out = [];
  let open = false;
  for (const line of lines.slice(at + 1)) {
    if (/^#{1,6}[ \t]/.test(line)) break;
    const m = line.match(LIST_ITEM);
    if (!m) {
      if (open && line) out[out.length - 1] = cutCheck(`${out[out.length - 1]} ${line}`.replace(/\s+/g, ' '));
      else open = false;
      continue;
    }
    open = false;
    const text = (m[1] ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (out.length === CI_CHECKS) break;
    out.push(cutCheck(text));
    open = true;
  }
  return out;
}

// The planner's rule for them.
export const CI_RULE = `A check that only a CI run can show (CI green on another system, no warnings or annotations on a hosted runner, a deploy preview) is never a task's gate: the PR opens, and its CI runs, only once every task has passed. List such checks under a "${CI_HEADING.slice(3)}" section (a level-2 heading), one "- " line each. A task whose only check is one of them says so, and its writer reports \`TESTS: none-needed: checked by the PR's CI\`. Every task still runs the local tests it can.`;

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

// A writer's word that its task needed no change to any file: `CHANGES: none-needed: <why>`. { why } or { why: null }.
// The last such line outside fences counts; a reason of only punctuation is none.
const CHANGES = /^[ \t]*(?:[-*+][ \t]+)?[*_`]*CHANGES[*_`]*:[ \t*_`]*none-needed\b(.*)$/i;
export const CHANGES_LINE = 'If this task needs no change to any file, say why on its own line above your TESTS line: `CHANGES: none-needed: <why>`. A step that changes nothing without it is not done.';
export function changesOf(output) {
  let why = null;
  for (const { line } of outsideFences(String(output ?? ''))) {
    const m = line.match(CHANGES);
    if (m) {
      const said = whyOf(m[1]);
      why = said && /[\p{L}\p{N}]/u.test(said) ? said : null;
    }
  }
  return { why };
}

// Why a writer's step parks instead of going to review, or null when it may go on: only "passed", or
// "none-needed" with a reason (a none-needed with no reason parks; the reviewer can't weigh a reason never given).
// tests: testsOf's answer; who: the writer's name; n: the task's number.
export function testsParkReason(tests, who, n) {
  const { result, why } = tests ?? {};
  if (result === 'passed') return null;
  if (result === 'none-needed') return why && /[\p{L}\p{N}]/u.test(why) ? null : `${who} said no tests were needed for task ${n} but gave no reason`;
  // The writer ran them in its own sandbox, which may lack what they need (the full check runs on this machine).
  if (result === 'failed') return `Task ${n}'s tests failed in ${who}'s sandbox`;
  if (result === 'not-run') return `${who} didn't run task ${n}'s tests`;
  return `${who} didn't say whether task ${n}'s tests ran`;
}

// Quoted output in a prompt goes in a fence of its own, so an agent echoing the prompt never seems to say it.
const fenced = (text) => `${fenceFor(text)}\n${text}\n${fenceFor(text)}`;

// The person's notes on a ticket, as every later planner, writer and reviewer of it reads them: newest last, the oldest
// left out past NOTES_CHARS (one note always fits whole: the engine keeps each under it). Fenced like other quoted text,
// so a TESTS or VERDICT line in a note is never read as the agent's own. role: 'reviewer' is told not to fail work for
// following them. [] when the ticket has none.
export const NOTES_CHARS = 12_000;
export function notesSection(ticket, role = 'writer') {
  const notes = (ticket?.notes ?? []).filter((x) => (x?.kind ?? 'note') === 'note' && String(x?.text ?? '').trim());
  if (!notes.length) return [];
  const shown = [];
  let size = 0;
  for (const x of [...notes].reverse()) {
    const when = typeof x.at === 'string' && x.at.length >= 16 ? ` (${x.at.slice(0, 16).replace('T', ' ')} UTC)` : '';
    const line = `Note ${x.n}${when}: ${String(x.text).trim()}`;
    if (shown.length && size + line.length > NOTES_CHARS) break;
    shown.unshift(line);
    size += line.length;
  }
  const left = notes.length - shown.length;
  const weigh = role === 'reviewer'
    ? 'Judge the change with them in mind, and never fail the task for following one.'
    : 'Follow them.';
  return [
    '',
    "## The person's notes on this ticket",
    `The person running this sprint wrote these for ${ticket.key}. ${weigh} Where two disagree, the newer one counts.${left ? ` (${left} older note${left === 1 ? ' is' : 's are'} left out.)` : ''}`,
    fenced(shown.join('\n\n')),
  ];
}

// What the plan left to the PR's CI (CI_HEADING), as each writer and reviewer of the ticket reads it: none of it can run
// before the PR opens, so a writer never waits on it and a reviewer never fails a task for it. Fenced like the plan's own
// text, so a TESTS or VERDICT line in one is never an agent's answer. [] when the plan left nothing to CI.
export function ciSection(ticket, role = 'writer') {
  const checks = (ticket?.ciChecks ?? []).filter((x) => String(x ?? '').trim());
  if (!checks.length) return [];
  const weigh = role === 'reviewer'
    ? "Don't fail the task because these were not run: judge whether the change should make them pass, and the local tests the task names."
    : "Don't try to run these, and don't wait for them. Run the local tests the task names; if the task's only check is one of these, finish with `TESTS: none-needed: checked by the PR's CI`.";
  return [
    '',
    CI_HEADING,
    `The plan leaves these checks to the PR's CI, which runs only once every task has passed and the PR is open; Podium follows the CI for them then. ${weigh}`,
    fenced(checks.map((x) => `- ${String(x).trim()}`).join('\n')),
  ];
}

// Text that only points at a tracker: a bare ticket key, a lone URL, or "see KEY" (also "see ticket KEY", "see the
// ticket at <url>", "refer to KEY", "per KEY"), with at most a closing full stop. An agent that can't open the tracker
// learns nothing from it.
const POINTER = /^(?:(?:see|refer to|per|as in)\s+(?:the\s+)?(?:ticket\s+|issue\s+)?(?:at\s+|in\s+\S+\s+)?)?(?:[A-Z][A-Z0-9]*-\d+|https?:\/\/\S+)\s*[.!]?$/i;
export const pointerOnly = (text) => POINTER.test(String(text ?? '').trim());

// The tracker's text for a ticket, as each writer and reviewer reads it: agents that can't open the tracker have only this.
// Past SUMMARY_CHARS only its start is shown, and the prompt says so.
export const SUMMARY_CHARS = 8_000;
export function ticketSection(ticket) {
  const text = String(ticket?.summary ?? '').trim();
  const cut = text.length > SUMMARY_CHARS;
  return [
    '',
    '## The ticket',
    `${ticket.key}: ${ticket.title}`,
    ...(text
      ? [
          // Fenced like other quoted text, so a TESTS or VERDICT line in the ticket is never read as the agent's own.
          fenced(cut ? text.slice(0, SUMMARY_CHARS) : text),
          ...(cut ? [`(Cut: the ticket's text is ${text.length} characters; only its first ${SUMMARY_CHARS} are shown.)`] : []),
        ]
      : ['(No ticket text was given: work from the task below.)']),
  ];
}

const LIMIT = /usage limit|rate[ -]?limit(?:ed|s? (?:reached|exceeded|hit))|too many requests|\b(?:HTTP|status|error)[: ]+429\b|quota (?:exceeded|reached)|exceeded your (?:current )?quota|out of credits/i;
export function isUsageLimit(text) {
  return LIMIT.test(String(text ?? ''));
}

export function ticketBranch(type, key, title) {
  const kind = String(type ?? '').toLowerCase();
  return `${/^[a-z]+$/.test(kind) ? kind : 'feat'}/${String(key).toLowerCase()}-${slugOf(title)}`;
}

// The repo's task test as Podium last ran it on the host for this task, when it failed (or ran past its limit): the
// writer's next step sees what the host saw. [] otherwise.
export function hostFailure(ticket, task) {
  const h = ticket?.hostTest;
  if (!h || h.task !== task.n || h.state === 'passed') return [];
  return [
    '',
    `## Podium ran the repo's task test on this machine after the last step, and it ${h.state === 'timed-out' ? 'ran past its time limit' : 'failed'}`,
    ...(h.base?.state === 'passed' ? ["It passes at the ticket's base, before this task's change: this change broke it."] : []),
    'Podium runs it again after this step, and that run is the one that counts. The command, then its last lines:',
    // Both fenced: the command is a setting's text and the log the test's own output, neither ever the writer's TESTS line.
    fenced(String(h.command ?? '')),
    fenced(String(h.log ?? '').trim() || '(it printed nothing)'),
  ];
}

const DOTNET_INSTRUCTION = "If you build or test a .NET project, pass -p:UseSharedCompilation=false to dotnet build, dotnet test, or MSBuild. Keep Podium's temporary-folder settings so build files stay out of the ticket's changes.";

export function authorPrompt(ticket, task) {
  return [
    `${ticket.key} task ${task.n}: ${task.title}`,
    '',
    `This is one task of ${ticket.key} (${ticket.title}), worked one task at a time from its plan. Do only this task, and run the tests it names. A reviewer checks it before the next one starts.`,
    "Do not commit: Podium commits this task's changes itself. If the task below has a commit step, skip it.",
    CHANGES_LINE,
    ...ticketSection(ticket),
    '',
    '## This task',
    // Fenced, so a TESTS line or a stray fence in the plan's text is never read as the writer's own line, nor hides it.
    fenced(task.text),
    ...hostFailure(ticket, task),
    ...ciSection(ticket),
    ...notesSection(ticket),
    '',
    DOTNET_INSTRUCTION,
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
    CHANGES_LINE,
    ...ticketSection(ticket),
    '',
    '## The task',
    fenced(String(task.text ?? task.title)),
    '',
    '## The reviewer said',
    fenced(said),
    ...hostFailure(ticket, task),
    ...ciSection(ticket),
    ...notesSection(ticket),
    '',
    DOTNET_INSTRUCTION,
    '',
    TESTS_LINE,
  ].join('\n');
}

// A writer step that ended without its TESTS line: its agent, resumed in the same conversation, is asked for that line alone.
export function testsAskPrompt(ticket, task) {
  return [
    `${ticket.key} task ${task.n}: your TESTS line`,
    '',
    `Your last step on task ${task.n} (${task.title}) ended without its TESTS line, so Podium can't tell whether its tests ran. Change nothing now: only say how the tests you ran went, or that you didn't run them.`,
    '',
    TESTS_LINE,
  ].join('\n');
}

// What a reviewer is told about the task's tests: a pass on this machine counts over the writer's own run; failures that
// fail at the ticket's base too, and results the person accepted, are not held against the task; otherwise the writer's
// run must have passed. Commands, logs and reasons are fenced: none is ever read as the reviewer's verdict.
function testsLines({ tests, host, preexisting, accepted }) {
  if (host) {
    return [
      "Podium ran the repo's task test on this machine after this change, and it passed. The writer's own run (in its sandbox) may say otherwise: the result on this machine is the one that counts. The writer's report is below. The task test's command:",
      fenced(String(host.command ?? '')),
    ];
  }
  const lines = [];
  if (preexisting) {
    lines.push(
      "Podium ran the repo's task test on this machine after this change and it failed, but it fails at the ticket's base too, before this change. Fail the task only for failures this change caused: compare the two runs. The command, its last lines after this change, then at the base:",
      fenced(String(preexisting.command ?? '')),
      fenced(String(preexisting.log ?? '').trim() || '(it printed nothing)'),
      fenced(String(preexisting.baseLog ?? '').trim() || '(it printed nothing)'),
    );
  }
  if (accepted.length) {
    lines.push(
      "The person looked at this task's test results and accepted them, for the reasons quoted next: don't fail the task for those test results, and judge everything else. The writer's report is below.",
      fenced(accepted.map((x) => String(x).trim()).join('\n\n')),
    );
  } else if (preexisting) {
    lines.push("The writer's report is below.");
  } else {
    lines.push("The writer's report is below. Fail the task if its tests did not run or failed.");
    if (tests?.result === 'none-needed') lines.push(`The writer said this task needed no tests: ${tests.why ?? '(no reason given)'}. Fail the task if it needed tests.`);
  }
  return lines;
}

// report: the writer's output (its last REPORT_CHARS characters are shown); tests: what it said about its tests (testsOf);
// host: the repo's task test that passed on this machine on exactly this change ({ command }), whose result counts instead;
// accepted: the person's reasons for accepting this task's test results (Accept and continue), quoted;
// preexisting: the task test that failed on this machine after this change and also at the ticket's base
// ({ command, log, baseLog }): the reviewer fails the task only for failures this change caused.
// evidence: what the person gave the reviewer to weigh (Review again with evidence), quoted.
// changes: the writer's word that the task needed no change (changesOf), quoted for the reviewer to judge.
export function reviewerPrompt(ticket, task, diff, copy, { report = '', tests = null, host = null, preexisting = null, accepted = [], evidence = [], changes = null } = {}) {
  const text = String(diff ?? '');
  const shown = text.length > DIFF_LIMIT ? `${text.slice(0, DIFF_LIMIT)}\n… (cut: the whole change is in the copy)` : text;
  const reported = String(report ?? '').trim().slice(-REPORT_CHARS) || '(the writer said nothing)';
  return [
    `Review ${ticket.key} task ${task.n}: ${task.title}`,
    '',
    `Another agent just did this task. You are working in the ticket's own copy of the repo (${copy}), with the change in it. Run the tests you need to judge it: Podium puts the copy back as it was once your review is read, so leave the code itself as it is, and give your findings in your answer.`,
    "Judge the task's change (the diff) against the task. Ignore commit messages, commit steps and how the change was committed: Podium makes the commits, so never fail a task for them.",
    'Check the change against the task, and against what the ticket below asks of the part this task covers (its acceptance, where the task covers it; later tasks do the rest): is it complete and correct, and does it have the tests the task asks for? List problems by severity (high, medium, low), each with file:line.',
    'Say pass only if nothing needs fixing before the next task.',
    ...testsLines({ tests, host, preexisting, accepted }),
    ...(changes?.why
      ? [
          'The writer changed no files and said none were needed:',
          fenced(changes.why),
          'Pass only if the task itself says no change is needed, or asks only for a check that needs none; otherwise fail it.',
        ]
      : []),
    ...(evidence.length
      ? [
          'The person gave evidence about this change, quoted next. Weigh it before failing the task for tests you could not run.',
          fenced(evidence.map((x) => String(x).trim()).join('\n\n')),
        ]
      : []),
    DOTNET_INSTRUCTION,
    'End your answer with the verdict as the very last line, on its own: VERDICT: <pass or fail>. Put your findings above it.',
    ...ticketSection(ticket),
    '',
    '## The task',
    // Fenced, so a fence the task's text leaves open never takes in what follows (a note's VERDICT line, say).
    fenced(String(task.text ?? task.title)),
    ...ciSection(ticket, 'reviewer'),
    ...notesSection(ticket, 'reviewer'),
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
export function planPath(ticket, now = Date.now(), dir = 'docs/plans') {
  return `${dir}/${new Date(now).toISOString().slice(0, 10)}-${String(ticket.key).toLowerCase()}-${slugOf(ticket.title)}.md`;
}

export function planPrompt(ticket) {
  return [
    `${ticket.key}: write the plan`,
    '',
    `Write an implementation plan for ${ticket.key} (${ticket.title}) and save it as ${ticket.plan} in this folder. If you have a planning skill, use it within the rules below.`,
    'Start with a title and a short paragraph on the approach. Then split the work into tasks headed "### Task N: <title>" (### Task 1:, ### Task 2:, and so on). Podium runs them one at a time, each by an agent that sees only its own task, with a reviewer agent checking each one, so every task must stand on its own: its files, its code and its tests.',
    "Write each task so it is self-contained: never refer to the tracker, the ticket's key or \"the ticket\" for what to do, because the agent that runs the task may not be able to open the tracker. Copy what the task needs from the ticket below into the task itself.",
    'Podium commits each task itself once the task is done and reviewed, so the plan must not have commit steps, commit messages or co-author lines. Each task ends when its change and its checks are in place.',
    CI_RULE,
    'End the plan with a "## PR summary" section: two to four plain sentences for people outside the team, saying what the change does and why. Podium makes it the PR description and commit message, so leave out ticket keys, tracker or internal references, private product names or agent names.',
    'Write only the plan: change no other file, and leave it uncommitted. Podium commits it, and the person reads and approves it before any task starts.',
    '',
    '## The ticket',
    `${ticket.key}: ${ticket.title}`,
    ...(ticket.summary && String(ticket.summary).trim() ? ['', String(ticket.summary).trim()] : []),
    ...notesSection(ticket),
  ].join('\n');
}

export function revisePrompt(ticket, notes) {
  return [
    `${ticket.key}: change the plan`,
    '',
    `The person read the plan at ${ticket.plan} and asked for changes. Change the plan to answer them, keep its "### Task N:" headings, change no other file, and leave it uncommitted.`,
    'Podium commits each task itself, so the plan must not have commit steps, commit messages or co-author lines: take out any that are there.',
    CI_RULE,
    'Keep its "## PR summary" section true to the changed plan.',
    '',
    '## The person asked',
    notes && String(notes).trim() ? String(notes).trim() : '(no details)',
    ...notesSection(ticket),
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
  const { warn, attention, ack } = attentionNews(ticket);
  const ciLine = ticket.ciChecks?.length ? [`Left to the PR's CI (followed once the PR opens): ${ticket.ciChecks.join('; ')}.`] : [];
  const notes = asked && String(asked).trim() ? ` was changed after your notes ("${quoteOf(asked)}"),` : '';
  if (ticket.state === 'no-tasks') {
    let head = changed ? `${changed}, but Podium couldn't find tasks in it.` : `${ticket.key}'s plan is written, but Podium couldn't find tasks in it.`;
    if (warn) head = `${warn}, and${notes || ' is written,'} but Podium couldn't find tasks in it.`;
    return [
      head,
      about,
      `${read} whether to run the whole plan as one task or to change it. Podium splits a plan into tasks at its "### Task N:" headings.`,
      ...ciLine,
      ...attention,
      `To run it as one task: the sprint tool, action "one-task" (${ids})${ack}. ${change}`,
    ].join('\n');
  }
  const n = ticket.proposed.length;
  const count = `${n} task${n === 1 ? '' : 's'}`;
  const listed = ticket.proposed.slice(0, NEWS_TASKS).map((x) => `${x.n}. ${x.title}`).join('; ');
  const more = n > NEWS_TASKS ? `; and ${n - NEWS_TASKS} more` : '';
  return [
    warn ? `${warn}, and${notes ? notes.replace(/,$/, ':') : ' is ready:'} ${count}.` : `${changed ? `${changed}: ${count}` : `${ticket.key}'s plan is ready: ${count}`}.`,
    about,
    `${read} whether to approve it.`,
    `Its tasks: ${listed}${more}.`,
    ...ciLine,
    ...attention,
    `To approve: the sprint tool, action "approve" (${ids})${ack}. ${change}`,
  ].join('\n');
}

// How much of the first command the headline shows.
const HEAD_COMMAND_CHARS = 60;

// Production commands in a plan's tasks, for its news: the start of the headline the person sees (warn: a headline is cut
// short, and a batch of updates keeps only each one's first sentence), with the first of them; listed for Claude
// (attention); and approval takes acknowledge (ack).
function attentionNews(ticket) {
  const flagged = ticket.attention ?? [];
  const extra = ticket.attentionMore ?? 0;
  const k = flagged.length + extra;
  if (!k) return { warn: '', attention: [], ack: '' };
  const unlisted = extra ? ' Read the plan for the ones not listed here.' : '';
  // In double quotes (its own become single ones), so a full stop in it never ends the headline's first sentence.
  const first = String(flagged[0]?.command ?? '').replace(/"/g, "'");
  const named = first ? ` ("${first.length > HEAD_COMMAND_CHARS ? `${first.slice(0, HEAD_COMMAND_CHARS - 1)}…` : first}"${k > 1 ? ` and ${k - 1} more` : ''})` : '';
  return {
    warn: `${ticket.key}'s plan needs your attention: it runs ${k === 1 ? 'a production command' : `${k} production commands`}${named}`,
    attention: [`Needs your attention: ${attentionText(flagged, flagged.length, extra)}.${unlisted} Tell the person exactly which commands these are and that the agent would run them; go on only if they agree.`],
    ack: ', with acknowledge: true once the person has agreed to those commands',
  };
}

// What Claude is told when Sync with base changed a waiting plan: read it again. Its production commands, if any, as for a
// new plan: at the start of the headline (all the person may see), then listed, with how to approve.
export function syncedPlanNews(sprintId, ticket, base, where) {
  const { warn, attention, ack } = attentionNews(ticket);
  const read = `Read it again at ${where} before it is approved.`;
  if (!warn) return `${ticket.key}'s plan changed when ${base} was merged into its copy. ${read}`;
  const action = ticket.state === 'no-tasks' ? 'one-task' : 'approve';
  return [`${warn}, and changed when ${base} was merged into its copy.`, read, ...attention, `To approve: the sprint tool, action "${action}" (id ${sprintId}, ticket ${ticket.key})${ack}.`].join('\n');
}

// The production commands a plan runs, for a message: "task 2: supabase functions delete old-fn; …", each line once, at
// most `max` of them, then how many more (`extra` more are not in the list).
export function attentionText(list, max = 3, extra = 0) {
  const seen = new Set();
  const lines = (list ?? []).filter((x) => {
    const id = x.id ?? `${x.n}\0${x.command}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  const shown = lines.slice(0, max).map((x) => `task ${x.n}: ${x.command}`).join('; ');
  const more = Math.max(0, lines.length - max) + extra;
  return more ? `${shown}; and ${more} more` : shown;
}

// A sprint ticket's PR body, which is also its squashed commit's: the plan's PR summary, one line per task, and how it was
// tested. Never the tracker's text (it may hold notes for the team only), agent names or step numbers.
export function ticketPrBody(ticket, { summary = '', tested = '' } = {}) {
  const lead = String(summary ?? '').trim();
  const ci = (ticket.ciChecks ?? []).filter((x) => String(x ?? '').trim());
  return [
    ...(lead ? [lead, ''] : []),
    'Changes:',
    ...(ticket.tasks ?? []).map((x) => `- ${String(x.title).trim()}`),
    // What only the PR's CI can show: the PR's acceptance list, followed once it opens.
    ...(ci.length ? ['', "Checked by the PR's CI:", ...ci.map((x) => `- ${String(x).trim()}`)] : []),
    ...(tested ? ['', `Tested: ${tested}`] : []),
  ].join('\n');
}

// How a sprint ticket's change was tested, for its PR: that the repo's full check and task test passed, when it has them.
// Never their command lines, which may hold local paths or whatever a check writes.
export function testedLine({ check = null, taskTest = null } = {}) {
  if (check && taskTest) return "the repo's full check passed on the final change, and its task test after each task.";
  if (check) return "the repo's full check passed on the final change.";
  if (taskTest) return "the repo's task test passed after each task.";
  return 'each task ran its own tests before review.';
}

// The writer's fix when the repo's full check failed before the PR: the check's command and the end of its log.
export function checkFixPrompt(ticket, command, log) {
  const text = String(log ?? '').trim() || '(the check printed nothing)';
  return [
    `${ticket.key}: fix what the full check found`,
    '',
    `Every task of ${ticket.key} (${ticket.title}) passed its review, but the repo's full check failed in this copy before the PR could open. Fix what it found and keep the change small. The check is: ${command ?? '(not set)'}`,
    'Do not commit: Podium commits your fixes itself, then runs the full check again.',
    DOTNET_INSTRUCTION,
    '',
    '## The check printed (its last lines)',
    fenced(text),
    ...notesSection(ticket),
  ].join('\n');
}
