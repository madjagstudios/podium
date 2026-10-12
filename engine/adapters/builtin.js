export const PERMISSIONS = ['read-only', 'edit-worktree', 'own-config', 'full-access'];

// Anything that may edit runs in a separate copy unless the user deliberately chooses otherwise.
export const DEFAULT_PERMISSION = 'edit-worktree';

const SAFER = 'Choose "Read only" or "Edit in a separate copy" instead.';

export const BUILTIN_ADAPTERS = [
  {
    name: 'codex',
    label: 'Codex',
    command: 'codex',
    baseArgs: ['exec', '--skip-git-repo-check'],
    promptVia: 'stdin',
    stdinArg: '-',
    modelFlag: '-m',
    versionArgs: ['--version'],
    authCheckArgs: ['login', 'status'],
    // Codex prints "session id: <uuid>" at the top of its output; `exec resume` takes no
    // --sandbox, so its permission levels are config overrides (no quotes: assertArg).
    resume: {
      capture: 'session id: ([0-9a-f-]{36})',
      continue: {
        command: ['exec', 'resume', '--skip-git-repo-check'],
        tail: ['{id}', '-'],
        permissions: {
          'read-only': ['-c', 'sandbox_mode=read-only'],
          'edit-worktree': ['-c', 'sandbox_mode=workspace-write'],
          'own-config': [],
          'full-access': ['-c', 'sandbox_mode=danger-full-access'],
        },
      },
    },
    permissions: {
      'read-only': ['--sandbox', 'read-only'],
      'edit-worktree': ['--sandbox', 'workspace-write'],
      'own-config': [],
      'full-access': ['--sandbox', 'danger-full-access'],
    },
    verified: true,
  },
  {
    name: 'muse',
    label: 'Muse',
    command: 'muse',
    baseArgs: ['exec', '--user-input-auto-resolve', '--workspace', '.'],
    promptVia: 'file',
    promptFileFlag: '--prompt-file',
    modelFlag: '--model',
    versionArgs: ['--version'],
    permissions: {
      'read-only': ['--disable-write', '--disable-shell', '--approval-mode', 'never'],
      'edit-worktree': ['--approval-mode', 'never'],
      'own-config': [],
      'full-access': ['--yolo'],
    },
    unattended: {
      // Verified 2026-10-05 (Muse 1.4.2): with its own settings, Muse's approval judge allowed a
      // file write, which landed directly in the user's folder. It did not stall.
      'own-config': { kind: 'direct-edit', message: `With its own settings Muse can change files directly in this folder, not in a separate copy. Choose "Read only", or "Edit in a separate copy" to review changes before they reach your files.` },
    },
    verified: true,
  },
  {
    name: 'claude',
    label: 'Claude',
    command: 'claude',
    baseArgs: ['-p'],
    promptVia: 'stdin',
    modelFlag: '--model',
    models: ['fable', 'opus', 'sonnet', 'haiku'],
    versionArgs: ['--version'],
    // Podium names the conversation at a thread's first step and resumes it later.
    resume: {
      start: ['--session-id', '{id}'],
      continue: { args: ['--resume', '{id}'] },
    },
    permissions: {
      'read-only': ['--permission-mode', 'plan'],
      'edit-worktree': ['--permission-mode', 'acceptEdits'],
      'own-config': [],
      'full-access': ['--dangerously-skip-permissions'],
    },
    // The repo's commands (repoCommands), allowed only at "edit in a separate copy": acceptEdits allows edits,
    // and in -p no one answers the prompt any other command needs. Names are plain words (settings.js), so each rule
    // passes assertArg. Headless Claude on Windows runs shell commands with its PowerShell tool, so both tools get a rule.
    allow: { flag: '--allowedTools', rules: ['Bash({cmd}:*)', 'PowerShell({cmd}:*)'] },
    unattended: {
      'own-config': { kind: 'skip', message: `In the background Claude refuses actions that would normally ask you first, so it may skip steps. ${SAFER}` },
    },
    verified: true,
  },
  {
    name: 'gemini',
    label: 'Gemini',
    command: 'gemini',
    baseArgs: [],
    promptVia: 'stdin',
    modelFlag: '-m',
    versionArgs: ['--version'],
    permissions: {
      'read-only': ['--approval-mode', 'default'],
      'edit-worktree': ['--approval-mode', 'auto_edit'],
      'own-config': [],
      'full-access': ['--yolo'],
    },
    unattended: {
      'own-config': { kind: 'skip', message: `In the background Gemini may refuse actions that need approval, so it may skip steps. ${SAFER}` },
    },
    verified: false,
  },
];
