// Whether an agent stopped on its account's usage limit or because its service was busy, read from the end of what it
// printed, and when a usage limit says it resets. Pure: no imports.

// An agent's stopping message is at the end; the work before it may quote these phrases from the task itself.
export const LIMIT_LINES = 40;
const LINE_CHARS = 200;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const EPOCH_DAYS = 8;

const USAGE = /usage limit|(?:session|weekly|daily|monthly|\d+-hour) limit|quota (?:exceeded|reached)|exceeded your (?:current )?quota|out of credits|credit balance is too low/i;
const BUSY = /at capacity|overloaded|rate[ -]?limit(?:ed|s? (?:reached|exceeded|hit))|too many requests|\b(?:HTTP|status|error)[: ]+(?:429|529)\b|API Error: (?:429|529)\b/i;

const lastLines = (text) => String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-LIMIT_LINES);

// texts: an array of strings (an agent's output, its stderr). Returns null, or { kind: 'usage' | 'busy', line, resetAt }:
// line is the last matching line of the winning kind (usage wins over busy), resetAt a ms timestamp or null.
export function agentLimit(texts, now = Date.now()) {
  const lines = [].concat(texts ?? []).flatMap(lastLines);
  const usage = lines.filter((l) => USAGE.test(l)).at(-1);
  if (usage) return { kind: 'usage', line: usage.slice(0, LINE_CHARS), resetAt: resetTimeOf(usage, now) };
  const busy = lines.filter((l) => BUSY.test(l)).at(-1);
  if (busy) return { kind: 'busy', line: busy.slice(0, LINE_CHARS), resetAt: null };
  return null;
}

// The zone's wall clock for `now`, in minutes past midnight; the machine's own zone when the name is unknown.
function wallMinutes(now, timeZone) {
  const read = (zone) => new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(now));
  let parts;
  try { parts = read(timeZone); } catch (e) { if (!(e instanceof RangeError)) throw e; parts = read(undefined); }
  const part = (type) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return (part('hour') % 24) * 60 + part('minute');
}

const RESETS = /\bresets\s+(\d{1,2})(?::(\d{2}))?\s*([ap]m)?\b(?:\s*\(([^)]+)\))?/i;
const EPOCH = /\|(\d{10})\s*$/;
const TRY_IN = /try again in\s+((?:\d+\s*(?:days?|hours?|h|minutes?|mins?|m)\b[\s,]*(?:and\s+)?)+)/i;
const SPAN = /(\d+)\s*(days?|hours?|h|minutes?|mins?|m)\b/gi;

function resetsAt(m, now) {
  const [, h, mm, ampm, zone] = m;
  if (!mm && !ampm) return null;
  let hour = Number(h);
  const minute = Number(mm ?? 0);
  if (minute > 59) return null;
  if (ampm) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (ampm.toLowerCase() === 'pm' ? 12 : 0);
  } else if (hour > 23) return null;
  const floor = now - (now % MINUTE);
  const diff = (((hour * 60 + minute) - wallMinutes(now, zone?.trim() || undefined)) % 1440 + 1440) % 1440;
  return floor + diff * MINUTE;
}

// When a usage limit's line says it resets, as a ms timestamp, or null when it names nothing Podium can read.
export function resetTimeOf(line, now = Date.now()) {
  const text = String(line ?? '');
  const resets = text.match(RESETS);
  if (resets) return resetsAt(resets, now);
  const epoch = text.match(EPOCH);
  if (epoch) {
    const at = Number(epoch[1]) * 1000;
    return at > now && at - now <= EPOCH_DAYS * DAY ? at : null;
  }
  const tryIn = text.match(TRY_IN);
  if (tryIn) {
    let ms = 0;
    for (const [, n, unit] of tryIn[1].matchAll(SPAN)) {
      const u = unit.toLowerCase();
      ms += Number(n) * (u.startsWith('d') ? DAY : u.startsWith('h') ? 60 * MINUTE : MINUTE);
    }
    return ms > 0 ? now + ms : null;
  }
  return null;
}
