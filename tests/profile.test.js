import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('profiling retains assert.ok generated source-expression diagnostics', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'podium-assert-source-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'assertion.mjs');
  fs.writeFileSync(file, `import assert from 'node:assert/strict'; const value = 0; try { assert.ok(value > 1); } catch (error) { console.log(JSON.stringify(error.message)); }`);
  const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.PODIUM_TEST_PROFILE_DIR;
  const baseline = spawnSync(process.execPath, [file], { env, encoding: 'utf8' });
  const profiled = spawnSync(process.execPath, ['--import', new URL('./profile-processes.js', import.meta.url).href, file], { env: { ...env, PODIUM_TEST_PROFILE_DIR: path.join(dir, 'profile') }, encoding: 'utf8' });
  assert.equal(baseline.status, 0, baseline.stderr); assert.equal(profiled.status, 0, profiled.stderr);
  assert.match(JSON.parse(baseline.stdout), /assert\.ok\(value > 1\)/);
  assert.equal(profiled.stdout, baseline.stdout, 'profiling must retain the native caller expression');
});

test('profile output failures preserve intended process exit codes', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'podium-profile-write-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const metrics = new URL('./profile-metrics.js', import.meta.url).href;
  for (const code of [0, 7]) {
    const profile = path.join(dir, `exit-${code}`);
    const source = `import fs from 'node:fs'; import path from 'node:path'; import {record} from ${JSON.stringify(metrics)}; record('proof',1); fs.mkdirSync(path.join(process.env.PODIUM_TEST_PROFILE_DIR, 'process-' + process.pid + '.ndjson')); console.log('body exit ${code}'); process.exit(${code});`;
    const env = { ...process.env, PODIUM_TEST_PROFILE_DIR: profile }; delete env.NODE_OPTIONS;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', source], { env, encoding: 'utf8' });
    assert.match(r.stdout, new RegExp(`body exit ${code}`));
    assert.equal(r.status, code, r.stderr);
    assert.match(r.stderr, /Test profile could not be written/);
  }
});

test('unavailable profile directory leaves the ordinary suite exit unchanged', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'podium-profile-start-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const profile = path.join(dir, 'not-a-directory'); fs.writeFileSync(profile, 'obstruction');
  const env = { ...process.env, PODIUM_TEST_PROFILE_DIR: profile }; delete env.NODE_OPTIONS;
  const r = spawnSync(process.execPath, ['--import', new URL('./profile-processes.js', import.meta.url).href, '--input-type=module', '-e', `console.log('body reached'); process.exit(0);`], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /body reached/);
});

test('optional reporter and run-metadata write failures do not determine test success', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'podium-profile-artifacts-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const folder of ['scripts', 'tests']) fs.mkdirSync(path.join(dir, folder));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  for (const file of ['scripts/test.js', 'tests/profile-reporter.js', 'tests/profile-processes.js', 'tests/profile-metrics.js']) fs.copyFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), path.join(dir, file));
  for (const fail of [false, true]) {
    const profile = path.join(dir, `profile-${fail}`); fs.mkdirSync(profile);
    for (const file of ['tests.ndjson', 'run.json']) fs.mkdirSync(path.join(profile, file));
    fs.writeFileSync(path.join(dir, 'tests', 'launcher.test.js'), `import test from 'node:test'; import assert from 'node:assert/strict'; test('actual test outcome', () => { console.log('test body executed'); ${fail ? "assert.fail('actual test failed');" : ''} });`);
    const env = { ...process.env, PODIUM_TEST_PROFILE_DIR: profile }; delete env.NODE_OPTIONS; delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, ['scripts/test.js'], { cwd: dir, env, encoding: 'utf8', timeout: 30_000 });
    assert.match(r.stdout, /test body executed/); assert.match(r.stderr, /Test profile could not be written/);
    assert.equal(r.status, fail ? 1 : 0, 'the actual test outcome determines the exit even when both artifacts cannot be written');
    if (fail) assert.match(r.stdout, /actual test failed/);
  }
});

test('the profiled suite launcher loads its reporter and preserves a failing test exit', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'podium profile launcher '));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const folder of ['scripts', 'tests']) fs.mkdirSync(path.join(dir, folder));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  for (const file of ['scripts/test.js', 'tests/profile-reporter.js', 'tests/profile-processes.js', 'tests/profile-metrics.js']) {
    fs.copyFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), path.join(dir, file));
  }
  fs.writeFileSync(path.join(dir, 'tests', 'launcher.test.js'), `import test from 'node:test'; import assert from 'node:assert/strict'; test('intentional launcher failure', () => assert.fail('launcher sentinel'));`);
  const profile = path.join(dir, 'measurements');
  const env = { ...process.env, PODIUM_TEST_PROFILE_DIR: profile };
  delete env.NODE_TEST_CONTEXT; // This child starts an independent test coordinator.
  delete env.NODE_OPTIONS; // Its launcher installs the copied profiler exactly once.
  const r = spawnSync(process.execPath, ['scripts/test.js'], { cwd: dir, env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 1, r.stderr);
  const rows = fs.readFileSync(path.join(profile, 'tests.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(rows.some(row => row.name === 'intentional launcher failure' && row.result === 'test:fail'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(profile, 'run.json'), 'utf8')).exitCode, 1);
});

test('profiling preserves execFile Promise results, child handle and rejection output', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'podium-profile-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const preload = new URL('./profile-processes.js', import.meta.url).href;
  const source = `import {execFile} from 'node:child_process'; import {promisify} from 'node:util'; import assert from 'node:assert/strict';
const run = promisify(execFile);
const pending = run(process.execPath, ['-e', 'console.log("ok"); console.error("err")']);
assert.ok(pending.child?.pid); const result = await pending; assert.equal(result.stdout.trim(), 'ok'); assert.equal(result.stderr.trim(), 'err');
await assert.rejects(run(process.execPath, ['-e', 'console.log("out"); console.error("failed"); process.exit(3)']), e => e.code === 3 && e.stdout.trim() === 'out' && e.stderr.trim() === 'failed');`;
  const r = spawnSync(process.execPath, ['--import', preload, '--input-type=module', '-e', source], { env: { ...process.env, PODIUM_TEST_PROFILE_DIR: dir }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const records = fs.readdirSync(dir).flatMap((file) => fs.readFileSync(path.join(dir, file), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));
  assert.ok(records.some((r) => r.kind === 'process.lifetime' && r.ms > 0));
  assert.ok(records.some((r) => r.kind === 'file.wall' && r.ms > 0), 'normal exit records reach the profile output');
});
for (const [name, source, failure] of [
  ['assertions', `import assert from 'node:assert/strict'; assert.rejects(Promise.resolve()); setTimeout(() => process.exit(0), 5000);`, /profile-failure:ERR_ASSERTION:Missing expected rejection/],
  ['subprocesses', `import {execFile} from 'node:child_process'; import {promisify} from 'node:util'; promisify(execFile)(process.execPath, ['-e','console.error("subprocess sentinel"); process.exit(7)']); setTimeout(() => process.exit(0), 5000);`, /profile-failure:7:Command failed:/],
]) test(`profiling preserves unhandled rejection failures for ${name}`, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'podium-profile-errors-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const preload = new URL('./profile-processes.js', import.meta.url).href;
  const body = `console.log(${JSON.stringify(`profile-body:${name}`)}); process.once('uncaughtExceptionMonitor', error => console.error('profile-failure:' + error.code + ':' + error.message)); ${source}`;
  const r = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--import', preload, '--input-type=module', '-e', body], { env: { ...process.env, PODIUM_TEST_PROFILE_DIR: dir }, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 1, 'an unawaited failing operation must still fail the process');
  assert.match(r.stdout, new RegExp(`^profile-body:${name}$`, 'm'), 'the intended test body must execute');
  assert.match(r.stderr, failure, 'the failure must come from the intended unhandled rejection');
  assert.doesNotMatch(r.stderr, /ERR_UNSUPPORTED_ESM_URL_SCHEME|ERR_MODULE_NOT_FOUND|ERR_UNKNOWN_FILE_EXTENSION/);
  if (name === 'subprocesses') assert.match(r.stderr, /subprocess sentinel/);
});
test('profiling distinguishes asynchronous Git and retains fork IPC behavior', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'podium-profile-async-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'ipc.cjs');
  fs.writeFileSync(file, `process.on('message', () => { process.send('pong', () => process.exit(0)); });`);
  const preload = new URL('./profile-processes.js', import.meta.url).href;
  const source = `import {execFile, spawn, fork} from 'node:child_process'; import {promisify} from 'node:util'; import assert from 'node:assert/strict';
assert.match((await promisify(execFile)('git', ['--version'])).stdout, /git version/);
const g = spawn('git', ['--version']); assert.equal(await new Promise(r => g.on('close', r)), 0);
const child = fork(${JSON.stringify(file)}, [], {execArgv: []});
const closed = new Promise(r => child.on('close', r));
const answer = new Promise(r => child.on('message', r)); child.send('ping');
assert.equal(await answer, 'pong'); assert.equal(await closed, 0);`;
  const r = spawnSync(process.execPath, ['--import', preload, '--input-type=module', '-e', source], { env: { ...process.env, PODIUM_TEST_PROFILE_DIR: dir }, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
  const rows = fs.readdirSync(dir).filter(f => f.endsWith('.ndjson')).flatMap(f => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));
  for (const api of ['execFile', 'spawn']) assert.ok(rows.some(r => r.kind === 'process.git.async.lifetime' && r.api === api && r.command === '--version'));
  assert.ok(rows.some(r => r.kind === 'process.lifetime' && r.api === 'fork'));
});
