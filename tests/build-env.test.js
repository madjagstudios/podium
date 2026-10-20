import test from 'node:test';
import assert from 'node:assert/strict';
import { copyBuildEnv } from '../engine/build-env.js';

const defaults = {
  UseSharedCompilation: 'false',
  DOTNET_CLI_USE_MSBUILD_SERVER: '0',
  MSBUILDDISABLENODEREUSE: '1',
};

test('copyBuildEnv returns a complete new environment without changing its input', () => {
  const env = Object.freeze({ PATH: '/tools/bin', TMPDIR: '/tmp/job', TEMP: '/temp/job', TMP: '/tmp/other', CUSTOM: 'kept', EMPTY: '' });
  const result = copyBuildEnv(env);
  assert.notEqual(result, env);
  assert.deepEqual(result, { ...env, ...defaults });
  result.CUSTOM = 'changed';
  assert.equal(env.CUSTOM, 'kept');
});

test('copyBuildEnv overrides inherited shared-process settings and removes every case variant', () => {
  const env = Object.freeze({
    Path: 'C:\\tools', unrelated: 'kept',
    UseSharedCompilation: 'true', USESHAREDCOMPILATION: 'true', usesharedcompilation: 'true',
    DOTNET_CLI_USE_MSBUILD_SERVER: '1', dotnet_cli_use_msbuild_server: '1',
    MSBUILDDISABLENODEREUSE: '0', MsBuildDisableNodeReuse: '0',
  });
  assert.deepEqual(copyBuildEnv(env), { Path: 'C:\\tools', unrelated: 'kept', ...defaults });
});

test('copyBuildEnv defaults to the current process environment without mutating it', () => {
  const before = { ...process.env };
  assert.deepEqual(copyBuildEnv(), copyBuildEnv(before));
  assert.deepEqual({ ...process.env }, before);
});
