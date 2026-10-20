import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const workflow = fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const evaluate = (expression, context) => Function('github', 'inputs', 'env', 'runner', 'cancelled', 'format', `return (${expression})`)(context.github, context.inputs, context.env, { temp: '/runner/temp' }, () => context.cancelled, (s, value) => s.replace('{0}', value));
const flag = workflow.match(/^      PROFILE_TESTS: \$\{\{ (.+) \}\}$/m)?.[1];
const directory = workflow.match(/^          PODIUM_TEST_PROFILE_DIR: \$\{\{ (.+) \}\}$/m)?.[1];

test('profiling is opt-in and ordinary required checks do not preload it', () => {
  assert.ok(flag && directory);
  assert.match(workflow, /^        default: false$/m);
  for (const [eventName, requested, expected] of [['push', true, false], ['pull_request', true, false], ['workflow_dispatch', false, false], ['workflow_dispatch', true, true]]) {
    const context = { github: { event_name: eventName }, inputs: { profile: requested } };
    const enabled = evaluate(flag, context);
    assert.equal(enabled, expected);
    assert.equal(evaluate(directory, { ...context, env: { PROFILE_TESTS: String(enabled) } }), expected ? '/runner/temp/test-profile' : '');
  }
});

test('optional artifacts can follow failed tests but do not run after cancellation or gate success', () => {
  const blocks = ['      - name: Summarize test profile', '      - uses: actions/upload-artifact@v4'].map(start => workflow.split(start)[1]?.split('\n      - ')[0]);
  for (const block of blocks) {
    assert.ok(block);
    assert.match(block, /^        continue-on-error: true$/m);
    const condition = block.match(/^        if: \$\{\{ (.+) \}\}$/m)?.[1];
    assert.ok(condition); assert.doesNotMatch(condition, /always\(/);
    for (const cancelled of [false, true]) for (const enabled of [false, true]) {
      assert.equal(evaluate(condition, { cancelled, env: { PROFILE_TESTS: String(enabled) } }), enabled && !cancelled);
    }
  }
  const testStep = workflow.split('      - run: npm test')[1]?.split('      - name: Summarize test profile')[0];
  assert.ok(testStep);
  assert.doesNotMatch(testStep, /continue-on-error/, 'real test failures remain required failures');
});
