const HEADING = /^\s*(?:#{1,6}\s*)?summary\s*(?::\s*(.*))?$/i;

// Agents often end with a "Summary" section; use it so we don't spend a model call.
export function extractSummary(text, maxLines = 10) {
  const lines = String(text).split(/\r?\n/);
  const start = lines.findIndex((l) => HEADING.test(l));
  if (start === -1) return null;
  const out = [];
  const inline = lines[start].match(HEADING)[1];
  if (inline && inline.trim()) out.push(inline.trim());
  for (const line of lines.slice(start + 1)) {
    if (out.length >= maxLines) break;
    if (/^\s*#{1,6}\s/.test(line)) break;
    if (line.trim()) out.push(line.trim());
  }
  return out.length ? out.join('\n') : null;
}
