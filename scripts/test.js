// Run the Node test suites only. hooks/*.test.ts belong to `claude plugin test`;
// Node >= 23 strips TypeScript and would otherwise try to run them.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const files = readdirSync('tests').filter((f) => f.endsWith('.test.js')).map((f) => path.join('tests', f));
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
