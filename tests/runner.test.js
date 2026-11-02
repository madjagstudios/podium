import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { saveAdapter } from '../engine/adapters/registry.js';
import { createJob, updateJob, readJob } from '../engine/store.js';
import { createWorktree } from '../engine/worktree.js';
import { runJob, recordCrash } from '../engine/runner.js';
import { tempRoot, tempRepo, fakeAdapter, scriptAgent } from './helpers.js';
import { setSetting } from '../engine/settings.js';
import * as runner from '../engine/runner.js';

function setup(mode, extra = {}) {
  const root = tempRoot();
  saveAdapter(root, fakeAdapter(mode, extra));
  const { job, dir } = createJob(root, { project: 'demo', ticket: 'NO-TICKET', agent: 'fake', permission: 'read-only', cwd: tempRoot(), prompt: 'Do the task' });
  return { root, job, dir };
}

for (const kind of ['writer', 'reviewer', 'ordinary']) {
  test(`${kind} launch receives the copy build defaults only when it has a copy`, async () => {
    const { root, dir, job } = setup('ok');
    const defaults = { UseSharedCompilation: 'false', DOTNET_CLI_USE_MSBUILD_SERVER: '0', MSBUILDDISABLENODEREUSE: '1' };
    const inherited = { UseSharedCompilation: 'true', DOTNET_CLI_USE_MSBUILD_SERVER: '1', MSBUILDDISABLENODEREUSE: '0', PODIUM_JOB_ID: 'parent-job' };
    const temps = ['TMPDIR', 'TEMP', 'TMP'];
    const names = [...Object.keys(inherited), ...temps];
    scriptAgent(root, 'fake', [{ envValues: names, ...(kind === 'reviewer' ? { env: 'TMPDIR' } : {}) }]);
    let copy;
    if (kind !== 'ordinary') {
      const repo = tempRepo();
      copy = path.join(root, 'worktrees', kind);
      const branch = `podium/${job.id}`;
      const base = await createWorktree(repo, copy, branch);
      updateJob(root, dir, { permission: 'edit-worktree', repoRoot: repo, worktree: copy, branch, baseCommit: base, step: 2, scratchTmp: kind === 'reviewer' });
    }
    for (const name of temps) inherited[name] = path.join(copy || job.cwd, '.review-tmp');
    const before = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    let result;
    try {
      Object.assign(process.env, inherited);
      result = await runJob(root, dir);
    } finally {
      for (const [name, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
    }
    assert.equal(result.status, 'done');
    const output = fs.readFileSync(path.join(dir, 'output.md'), 'utf8');
    const values = JSON.parse(output.match(/^ENV_VALUES (.+)$/m)[1]);
    const expected = { ...inherited, ...(copy ? defaults : {}), PODIUM_JOB_ID: job.id };
    if (kind === 'reviewer') {
      const tmp = path.resolve(dir, 'tmp');
      for (const name of temps) expected[name] = tmp;
      assert.match(output, /ENV TMPDIR=.* writable=true/);
      assert.ok(path.relative(copy, tmp).startsWith('..'));
      assert.equal(fs.existsSync(tmp), false);
    }
    assert.deepEqual(values, expected);
    assert.equal(fs.existsSync(path.join(copy || job.cwd, '.review-tmp')), false);
  });
}

test('scratch temp creation fails explicitly instead of inheriting an unsafe folder', () => {
  const dir = tempRoot();
  const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
  assert.equal(typeof runner.tempEnv, 'function');
  assert.throws(
    () => runner.tempEnv({ scratchTmp: true }, dir, { mkdir() { throw denied; } }),
    (e) => e.code === 'review-temp-unavailable'
      && e.message.includes('temporary folder')
      && e.message.includes(path.resolve(dir, 'tmp'))
      && e.details.cause === 'EACCES'
  );
  assert.deepEqual(runner.tempEnv({ scratchTmp: false }, dir, { mkdir() { assert.fail('not a scratch job'); } }), {});
});

test('scratch paths are absolute even for a relative job directory', () => {
  const dir = tempRoot();
  const tmp = path.resolve(dir, 'tmp');
  assert.equal(typeof runner.tempEnv, 'function');
  assert.deepEqual(runner.tempEnv({ scratchTmp: true }, path.relative(process.cwd(), dir)), { TMPDIR: tmp, TEMP: tmp, TMP: tmp });
  fs.writeFileSync(path.join(tmp, 'probe.txt'), 'writable');
});

test('a scratch preparation error happens before output streams open or the agent starts', async () => {
  const { root, dir } = setup('ok');
  updateJob(root, dir, { scratchTmp: true });
  fs.writeFileSync(path.join(dir, 'tmp'), 'a file blocks directory creation');
  await assert.rejects(runJob(root, dir), (e) => e.code === 'review-temp-unavailable');
  // Let any mistakenly opened streams finish opening before checking for their files.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fs.existsSync(path.join(dir, 'output.md')), false);
  assert.equal(fs.existsSync(path.join(dir, 'stderr.log')), false);
  assert.equal(readJob(dir).agentPid, null);
  assert.equal(readJob(dir).status, 'queued');
});

test('scratch jobs override all inherited temp variables with a writable folder outside the copy', async () => {
  const { root, dir, job } = setup('ok');
  const probe = path.join(root, 'temp-probe.cjs');
  fs.writeFileSync(probe, `const fs = require('node:fs');
    const path = require('node:path');
    const values = Object.fromEntries(['TMPDIR', 'TEMP', 'TMP'].map(key => [key, process.env[key]]));
    for (const [key, value] of Object.entries(values)) fs.writeFileSync(path.join(value, key), 'writable');
    console.log(JSON.stringify(values));`);
  saveAdapter(root, fakeAdapter('ok', { baseArgs: [probe] }));
  updateJob(root, dir, { scratchTmp: true });
  const inherited = Object.fromEntries(['TMPDIR', 'TEMP', 'TMP'].map(key => [key, process.env[key]]));
  try {
    for (const key of Object.keys(inherited)) process.env[key] = path.join(job.cwd, '.review-tmp');
    await runJob(root, dir);
  } finally {
    for (const [key, value] of Object.entries(inherited)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  const tmp = path.resolve(dir, 'tmp');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'output.md'), 'utf8')), { TMPDIR: tmp, TEMP: tmp, TMP: tmp });
  assert.ok(path.relative(job.cwd, tmp).startsWith('..'));
  assert.equal(fs.existsSync(path.join(job.cwd, '.review-tmp')), false);
  assert.equal(fs.existsSync(tmp), false);
});

test('a successful job streams output and finishes done', async () => {
  const { root, dir } = setup('ok');
  const job = await runJob(root, dir);
  assert.equal(job.status, 'done');
  assert.equal(job.exitCode, 0);
  assert.equal(job.runnerPid, process.pid);
  assert.ok(job.startedAt && job.endedAt);
  const out = fs.readFileSync(path.join(dir, 'output.md'), 'utf8');
  assert.match(out, /PROMPT: Do the task/);
  assert.match(out, /ARGS: --ro/);
});

test('an adapter\'s settings layer is written into the job folder and passed to the agent', async () => {
  const { root, dir } = setup('ok', { settings: { flag: '--settings', content: { disableAllHooks: true } } });
  const job = await runJob(root, dir);
  assert.equal(job.status, 'done');
  const file = path.join(dir, 'agent-settings.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { disableAllHooks: true });
  const args = fs.readFileSync(path.join(dir, 'output.md'), 'utf8').match(/^ARGS: (.*)$/m)[1];
  assert.ok(args.includes(`--settings ${file}`), args);
});

test('an adapter without a settings layer gets no settings file or flag', async () => {
  const { root, dir } = setup('ok');
  await runJob(root, dir);
  assert.equal(fs.existsSync(path.join(dir, 'agent-settings.json')), false);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'output.md'), 'utf8').match(/^ARGS: (.*)$/m)[1], /--settings/);
});

test('a summary section becomes summary.md', async () => {
  const { root, dir } = setup('summary');
  await runJob(root, dir);
  assert.equal(fs.readFileSync(path.join(dir, 'summary.md'), 'utf8'), 'Did the thing.\nAll tests pass.\n');
});

test('prompts can be delivered by file', async () => {
  const { root, dir } = setup('ok', { promptVia: 'file', promptFileFlag: '--prompt-file' });
  await runJob(root, dir);
  assert.match(fs.readFileSync(path.join(dir, 'output.md'), 'utf8'), /PROMPT: Do the task/);
});

test('a failing agent marks the job failed with an unknown outcome', async () => {
  const { root, dir } = setup('fail');
  const job = await runJob(root, dir);
  assert.equal(job.status, 'failed');
  assert.equal(job.exitCode, 3);
  assert.equal(job.outcome, 'unknown');
  assert.match(job.error, /Fake exited with code 3/);
  assert.match(fs.readFileSync(path.join(dir, 'stderr.log'), 'utf8'), /boom/);
  assert.equal('limit' in job, false, 'boom is not a limit');
});

test('an agent that stops on a usage limit says so, with when it resets', async () => {
  const { root, dir } = setup('ok');
  scriptAgent(root, 'fake', [{ err: "You've hit your session limit · resets 3am (UTC)", exit: 1 }]);
  const before = Date.now();
  const job = await runJob(root, dir);
  assert.equal(job.status, 'failed');
  assert.equal(job.outcome, 'unknown');
  assert.equal(job.error, "Fake hit a usage limit: You've hit your session limit · resets 3am (UTC) (exit code 1)");
  assert.equal(job.limit.kind, 'usage');
  const at = new Date(job.limit.resetAt);
  assert.equal(job.limit.resetAt, at.toISOString());
  assert.ok(at.getTime() >= before - 60_000 && at.getTime() <= Date.now() + 24 * 3_600_000, job.limit.resetAt);
  assert.equal(at.getUTCHours(), 3);
  assert.equal(at.getUTCMinutes(), 0);
});

test('an agent that stops on a busy service says so', async () => {
  const { root, dir } = setup('ok');
  scriptAgent(root, 'fake', [{ err: 'Selected model is at capacity. Please try a different model.', exit: 1 }]);
  const job = await runJob(root, dir);
  assert.equal(job.status, 'failed');
  assert.equal(job.error, "Fake couldn't get through, its service was busy: Selected model is at capacity. Please try a different model. (exit code 1)");
  assert.deepEqual(job.limit, { kind: 'busy', resetAt: null });
});

test('an edit job in a worktree produces a patch and needs review', async () => {
  const { root, dir } = setup('edit');
  const repo = tempRepo();
  const wt = path.join(root, 'worktrees', 'x');
  const base = await createWorktree(repo, wt, 'podium/x');
  updateJob(root, dir, { permission: 'edit-worktree', repoRoot: repo, worktree: wt, branch: 'podium/x', baseCommit: base });
  const job = await runJob(root, dir);
  assert.equal(job.status, 'needs-review');
  assert.equal(job.hasChanges, true);
  assert.deepEqual(job.changes, { files: 1, added: 1, removed: 0 });
  assert.match(fs.readFileSync(path.join(dir, 'diff.patch'), 'utf8'), /fake-edit\.txt/);
  assert.equal(fs.existsSync(path.join(repo, 'fake-edit.txt')), false);
});

test('a job cancelled while running stays cancelled', async () => {
  const { root, dir } = setup('ok');
  const running = runJob(root, dir);
  updateJob(root, dir, { status: 'cancelled' });
  const job = await running;
  assert.equal(job.status, 'cancelled');
});

test('recordCrash marks the job failed and never throws', () => {
  const { root, dir } = setup('ok');
  recordCrash(root, dir, new Error('disk full'));
  assert.equal(readJob(dir).status, 'failed');
  assert.match(readJob(dir).error, /disk full/);
  recordCrash(root, path.join(dir, 'missing'), new Error('x'));
});

test('a running job keeps live.json up to date', async () => {
  const { root, dir } = setup('chatty');
  await runJob(root, dir);
  const live = JSON.parse(fs.readFileSync(path.join(dir, 'live.json'), 'utf8'));
  assert.equal(live.activity, 'reading src/a.ts');
  assert.ok(live.lines.includes('step one'));
});

async function commitJob(mode) {
  const { root, dir } = setup(mode);
  const repo = tempRepo();
  const wt = path.join(root, 'worktrees', 'x');
  const base = await createWorktree(repo, wt, 'podium/x');
  updateJob(root, dir, { permission: 'edit-worktree', repoRoot: repo, worktree: wt, branch: 'podium/x', baseCommit: base });
  return { root, dir, repo, wt, job: await runJob(root, dir) };
}
const branchExists = (repo, b) => {
  try { execFileSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`], { cwd: repo, stdio: 'pipe' }); return true; } catch { return false; }
};

test('an agent that commits on a new branch: the commits are the result and the copy is removed', async () => {
  const { dir, repo, wt, job } = await commitJob('commit');
  assert.equal(job.status, 'done');
  assert.equal(job.hasChanges, false);
  assert.deepEqual({ branch: job.committed.branch, count: job.committed.count, subject: job.committed.commits[0].subject }, { branch: 'feat/agent-work', count: 1, subject: 'Agent work' });
  assert.equal(job.worktree, null);
  assert.equal(fs.existsSync(wt), false);
  assert.equal(branchExists(repo, 'feat/agent-work'), true);
  assert.equal(branchExists(repo, 'podium/x'), false);
  assert.equal(fs.existsSync(path.join(dir, 'diff.patch')), false);
});

test('commits on Podium\'s own branch keep that branch', async () => {
  const { repo, wt, job } = await commitJob('commit-here');
  assert.equal(job.committed.branch, 'podium/x');
  assert.equal(fs.existsSync(wt), false);
  assert.equal(branchExists(repo, 'podium/x'), true);
});

test('uncommitted leftovers keep the copy', async () => {
  const { wt, job } = await commitJob('commit-dirty');
  assert.equal(job.leftovers, true);
  assert.equal(job.worktree, wt);
  assert.equal(fs.existsSync(wt), true);
});

test('an edit copy with no changes and no commits is removed', async () => {
  const { wt, job } = await commitJob('ok');
  assert.equal(job.status, 'done');
  assert.equal(job.worktree, null);
  assert.equal(fs.existsSync(wt), false);
});

test('agents run with PODIUM_JOB_ID set, so the mod stays out of them', async () => {
  const { root, dir, job } = setup('env');
  await runJob(root, dir);
  assert.match(fs.readFileSync(path.join(dir, 'output.md'), 'utf8'), new RegExp(`JOB=${job.id}`));
});

test('an agent whose sandbox cannot start gets a plain warning', async () => {
  const { root, dir } = setup('sandbox-broken');
  const job = await runJob(root, dir);
  assert.equal(job.warning.code, 'sandbox-broken');
  assert.match(job.warning.message, /Fake couldn't run any commands/);
  assert.equal(job.warning.repair, null);
});

test('an id the agent prints is captured as its conversation', async () => {
  const { root, dir } = setup('session', { resume: { capture: 'session id: ([0-9a-f-]{36})', continue: { args: ['--resume', '{id}'] } } });
  const job = await runJob(root, dir);
  assert.deepEqual(job.agentSession, { agent: 'fake', id: '0f3c9d4e-1111-4222-8333-944455556666' });
});

test('a step with resumeFrom runs the resume arguments', async () => {
  const { root, dir } = setup('session', { resume: { continue: { args: ['--resume', '{id}'] } } });
  updateJob(root, dir, { resumeFrom: 'abc', agentSession: { agent: 'fake', id: 'abc' }, step: 2 });
  await runJob(root, dir);
  assert.match(fs.readFileSync(path.join(dir, 'output.md'), 'utf8'), /--resume abc/);
});

test('a resume that fails fast is retried once as a fresh conversation with the brief', async () => {
  const { root, dir } = setup('resume-fails', { resume: { continue: { args: ['--resume', '{id}'] } } });
  fs.writeFileSync(path.join(dir, 'prompt-brief.md'), 'You are continuing work… Now:\nDo it');
  updateJob(root, dir, { resumeFrom: 'gone', agentSession: { agent: 'fake', id: 'gone' }, step: 2 });
  const job = await runJob(root, dir);
  assert.equal(job.status, 'done');
  assert.equal(job.resumeFailed, true);
  assert.equal(job.resumeFrom, null);
  assert.match(fs.readFileSync(path.join(dir, 'output.md'), 'utf8'), /fresh ARGV/);
  assert.equal(fs.readFileSync(path.join(dir, 'prompt.md'), 'utf8'), 'You are continuing work… Now:\nDo it');
});

test('a later step that changed nothing keeps the thread copy', async () => {
  const { root, dir } = setup('ok');
  const repo = tempRepo();
  const wt = path.join(root, 'worktrees', 'x');
  const base = await createWorktree(repo, wt, 'podium/x');
  updateJob(root, dir, { permission: 'edit-worktree', repoRoot: repo, worktree: wt, branch: 'podium/x', baseCommit: base, step: 2 });
  const job = await runJob(root, dir);
  assert.equal(job.worktree, wt);
  assert.equal(fs.existsSync(wt), true);
});

test('after a failed resume the fresh conversation id is captured, not the dead one', async () => {
  const { root, dir } = setup('session', { resume: { capture: 'session id: ([0-9a-f-]{36})', continue: { args: ['--resume', '{id}'] } } });
  fs.writeFileSync(path.join(dir, 'stderr.log'), 'session id: 11111111-1111-4111-8111-111111111111\nerror: no conversation\n');
  const job = await runJob(root, dir);
  assert.equal(job.agentSession.id, '0f3c9d4e-1111-4222-8333-944455556666');
});

test('a step runs with the repo\'s commands allowed when its adapter says how', async () => {
  const root = tempRoot();
  saveAdapter(root, fakeAdapter('ok', { allow: { flag: '--allow', rules: ['Bash({cmd}:*)', 'PowerShell({cmd}:*)'] } }));
  setSetting(root, 'repoCommands', { demo: ['dotnet'] });
  const inCopy = async () => {
    const made = createJob(root, { project: 'demo', ticket: 'NO-TICKET', agent: 'fake', permission: 'edit-worktree', cwd: tempRoot(), prompt: 'Run dotnet --version' });
    const repo = tempRepo();
    const wt = path.join(tempRoot(), 'copy');
    const base = await createWorktree(repo, wt, `podium/${made.job.id}`);
    updateJob(root, made.dir, { repoRoot: repo, worktree: wt, branch: `podium/${made.job.id}`, baseCommit: base });
    return made.dir;
  };
  const dir = await inCopy();
  await runJob(root, dir);
  assert.match(fs.readFileSync(path.join(dir, 'output.md'), 'utf8'), /ARGS: --rw --allow Bash\(dotnet:\*\) PowerShell\(dotnet:\*\)/);
  // A hand-edited list that is not a list does not crash the step.
  fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ repoCommands: { demo: 'dotnet' } }));
  const again = await inCopy();
  await runJob(root, again);
  assert.match(fs.readFileSync(path.join(again, 'output.md'), 'utf8'), /ARGS: --rw\s*$/m);
});

test('an edit job in the person\'s own folder (no copy) gets no allow rule', async () => {
  const root = tempRoot();
  saveAdapter(root, fakeAdapter('ok', { allow: { flag: '--allow', rules: ['Bash({cmd}:*)', 'PowerShell({cmd}:*)'] } }));
  setSetting(root, 'repoCommands', { demo: ['dotnet'] });
  const { dir } = createJob(root, { project: 'demo', ticket: 'NO-TICKET', agent: 'fake', permission: 'edit-worktree', cwd: tempRoot(), prompt: 'Run dotnet --version' });
  await runJob(root, dir);
  assert.match(fs.readFileSync(path.join(dir, 'output.md'), 'utf8'), /ARGS: --rw\s*$/m);
});
