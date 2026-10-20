import path from 'node:path';
import { readJson, writeJsonAtomic } from './fsutil.js';
import { PodiumError } from './errors.js';
import { isFullPath } from './paths.js';

export const DEFAULT_SETTINGS = Object.freeze({
  retention: { compressDays: 30, deleteDays: 90 },
  longJobMinutes: 30,
  worktreeForEdits: true,
  worktreeWarnMB: 500,
  // The folder Podium makes its copies in; null for the default.
  worktreeRoot: null,
  tellClaudeWhenDone: true,
  defaultPermission: {},
  disabledAgents: [],
  pinned: [],
  instructions: '',
  repoInstructions: {},
  branchPattern: 'feat/{ticket}-{slug}',
  mergeMethod: 'merge',
  sprintParallel: 3,
  // Per repo, keyed by project like repoInstructions: commands agents may run while editing a copy, the full
  // check run before a sprint ticket's PR, the task test run after each writer step, whether a sprint ticket's commits
  // become one (default yes), a merge method that overrides the repo's own default, the folder sprint plans go in
  // (default docs/plans), and whether a sprint ticket's PR keeps its plan file (default no).
  repoCommands: {},
  repoCheck: {},
  repoTaskTest: {},
  repoSquash: {},
  repoMergeMethod: {},
  // Per repo: more phrases (plain text, like "deploy-prod") for commands a plan must not run without the person's say-so,
  // beside the built-in list (productionSteps in sprint-text.js).
  repoProdPatterns: {},
  repoPlanDir: {},
  repoKeepPlan: {},
  // Per repo: whether its PRs are public (true or false; unset asks GitHub), and phrases its PR text must never hold in
  // a public repo, like another product's name (plain text, like repoProdPatterns).
  repoPublic: {},
  repoPrivateTerms: {},
  // How long a full check (or a task test) may run before it counts as failed.
  checkMinutes: 30,
});

const fileOf = (root) => path.join(root, 'settings.json');

export function loadSettings(root) {
  const saved = readJson(fileOf(root), {});
  const base = structuredClone(DEFAULT_SETTINGS);
  return { ...base, ...saved, retention: { ...base.retention, ...(saved.retention ?? {}) } };
}

// A command agents may run is a plain word, so Claude's allow rule built from it always passes assertArg.
export const COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const MERGE_METHODS = ['merge', 'squash', 'rebase'];
// The longest a repo's full check may run, in minutes.
export const MAX_CHECK_MINUTES = 1440;
const CHECK_CHARS = 2000;
// The per-repo command lines the person confirms (in Settings, or a sprint draft's proposal saved at Start), run by the
// shell as typed: the key in the settings file, the draft's field, and what the line is called.
const REPO_LINES = [
  { key: 'repoCheck', field: 'check', name: 'The full check' },
  { key: 'repoTaskTest', field: 'taskTest', name: 'The task test' },
];
const REPO_KEYS = new Set(['repoCommands', 'repoSquash', 'repoMergeMethod', 'repoProdPatterns', 'repoPlanDir', 'repoKeepPlan', 'repoPublic', 'repoPrivateTerms', 'checkMinutes', ...REPO_LINES.map((l) => l.key)]);
const badSetting = (message) => new PodiumError('bad-setting', message);
const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// A shell is never an allowed command: allowing one would let an agent run anything through it.
const SHELL = /^(bash|sh|zsh|fish|pwsh|powershell|cmd)(\.exe)?$/i;
export const isShell = (name) => SHELL.test(String(name));
// A command name that may be allowed: a plain word, and not a shell.
const allowedName = (c) => typeof c === 'string' && COMMAND_NAME.test(c) && !isShell(c);

export function checkCommands(list) {
  if (!Array.isArray(list)) throw badSetting('Commands must be a list of command names, like ["dotnet"].');
  for (const c of list) {
    if (typeof c !== 'string' || !COMMAND_NAME.test(c)) {
      throw badSetting(`${JSON.stringify(c)} is not a plain command name. Use only letters, digits, dots, dashes and underscores, like dotnet or npm.`);
    }
    if (isShell(c)) throw badSetting(`${c} is a shell, and allowing it would let agents run anything. Name the commands they need instead, like dotnet or npm.`);
  }
  return [...new Set(list)];
}

export function checkLine(text, name = 'The full check') {
  if (typeof text !== 'string') throw badSetting(`${name} must be a command line, like "dotnet build && dotnet test".`);
  const line = text.trim();
  if (line.length > CHECK_CHARS) throw badSetting(`${name} is longer than ${CHECK_CHARS} characters.`);
  return line;
}

// A repo's own production patterns: at most PROD_PATTERNS plain-text phrases (never regular expressions, which a plan's
// text could make run for minutes), each of 1 to PROD_PATTERN_CHARS characters.
const PROD_PATTERNS = 20;
const PROD_PATTERN_CHARS = 200;
const prodPattern = (p) => typeof p === 'string' && Boolean(p.trim()) && p.length <= PROD_PATTERN_CHARS;
export function checkProdPatterns(list) {
  if (!Array.isArray(list)) throw badSetting('Production patterns must be a list of phrases, like ["deploy-prod"].');
  if (list.length > PROD_PATTERNS) throw badSetting(`At most ${PROD_PATTERNS} production patterns.`);
  for (const p of list) {
    if (!prodPattern(p)) throw badSetting(`Each production pattern must be a phrase of 1 to ${PROD_PATTERN_CHARS} characters, like "deploy-prod".`);
  }
  return list;
}

// A repo's private terms: at most PROD_PATTERNS plain-text phrases, each of 1 to PROD_PATTERN_CHARS characters.
export function checkPrivateTerms(list) {
  if (!Array.isArray(list)) throw badSetting('Private terms must be a list of phrases, like ["Nightjar"].');
  if (list.length > PROD_PATTERNS) throw badSetting(`At most ${PROD_PATTERNS} private terms.`);
  for (const p of list) {
    if (!prodPattern(p)) throw badSetting(`Each private term must be a phrase of 1 to ${PROD_PATTERN_CHARS} characters, like "Nightjar".`);
  }
  return list;
}

// A folder sprint plans go in: a non-empty path relative to the repo, forward slashes, no "..", so a plan
// always lands inside it.
const PLAN_DIR_CHARS = 200;
export function checkPlanDir(text) {
  if (typeof text !== 'string') throw badSetting('The plans folder must be a folder, like "docs/plans".');
  const trimmed = text.trim();
  if (!trimmed) throw badSetting('The plans folder cannot be empty.');
  if (trimmed.includes('\\')) throw badSetting('The plans folder must use forward slashes, like "docs/plans", not backslashes.');
  if (trimmed.startsWith('/') || /^[A-Za-z]:/.test(trimmed)) throw badSetting('The plans folder must be relative to the repo, like "docs/plans", not an absolute path.');
  if (trimmed.split('/').includes('..')) throw badSetting('The plans folder must stay inside the repo, with no "..", like "docs/plans".');
  // As git names it ("./docs//plans/" is "docs/plans"), so the plan's path matches what the copy's diffs say.
  const dir = path.posix.normalize(trimmed).replace(/\/+$/, '');
  if (!dir || dir === '.') throw badSetting('The plans folder must name a folder inside the repo, like "docs/plans".');
  if (dir.length > PLAN_DIR_CHARS) throw badSetting(`The plans folder is longer than ${PLAN_DIR_CHARS} characters.`);
  return dir;
}

// Every per-repo setting, checked before any of them is saved.
function checkRepoSettings(s) {
  for (const key of ['repoCommands', 'repoSquash', 'repoMergeMethod', 'repoProdPatterns', 'repoPlanDir', 'repoKeepPlan', 'repoPublic', 'repoPrivateTerms', ...REPO_LINES.map((l) => l.key)]) {
    if (!isMap(s[key])) throw badSetting(`"${key}" must give each repo its own value.`);
  }
  for (const list of Object.values(s.repoCommands)) checkCommands(list);
  for (const { key, name } of REPO_LINES) for (const line of Object.values(s[key])) checkLine(line, name);
  for (const list of Object.values(s.repoProdPatterns)) checkProdPatterns(list);
  for (const dir of Object.values(s.repoPlanDir)) checkPlanDir(dir);
  for (const on of Object.values(s.repoSquash)) {
    if (typeof on !== 'boolean') throw badSetting('"repoSquash" takes true or false for each repo.');
  }
  for (const on of Object.values(s.repoKeepPlan)) {
    if (typeof on !== 'boolean') throw badSetting('"repoKeepPlan" takes true or false for each repo.');
  }
  for (const on of Object.values(s.repoPublic)) {
    if (typeof on !== 'boolean') throw badSetting('"repoPublic" takes true or false for each repo.');
  }
  for (const list of Object.values(s.repoPrivateTerms)) checkPrivateTerms(list);
  for (const m of Object.values(s.repoMergeMethod)) {
    if (!MERGE_METHODS.includes(m)) throw badSetting(`The merge method must be one of: ${MERGE_METHODS.join(', ')}.`);
  }
  // A day at most: a check's time limit is a timer, and Node's timers overflow past about 24 days.
  if (!(Number.isFinite(s.checkMinutes) && s.checkMinutes > 0 && s.checkMinutes <= MAX_CHECK_MINUTES)) throw badSetting(`"checkMinutes" must be a number of minutes above 0 and at most ${MAX_CHECK_MINUTES} (a day).`);
}

// One repo's values, with the defaults filled in. The settings file may have been edited by hand, so each value
// is read as what it can safely mean: commands only the plain, non-shell names in a list; a known merge method (any case)
// or none; a command line (the full check, the task test) only a non-empty line; a plans folder only a valid one, else
// docs/plans; keeping the plan in PRs only a saved true; whether the repo is public only a saved true or false (else
// null: ask GitHub); private terms only phrases.
export function repoSettings(settings, project) {
  const commands = settings.repoCommands?.[project];
  const method = String(settings.repoMergeMethod?.[project] ?? '').toLowerCase();
  const lineOf = (key) => {
    const line = settings[key]?.[project];
    return typeof line === 'string' && line.trim() ? line.trim() : null;
  };
  return {
    commands: Array.isArray(commands) ? [...new Set(commands.filter(allowedName))] : [],
    ...Object.fromEntries(REPO_LINES.map(({ key, field }) => [field, lineOf(key)])),
    squash: settings.repoSquash?.[project] !== false,
    mergeMethod: MERGE_METHODS.includes(method) ? method : null,
    // Only phrases (a hand edit may have left others).
    prodPatterns: (Array.isArray(settings.repoProdPatterns?.[project]) ? settings.repoProdPatterns[project] : []).filter(prodPattern).slice(0, PROD_PATTERNS),
    planDir: validPlanDir(settings.repoPlanDir?.[project]),
    keepPlan: settings.repoKeepPlan?.[project] === true,
    public: typeof settings.repoPublic?.[project] === 'boolean' ? settings.repoPublic[project] : null,
    privateTerms: (Array.isArray(settings.repoPrivateTerms?.[project]) ? settings.repoPrivateTerms[project] : []).filter(prodPattern).slice(0, PROD_PATTERNS),
  };
}

// The saved plans folder, or the default when none was saved or a hand edit left an invalid one.
function validPlanDir(saved) {
  if (typeof saved !== 'string' || !saved.trim()) return 'docs/plans';
  try {
    return checkPlanDir(saved);
  } catch {
    return 'docs/plans';
  }
}

// A sprint draft's commands, command lines (check, taskTest), plans folder and whether PRs keep the plan, checked: only
// what was given. An empty folder is not checked: it removes the repo's own (see setRepoSettings).
export function repoInput(input = {}) {
  const out = {};
  if (input.commands !== undefined && input.commands !== null) out.commands = checkCommands(input.commands);
  for (const { field, name } of REPO_LINES) {
    if (input[field] !== undefined && input[field] !== null) out[field] = checkLine(input[field], name);
  }
  const { planDir } = input;
  if (planDir !== undefined && planDir !== null) out.planDir = (typeof planDir === 'string' && !planDir.trim()) ? '' : checkPlanDir(planDir);
  const { keepPlan } = input;
  if (keepPlan !== undefined && keepPlan !== null) {
    if (typeof keepPlan !== 'boolean') throw badSetting('keepPlan takes true or false.');
    out.keepPlan = keepPlan;
  }
  return out;
}

// Save a draft's commands, command lines, plans folder and whether PRs keep the plan for its repo. An empty line or
// folder removes it, as false does keeping the plan (the default). Returns what was saved.
export function setRepoSettings(root, project, input) {
  const values = repoInput(input);
  if (!Object.keys(values).length) return values;
  const settings = loadSettings(root);
  if (values.commands) settings.repoCommands = { ...settings.repoCommands, [project]: values.commands };
  for (const { key, field } of REPO_LINES) {
    if (values[field] === undefined) continue;
    const next = { ...settings[key] };
    if (values[field]) next[project] = values[field];
    else delete next[project];
    settings[key] = next;
  }
  if (values.planDir !== undefined) {
    const next = { ...settings.repoPlanDir };
    if (values.planDir) next[project] = values.planDir;
    else delete next[project];
    settings.repoPlanDir = next;
  }
  if (values.keepPlan !== undefined) {
    const next = { ...settings.repoKeepPlan };
    if (values.keepPlan) next[project] = true;
    else delete next[project];
    settings.repoKeepPlan = next;
  }
  writeJsonAtomic(fileOf(root), settings);
  return values;
}

export function setSetting(root, key, value) {
  const parts = key.split('.');
  if (!(parts[0] in DEFAULT_SETTINGS)) throw new PodiumError('unknown-setting', `Unknown setting "${key}".`);
  if (key === 'worktreeRoot') {
    if (value === null || value === '') value = null;
    else if (!isFullPath(value)) throw badSetting(`The copies folder must be a full path, like ${process.platform === 'win32' ? 'C:\\podium-copies' : '/Users/me/podium-copies'}.`);
  }
  const settings = loadSettings(root);
  let node = settings;
  for (const part of parts.slice(0, -1)) {
    if (typeof node[part] !== 'object' || node[part] === null) node[part] = {};
    node = node[part];
  }
  node[parts.at(-1)] = value;
  // Per-repo values are checked before anything is written.
  if (REPO_KEYS.has(parts[0])) checkRepoSettings(settings);
  writeJsonAtomic(fileOf(root), settings);
  return settings;
}
