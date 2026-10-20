// A real Windows .NET review end to end, plus deterministic legacy-lock recovery.
// The SDK-backed test runs only on Windows with PODIUM_TEST_DOTNET=1; without the opt-in it reports an explicit
// skip without invoking dotnet. The held-file test needs no SDK and runs on any Windows host.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createSprint, tick, setPaused, retryTicket, loadSprint } from '../engine/sprint.js';
import { listJobDirs, readJob, findJobDir } from '../engine/store.js';
import { setSetting } from '../engine/settings.js';
import { projectKey } from '../engine/paths.js';
import { waitFor, scriptAgent, sprintWorld, PLAN } from './helpers.js';
import { holdFile } from './windows-file-lock.js';

const OPT_IN = process.env.PODIUM_TEST_DOTNET === '1';
const SDK_SKIP = process.platform !== 'win32'
  ? 'A Windows .NET SDK review is required'
  : !OPT_IN ? 'Set PODIUM_TEST_DOTNET=1 to run the SDK-backed .NET review' : false;
const WINDOWS_SKIP = process.platform !== 'win32' ? 'Windows file sharing is required' : false;

const T = (over = {}) => ({ key: 'ABC-11', title: 'Probe build', type: 'feat', plan: 'docs/plan.md', agent: 'fa', reviewer: 'fr', ...over });
const run = (root, id, env, until) => waitFor(async () => { const s = await tick(root, id, { env }); return until(s) ? s : null; }, { timeoutMs: 300_000, intervalMs: 250 });
const settled = (s) => !['pending', 'running', 'waiting'].includes(s.tickets[0].state);
const jobsBy = (root, role) => listJobDirs(root).map(readJob).filter((j) => j.sprint?.role === role).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
const outputOf = (root, job) => fs.readFileSync(path.join(findJobDir(root, job.id), 'output.md'), 'utf8');
const promptOf = (root, job) => fs.readFileSync(path.join(findJobDir(root, job.id), 'prompt.md'), 'utf8');

// An installed .NET 8 SDK version from `dotnet --list-sdks`. With the opt-in this fails when no 8.0 SDK is on
// PATH; it never skips, so a required toolchain gap cannot hide as green.
function installedSdk8() {
  let list;
  try {
    list = execFileSync('dotnet', ['--list-sdks'], { stdio: 'pipe', timeout: 60_000, maxBuffer: 1024 * 1024 }).toString('utf8');
  } catch (error) {
    assert.fail(`PODIUM_TEST_DOTNET=1 requires the .NET SDK on PATH: ${error.message}`);
  }
  const versions = [...list.matchAll(/^(\d+)\.(\d+)\.(\d+)\s+\[/gm)]
    .map((m) => m.slice(1, 4).map(Number))
    .filter(([major, minor]) => major === 8 && minor === 0);
  assert.ok(versions.length, `PODIUM_TEST_DOTNET=1 requires an installed .NET 8 SDK, saw:\n${list}`);
  return versions.sort((a, b) => a[2] - b[2]).at(-1).join('.');
}

const DOTNET_PLAN = '# Plan\n\n### Task 1: Note the probe class\nAdd a comment to Probe.cs.\n\n### Task 2: Note the interop class\nAdd a comment to NativeMethods.cs.\n';
// The analyzer family named by the incident: a built-in interop source generator, no package references.
const NATIVE_METHODS = 'using System.Runtime.InteropServices;\n\ninternal static partial class NativeMethods\n{\n    [LibraryImport("kernel32.dll")]\n    internal static partial uint GetCurrentProcessId();\n}\n';
const PROBE_CLASS = 'namespace Probe;\n\npublic class ProbeClass\n{\n    public static string Name => "probe";\n}\n';
const CSPROJ = '<Project Sdk="Microsoft.NET.Sdk">\n\n  <PropertyGroup>\n    <TargetFramework>net8.0</TargetFramework>\n    <ImplicitUsings>enable</ImplicitUsings>\n    <Nullable>enable</Nullable>\n    <AllowUnsafeBlocks>true</AllowUnsafeBlocks>\n  </PropertyGroup>\n\n  <Target Name="EmitUseSharedCompilation" AfterTargets="Build">\n    <WriteLinesToFile File="$(IntermediateOutputPath)used-shared-compilation.txt" Lines="$(UseSharedCompilation)" Overwrite="true" />\n  </Target>\n\n</Project>\n';
const NUGET_CONFIG = '<?xml version="1.0" encoding="utf-8"?>\n<configuration>\n  <packageSources>\n    <clear />\n  </packageSources>\n</configuration>\n';

// Seed the disposable .NET 8 fixture in the fixture repo: the solution and project are created by the pinned SDK,
// fixed content goes on top, nothing needs a network feed, and build outputs are ignored.
function seedDotnetRepo(w, sdk) {
  const repo = w.repo;
  fs.writeFileSync(path.join(repo, 'global.json'), `${JSON.stringify({ sdk: { version: sdk, rollForward: 'disable' } }, null, 2)}\n`);
  const dotnet = (...a) => execFileSync('dotnet', a, { cwd: repo, stdio: 'pipe', timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
  dotnet('new', 'sln', '-n', 'Probe');
  dotnet('new', 'classlib', '-n', 'Probe', '--no-restore');
  dotnet('sln', 'Probe.sln', 'add', 'Probe/Probe.csproj');
  fs.rmSync(path.join(repo, 'Probe', 'Class1.cs'));
  fs.writeFileSync(path.join(repo, 'Probe', 'Probe.csproj'), CSPROJ);
  fs.writeFileSync(path.join(repo, 'Probe', 'Probe.cs'), PROBE_CLASS);
  fs.writeFileSync(path.join(repo, 'Probe', 'NativeMethods.cs'), NATIVE_METHODS);
  fs.writeFileSync(path.join(repo, 'NuGet.Config'), NUGET_CONFIG);
  fs.writeFileSync(path.join(repo, '.gitignore'), 'bin/\nobj/\n');
  w.git(repo, 'add', '-A');
  w.git(repo, 'commit', '-q', '-m', 'seed disposable .NET probe');
}

// The repo's task test for the fixture: it passes only with Podium's shared-process defaults, in a copy that has
// the solution. Success proves the host run received the same defaults the agents get.
const node = `"${process.execPath}"`;
const HOST_TEST = `${node} -e "const a=require('assert'),f=require('fs');a.equal(process.env.UseSharedCompilation,'false');a.equal(process.env.DOTNET_CLI_USE_MSBUILD_SERVER,'0');a.equal(process.env.MSBUILDDISABLENODEREUSE,'1');a.ok(f.existsSync('Probe.sln'),'the copy has no Probe.sln');console.log('HOST_DEFAULTS '+JSON.stringify({UseSharedCompilation:process.env.UseSharedCompilation,DOTNET_CLI_USE_MSBUILD_SERVER:process.env.DOTNET_CLI_USE_MSBUILD_SERVER,MSBUILDDISABLENODEREUSE:process.env.MSBUILDDISABLENODEREUSE}))"`;

const checkLogs = (root, id) => fs.readdirSync(path.join(root, 'sprints', id, 'checks'))
  .map((name) => path.join(root, 'sprints', id, 'checks', name, 'check.log'))
  .filter((file) => fs.existsSync(file))
  .map((file) => fs.readFileSync(file, 'utf8'));

function envValuesOf(output) {
  const line = output.split('\n').find((l) => l.startsWith('ENV_VALUES '));
  assert.ok(line, `the review output has no ENV_VALUES line:\n${output}`);
  return JSON.parse(line.slice('ENV_VALUES '.length));
}

// A finished review's temp folder, rebuild evidence, and evaluated build property, read before cleanup processes it.
function assertReviewBuild(root, review, copy) {
  const output = outputOf(root, review);
  assert.match(output, /DOTNET_BUILD ok/);
  assert.match(output, /-> .*Probe\.dll/, 'the log shows a real compile');
  const tmp = path.join(findJobDir(root, review.id), 'tmp');
  assert.deepEqual(envValuesOf(output), { TMPDIR: tmp, TEMP: tmp, TMP: tmp });
  assert.ok(output.includes(`ENV TMPDIR=${tmp} writable=true`), `the temp folder is writable:\n${output}`);
  assert.ok(path.relative(copy, tmp).startsWith('..'), 'the review temp folder is outside the copy');
  assert.equal(fs.readFileSync(path.join(copy, 'Probe', 'obj', 'Debug', 'net8.0', 'used-shared-compilation.txt'), 'utf8').trim(), 'false');
  assert.equal(fs.existsSync(path.join(copy, '.review-tmp')), false);
  return tmp;
}

test('a real .NET review builds with shared compilation off and the next task checkpoints', { skip: SDK_SKIP, timeout: 600_000 }, async () => {
  const sdk = installedSdk8();
  const { root, w } = sprintWorld({ plans: { 'docs/plan.md': DOTNET_PLAN } });
  seedDotnetRepo(w, sdk);
  setSetting(root, 'repoTaskTest', { [projectKey(w.repo)]: HOST_TEST });
  scriptAgent(root, 'fa', [
    { write: 'Probe/Probe.cs', content: `${PROBE_CLASS}\n// task 1: the writer's note\n`, dotnetBuild: true, say: 'Built task 1.' },
    { write: 'Probe/NativeMethods.cs', content: `${NATIVE_METHODS}\n// task 2: the writer's note\n`, dotnetBuild: true, say: 'Built task 2.' },
  ]);
  const reviewStep = { dotnetBuild: true, env: 'TMPDIR', envValues: ['TMPDIR', 'TEMP', 'TMP'], tests: false, say: 'Built the change.\nVERDICT: pass' };
  scriptAgent(root, 'fr', [reviewStep, { ...reviewStep }]);
  const s0 = await createSprint(root, { name: 'dotnet review', tickets: [T()] }, { cwd: w.repo });

  // Task 1's review, finished but not yet processed: temp, rebuild, evaluated property, and the host test first.
  await run(root, s0.id, w.env, (s) => s.tickets[0].phase === 'review');
  await setPaused(root, s0.id, true);
  const first = jobsBy(root, 'reviewer')[0];
  await waitFor(() => ['done', 'needs-review'].includes(readJob(findJobDir(root, first.id)).status), { timeoutMs: 300_000 });
  const copy = jobsBy(root, 'author')[0].worktree;
  const firstTmp = assertReviewBuild(root, first, copy);
  const atFirst = loadSprint(root, s0.id).tickets[0];
  assert.deepEqual([atFirst.hostTest.task, atFirst.hostTest.state], [1, 'passed'], 'the host task test passed before the review');
  assert.equal(atFirst.hostTest.command, HOST_TEST);
  assert.match(promptOf(root, first), /Podium ran the repo's task test on this machine after this change, and it passed\./);
  const firstLogs = checkLogs(root, s0.id);
  assert.equal(firstLogs.length, 1);
  assert.match(firstLogs[0], /HOST_DEFAULTS \{"UseSharedCompilation":"false","DOTNET_CLI_USE_MSBUILD_SERVER":"0","MSBUILDDISABLENODEREUSE":"1"\}/);
  const base = jobsBy(root, 'author')[0].baseCommit;
  assert.deepEqual(w.git(copy, 'diff', base, atFirst.reviewHead, '--name-only').split('\n').filter(Boolean), ['Probe/Probe.cs']);

  // Task 2's review, likewise: a distinct temp folder, and only source changes in the checkpoints.
  await setPaused(root, s0.id, false);
  await run(root, s0.id, w.env, (s) => s.tickets[0].task === 1 && s.tickets[0].phase === 'review');
  await setPaused(root, s0.id, true);
  const second = jobsBy(root, 'reviewer')[1];
  await waitFor(() => ['done', 'needs-review'].includes(readJob(findJobDir(root, second.id)).status), { timeoutMs: 300_000 });
  const secondTmp = assertReviewBuild(root, second, copy);
  assert.notEqual(secondTmp, firstTmp, 'each review gets its own temp folder');
  const atSecond = loadSprint(root, s0.id).tickets[0];
  assert.deepEqual([atSecond.hostTest.task, atSecond.hostTest.state], [2, 'passed']);
  assert.equal(checkLogs(root, s0.id).length, 2);
  assert.deepEqual(w.git(copy, 'diff', base, atSecond.reviewHead, '--name-only').split('\n').filter(Boolean).sort(), ['Probe/NativeMethods.cs', 'Probe/Probe.cs']);

  await setPaused(root, s0.id, false);
  const done = await run(root, s0.id, w.env, settled);
  assert.equal(done.tickets[0].state, 'pr-open', done.tickets[0].reason);
  const branch = jobsBy(root, 'author')[0].branch;
  assert.deepEqual(w.git(w.remote, 'diff', base, branch, '--name-only').split('\n').filter(Boolean).sort(), ['Probe/NativeMethods.cs', 'Probe/Probe.cs']);
  const shipped = w.git(w.remote, 'ls-tree', '-r', '--name-only', branch);
  for (const forbidden of ['.review-tmp', 'VBCSCompiler', 'AnalyzerAssemblyLoader', '/bin/', '/obj/', 'used-shared-compilation']) {
    assert.ok(!shipped.includes(forbidden), `the branch ships no ${forbidden}`);
  }
  assert.equal(fs.existsSync(path.join(copy, '.review-tmp')), false);
});

test('a locked legacy .review-tmp file parks the checkpoint with a release-and-retry path and ships nothing of it', { skip: WINDOWS_SKIP, timeout: 300_000 }, async (t) => {
  const { root, w } = sprintWorld({ plans: { 'docs/plan.md': PLAN } });
  scriptAgent(root, 'fa', [{ write: 'a.txt', content: 'task 1 source\n' }, { write: 'b.txt', content: 'task 2 source\n' }]);
  // Three reviews run: task 1's, task 1's again after Retry, then task 2's.
  scriptAgent(root, 'fr', [{ say: 'VERDICT: pass' }, { say: 'VERDICT: pass' }, { say: 'VERDICT: pass' }]);
  const s0 = await createSprint(root, { name: 'legacy lock', tickets: [T({ title: 'Legacy lock' })] }, { cwd: w.repo });
  await run(root, s0.id, w.env, (s) => s.tickets[0].phase === 'review');
  await setPaused(root, s0.id, true);
  const review = jobsBy(root, 'reviewer')[0];
  await waitFor(() => ['done', 'needs-review'].includes(readJob(findJobDir(root, review.id)).status), { timeoutMs: 300_000 });
  const author = jobsBy(root, 'author')[0];
  const copy = author.worktree;
  const checkpoint = readJob(findJobDir(root, author.id)).checkpoint;
  assert.ok(checkpoint);
  // A legacy lock, inserted after the review finished but before its cleanup tick.
  const file = '.review-tmp/VBCSCompiler/AnalyzerAssemblyLoader/x/Microsoft.Interop.ComInterfaceGenerator.dll';
  const held = path.join(copy, file);
  fs.mkdirSync(path.dirname(held), { recursive: true });
  fs.writeFileSync(held, 'legacy analyzer bytes');
  fs.writeFileSync(path.join(copy, 'a.txt'), 'source edit after checkpoint\n');
  const holder = await holdFile(held);
  t.after(() => holder.release());
  await setPaused(root, s0.id, false);
  const parked = await run(root, s0.id, w.env, (s) => s.tickets[0].state === 'parked');
  const ticket = parked.tickets[0];
  assert.equal(ticket.resume, 'review');
  assert.equal(ticket.task, 0);
  assert.equal(jobsBy(root, 'author').length, 1);
  assert.equal(jobsBy(root, 'reviewer').length, 1, 'no subsequent reviewer starts');
  const lock = ticket.checkpointLock;
  assert.ok(lock, ticket.reason);
  assert.equal(lock.file, file);
  assert.equal(lock.hint, 'dotnet');
  assert.deepEqual(Object.keys(lock).sort(), ['file', 'hint', 'stashAfter', 'stashBefore'], 'no holder is stored');
  assert.match(ticket.reason, /Microsoft\.Interop\.ComInterfaceGenerator\.dll/);
  assert.match(ticket.reason, /still open in a program/);
  assert.match(ticket.reason, /dotnet build-server shutdown in this ticket's copy/);
  assert.match(ticket.reason, /then Retry/);
  // The saved work is preserved: the checkpoint, the source edit, and every stash stay readable.
  assert.equal(w.git(copy, 'show', `${checkpoint}:a.txt`), 'task 1 source');
  const refs = w.git(copy, 'stash', 'list', '--format=%H').split('\n').filter(Boolean);
  for (const ref of refs) assert.doesNotThrow(() => w.git(copy, 'cat-file', '-e', `${ref}^{commit}`));
  const sources = [fs.readFileSync(path.join(copy, 'a.txt'), 'utf8'), ...refs.map((ref) => w.git(copy, 'show', `${ref}:a.txt`))];
  assert.ok(sources.some((text) => text.includes('source edit after checkpoint')), 'the source edit is recoverable');
  await holder.release();
  await retryTicket(root, s0.id, 'ABC-11');
  assert.equal(loadSprint(root, s0.id).tickets[0].checkpointLock, undefined);
  const done = await run(root, s0.id, w.env, settled);
  assert.equal(done.tickets[0].state, 'pr-open', done.tickets[0].reason);
  assert.equal(jobsBy(root, 'author').length, 2);
  for (const ref of refs) assert.ok(w.git(w.repo, 'stash', 'list', '--format=%H').includes(ref), 'prior stashes are retained after Retry');
  const branch = jobsBy(root, 'author')[0].branch;
  assert.match(w.git(w.remote, 'ls-tree', '-r', '--name-only', branch), /^a\.txt$/m);
  assert.match(w.git(w.remote, 'ls-tree', '-r', '--name-only', branch), /^b\.txt$/m);
  assert.deepEqual(w.git(w.remote, 'diff', author.baseCommit, branch, '--name-only').split('\n').filter(Boolean).sort(), ['a.txt', 'b.txt']);
  for (const forbidden of ['.review-tmp', 'VBCSCompiler', 'ComInterfaceGenerator']) {
    assert.ok(!w.git(w.remote, 'ls-tree', '-r', '--name-only', branch).includes(forbidden), `the branch ships no ${forbidden}`);
  }
});
