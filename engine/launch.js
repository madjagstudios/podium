import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PodiumError } from './errors.js';

// Characters cmd.exe would interpret even inside double quotes, plus newlines.
const UNSAFE = /["%!^&|<>\r\n]/;

export function assertArg(value) {
  if (typeof value !== 'string' || value.length === 0 || UNSAFE.test(value)) {
    throw new PodiumError('unsafe-arg', `Refusing to pass ${JSON.stringify(value)}: it is empty or contains characters a shell would interpret (" % ! ^ & | < > or a newline).`);
  }
  return value;
}

// Text that must reach a command line and say something, such as a sprint PR's title: double quotes become single
// ones and the other characters assertArg refuses are dropped, so it passes on Windows and keeps its words.
export function safeArgText(value) {
  const text = String(value ?? '').replace(/"/g, "'").replace(/[%!^&|<>\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text || '-';
}

// On Windows, turn a bare command name into the full path of the file cmd.exe would run.
// Shims such as muse.cmd locate their own files with %~dp0, which cmd.exe resolves to the
// current folder when the shim is started by a quoted bare name; a full path avoids that.
// Unknown names are returned unchanged so the failure still surfaces as "not installed".
export function resolveCommand(command, platform = process.platform, env = process.env) {
  if (platform !== 'win32' || /[\\/]/.test(command)) return command;
  const exts = (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const hasExt = exts.some((e) => command.toLowerCase().endsWith(e.toLowerCase()));
  for (const dir of (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of hasExt ? [''] : exts) {
      const candidate = path.join(dir, command + ext.toLowerCase());
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
  }
  return command;
}

// Agents on Windows are usually .cmd shims, which Node can only start through cmd.exe.
// Every part is checked and quoted; prompts never travel this way (stdin or file only).
export function commandLine(command, args, platform = process.platform, env = process.env) {
  if (platform !== 'win32') return { file: command, argv: [...args], verbatim: false };
  const parts = [resolveCommand(command, platform, env), ...args].map((a) => `"${assertArg(a)}"`);
  return { file: process.env.ComSpec || 'cmd.exe', argv: ['/d', '/s', '/c', `"${parts.join(' ')}"`], verbatim: true };
}

export function killTree(pid, platform = process.platform) {
  if (!pid) return;
  if (platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM'); // whole process group (detached runners lead their own group)
  } catch {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }
}

// A command Podium may stop at a time limit, with whatever it started (a transport, a credential helper, gh's git): on
// macOS and Linux it leads its own process group, so killGroup can stop them all; Windows stops a tree with taskkill /T.
export const ownGroup = (platform = process.platform) => (platform === 'win32' ? {} : { detached: true });

// Stop a command started with ownGroup, and everything it started, at once: it is past its time limit, so nothing is
// left to wait for. kill is a test seam.
export function killGroup(pid, { platform = process.platform, kill = (p, sig) => process.kill(p, sig) } = {}) {
  if (!pid) return;
  if (platform === 'win32') {
    killTree(pid, platform);
    return;
  }
  try {
    kill(-pid, 'SIGKILL');
  } catch {
    try { kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

export function runCaptured(command, args, { cwd, input, timeoutMs = 30_000, env } = {}) {
  return new Promise((resolve) => {
    const childEnv = env ? { ...process.env, ...env } : process.env;
    let line;
    try {
      line = commandLine(command, args, process.platform, childEnv);
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: e.message, timedOut: false, error: e });
      return;
    }
    const child = spawn(line.file, line.argv, {
      cwd,
      env: childEnv,
      windowsVerbatimArguments: line.verbatim,
      windowsHide: true,
      ...ownGroup(),
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
    // Past the time limit the whole tree is stopped, and the answer comes at once: a helper the command started may hold
    // its output open long after (as in Podium's git helper).
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid);
      resolve({ code: -1, stdout, stderr, timedOut });
    }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr + e.message, timedOut, error: e }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr, timedOut }); });
    child.stdin.on('error', () => {}); // the child may exit before reading stdin
    child.stdin.end(input ?? '');
  });
}

// The runner must outlive whoever called the CLI, so it gets its own process group
// and no pipes back to the caller.
export function spawnDetachedNode(script, args, { cwd } = {}) {
  const child = spawn(process.execPath, [script, ...args], { cwd, detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return child.pid;
}
