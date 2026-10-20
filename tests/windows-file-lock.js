import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// Fixed code only: the path (including quotes or shell characters) arrives as JSON on stdin.
const SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
$file = ConvertFrom-Json -InputObject ([Console]::ReadLine())
$stream = $null
try {
  $stream = [System.IO.FileStream]::new($file, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
  [Console]::WriteLine('READY')
  [Console]::Out.Flush()
  $null = [Console]::ReadLine()
} finally {
  if ($null -ne $stream) { $stream.Dispose() }
}
`;

async function bounded(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

export async function holdFile(file) {
  if (process.platform !== 'win32') throw new Error('holdFile requires Windows; skip this test on other platforms.');
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  let spawnError;
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr = (stderr + chunk).slice(-4096); });
  child.on('error', (error) => { spawnError = error; });
  child.stdin.on('error', () => {}); // Early exit is reported by closed below.
  const closed = new Promise((resolve) => child.once('close', (code) => resolve(code)));
  const lines = createInterface({ input: child.stdout });
  const ready = new Promise((resolve) => lines.on('line', (line) => { if (line === 'READY') resolve(); }));
  let releasePromise;
  const release = () => releasePromise ??= (async () => {
    try {
      child.stdin.end('\n');
      const code = await bounded(closed, 10_000, 'File holder did not exit after release.');
      if (code !== 0) throw spawnError ?? new Error(`File holder exited with code ${code}: ${stderr}`);
    } finally {
      if (child.exitCode === null && child.signalCode === null && child.pid) {
        child.kill(); // Only the child owned by this helper.
        await bounded(closed, 10_000, 'File holder did not exit after termination.');
      }
      lines.close();
    }
  })();
  let started = false;
  try {
    child.stdin.write(`${JSON.stringify(file)}\n`);
    await bounded(Promise.race([ready, closed.then((code) => {
      throw spawnError ?? new Error(`File holder exited before ready (${code}): ${stderr}`);
    })]), 30_000, 'File holder did not become ready.');
    started = true;
    return { pid: child.pid, release };
  } finally {
    if (!started) await release();
  }
}
