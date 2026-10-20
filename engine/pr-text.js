// A sprint PR's text: the summary its plan gives, and the check its text passes in a public repo, where words that belong
// to the team (another project's tickets, the tracker, an agent, a private name) must not reach readers.

export const PR_SUMMARY_HEADING = '## PR summary';
const SUMMARY_CHARS = 1_000;

// The plan's PR summary on one line: the text under its heading (any case) up to the next heading, or '' without one.
export function planSummary(plan) {
  const text = String(plan ?? '').replace(/\r\n/g, '\n');
  const head = /^##[ \t]+PR summary[ \t]*$/im.exec(text);
  if (!head) return '';
  const rest = text.slice(head.index + head[0].length);
  const next = rest.search(/^#{1,6}[ \t]/m);
  const words = (next === -1 ? rest : rest.slice(0, next)).replace(/\s+/g, ' ').trim();
  return words.length > SUMMARY_CHARS ? `${words.slice(0, SUMMARY_CHARS - 1).trimEnd()}…` : words;
}

// Words that point at a tracker or at notes only the team can read.
export const TRACKER_PHRASES = ['ticket', 'tickets', 'tracker', 'jira', 'implementation brief', 'the brief', 'backlog', 'worknote', 'worknotes', 'internal only', 'confidential', 'private repo'];
// Shaped like a ticket key, but standard names.
const NOT_KEYS = new Set(['UTF', 'SHA', 'ISO', 'RFC', 'CVE', 'MD', 'TLS', 'SSL', 'HTTP', 'IPV', 'ES', 'ECMA', 'WCAG', 'AES', 'RSA', 'PEP']);
const KEY = /\b([A-Z][A-Z0-9]{0,9})-\d+\b/g;
// Credit given to a tool for the work.
const ATTRIBUTION = [/co-authored-by/i, /generated (?:with|by)/i, /\u{1F916}/u];
// Shorter agent names match ordinary words.
const AGENT_CHARS = 3;

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A phrase as whole words, any case, any whitespace between its words. Escaped, so it is plain text, never a pattern.
const phrase = (p) => new RegExp(`(?<![A-Za-z0-9])${String(p).trim().split(/\s+/).map(escape).join('\\s+')}(?![A-Za-z0-9])`, 'i');

export function prLeaks(text, { key = '', agents = [], terms = [] } = {}) {
  const s = String(text ?? '');
  const own = String(key).split('-')[0].toUpperCase();
  const found = [];
  for (const m of s.matchAll(KEY)) {
    if (m[1].toUpperCase() !== own && !NOT_KEYS.has(m[1])) found.push({ kind: 'key', found: m[0] });
  }
  const look = (kind, p) => {
    const m = s.match(phrase(p));
    if (m) found.push({ kind, found: m[0] });
  };
  for (const p of TRACKER_PHRASES) look('tracker', p);
  // Once per name: a name and its label ("codex", "Codex") are the same word here.
  for (const a of new Set(agents.map((x) => String(x ?? '').trim().toLowerCase()))) if (a.length >= AGENT_CHARS) look('agent', a);
  for (const r of ATTRIBUTION) {
    const m = s.match(r);
    if (m) found.push({ kind: 'agent', found: m[0] });
  }
  for (const t of terms) if (String(t ?? '').trim()) look('term', t);
  return found;
}

// The PR's text with every body line that has a leak left out, and a leaking title reduced to the ticket's key.
export function cleanPrText({ key, title, body }, { agents = [], terms = [] } = {}) {
  const left = [];
  const note = (hits) => { for (const x of hits) if (!left.includes(x.found)) left.push(x.found); };
  const lines = String(body ?? '').split('\n').filter((line) => {
    const hits = prLeaks(line, { key, agents, terms });
    note(hits);
    return !hits.length;
  });
  const titleHits = prLeaks(title, { key, agents, terms });
  note(titleHits);
  return {
    subject: titleHits.length ? String(key) : `${key}: ${title}`,
    body: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    left,
  };
}
