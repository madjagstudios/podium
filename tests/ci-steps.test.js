import test from 'node:test';
import assert from 'node:assert/strict';
import { workflowRuns, ciNotes } from '../engine/ci-steps.js';

test('workflowRuns reads a single-line run step', () => {
  const text = [
    'name: CI',
    'jobs:',
    '  test:',
    '    steps:',
    '      - run: npm test',
  ].join('\n');
  assert.deepEqual(workflowRuns(text), ['npm test']);
});

test('workflowRuns strips surrounding quotes from a single-line run step', () => {
  const wrap = (step) => ['jobs:', '  test:', '    steps:', step].join('\n');
  assert.deepEqual(workflowRuns(wrap('      - run: "npm run lint"')), ['npm run lint']);
  assert.deepEqual(workflowRuns(wrap("      - run: 'npm run lint'")), ['npm run lint']);
});

test('workflowRuns reads block run steps and skips comment lines', () => {
  const text = [
    'jobs:',
    '  test:',
    '    steps:',
    '      - run: |',
    '          npm ci',
    '          # build first',
    '          npm run build',
    '',
    '          npm test',
    '      - run: >-',
    '          node scripts/check.mjs',
    '          npm run lint',
  ].join('\n');
  assert.deepEqual(workflowRuns(text), ['npm ci', 'npm run build', 'npm test', 'node scripts/check.mjs npm run lint']);
});

test('workflowRuns reads runs from two jobs in one file', () => {
  const text = [
    'jobs:',
    '  test:',
    '    steps:',
    '      - run: npm test',
    '  lint:',
    '    steps:',
    '      - run: |',
    '          npm run lint',
  ].join('\n');
  assert.deepEqual(workflowRuns(text), ['npm test', 'npm run lint']);
});

test('ciNotes names runs the full check does not cover', () => {
  const notes = ciNotes({ runs: ['npm test', 'npm run lint'], check: 'npm test', wanted: 'merge', used: 'merge', allowed: ['merge'] });
  assert.equal(notes.length, 1);
  assert.match(notes[0], /`npm run lint`/);
  assert.doesNotMatch(notes[0], /`npm test`/);
});

test('ciNotes counts a run as covered when the check contains it with different spacing', () => {
  const notes = ciNotes({ runs: ['npm   test'], check: 'npm test', wanted: 'merge', used: 'merge', allowed: ['merge'] });
  assert.deepEqual(notes, []);
});

test('ciNotes leaves out setup lines that are not checks', () => {
  const runs = ['npm ci', 'npm install', 'pnpm install', 'yarn install', 'echo hello', 'cd app', 'git config user.email a@b.c'];
  const notes = ciNotes({ runs, check: 'npm run build', wanted: 'merge', used: 'merge', allowed: ['merge'] });
  assert.deepEqual(notes, []);
});

test('ciNotes names at most five uncovered runs and counts the rest', () => {
  const runs = ['run-a', 'run-b', 'run-c', 'run-d', 'run-e', 'run-f', 'run-g'];
  const notes = ciNotes({ runs, check: 'npm test', wanted: 'merge', used: 'merge', allowed: ['merge'] });
  assert.equal(notes.length, 1);
  for (const r of ['run-a', 'run-b', 'run-c', 'run-d', 'run-e']) assert.match(notes[0], new RegExp(`\`${r}\``));
  assert.match(notes[0], /and 2 more/);
  assert.doesNotMatch(notes[0], /run-f/);
});

test('ciNotes gives no CI note when the repo has no full check', () => {
  const notes = ciNotes({ runs: ['npm run lint'], check: null, wanted: 'merge', used: 'merge', allowed: ['merge'] });
  assert.deepEqual(notes, []);
});

test('workflowRuns ends a block before sibling step keys at the run key column', () => {
  const text = [
    'jobs:',
    '  test:',
    '    steps:',
    '      - run: |',
    '          npm test',
    '        env:',
    '          FOO: bar',
    '        shell: bash',
    '      - run: npm run lint',
  ].join('\n');
  assert.deepEqual(workflowRuns(text), ['npm test', 'npm run lint']);
});

test('workflowRuns ignores run keys that are not step keys', () => {
  const text = [
    'jobs:',
    '  test:',
    '    steps:',
    '      - uses: actions/setup-node@v4',
    '        with:',
    '          node-version: 22',
    '          run: npm test',
    '      - uses: actions/github-script@v7',
    '        with:',
    '          script: |',
    '            console.log("hi")',
    '            run: echo hi',
    '      - run: npm run lint',
  ].join('\n');
  assert.deepEqual(workflowRuns(text), ['npm run lint']);
});

test('workflowRuns reads block headers with a trailing comment', () => {
  const text = [
    'jobs:',
    '  test:',
    '    steps:',
    '      - run: | # checks',
    '          npm test',
    '      - run: >- # folded',
    '          npm run lint',
  ].join('\n');
  assert.deepEqual(workflowRuns(text), ['npm test', 'npm run lint']);
});

test('workflowRuns joins folded blocks into one command', () => {
  const text = [
    'jobs:',
    '  test:',
    '    steps:',
    '      - run: >',
    '          npm run build',
    '          --watch',
  ].join('\n');
  assert.deepEqual(workflowRuns(text), ['npm run build --watch']);
});

test('ciNotes covers a run only when it equals a command in the check', () => {
  const notes = ciNotes({ runs: ['npm test'], check: 'npm test:unit', wanted: 'merge', used: 'merge', allowed: ['merge'] });
  assert.equal(notes.length, 1);
  assert.match(notes[0], /`npm test`/);
  assert.deepEqual(ciNotes({ runs: ['npm test'], check: 'npm test && npm run lint', wanted: 'merge', used: 'merge', allowed: ['merge'] }), []);
});

test('ciNotes reports compound lines whole when a non-setup part is uncovered', () => {
  const forRun = (run) => ciNotes({ runs: [run], check: 'npm test', wanted: 'merge', used: 'merge', allowed: ['merge'] });
  const lint = forRun('npm ci && npm run lint');
  assert.equal(lint.length, 1);
  assert.match(lint[0], /`npm ci && npm run lint`/);
  const moved = forRun('cd app && npm run lint');
  assert.equal(moved.length, 1);
  assert.match(moved[0], /`cd app && npm run lint`/);
  assert.deepEqual(forRun('npm ci && cd app'), []);
});

test('ciNotes gives a merge note only when the used method differs from the wanted one', () => {
  assert.deepEqual(ciNotes({ runs: [], check: 'npm test', wanted: 'merge', used: 'merge', allowed: ['squash', 'merge'] }), []);
  const notes = ciNotes({ runs: [], check: 'npm test', wanted: 'merge', used: 'squash', allowed: ['squash'] });
  assert.equal(notes.length, 1);
  assert.match(notes[0], /squash/);
  assert.match(notes[0], /will merge by squash, not merge/);
  assert.deepEqual(ciNotes({ runs: [], check: 'npm test', wanted: 'merge', used: 'squash', allowed: null }), []);
});

test('workflowRuns reads run steps only inside a steps list', () => {
  const text = [
    'on:',
    '  push:',
    '    branches:',
    '      - run: echo branch',
    'jobs:',
    '  test:',
    '    strategy:',
    '      matrix:',
    '        include:',
    '          - run: echo matrix',
    '    steps:',
    '      - run: npm test',
  ].join('\n');
  assert.deepEqual(workflowRuns(text), ['npm test']);
});

test('ciNotes covers a line that changes directory only as a whole line', () => {
  const args = { runs: ['cd app && npm test'], wanted: 'merge', used: 'merge', allowed: ['merge'] };
  assert.deepEqual(ciNotes({ ...args, check: 'cd app && npm test' }), []);
  const notes = ciNotes({ ...args, check: 'npm test' });
  assert.equal(notes.length, 1);
  assert.match(notes[0], /`cd app && npm test`/);
});

test('workflowRuns drops a trailing comment on a one-line run step', () => {
  const wrap = (step) => ['jobs:', '  test:', '    steps:', step].join('\n');
  assert.deepEqual(workflowRuns(wrap('      - run: npm test # unit tests')), ['npm test']);
  assert.deepEqual(workflowRuns(wrap('      - run: "echo # kept"')), ['echo # kept']);
  assert.deepEqual(workflowRuns(wrap('      - run: echo hi#there')), ['echo hi#there']);
});

test('workflowRuns joins lines ending in a backslash in literal blocks', () => {
  const text = [
    'jobs:',
    '  test:',
    '    steps:',
    '      - run: |',
    '          npm run build \\',
    '          --watch',
    '          npm test',
  ].join('\n');
  assert.deepEqual(workflowRuns(text), ['npm run build --watch', 'npm test']);
});

test('workflowRuns reads each run of lines in a folded block as one command', () => {
  const text = [
    'jobs:',
    '  test:',
    '    steps:',
    '      - run: >',
    '          npm run build',
    '          --watch',
    '',
    '          npm test',
  ].join('\n');
  assert.deepEqual(workflowRuns(text), ['npm run build --watch', 'npm test']);
});

test('workflowRuns joins a plain run value with its continuation lines', () => {
  const text = [
    'jobs:',
    '  test:',
    '    steps:',
    '      - run: npm test',
    '          --watch',
    '      - run: npm run lint',
  ].join('\n');
  assert.deepEqual(workflowRuns(text), ['npm test --watch', 'npm run lint']);
});

test('ciNotes matches setup commands on whole words only', () => {
  const args = { wanted: 'merge', used: 'merge', allowed: ['merge'] };
  const notes = ciNotes({ ...args, runs: ['npm install-test'], check: 'npm test' });
  assert.equal(notes.length, 1);
  assert.match(notes[0], /`npm install-test`/);
  assert.deepEqual(ciNotes({ ...args, runs: ['npm install --frozen', 'npm ci'], check: 'npm test' }), []);
});

test('workflowRuns reads quoted run and steps keys', () => {
  const text = [
    'jobs:',
    '  test:',
    '    "steps":',
    "      - 'run': npm test",
    '      - "run": npm run lint',
  ].join('\n');
  assert.deepEqual(workflowRuns(text), ['npm test', 'npm run lint']);
});

test('workflowRuns reads a steps list written at the steps key\'s own column', () => {
  const text = [
    'jobs:',
    '  test:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '    - uses: actions/checkout@v4',
    '    - run: npm test',
    '    - name: Lint',
    '      run: npm run lint',
    '    env:',
    '      run: not a step',
  ].join('\n');
  assert.deepEqual(workflowRuns(text), ['npm test', 'npm run lint']);
});

test('ciNotes covers a line that changes folder only with the same commands in the same order', () => {
  const args = { wanted: 'merge', used: 'merge', allowed: ['merge'] };
  const runs = ['cd frontend && npm run lint'];
  assert.equal(ciNotes({ ...args, runs, check: 'cd frontend && npm run lint:types' }).length, 1, 'lint:types is another script');
  assert.deepEqual(ciNotes({ ...args, runs, check: 'npm test && cd frontend && npm run lint' }), []);
});

test('workflowRuns runs commands in their step\'s folder: a cd line, working-directory, or the job\'s defaults', () => {
  const text = [
    'defaults:',
    '  run:',
    '    working-directory: app',
    'jobs:',
    '  web:',
    '    defaults:',
    '      run:',
    '        working-directory: web',
    '    steps:',
    '      - run: npm test',
    '      - name: Unit',
    '        working-directory: web/unit',
    '        run: npm test',
    '      - run: |',
    '          cd frontend',
    '          npm test',
    '  api:',
    '    steps:',
    '      - run: npm test',
  ].join('\n');
  assert.deepEqual(workflowRuns(text), [
    'cd web && npm test',
    'cd web/unit && npm test',
    'cd web/frontend && npm test',
    'cd app && npm test',
  ]);
  const notes = ciNotes({ runs: workflowRuns(text), check: 'npm test', wanted: 'merge', used: 'merge', allowed: ['merge'] });
  assert.match(notes[0], /`cd web && npm test`/);
});

test('ciNotes keeps a pipeline that starts with echo: it is a check, not setup', () => {
  const gate = "echo \"$(cat coverage/coverage-summary.json)\" | jq -e '.total.lines.pct >= 80'";
  const notes = ciNotes({ runs: [gate, 'echo done'], check: 'npm test -- --coverage', wanted: 'merge', used: 'merge', allowed: ['merge'] });
  assert.equal(notes.length, 1);
  assert.ok(notes[0].includes(gate));
  assert.doesNotMatch(notes[0], /echo done/);
});

test('workflowRuns reads a quoted run value with a trailing comment', () => {
  const text = ['jobs:', '  t:', '    steps:', '      - run: "npm test" # unit tests', "      - run: 'it''s fine' # x"].join('\n');
  assert.deepEqual(workflowRuns(text), ['npm test', "it's fine"]);
});

test('workflowRuns walks folders as a shell does: defaults kept for a job\'s last step, relative and compound cd', () => {
  const text = [
    'jobs:',
    '  web:',
    '    defaults:',
    '      run:',
    '        working-directory: packages/web',
    '    steps:',
    '      - working-directory: packages/web',
    '        run: |',
    '          cd integration',
    '          npm test',
    '      - run: |',
    '          cd ../api && npm run build',
    '          npm run lint',
    '      - run: npm test',
    '  call:',
    '    uses: ./.github/workflows/shared.yml',
  ].join('\n');
  assert.deepEqual(workflowRuns(text), [
    'cd packages/web/integration && npm test',
    'cd packages/web && cd ../api && npm run build',
    'cd packages/api && npm run lint',
    'cd packages/web && npm test',
  ]);
});

test('ciNotes compares commands in the folders they run in, the check\'s too; one it can\'t know never counts as covered', () => {
  const args = { wanted: 'merge', used: 'merge', allowed: ['merge'] };
  assert.equal(ciNotes({ ...args, runs: ['npm test'], check: 'cd packages/web && npm test' }).length, 1, 'the root tests are not the workspace tests');
  assert.deepEqual(ciNotes({ ...args, runs: ['cd packages/web && npm run build', 'cd packages/web && npm test'], check: 'cd packages/web && npm run build && npm test' }), []);
  assert.equal(ciNotes({ ...args, runs: ['cd $GITHUB_WORKSPACE/web && npm test'], check: 'npm test' }).length, 1);
  assert.equal(ciNotes({ ...args, runs: ['cd - && npm test'], check: 'npm test' }).length, 1);
});

test('workflowRuns applies defaults written after the steps, for the job and for the workflow', () => {
  const text = [
    'jobs:',
    '  web:',
    '    steps:',
    '      - run: npm test',
    '    defaults:',
    '      run:',
    '        working-directory: packages/web',
    '  api:',
    '    steps:',
    '      - run: npm test',
    'defaults:',
    '  run:',
    '    working-directory: packages/api',
  ].join('\n');
  assert.deepEqual(workflowRuns(text), ['cd packages/web && npm test', 'cd packages/api && npm test']);
  assert.equal(ciNotes({ runs: workflowRuns(text), check: 'npm test', wanted: 'merge', used: 'merge', allowed: ['merge'] }).length, 1);
});

test('a comment line at column zero inside a job does not end the job its defaults apply to', () => {
  const text = [
    'jobs:',
    '  web:',
    '    defaults:',
    '      run:',
    '        working-directory: packages/web',
    '# the steps',
    '    steps:',
    '      - run: npm test',
  ].join('\n');
  assert.deepEqual(workflowRuns(text), ['cd packages/web && npm test']);
});

test('ciNotes reads the check as a shell line: what follows a # is a comment', () => {
  const notes = ciNotes({ runs: ['npm test', 'npm run lint'], check: 'npm test # && npm run lint', wanted: 'merge', used: 'merge', allowed: ['merge'] });
  assert.equal(notes.length, 1);
  assert.match(notes[0], /`npm run lint`/);
});

test('the scan stays quick on long runs of spaces and never overflows on a huge run block', () => {
  const started = Date.now();
  workflowRuns(['jobs:', '  t:', '    steps:', `      - run: npm test${' '.repeat(200_000)}x`].join('\n'));
  ciNotes({ runs: [], check: `npm test${' '.repeat(200_000)}x`, wanted: 'merge', used: 'merge', allowed: ['merge'] });
  // A file under the size cap built to be slow: lines of spaces with no colon, comment markers, and a long chain of cds.
  const slow = ['jobs:', '  t:', '    steps:', ...Array.from({ length: 300 }, () => ' '.repeat(800)), '      - run: |',
    ...Array.from({ length: 20_000 }, () => '          cd a && echo x'), ...Array.from({ length: 300 }, () => '          # # # # # # #')].join('\n');
  workflowRuns(slow);
  ciNotes({ runs: [], check: `${'# a '.repeat(50_000)}`, wanted: 'merge', used: 'merge', allowed: ['merge'] });
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
  const huge = ['jobs:', '  t:', '    steps:', '      - run: |', ...Array.from({ length: 200_000 }, (_, k) => `          echo ${k}`)].join('\n');
  assert.equal(workflowRuns(huge).length, 200_000);
});

test('many defaults in one job and many steps stay quick; the first default written counts', () => {
  const text = [
    'jobs:',
    ' t:',
    ...Array.from({ length: 4_800 }, (_, k) => ['  defaults:', '   run:', `    working-directory: w${k}`]).flat(),
    '  steps:',
    ...Array.from({ length: 300 }, () => '   - run: npm test'),
  ].join('\n');
  assert.ok(text.length < 256_000);
  const started = Date.now();
  const runs = workflowRuns(text);
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
  assert.equal(runs.length, 300);
  assert.ok(runs.every((run) => run === 'cd w0 && npm test'));
});

test('workflowRuns reads escapes in a double-quoted run value, a new line starting a command of its own', () => {
  const text = ['jobs:', '  t:', '    steps:', '      - run: "npm ci\\nnpm run lint"'].join('\n');
  assert.deepEqual(workflowRuns(text), ['npm ci', 'npm run lint']);
  assert.equal(ciNotes({ runs: workflowRuns(text), check: 'npm test', wanted: 'merge', used: 'merge', allowed: ['merge'] }).length, 1);
});
