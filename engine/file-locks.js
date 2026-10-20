import fs from 'node:fs';
import path from 'node:path';

const MAX_PATH = 1024;
const MAX_OUTPUT = 16 * 1024;

// Git's double-quoted paths use C escapes, including octal UTF-8 bytes (not JS Unicode escapes).
function gitPath(raw, unlink) {
  // Only unlink messages add single-quote delimiters. Removal warnings can contain literal single quotes.
  if (unlink && raw.startsWith("'") && raw.endsWith("'")) raw = raw.slice(1, -1);
  if (!raw.startsWith('"')) return raw;
  if (!raw.endsWith('"')) return null;
  const bytes = [];
  const escapes = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '\\': 92, '"': 34 };
  for (let i = 1; i < raw.length - 1;) {
    if (raw[i] !== '\\') {
      if (raw[i] === '"') return null;
      const char = String.fromCodePoint(raw.codePointAt(i));
      bytes.push(...Buffer.from(char)); i += char.length;
    } else {
      const octal = raw.slice(i + 1, -1).match(/^[0-3][0-7]{2}/)?.[0];
      if (octal) { bytes.push(parseInt(octal, 8)); i += 4; }
      else if (Object.hasOwn(escapes, raw[i + 1])) { bytes.push(escapes[raw[i + 1]]); i += 2; }
      else return null;
    }
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes)); }
  catch { return null; }
}

const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

function validated(copy, raw, unlink) {
  const file = gitPath(raw, unlink);
  if (!file || file.length > MAX_PATH || /[\x00-\x1f\x7f-\x9f]/.test(file) || file.split(/[\\/]/).includes('..')) return null;
  // Off Windows a name like "a: b.txt" is an ordinary file; only a path Windows would read as absolute is refused.
  if (process.platform !== 'win32' && path.win32.isAbsolute(file)) return null;
  try {
    const absolute = path.resolve(copy, file);
    if (!inside(path.resolve(copy), absolute)) return null;
    const root = fs.realpathSync.native(copy);
    const real = fs.realpathSync.native(absolute);
    if (!inside(root, real) || !fs.statSync(real).isFile()) return null;
    const relative = path.relative(path.resolve(copy), absolute).replaceAll(path.sep, '/');
    if (relative.length > MAX_PATH) return null;
    return { absolute: real, file: relative };
  } catch { return null; }
}

// Which file blocked a stash push, from the bounded Git output on a git-failed error.
// It doesn't look up which program holds the file: on Windows that needs a PowerShell script run with its execution
// policy bypassed, which security software rightly flags.
export async function diagnoseStashFailure(copy, error) {
  if (error?.code !== 'git-failed') return null;
  let recognized = false;
  let candidate = null;
  for (const stream of ['stderr', 'stdout']) {
    const text = String(error.details?.[stream] ?? '').slice(0, MAX_OUTPUT);
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^(?:(?:warning|error):\s*)?(failed to remove|unable to unlink(?: old)?|cannot unlink|could not remove) (.+): (?:Invalid argument|Permission denied|Access is denied\.?|Device or resource busy|Resource busy|Operation not permitted|Sharing violation)\s*$/i);
      if (!match) continue;
      recognized = true;
      candidate = validated(copy, match[2], /^unable to unlink/i.test(match[1]));
      if (candidate) break;
    }
    if (candidate) break;
  }
  if (!recognized) return null;
  return { file: candidate?.file ?? 'an unidentified file', hint: candidate && /(?:^|\/)VBCSCompiler\/|(?:^|\/)AnalyzerAssemblyLoader\//i.test(candidate.file) ? 'dotnet' : null };
}

export function checkpointLockMessage({ file, hint }) {
  return `Podium couldn't finish saving changes because ${file} is still open in a program. Close the program holding the file, then Retry. The ticket's copy and any stash Git made have been kept.${hint === 'dotnet' ? " For a .NET compiler server, run dotnet build-server shutdown in this ticket's copy, then Retry." : ''}`;
}
