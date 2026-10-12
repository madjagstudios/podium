#!/usr/bin/env node
// Stand-in for a real agent CLI. Behaviour is chosen with --mode.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('fake-agent 1.2.3'); process.exit(0); }
if (args.includes('--help')) {
  console.log('Usage: fake [OPTIONS] [PROMPT]\n\nCommands:\n  exec   Run one prompt headless\n\nOptions:\n  --model <ID>          Model id\n  --prompt-file <PATH>  Read prompt from file\n');
  process.exit(0);
}
const modeAt = args.indexOf('--mode');
const mode = modeAt >= 0 ? args[modeAt + 1] : 'ok';
const passed = modeAt >= 0 ? args.slice(modeAt + 2) : args;
const fileAt = passed.indexOf('--prompt-file');

async function readPrompt() {
  if (fileAt >= 0) return fs.readFileSync(passed[fileAt + 1], 'utf8');
  let s = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) s += chunk;
  return s;
}

const prompt = await readPrompt();
console.log(`PROMPT: ${prompt.trim()}`);
console.log(`ARGS: ${passed.join(' ')}`);
switch (mode) {
  case 'ok': console.log('ready'); break;
  case 'summary': console.log('## Summary\nDid the thing.\nAll tests pass.\n\n## Details\nLots of detail.'); break;
  case 'fail': console.error('boom'); process.exit(3); break;
  case 'slow': await new Promise((r) => setTimeout(r, 60_000)); break;
  case 'edit': fs.writeFileSync('fake-edit.txt', 'edited by fake\n'); console.log('edited'); break;
  case 'chatty':
    console.log('step one');
    await new Promise((r) => setTimeout(r, 50));
    console.error('\x1b[32mreading src/a.ts\x1b[0m');
    await new Promise((r) => setTimeout(r, 50));
    console.error('⠋');
    break;
  case 'commit':
  case 'commit-here':
  case 'commit-dirty': {
    const git = (...a) => execFileSync('git', a, { stdio: 'pipe' });
    if (mode !== 'commit-here') git('checkout', '-q', '-b', 'feat/agent-work');
    fs.writeFileSync('agent.txt', 'agent work\n');
    git('add', '-A');
    git('-c', 'user.name=Fake', '-c', 'user.email=fake@example.com', 'commit', '-qm', 'Agent work');
    if (mode === 'commit-dirty') fs.writeFileSync('loose.txt', 'not committed\n');
    console.log('committed');
    break;
  }
  case 'env': console.log(`JOB=${process.env.PODIUM_JOB_ID ?? ''}`); break;
  case 'sandbox-broken':
    console.error('tool failed: windows_elevated unified exec session launcher unavailable: sandbox enforcement unavailable: Windows sandbox ACL update failed for C:\\x: SetNamedSecurityInfoW failed: 1340');
    console.log('I could not run any commands.');
    break;
  case 'edit2': fs.writeFileSync('fake-edit2.txt', 'edited by fake2\n'); console.log('edited 2'); break;
  case 'session': console.error('session id: 0f3c9d4e-1111-4222-8333-944455556666'); console.log(`ARGV ${passed.join(' ')}`); break;
  case 'resume-fails':
    if (passed.includes('--resume')) { console.error('error: no conversation found for that session'); process.exit(1); }
    console.log(`fresh ARGV ${passed.join(' ')}`);
    break;
  case 'script': {
    // Scripted runs: each run takes the next step of the JSON list in --script <file>.
    const file = passed[passed.indexOf('--script') + 1];
    const queue = JSON.parse(fs.readFileSync(file, 'utf8'));
    const step = queue.shift() ?? { say: 'nothing scripted' };
    fs.writeFileSync(file, JSON.stringify(queue));
    // A step can clear a path first (an agent tidying its own mistake).
    if (step.rm) fs.rmSync(path.resolve(step.rm), { recursive: true, force: true });
    if (step.write) {
      // A plan goes into docs/plans, which a new copy may not have yet.
      fs.mkdirSync(path.dirname(path.resolve(step.write)), { recursive: true });
      fs.writeFileSync(step.write, step.content ?? `${step.write}\n`);
    }
    // More files in the same run ({ path: content }): a planner that also changes code, say.
    for (const [file, content] of Object.entries(step.also ?? {})) {
      fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
      fs.writeFileSync(file, content);
    }
    // The agent commits its own work (step.commit is the message).
    if (step.commit) {
      const git = (...a) => execFileSync('git', a, { stdio: 'pipe' });
      git('add', '-A');
      git('-c', 'user.name=Fake', '-c', 'user.email=fake@example.com', 'commit', '-qm', step.commit);
    }
    // A writer's report of its tests, only from a step that writes a file or sets tests (a reviewer's step
    // prints none; a planner's plan file prints one, which nothing reads): "TESTS: passed" unless the step says
    // otherwise (tests: 'not-run', 'failed', 'none-needed: why', or false for no line). Printed before `say`.
    if (step.tests !== undefined ? step.tests !== false : Boolean(step.write)) console.log(`TESTS: ${step.tests ?? 'passed'}`);
    if (step.say) console.log(step.say);
    if (step.err) console.error(step.err);
    if (step.ms) await new Promise((r) => setTimeout(r, step.ms));
    process.exit(step.exit ?? 0);
  }
  default: console.error(`unknown mode ${mode}`); process.exit(2);
}
