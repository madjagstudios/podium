#!/usr/bin/env node
// Stand-in for the gh CLI. PODIUM_FAKE_GH names a JSON file:
// { "log": "<path>", "responses": [{ "match": ["pr", "create"], "stdout": "...", "code": 0, "stderr": "" }] }
// The first response whose match is a prefix of argv answers; every call is appended to log.
import fs from 'node:fs';

const args = process.argv.slice(2);
const spec = JSON.parse(fs.readFileSync(process.env.PODIUM_FAKE_GH, 'utf8'));
// A call with --body-file is logged with the body itself after it ('--body-text', content): Podium removes the file at once.
const bodyAt = args.indexOf('--body-file');
const body = bodyAt >= 0 && fs.existsSync(args[bodyAt + 1]) ? ['--body-text', fs.readFileSync(args[bodyAt + 1], 'utf8')] : [];
if (spec.log) fs.appendFileSync(spec.log, JSON.stringify([...args, ...body]) + '\n');
const hit = (spec.responses ?? []).find((r) => r.match.every((m, i) => args[i] === m));
if (!hit) {
  console.error(`fake-gh: no response for ${args.join(' ')}`);
  process.exit(1);
}
// A held answer: it says it arrived (a line appended to `arrived`), then waits until the file `gate` exists (at most 30 s),
// so a test can let several callers reach gh before any of them gets its answer.
if (hit.arrived) fs.appendFileSync(hit.arrived, `${process.pid}\n`);
if (hit.gate) {
  const until = Date.now() + 30_000;
  while (!fs.existsSync(hit.gate) && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
}
// A slow gh (ms), and one that shows the given variables of its environment (echoEnv) as JSON.
if (hit.ms) await new Promise((r) => setTimeout(r, hit.ms));
if (hit.echoEnv) process.stdout.write(JSON.stringify(Object.fromEntries(hit.echoEnv.map((k) => [k, process.env[k] ?? null]))));
if (hit.stdout !== undefined) process.stdout.write(typeof hit.stdout === 'string' ? hit.stdout : JSON.stringify(hit.stdout));
if (hit.stderr) process.stderr.write(hit.stderr);
process.exit(hit.code ?? 0);
