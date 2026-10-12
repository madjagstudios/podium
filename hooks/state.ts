// Plain constants shared by the hooks module and the pure screens. Atoms are
// not declared here: the engine reads $.state references only in the module
// that uses them, so they live in register.tsx.

export const PANE = 'podium'

// The longest notes for a plan's writer (Ask for changes). The engine keeps 20,000 (TEXT_CHARS in engine/sprint.js), but
// the notes are the box's value, and the terminal refuses an Input whose value is over 10,000 characters (the desktop
// page over 16,384): either would blank the pane, so the box keeps the stricter 10,000.
export const NOTE_CHARS = 10_000

export const PERMISSION_CHOICES = [
  { value: 'edit-worktree', label: 'Edit in a separate copy' },
  { value: 'read-only', label: 'Read only' },
  { value: 'own-config', label: "Agent's own settings" },
  { value: 'full-access', label: 'Full access ⚠' },
]

export const CLAUDE_MODELS = [
  { value: '', label: 'Default' },
  { value: 'haiku', label: 'Haiku' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'opus', label: 'Opus' },
]

export const LEVEL_LABEL: Record<string, string> = {
  'read-only': 'Read only',
  'edit-worktree': 'Edit in a separate copy',
  'own-config': "Agent's own settings",
  'full-access': 'Full access',
}

// The most fold states the pane keeps: the oldest are forgotten, and a forgotten fold is back to its default.
export const FOLDS_KEPT = 200
