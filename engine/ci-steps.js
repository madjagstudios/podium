// What a repo's GitHub Actions workflows run, and how that compares with the
// check that will apply and the merge method its sprint PRs will use.
import fs from 'node:fs';
import path from 'node:path';
import { ghJson } from './gh.js';
import { pickMethod, wantedMethod, allowedMethods } from './pr.js';

// A key without surrounding quotes: `'run':` and `"run":` count as `run:`.
const keyNameOf = (raw) => {
  const t = String(raw ?? '').trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) return t.slice(1, -1);
  return t;
};

// A quoted value (`"npm test"` or `'npm test'`, with an optional comment after it), unquoted; null when the value is not
// quoted. Inside double quotes a backslash escapes (`\n` is a new line, `\t` a tab, `\"` a quote); inside single quotes
// `''` is one quote.
const ESCAPED = { n: '\n', t: '\t', r: '\r' };
const quotedValue = (value) => {
  const t = String(value ?? '').trim();
  const q = t[0];
  if (q !== '"' && q !== "'") return null;
  let out = '';
  for (let k = 1; k < t.length; k++) {
    const c = t[k];
    if (q === '"' && c === '\\' && k + 1 < t.length) { out += ESCAPED[t[k + 1]] ?? t[k + 1]; k++; continue; }
    if (c === q) {
      if (q === "'" && t[k + 1] === "'") { out += "'"; k++; continue; }
      const rest = t.slice(k + 1).trim();
      return !rest || rest.startsWith('#') ? out : null;
    }
    out += c;
  }
  return null;
};

// Where a comment starts in a line: the first `#` at its start or right after whitespace; -1 when there is none.
const commentAt = (s) => {
  for (let at = s.indexOf('#'); at !== -1; at = s.indexOf('#', at + 1)) if (at === 0 || /\s/.test(s[at - 1])) return at;
  return -1;
};

// A `#` starts a comment only after whitespace, and only in an unquoted value.
const stripComment = (value) => {
  const t = String(value ?? '').trim();
  const quoted = quotedValue(t);
  if (quoted !== null) return quoted;
  const at = commentAt(t);
  return at <= 0 ? (at === 0 ? '' : t) : t.slice(0, at).trimEnd();
};

const collapse = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const splitCommands = (s) => String(s ?? '').split(/&&|\|\||;/).map(collapse).filter(Boolean);
const isCd = (part) => part === 'cd' || part.startsWith('cd ');

// Where a command runs: { dir, shown }. dir is a folder relative to the repo's top ('.' for the top), or null when Podium
// can't know it (`cd -`, `cd ~`, `cd $DIR`, an absolute path, one above the top); shown is how it is written, so a folder
// that can't be known stays as the workflow says it.
const TOP = { dir: '.', shown: '.' };
// Bounds that keep the scan linear on any file: a folder longer than this counts as one Podium can't know, and a line
// longer than MAX_LINE_CHARS is left out (no real workflow line comes near either).
const MAX_FOLDER_CHARS = 1000;
const MAX_LINE_CHARS = 1000;
const PLAIN_FOLDER = /^[\w.@+-][\w./@+-]*$/;
function moveTo(at, target) {
  const raw = String(target ?? '').trim();
  const t = quotedValue(raw) ?? raw;
  if (!t || t === '-' || at.dir === null || !PLAIN_FOLDER.test(t) || at.dir.length + t.length > MAX_FOLDER_CHARS) {
    if (at.dir === null) return at.shown.length > MAX_FOLDER_CHARS ? at : { dir: null, shown: `${at.shown}/${t || '~'}` };
    return { dir: null, shown: t || '~' };
  }
  const next = path.posix.normalize(path.posix.join(at.dir, t)).replace(/\/+$/, '') || '.';
  if (next === '..' || next.startsWith('../')) return { dir: null, shown: next };
  return { dir: next, shown: next };
}
// Each `cd` of a command, applied in order from `at`.
const after = (command, at) => splitCommands(command).filter(isCd).reduce((here, part) => moveTo(here, part.slice(2)), at);

// The shell commands of a workflow file's run steps. A line-based scan by design, not a YAML parser: a `run:` key of a
// step holds one command or a block of them. Only a `run:` inside a `steps:` list counts, on a step's own dash line
// (`- run: ...`) or at the same column as the step's first key; deeper keys (action inputs under `with:`) and lines
// inside another key's block never do. A step's commands share one shell, in its folder: the step's `working-directory`,
// else the one `defaults: run: working-directory` sets for its job or workflow, moved by each `cd` as a shell would. A
// command that runs anywhere but the repo's top is given as `cd <folder> && <command>`.
export function workflowRuns(text) {
  const runs = [];
  const lines = String(text ?? '').split(/\r?\n/).map((line) => (line.length > MAX_LINE_CHARS ? '' : line));
  const indentOf = (line) => line.match(/^\s*/)[0].length;
  // A block header (`|`, `>`, with `-`/`+`): a trailing comment is allowed.
  const headerOf = (rest) => rest.match(/^([>|][+-]?)(?:\s+#.*)?$/)?.[1] ?? null;
  // The block under a key at keyCol ends at the first non-empty line at or left of the key. Returns that line's index.
  const blockEnd = (from, keyCol) => {
    let j = from;
    for (; j < lines.length; j++) {
      if (!lines[j].trim()) continue;
      if (indentOf(lines[j]) <= keyCol) break;
    }
    return j;
  };
  // The commands of one run value: a folded block (`>`) joins each run of lines between blank lines; a literal block (`|`)
  // is one command per line, a line ending in `\` joining the next; a plain or quoted value is one command, a plain one
  // joined with its continuation lines. Returns { commands, end }.
  const readRun = (rest, keyCol, from) => {
    const commands = [];
    const header = headerOf(rest.trim());
    if (header) {
      const end = blockEnd(from + 1, keyCol);
      if (header.startsWith('>')) {
        let group = [];
        const flushGroup = () => { if (group.length) commands.push(group.join(' ')); group = []; };
        for (let k = from + 1; k < end; k++) {
          const trimmed = lines[k].trim();
          if (!trimmed) flushGroup();
          else if (!trimmed.startsWith('#')) group.push(trimmed);
        }
        flushGroup();
      } else {
        let held = '';
        for (let k = from + 1; k < end; k++) {
          const trimmed = lines[k].trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          if (trimmed.endsWith('\\')) {
            held = held ? `${held} ${trimmed.slice(0, -1).trimEnd()}` : trimmed.slice(0, -1).trimEnd();
          } else {
            commands.push(held ? `${held} ${trimmed}` : trimmed);
            held = '';
          }
        }
        if (held) commands.push(held);
      }
      return { commands, end };
    }
    const quoted = quotedValue(rest);
    if (quoted !== null) {
      // Lines of a quoted value (`"npm ci\nnpm test"`) are commands of their own, as in a literal block.
      for (const command of quoted.split(/\r?\n/).map((l) => l.trim())) if (command) commands.push(command);
      return { commands, end: from + 1 };
    }
    const end = blockEnd(from + 1, keyCol);
    const parts = [];
    const first = stripComment(rest);
    if (first) parts.push(first);
    for (let k = from + 1; k < end; k++) {
      const trimmed = lines[k].trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const next = stripComment(trimmed);
      if (next) parts.push(next);
    }
    if (parts.length) commands.push(parts.join(' '));
    return { commands, end };
  };

  // The keys enclosing the current line ({ col, name, line }). The folders `defaults: run: working-directory` sets, by the
  // line of the job key holding that `defaults:`, and the workflow's own: keys may come in any order, so they are matched
  // to the steps once the whole file is read. The first one written counts.
  const stack = [];
  const jobDefaults = new Map();
  let workflowDefault = null;
  const steps = [];
  let stepsCol = null;
  let stepCol = null;
  // The line of the key holding the open `steps:` (its job), or null at the top.
  let stepsHolder = null;
  // The current step: its job's line, its commands and its own working-directory.
  let step = null;
  const endStep = () => {
    if (step) steps.push(step);
    step = null;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) { i++; continue; }
    const indent = indentOf(line);
    const dash = line.match(/^(\s*)-\s+(.*)$/);
    const rest = dash ? dash[2] : trimmed;
    const keyCol = dash ? line.length - dash[2].length : indent;
    // A key ends at the line's first colon.
    const colon = rest.indexOf(':');
    const keyed = colon > 0 && rest.slice(0, colon).trim() ? [rest, rest.slice(0, colon).trimEnd(), rest.slice(colon + 1)] : null;
    const keyName = keyed ? keyNameOf(keyed[1]) : null;
    // A steps list may sit at the `steps:` key's own column (`steps:` then `- run: ...` under it, unindented).
    if (stepsCol !== null && (indent < stepsCol || (indent === stepsCol && !dash))) { endStep(); stepsCol = null; stepCol = null; }
    if (stepsCol !== null && dash && indent >= stepsCol && (stepCol === null || indent <= stepCol - 2)) {
      endStep();
      stepCol = keyCol;
      step = { holder: stepsHolder, commands: [], dir: null };
    }
    if (stepsCol !== null && !dash && stepCol !== null && indent < stepCol) { endStep(); stepCol = null; }
    while (stack.length && stack.at(-1).col >= keyCol) stack.pop();
    if (keyName) stack.push({ col: keyCol, name: keyName, line: i });
    // A `steps:` key with no inline value opens a steps list; any other dash list (`on:`, `matrix:` entries) never holds steps.
    if (keyName === 'steps' && !stripComment(keyed[2])) {
      endStep();
      stepsCol = keyCol;
      stepCol = null;
      stepsHolder = stack.at(-2)?.line ?? null;
      i++;
      continue;
    }
    const inStep = stepsCol !== null && stepCol !== null && keyCol === stepCol && step;
    if (keyName === 'run' && inStep) {
      const { commands, end } = readRun(keyed[2], keyCol, i);
      for (const command of commands) step.commands.push(command);
      i = end;
      continue;
    }
    if (keyName === 'working-directory') {
      const dir = stripComment(keyed[2]);
      if (inStep) step.dir = dir || null;
      // `defaults: run: working-directory: x`, for the job or the workflow that holds that `defaults:`.
      if (!inStep && dir && stack.at(-2)?.name === 'run' && stack.at(-3)?.name === 'defaults') {
        const holder = stack.at(-4);
        if (!holder) workflowDefault ??= dir;
        else if (!jobDefaults.has(holder.line)) jobDefaults.set(holder.line, dir);
      }
    }
    // Another key's block is skipped wherever it sits, so its lines are never read as keys.
    if (keyed && headerOf(keyed[2].trim())) {
      i = blockEnd(i + 1, keyCol);
      continue;
    }
    i++;
  }
  endStep();
  for (const s of steps) {
    const start = s.dir ?? jobDefaults.get(s.holder) ?? workflowDefault;
    let at = start ? moveTo(TOP, start) : TOP;
    for (const command of s.commands) {
      if (!splitCommands(command).every(isCd)) runs.push(at.shown === '.' ? command : `cd ${at.shown} && ${command}`);
      at = after(command, at);
    }
  }
  return runs;
}

const SETUP_WORDS = ['npm ci', 'npm install', 'pnpm install', 'yarn install', 'echo', 'cd', 'git config'];
// Setup, not a check: a whole-word setup command that pipes into nothing (`echo … | jq -e …` is a check).
const isSetup = (part) => !part.includes('|') && SETUP_WORDS.some((word) => part === word || part.startsWith(`${word} `));

// Each command of a line with the folder it runs in, walking its `cd`s from the repo's top: "folder|command", or null for
// a folder Podium can't know (which never matches).
function placed(line) {
  let at = TOP;
  const out = [];
  for (const part of splitCommands(line)) {
    if (isCd(part)) { at = moveTo(at, part.slice(2)); continue; }
    out.push({ part, key: at.dir === null ? null : `${at.dir}|${part}` });
  }
  return out;
}

function nameList(items, wrap = (r) => `\`${r}\``) {
  const parts = items.map(wrap);
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

// Notes about CI steps the check does not cover, and about the merge method GitHub will use when it differs from the one
// Podium is set to use. A CI command is covered only when the check runs the same command in the same folder.
export function ciNotes({ runs = [], check = null, wanted = null, used = null, allowed = null } = {}) {
  const notes = [];
  // The check is a shell line: a `#` that starts a word comments out the rest of it.
  const fullCheck = String(check ?? '');
  const hash = commentAt(fullCheck);
  const checkLine = hash === -1 ? fullCheck : fullCheck.slice(0, hash);
  const covered = new Set(placed(checkLine).map((p) => p.key).filter(Boolean));
  if (splitCommands(checkLine).length) {
    const seen = new Set();
    const uncovered = [];
    for (const run of runs ?? []) {
      const line = collapse(run);
      if (!line || seen.has(line)) continue;
      seen.add(line);
      const checks = placed(line).filter((p) => !isSetup(p.part));
      if (!checks.length || checks.every((p) => p.key && covered.has(p.key))) continue;
      uncovered.push(line);
    }
    if (uncovered.length) {
      const shown = uncovered.slice(0, 5);
      const extra = uncovered.length - shown.length;
      const list = extra > 0 ? `${shown.map((r) => `\`${r}\``).join(', ')} and ${extra} more` : nameList(shown);
      notes.push(`The repo's CI also runs ${list}, which the full check doesn't, so failures there would show up only after the PRs open. If the person wants them caught first, propose adding them to the check.`);
    }
  }
  if (wanted && used && used !== wanted && Array.isArray(allowed) && allowed.length) {
    const allowedText = allowed.length === 1 ? `${allowed[0]} merges` : nameList(allowed, (m) => m);
    notes.push(`GitHub allows only ${allowedText} for this repo, so the sprint's PRs will merge by ${used}, not ${wanted}. To make that explicit, set This repo's merge method to ${used} in Podium's Settings.`);
  }
  return notes;
}

// Read a repo's workflow runs and GitHub merge settings, and say how they
// compare with the check that will apply and the chosen merge method. Any failure
// reading workflows or asking GitHub gives fewer notes, never an error.
export const MAX_WORKFLOW_BYTES = 256_000;
export async function repoCiNotes(repo, settings, project, { env = process.env, check = null } = {}) {
  const runs = [];
  try {
    const dir = path.join(repo, '.github', 'workflows');
    const files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/i.test(f)).sort();
    for (const file of files) {
      try {
        const full = path.join(dir, file);
        // A workflow file is a few kilobytes; one far past that is not read, so a draft never waits on it.
        if (fs.statSync(full).size > MAX_WORKFLOW_BYTES) continue;
        for (const run of workflowRuns(fs.readFileSync(full, 'utf8'))) runs.push(run);
      } catch { /* one unreadable file leaves out only its runs */ }
    }
  } catch { /* no workflows folder means no runs */ }

  let methods = null;
  try {
    // A short limit: the draft is already saved, and a stalled lookup must not fail its answer.
    methods = await ghJson(['repo', 'view', '--json', 'viewerDefaultMergeMethod,mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed'], { cwd: repo, env, timeoutMs: 10_000 });
  } catch {
    methods = null;
  }

  if (!methods) return ciNotes({ runs, check, wanted: null, used: null, allowed: null });
  const job = { project, pr: { methods } };
  return ciNotes({ runs, check, wanted: wantedMethod(settings, job), used: pickMethod(settings, job), allowed: allowedMethods(methods) });
}
