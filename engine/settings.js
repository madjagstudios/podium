import path from 'node:path';
import { readJson, writeJsonAtomic } from './fsutil.js';
import { PodiumError } from './errors.js';

export const DEFAULT_SETTINGS = Object.freeze({
  retention: { compressDays: 30, deleteDays: 90 },
  longJobMinutes: 30,
  worktreeForEdits: true,
  worktreeWarnMB: 500,
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
  // check run before a sprint ticket's PR, whether a sprint ticket's commits become one (default yes), and a merge
  // method that overrides the repo's own default.
  repoCommands: {},
  repoCheck: {},
  repoSquash: {},
  repoMergeMethod: {},
  // How long a full check may run before it counts as failed.
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
const REPO_KEYS = new Set(['repoCommands', 'repoCheck', 'repoSquash', 'repoMergeMethod', 'checkMinutes']);
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

export function checkLine(text) {
  if (typeof text !== 'string') throw badSetting('The full check must be a command line, like "dotnet build && dotnet test".');
  const line = text.trim();
  if (line.length > CHECK_CHARS) throw badSetting(`The full check is longer than ${CHECK_CHARS} characters.`);
  return line;
}

// Every per-repo setting, checked before any of them is saved.
function checkRepoSettings(s) {
  for (const key of ['repoCommands', 'repoCheck', 'repoSquash', 'repoMergeMethod']) {
    if (!isMap(s[key])) throw badSetting(`"${key}" must give each repo its own value.`);
  }
  for (const list of Object.values(s.repoCommands)) checkCommands(list);
  for (const line of Object.values(s.repoCheck)) checkLine(line);
  for (const on of Object.values(s.repoSquash)) {
    if (typeof on !== 'boolean') throw badSetting('"repoSquash" takes true or false for each repo.');
  }
  for (const m of Object.values(s.repoMergeMethod)) {
    if (!MERGE_METHODS.includes(m)) throw badSetting(`The merge method must be one of: ${MERGE_METHODS.join(', ')}.`);
  }
  // A day at most: a check's time limit is a timer, and Node's timers overflow past about 24 days.
  if (!(Number.isFinite(s.checkMinutes) && s.checkMinutes > 0 && s.checkMinutes <= MAX_CHECK_MINUTES)) throw badSetting(`"checkMinutes" must be a number of minutes above 0 and at most ${MAX_CHECK_MINUTES} (a day).`);
}

// One repo's values, with the defaults filled in. The settings file may have been edited by hand, so each value
// is read as what it can safely mean: commands only the plain, non-shell names in a list; a known merge method (any case)
// or none; a check only a non-empty line.
export function repoSettings(settings, project) {
  const commands = settings.repoCommands?.[project];
  const method = String(settings.repoMergeMethod?.[project] ?? '').toLowerCase();
  const check = settings.repoCheck?.[project];
  return {
    commands: Array.isArray(commands) ? [...new Set(commands.filter(allowedName))] : [],
    check: typeof check === 'string' && check.trim() ? check.trim() : null,
    squash: settings.repoSquash?.[project] !== false,
    mergeMethod: MERGE_METHODS.includes(method) ? method : null,
  };
}

// A sprint draft's commands and check, checked: only what was given.
export function repoInput({ commands, check } = {}) {
  const out = {};
  if (commands !== undefined && commands !== null) out.commands = checkCommands(commands);
  if (check !== undefined && check !== null) out.check = checkLine(check);
  return out;
}

// Save a draft's commands and check for its repo. An empty check removes it. Returns what was saved.
export function setRepoSettings(root, project, input) {
  const values = repoInput(input);
  if (!Object.keys(values).length) return values;
  const settings = loadSettings(root);
  if (values.commands) settings.repoCommands = { ...settings.repoCommands, [project]: values.commands };
  if (values.check !== undefined) {
    const next = { ...settings.repoCheck };
    if (values.check) next[project] = values.check;
    else delete next[project];
    settings.repoCheck = next;
  }
  writeJsonAtomic(fileOf(root), settings);
  return values;
}

export function setSetting(root, key, value) {
  const parts = key.split('.');
  if (!(parts[0] in DEFAULT_SETTINGS)) throw new PodiumError('unknown-setting', `Unknown setting "${key}".`);
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
