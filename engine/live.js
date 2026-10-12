// The live-progress file the pane reads while a job runs.
// This module is its only writer. Format v1:
//   { v: 1, updatedAt: ISO string, activity: string | null, lines: string[] (last 20), bytes: number }
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export const LIVE_FILE = 'live.json';
export const LIVE_LINES = 20;
const ACTIVITY_MAX = 120;
// CSI sequences (colours, cursor moves) and OSC sequences (titles, links).
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function cleanLine(raw) {
  return String(raw).replace(ANSI, '').replace(/\s+$/, '');
}

export function activityOf(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (/[\p{L}\p{N}]/u.test(line)) return line.length > ACTIVITY_MAX ? `${line.slice(0, ACTIVITY_MAX - 1)}…` : line;
  }
  return null;
}

export function createLiveWriter(dir, { intervalMs = 1000 } = {}) {
  const file = path.join(dir, LIVE_FILE);
  const decoders = { out: new StringDecoder('utf8'), err: new StringDecoder('utf8') };
  const partial = { out: '', err: '' };
  let lines = [];
  let bytes = 0;
  let timer = null;
  let lastWrite = Date.now(); // the first write also waits intervalMs, so a burst of early output is one write

  function push(raw) {
    const line = cleanLine(raw);
    if (!line.trim()) return;
    lines.push(line);
    if (lines.length > LIVE_LINES) lines = lines.slice(-LIVE_LINES);
  }

  function write() {
    timer = null;
    lastWrite = Date.now();
    const body = { v: 1, updatedAt: new Date(lastWrite).toISOString(), activity: activityOf(lines), lines, bytes };
    const tmp = `${file}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(body));
      fs.renameSync(tmp, file);
    } catch {
      // A reader may hold the file open on Windows; the next write lands instead.
    }
  }

  function schedule() {
    if (timer) return;
    timer = setTimeout(write, Math.max(0, intervalMs - (Date.now() - lastWrite)));
  }

  return {
    feed(stream, chunk) {
      bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
      const text = typeof chunk === 'string' ? chunk : decoders[stream].write(chunk);
      const parts = (partial[stream] + text).split(/\r\n|\n|\r/);
      partial[stream] = parts.pop();
      parts.forEach(push);
      schedule();
    },
    finish() {
      if (timer) clearTimeout(timer);
      for (const stream of ['out', 'err']) {
        const rest = partial[stream] + decoders[stream].end();
        if (rest) push(rest);
        partial[stream] = '';
      }
      write();
    },
  };
}
