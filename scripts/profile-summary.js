import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('Provide the profile directory');
const files = new Map();
for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.ndjson'))) {
  for (const line of fs.readFileSync(path.join(dir, name), 'utf8').trim().split('\n').filter(Boolean)) {
    const row = JSON.parse(line);
    const file = row.file ? path.basename(row.file.replaceAll('\\', '/')) : '(runner)';
    const totals = files.get(file) || {};
    const metric = totals[row.kind] || { count: 0, ms: 0 };
    metric.count++; metric.ms += row.ms || 0;
    totals[row.kind] = metric;
    if (row.kind === 'test') (totals.tests ||= []).push({ name: row.name, ms: row.ms, result: row.result, skip: row.skip });
    files.set(file, totals);
  }
}
const runFile = path.join(dir, 'run.json');
const run = fs.existsSync(runFile) ? JSON.parse(fs.readFileSync(runFile, 'utf8')) : undefined;
console.log(JSON.stringify({ run, files: Object.fromEntries([...files].sort()) }, null, 2));
