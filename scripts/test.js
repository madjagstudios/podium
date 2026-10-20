// Run the Node test suites only. hooks/*.test.ts belong to `claude plugin test`;
// Node >= 23 strips TypeScript and would otherwise try to run them.
import { readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import { profileEnabled, profileWarning } from '../tests/profile-metrics.js';

const files = readdirSync('tests').filter((f) => f.endsWith('.test.js')).map((f) => path.join('tests', f));
const profile = profileEnabled ? process.env.PODIUM_TEST_PROFILE_DIR : undefined;
const options = profile ? ['--test-reporter=spec', '--test-reporter-destination=stdout', `--test-reporter=${new URL('../tests/profile-reporter.js', import.meta.url).href}`, '--test-reporter-destination=stdout'] : [];
const preload = pathToFileURL(fileURLToPath(new URL('../tests/profile-processes.js', import.meta.url))).href;
const env = profile ? { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --import=${preload}` } : { ...process.env, PODIUM_TEST_PROFILE_DIR: '' };
const metadata = profile ? { revision: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout?.trim(), osRelease: os.release(), parallelism: os.availableParallelism(), loadBefore: os.loadavg(), runId: process.env.GITHUB_RUN_ID } : {};
const start = performance.now();
const r = spawnSync(process.execPath, ['--test', ...options, ...files], { stdio: 'inherit', env });
if (profile) {
  try { writeFileSync(path.join(profile, 'run.json'), JSON.stringify({ ...metadata, node: process.version, platform: process.platform, arch: process.arch, files, wallMs: performance.now() - start, exitCode: r.status ?? 1, loadAfter: os.loadavg() }, null, 2)); }
  catch (error) { profileWarning(error); }
}
process.exit(r.status ?? 1);
