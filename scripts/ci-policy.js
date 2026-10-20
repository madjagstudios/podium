import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const docs = (file) => ['README.md', 'CHANGELOG.md', 'AGENTS.md', 'CLAUDE.md'].includes(file) || /^docs\/.+\.md$/.test(file);
const regular = (mode) => ['000000', '100644'].includes(mode);
const contextValue = (value, key) => {
  const actual = value && typeof value === 'object' ? Object.keys(value).find(k => k.toLowerCase() === key) : undefined;
  return actual === undefined ? undefined : value[actual];
};
export function ciPlan(eventName, event, changes) {
  const action = contextValue(event, 'action');
  if (eventName === 'pull_request' && typeof action === 'string' && action.toLowerCase() === 'edited') {
    // Match native case-insensitive context/JSON comparisons and missing-property empty strings.
    const json = value => JSON.stringify(value === undefined ? '' : value).toLowerCase();
    const fields = contextValue(event, 'changes');
    const from = key => contextValue(contextValue(fields, key), 'from');
    const metadata = [['title'], ['body'], ['title', 'body'], ['body', 'title']].some(keys => json(fields) === json(Object.fromEntries(keys.map(key => [key, { from: from(key) === undefined ? '' : from(key) }]))));
    if (metadata) {
      return { kind: 'metadata', full: false, metadataOnly: true, reason: 'Title/body edit: existing code-validation checks remain authoritative' };
    }
    return { kind: 'validation', full: true, metadataOnly: false, reason: 'Base retarget or uncertain edited event requires full validation' };
  }
  if (eventName !== 'pull_request') return { kind: 'validation', full: true, reason: 'Full validation requested' };
  if (event.pull_request?.draft === true) return { kind: 'deferred', full: false, reason: 'Draft deferred: full validation runs when ready for review' };
  if (event.pull_request?.draft !== false) return { kind: 'validation', full: true, reason: 'Uncertain PR state' };
  if (Array.isArray(changes) && changes.length && changes.every((c) => c && docs(c.path) && regular(c.oldMode) && regular(c.newMode))) {
    return { kind: 'validation', full: false, reason: 'Only regular documentation files changed across the entire PR' };
  }
  return { kind: 'validation', full: true, reason: 'Code, configuration or uncertain changes' };
}
export function ciPassed(planResult, full, testResult, kind, expectedKind, workflowKind) {
  if (planResult !== 'success' || kind !== expectedKind || kind !== workflowKind || !['validation', 'deferred', 'metadata'].includes(kind)) return false;
  if (full === 'true') return kind === 'validation' && testResult === 'success';
  return full === 'false' && testResult === 'skipped';
}
export function prChanges(base, head, cwd = process.cwd()) {
  if (![base, head].every((s) => /^[a-f0-9]{40}$/.test(s))) throw new Error('Invalid commit identity');
  // No rename folding: both the removed source and added destination must be safe.
  const raw = execFileSync('git', ['diff', '--raw', '-z', '--no-renames', `${base}...${head}`, '--'], { cwd, encoding: 'utf8' });
  const entries = raw.split('\0'); entries.pop();
  if (entries.length % 2) throw new Error('Incomplete diff');
  const changes = [];
  for (let i = 0; i < entries.length; i += 2) {
    const match = /^:(\d{6}) (\d{6}) [a-f0-9]+ [a-f0-9]+ [AMDT]$/.exec(entries[i]);
    if (!match) throw new Error('Unknown diff entry');
    changes.push({ oldMode: match[1], newMode: match[2], path: entries[i + 1] });
  }
  return changes;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'result') {
    let expectedKind;
    try { expectedKind = ciPlan(process.env.GITHUB_EVENT_NAME, JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))).kind; }
    catch { /* Unavailable event context cannot certify a result. */ }
    const passed = ciPassed(process.env.PLAN_RESULT, process.env.FULL, process.env.TEST_RESULT, process.env.KIND, expectedKind, process.env.EXPECTED_KIND);
    console.log(passed ? 'CI policy satisfied' : 'CI policy failed: required validation did not succeed');
    process.exitCode = passed ? 0 : 1;
  } else {
    const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    let changes;
    try { changes = prChanges(event.pull_request?.base?.sha, event.pull_request?.head?.sha); }
    catch { /* Missing or unreadable metadata always falls back to full validation. */ }
    const plan = ciPlan(process.env.GITHUB_EVENT_NAME, event, changes);
    console.log(plan.reason);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `full=${plan.full}\nkind=${plan.kind}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${plan.reason}\n`);
  }
}
