import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { FAKE_AGENT, tempRepo } from './helpers.js';

test('fake agent echoes prompt and args', () => {
  const out = execFileSync(process.execPath, [FAKE_AGENT, '--mode', 'ok', '--ro'], { input: 'hi there', encoding: 'utf8' });
  assert.match(out, /PROMPT: hi there/);
  assert.match(out, /ARGS: --ro/);
  assert.match(out, /ready/);
});

test('fake agent reports a version', () => {
  assert.match(execFileSync(process.execPath, [FAKE_AGENT, '--version'], { encoding: 'utf8' }), /fake-agent 1\.2\.3/);
});

test('tempRepo creates a committed git repo', () => {
  const repo = tempRepo();
  assert.ok(fs.existsSync(path.join(repo, '.git')));
  assert.match(execFileSync('git', ['log', '--oneline'], { cwd: repo, encoding: 'utf8' }), /init/);
});
