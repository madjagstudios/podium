import { PERMISSIONS } from './builtin.js';
import { PodiumError } from '../errors.js';
import { assertArg } from '../launch.js';
import { COMMAND_NAME } from '../settings.js';

const fill = (list, id) => list.map((a) => assertArg(a.split('{id}').join(id)));

export function buildInvocation(adapter, { permission, model, promptFile, session = null, allow = [] }) {
  if (!PERMISSIONS.includes(permission)) {
    throw new PodiumError('bad-permission', `Unknown permission level "${permission}". Use one of: ${PERMISSIONS.join(', ')}.`);
  }
  const resume = adapter.resume ?? null;
  const cont = session?.mode === 'continue' ? resume?.continue ?? null : null;
  const modelArgs = [];
  if (model) {
    if (!adapter.modelFlag) throw new PodiumError('no-model-flag', `${adapter.label} has no model option configured.`);
    modelArgs.push(adapter.modelFlag, assertArg(model));
  }
  // The repo's commands: only at edit-worktree, and only for an adapter that says how to allow them (Claude).
  // A stored name that is not a plain word (a hand-edited settings.json) is dropped, never passed on.
  // A stored value that is not a list is ignored. The flag goes once, then each rule template for each command.
  const names = (Array.isArray(allow) ? allow : []).filter((cmd) => typeof cmd === 'string' && COMMAND_NAME.test(cmd));
  const rules = adapter.allow ? adapter.allow.rules ?? [adapter.allow.rule] : [];
  const allowArgs = permission === 'edit-worktree' && rules.length && names.length
    ? [assertArg(adapter.allow.flag), ...names.flatMap((cmd) => rules.map((rule) => assertArg(rule.split('{cmd}').join(cmd))))]
    : [];
  let args;
  if (cont?.command) {
    // A resume command replaces the base command; the prompt goes last, through stdin.
    args = [...cont.command, ...(cont.permissions?.[permission] ?? []), ...allowArgs, ...modelArgs, ...fill(cont.tail ?? [], session.id)];
    return { command: adapter.command, args, stdin: true };
  }
  const sessionArgs = session?.mode === 'start' && resume?.start ? fill(resume.start, session.id)
    : cont?.args ? fill(cont.args, session.id) : [];
  args = [...adapter.baseArgs, ...sessionArgs, ...adapter.permissions[permission], ...allowArgs, ...modelArgs];
  if (adapter.promptVia === 'file') args.push(adapter.promptFileFlag, promptFile);
  else if (adapter.stdinArg) args.push(adapter.stdinArg);
  return { command: adapter.command, args, stdin: adapter.promptVia === 'stdin' };
}

const WORDS = {
  'read-only': 'will only read files',
  'edit-worktree': 'can edit files in a separate copy of your repo',
  'own-config': 'will use its own settings',
  'full-access': 'will run with full access and no safety checks',
};

export function permissionText(adapter, permission) {
  return `${adapter.label} ${WORDS[permission] ?? `will use "${permission}"`}`;
}

export function unattendedWarning(adapter, permission) {
  const risk = adapter.unattended?.[permission];
  return risk ? { code: `unattended-${risk.kind}`, message: risk.message } : null;
}
