import fs from 'node:fs';
import path from 'node:path';
import { BUILTIN_ADAPTERS, PERMISSIONS } from './builtin.js';
import { readJson, writeJsonAtomic } from '../fsutil.js';
import { PodiumError } from '../errors.js';
import { assertArg } from '../launch.js';

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function validateAdapter(a) {
  if (!a || typeof a !== 'object') return ['Adapter must be an object.'];
  const errors = [];
  const check = (ok, message) => { if (!ok) errors.push(message); };
  check(NAME.test(a.name ?? ''), 'name must be lowercase letters, digits or dashes (up to 40).');
  check(typeof a.label === 'string' && a.label.trim() !== '', 'label is required.');
  check(typeof a.command === 'string' && a.command.trim() !== '', 'command is required.');
  check(Array.isArray(a.baseArgs), 'baseArgs must be a list.');
  check(['stdin', 'file'].includes(a.promptVia), 'promptVia must be "stdin" or "file".');
  if (a.promptVia === 'file') check(typeof a.promptFileFlag === 'string', 'promptFileFlag is required when promptVia is "file".');
  check(a.permissions && PERMISSIONS.every((p) => Array.isArray(a.permissions[p])), `permissions must list arguments for each of: ${PERMISSIONS.join(', ')}.`);
  const rulesOf = (al) => (Array.isArray(al.rules) ? al.rules : [al.rule]);
  check(!a.allow || (typeof a.allow.flag === 'string' && rulesOf(a.allow).length > 0 && rulesOf(a.allow).every((x) => typeof x === 'string' && x.includes('{cmd}'))), 'allow needs a flag and rules that each contain {cmd}.');
  if (errors.length) return errors;
  const tokens = [
    a.command, ...a.baseArgs, ...PERMISSIONS.flatMap((p) => a.permissions[p]),
    ...[a.modelFlag, a.promptFileFlag, a.stdinArg].filter(Boolean),
    ...(a.versionArgs ?? []), ...(a.authCheckArgs ?? []),
    ...(a.allow ? [a.allow.flag, ...rulesOf(a.allow)] : []),
  ];
  for (const token of tokens) {
    try { assertArg(token); } catch (e) { errors.push(e.message); }
  }
  return errors;
}

const adaptersDir = (root) => path.join(root, 'adapters');

export function loadAdapters(root) {
  const adapters = new Map(BUILTIN_ADAPTERS.map((a) => [a.name, { ...a, source: 'builtin' }]));
  const errors = [];
  const dir = adaptersDir(root);
  if (fs.existsSync(dir)) {
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      let a;
      try { a = readJson(path.join(dir, file)); } catch (e) { errors.push({ file, errors: [e.message] }); continue; }
      const problems = validateAdapter(a);
      if (problems.length) { errors.push({ file, errors: problems }); continue; }
      adapters.set(a.name, { ...a, source: 'user' });
    }
  }
  return { adapters, errors };
}

export function getAdapter(root, name) {
  const a = loadAdapters(root).adapters.get(name);
  if (!a) throw new PodiumError('unknown-agent', `No agent called "${name}".`);
  return a;
}

export function saveAdapter(root, adapter) {
  const problems = validateAdapter(adapter);
  if (problems.length) throw new PodiumError('invalid-adapter', problems.join(' '), { errors: problems });
  const { source, ...clean } = adapter;
  writeJsonAtomic(path.join(adaptersDir(root), `${adapter.name}.json`), clean);
  return { ...clean, source: 'user' };
}
