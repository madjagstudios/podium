import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ciPlan, ciPassed, prChanges } from '../scripts/ci-policy.js';
const ready = { pull_request: { draft: false } };
const doc = (path = 'docs/guide.md', mode = '100644') => ({ path, oldMode: mode, newMode: mode });
const format = (value, ...args) => value.replace(/\{\{|\}\}|\{(\d+)\}/g, (match, n) => n !== undefined ? args[n] : match[0]);
function workflowExpression(expression, event, needs = {}, options = {}) {
  // Missing nested GitHub context properties evaluate to an empty string.
  const source = expression.replaceAll('github.event.changes.title.from', 'github.event.changes?.title?.from').replaceAll('github.event.changes.body.from', 'github.event.changes?.body?.from');
  // This workflow uses JSON strings only in equality/format; normalize for native case-insensitive ==.
  const context = value => value && typeof value === 'object' ? new Proxy(value, { get(target, key) { const actual = typeof key === 'string' ? Object.keys(target).find(k => k.toLowerCase() === key.toLowerCase()) : key; return context(target[actual]); } }) : value;
  return Function('github', 'needs', 'matrix', 'format', 'toJSON', 'fromJSON', `return (${source})`)(context({ workflow: 'ci', event_name: options.eventName || 'pull_request', run_id: options.runId || 100, run_attempt: options.runAttempt || 1, ref: 'refs/heads/main', event: { pull_request: { number: 33 }, ...event, action: event.action?.toLowerCase() } }), needs, { os: 'windows-latest' }, format, value => JSON.stringify(value === undefined ? '' : value, null, 2).toLowerCase(), JSON.parse);
}
test('only a ready documentation-only PR avoids the matrix', () => {
  assert.equal(ciPlan('pull_request', ready, [doc()]).full, false);
  for (const path of ['engine/a.js', 'package.json', '.github/workflows/ci.yml', 'tests/a.test.js', 'hooks/a.tsx', 'new.md', 'docs/tool.js', 'docs/config.json']) assert.equal(ciPlan('pull_request', ready, [doc(path)]).full, true, path);
  assert.equal(ciPlan('pull_request', ready, [doc('README.md')]).full, false);
  assert.equal(ciPlan('pull_request', ready, [doc(), doc('engine/a.js')]).full, true);
});
test('draft matrices wait until ready, while manual and main always run', () => {
  assert.equal(ciPlan('pull_request', { pull_request: { draft: true } }, [doc('engine/a.js')]).full, false);
  assert.equal(ciPlan('pull_request', ready, [doc('engine/a.js')]).full, true);
  for (const event of ['push', 'workflow_dispatch', 'unknown']) assert.equal(ciPlan(event, ready, [doc()]).full, true);
});
test('uncertain changes and executable or linked documentation require tests', () => {
  for (const changes of [null, [], [{}], [doc('docs/a.md', '100755')], [doc('docs/a.md', '120000')], [{ ...doc(), oldMode: '100755' }]]) assert.equal(ciPlan('pull_request', ready, changes).full, true);
  assert.equal(ciPlan('pull_request', {}, [doc()]).full, true);
  assert.equal(ciPlan('pull_request', ready, [{ ...doc(), newMode: '000000' }]).full, false);
});
test('a full matrix must succeed, and a skip requires a successful policy job', () => {
  const passed = (plan, full, result) => ciPassed(plan, full, result, 'validation', 'validation', 'validation');
  for (const result of ['failure', 'cancelled', 'skipped', undefined]) assert.equal(passed('success', 'true', result), false);
  assert.equal(passed('success', 'true', 'success'), true);
  assert.equal(passed('success', 'false', 'skipped'), true);
  assert.equal(passed('failure', 'false', 'skipped'), false);
  assert.equal(passed('success', '', 'skipped'), false);
  assert.equal(passed('success', 'false', 'failure'), false);
});
test('deferred and metadata results cannot claim validation authority or a full matrix', () => {
  for (const kind of ['deferred', 'metadata']) {
    assert.equal(ciPassed('success', 'false', 'skipped', kind, kind, kind), true);
    assert.equal(ciPassed('success', 'false', 'skipped', kind, 'validation', 'validation'), false);
    assert.equal(ciPassed('success', 'true', 'success', kind, kind, kind), false);
  }
  assert.equal(ciPassed('success', 'false', 'skipped', undefined, 'validation', 'validation'), false);
  assert.equal(ciPassed('success', 'false', 'skipped', 'validation', 'deferred', 'deferred'), false);
  for (const workflowKind of [undefined, '', 'deferred', 'metadata']) assert.equal(ciPassed('success', 'false', 'skipped', 'validation', 'validation', workflowKind), false);
  assert.equal(ciPassed('success', 'false', 'skipped', 'metadata', 'metadata', 'validation'), false);
});
test('the git diff includes earlier code, deleted sources and executable documentation', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-policy-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
  fs.writeFileSync(path.join(cwd, 'README.md'), 'initial'); git('add', '-A'); git('commit', '-qm', 'initial');
  const base = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(cwd, 'code.js'), 'code'); git('add', '-A'); git('commit', '-qm', 'code');
  fs.writeFileSync(path.join(cwd, 'README.md'), 'docs'); git('add', '-A'); git('commit', '-qm', 'docs after code');
  assert.equal(ciPlan('pull_request', ready, prChanges(base, git('rev-parse', 'HEAD'), cwd)).full, true);
  const codeBase = git('rev-parse', 'HEAD');
  fs.renameSync(path.join(cwd, 'code.js'), path.join(cwd, 'CHANGELOG.md')); git('add', '-A'); git('commit', '-qm', 'rename code to docs');
  assert.equal(ciPlan('pull_request', ready, prChanges(codeBase, git('rev-parse', 'HEAD'), cwd)).full, true);
  const modeBase = git('rev-parse', 'HEAD'); git('update-index', '--chmod=+x', 'README.md'); git('commit', '-qm', 'executable docs');
  assert.equal(ciPlan('pull_request', ready, prChanges(modeBase, git('rev-parse', 'HEAD'), cwd)).full, true);
});
test('the result command returns a failing exit code for an intentional matrix failure', (t) => {
  const script = fileURLToPath(new URL('../scripts/ci-policy.js', import.meta.url));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-result-event-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const event = path.join(dir, 'event.json'); fs.writeFileSync(event, JSON.stringify(ready));
  const run = (result, expectedKind = 'validation') => spawnSync(process.execPath, [script, 'result'], { env: { ...process.env, PLAN_RESULT: 'success', FULL: 'true', TEST_RESULT: result, KIND: 'validation', EXPECTED_KIND: expectedKind, GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: event } }).status;
  assert.equal(run('failure'), 1); assert.equal(run('success'), 0);
  for (const kind of [undefined, '', 'deferred', 'metadata']) assert.equal(run('success', kind === undefined ? '' : kind), 1);
});
test('known title/body edits are isolated from code checks while base or uncertain edits run fully', () => {
  const code = [doc('engine/a.js')];
  for (const changes of [{ title: { from: 'old' } }, { body: { from: null } }, { title: { from: 'old' }, body: { from: 'old body' } }]) {
    const plan = ciPlan('pull_request', { ...ready, action: 'edited', changes }, code);
    assert.equal(plan.full, false);
    assert.equal(plan.metadataOnly, true);
  }
  for (const changes of [undefined, {}, { title: null }, { title: { from: 'old', unknown: {} } }, { title: { from: 'old' }, unknown: {} }, { base: { ref: { from: 'main' } } }, { title: { from: 'old' }, base: {} }]) {
    const plan = ciPlan('pull_request', { ...ready, action: 'edited', changes }, [doc()]);
    assert.equal(plan.full, true);
    assert.equal(plan.metadataOnly, false);
  }
  assert.equal(ciPlan('pull_request', { pull_request: { draft: true }, action: 'edited', changes: { base: {} } }, [doc()]).full, true);
});
test('workflow metadata concurrency cannot cancel code or base-retarget runs', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const template = workflow.match(/^  group: (.+)$/m)[1];
  const group = (action, changes, number = 33) => template.replace(/\$\{\{(.*?)\}\}(?=-|$)/g, (_, expression) => workflowExpression(expression, { action, changes, pull_request: { number } }));
  assert.equal(group('synchronize', {}), group('edited', { base: {} }));
  assert.notEqual(group('synchronize', {}), group('edited', { title: { from: 'old' } }));
  assert.notEqual(group('edited', { body: { from: '' } }), group('edited', { body: { from: '' } }, 34));
  assert.equal(group('edited', { unknown: {} }), group('synchronize', {}));
  assert.notEqual(group('edited', { unknown: {} }), group('edited', { title: { from: 'old' } }));
});
test('metadata and draft results use separate authority without dynamic skipped-matrix names', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const names = ['plan', 'ci-result'].map(job => workflow.split(`  ${job}:\n`)[1].match(/^    name: \$\{\{(.+?)\}\}$/m)?.[1]);
  assert.ok(names.every(Boolean), 'policy and result must select names from the event before planning');
  assert.doesNotMatch(workflow.split('  test:\n')[1].split('  ci-result:\n')[0], /^    name:/m, 'native matrix names stay readable when the job skips');
  const name = (expression, metadata) => workflowExpression(expression, metadata ? { action: 'edited', changes: { title: { from: 'old' } } } : { action: 'synchronize' });
  assert.equal(name(names[0], false), 'validation-plan');
  assert.equal(name(names[1], false), 'ci-result');
  assert.notEqual(name(names[0], true), name(names[0], false));
  assert.notEqual(name(names[1], true), name(names[1], false));
  assert.equal(name(names[1], true), 'metadata-result', 'a failed plan with no outputs remains isolated');
  const guard = workflow.match(/^          EXPECTED_KIND: \$\{\{(.+?)\}\}$/m)?.[1];
  assert.equal(guard?.trim(), names[1].replaceAll("'metadata-result'", "'metadata'").replaceAll("'deferred-result'", "'deferred'").replaceAll("'ci-result'", "'validation'").trim(), 'native guard must use the actual result-name expression');
  for (const changes of [undefined, {}, { title: null }, { title: { From: '' } }, { title: { From: 'old' } }, { Title: { from: '' } }, { Title: { from: 'old' } }, { title: { from: 'old', extra: {} } }, { title: { from: 'old' }, unknown: {} }, { base: {} }, { title: { from: 'x\"\n{}' }, body: { from: null } }, { body: { from: '' }, title: { from: 'old' } }]) {
    const event = { ...ready, action: 'edited', changes };
    const plan = ciPlan('pull_request', event, [doc('engine/a.js')]);
    assert.equal(workflowExpression(names[1], event), plan.kind === 'metadata' ? 'metadata-result' : 'ci-result', 'workflow/Node classification must agree');
  }
});

test('draft to ready creates authoritative validation rather than a skipped same-name result', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const result = workflow.split('  ci-result:\n')[1];
  const expression = result.match(/^    name: \$\{\{(.+?)\}\}$/m)[1];
  assert.match(result, /^    if: always\(\)$/m, 'the one result job runs and changes its name instead of creating a skipped ci-result');
  for (const action of ['opened', 'synchronize', 'converted_to_draft']) {
    const event = { action, pull_request: { draft: true } };
    assert.equal(ciPlan('pull_request', event, [doc('engine/a.js')]).kind, 'deferred');
    assert.equal(workflowExpression(expression, event, { plan: { result: 'failure', outputs: {} } }), 'deferred-result');
  }
  const event = { action: 'ready_for_review', ...ready };
  assert.equal(ciPlan('pull_request', event, [doc('engine/a.js')]).full, true);
  assert.equal(workflowExpression(expression, event), 'ci-result');
  assert.equal(workflowExpression(expression, { action: 'edited', changes: { base: {} }, pull_request: { draft: true } }), 'ci-result');
});

test('non-PR runs have unique groups while draft conversion retains PR cancellation policy', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const template = workflow.match(/^  group: (.+)$/m)[1];
  const group = (event, options) => template.replace(/\$\{\{(.*?)\}\}(?=-|$)/g, (_, expression) => workflowExpression(expression, event, {}, options));
  for (const eventName of ['push', 'workflow_dispatch']) {
    assert.notEqual(group({}, { eventName, runId: 100 }), group({}, { eventName, runId: 101 }));
    assert.notEqual(group({}, { eventName, runId: 100, runAttempt: 1 }), group({}, { eventName, runId: 100, runAttempt: 2 }));
  }
  assert.equal(group({ action: 'synchronize' }), group({ action: 'converted_to_draft', pull_request: { number: 33, draft: true } }));
  assert.match(workflow, /^  cancel-in-progress: \$\{\{ github.event_name == 'pull_request' \}\}$/m);
});
