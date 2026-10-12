// Standing instructions: text the person wants every agent to read first,
// kept in Podium's settings (global, plus one per repo) rather than in the repo.
export function standingText(settings, project) {
  const parts = [settings.instructions, settings.repoInstructions?.[project]].map((t) => String(t ?? '').trim()).filter(Boolean);
  return parts.join('\n\n');
}

export function withInstructions(text, standing) {
  return standing ? `Standing instructions from the user:\n${standing}\n\n---\n\n${text}` : text;
}
