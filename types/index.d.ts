export type JobRecord = {
  id: string; agent: string; title: string; ticket: string; status: string; permission: string;
  createdAt: string; startedAt: string | null; endedAt: string | null; isLong?: boolean;
  delivered: boolean; hasChanges: boolean; outcome: string | null; outcomeSource: string | null;
  error: string | null; model: string | null; worktree: string | null;
  liveFile?: string; changes?: { files: number; added: number; removed: number } | null;
  committed?: { branch: string | null; head: string; count: number; commits: { sha: string; subject: string }[] } | null;
  leftovers?: boolean; base?: string | null;
  pr?: PrRecord | null; kind?: 'review'; reviewOf?: { number: number; url: string } | null; posted?: boolean;
  origin?: { session: string } | null;
  warning?: { code: string; message: string; repair: 'muse-sandbox' | null } | null;
  threadId?: string; step?: number; followUpOf?: string | null; endStatus?: string; resumeFrom?: string | null; resumeFailed?: boolean;
  agentSession?: { agent: string; id: string } | null;
  sprint?: { id: string; ticket: string; task: number; role: string } | null;
};
export type LiveInfo = { activity: string | null; lines: string[]; updatedAt: string };
export type PaneView = { screen: 'list' | 'detail' | 'agents' | 'agent' | 'add-agent' | 'settings' | 'new' | 'sprint' | 'ticket'; id: string | null; key?: string | null };
export type AgentRecord = {
  name: string; label: string; installed: boolean; version: string | null; signedIn: boolean | null;
  verified: boolean; source: string; enabled: boolean; defaultPermission: string;
  stats?: { jobs: number; used: number };
};
export type Draft = { agent: string; task: string; permission: string; includeUncommitted: boolean; model: string; ticket: string; base: string };
export type AdapterDraft = {
  name: string; label: string; command: string; baseArgs: string[]; promptVia: 'stdin' | 'file';
  promptFileFlag?: string; modelFlag: string | null; versionArgs: string[];
  permissions: Record<'read-only' | 'edit-worktree' | 'own-config' | 'full-access', string[]>; verified: boolean;
};
export type ChangeFile = { path: string; added: number | null; removed: number | null; patch: string; isTruncated: boolean };
export type ChangeSet = { files: ChangeFile[]; added: number; removed: number; more?: number };
export type JobDetail = { id: string; summary: string | null; output: string | null; changes: ChangeSet | null; open: string[]; confirmRepair?: boolean; confirm?: 'discard' | 'cancel' | null };
export type DoctorReport = {
  node: { ok: boolean; version: string | null }; git: { ok: boolean; version: string | null };
  gh: { installed: boolean; signedIn: boolean; version: string | null };
  tellClaude: boolean; welcomed: boolean;
  copies?: { root: string; ok: boolean };
};
export type PrRecord = {
  number: number; url: string; branch: string; base: string; state: 'OPEN' | 'MERGED' | 'CLOSED';
  checks: { total: number; passed: number; failed: number; running: number; failing: string[]; failedRunId?: string | null };
  review: string | null; mergeable: string; comments: number; autoMerge: boolean; blocked?: string | null;
  attention: string | null; watching?: boolean; watchUntil?: string;
};
export type SprintTaskSummary = { n: number; title: string; agent: string; reviewer: string; status: 'done' | 'current' | 'to-do'; canAssign: boolean };
export type SprintTicketSummary = {
  key: string; title: string; state: string; task: number; of: number; phase: string | null; agent: string;
  reason: string | null; findings?: string | null; pr: { number: number; url: string } | null; reviews: number;
  latest?: string | null; tasks?: SprintTaskSummary[]; canRetry?: boolean; giveTo?: 'writer' | 'reviewer' | null; canStop?: boolean;
  // A draft ticket sent as its card only: its tasks' writers and reviewers, without the tasks.
  writers?: string[]; reviewers?: string[];
  // Its place in the whole sprint, on a capped card (capRows).
  pos?: number;
  // The plan's path; a ticket drafted without a plan: its writer (who plans it) and its tasks' reviewer, and
  // whether they may change (task 0).
  plan?: string | null; writer?: string | null; reviewer?: string | null; canAssignPlan?: boolean;
  // A plan waiting for the person: its tasks' titles (the first PLAN_ROWS; proposedMore counts the rest) and what may be done.
  proposed?: { n: number; title: string }[] | null; proposedMore?: number; canApprove?: boolean; canRevise?: boolean; canOneTask?: boolean;
  // The production commands its plan runs (the open board's row), or how many (other rows): Approve asks first.
  attention?: { n: number; command: string }[] | null; attentionMore?: number; attentionCount?: number;
  // "after": the tickets it waits for, and those not merged yet.
  after?: string[]; waitingOn?: string[];
  // A pending ticket that may start: whether a slot is free for it now.
  slot?: 'free' | 'full' | null;
  // Commits in its copy that Podium didn't make, waiting for Keep or Drop; and whether its copy may take the base now.
  foreignCommits?: { count: number; newest: string } | null; canSync?: boolean;
  // The person's notes for its agents: the latest few, cut short, and how many there are; whether it takes one now.
  notes?: { n: number; at: string; text: string }[]; noteCount?: number; canNote?: boolean;
  // Stopped on its task's tests: Accept and continue, and where those tests ran.
  canAccept?: boolean; testsWhere?: 'sandbox' | 'host' | null;
  // Its step's runner is gone and the sprint waits for that step's agent to end.
  agentLeft?: boolean;
  // Stopped on a failed review: Review again with evidence.
  canEvidence?: boolean;
  // Running at the base after a failure: which run ('task' test or full 'check').
  baselineOf?: 'task' | 'check';
  // Parked on a file locked while saving changes: the blocked file, the .NET hint, and the stash refs Git
  // had before and after (absent on older tickets, which read ordinary).
  checkpointLock?: { file: string; hint: 'dotnet' | null; stashBefore: string | null; stashAfter: string | null } | null;
};
export type SprintSummary = {
  id: string; name: string | null; draft?: boolean; discarded?: boolean; paused: boolean; finishedAt: string | null; autoMerge: boolean;
  maxParallel?: number | null; news: number; unreadable?: string; tickets: SprintTicketSummary[];
  // The branch its tickets start from and their PRs target.
  base?: string;
  // Sent as its card only (desktop): no tasks or review findings.
  brief?: boolean;
  // Omitted ticket count, plus headline and status for the whole sprint (capRows).
  more?: number; headline?: string; status?: string;
  // Whether its repo has a full check; the board warns when it is false.
  check?: boolean;
  // The sprint's own chat: only it is told the sprint's news.
  chat?: string | null;
  // A draft's proposed commands, check and plans folder, saved for the repo at Start; the board's This repo fold shows them.
  proposed?: { commands?: string[]; check?: string; taskTest?: string; planDir?: string; keepPlan?: boolean } | null;
  // `ended` marks a finished sprint's row, whose tickets have all ended.
  ended?: boolean; archived?: boolean;
};
// A sprint ticket waiting on the person, for Your turn.
export type TurnTicket = { sprint: string; sprintName: string; key: string; title: string; state: string; reason: string };
export type AskForm = { threadId: string; agent: string; task: string; mode?: 'change' | 'review'; number?: number } | null;
// What a job's screen has open (mod/jobopen.js).
export type JobOpen = { ask: NonNullable<AskForm> } | { confirm: 'discard' | 'cancel'; id: string } | { repair: string } | null;
// The board's pane state: which sprint, its open row, and what is asking to be confirmed ('discard',
// 'stop:<KEY>', 'drop:<KEY>' for commits Podium didn't make, 'revise:<KEY>' while a plan's Ask for changes form is
// open, 'note:<KEY>' while a ticket's Add a note form is, 'accept:<KEY>' while its Accept and continue form is, or 'evidence:<KEY>' while its Review again with evidence form is; the
// form's words in note).
export type BoardState = { sprint: string | null; open: string | null; confirm: string | null; picking: string | null; note?: string };
export type RemovalPlan = { bytes: number; unkept: number; running: number; copies: number };
export type WhatsNew = { version: string; notes: string | null; open: boolean };

declare module 'claude-code' {
  interface PluginState {
    podium: {
      jobs: JobRecord[];
      view: PaneView;
      notice: string | null;
      detail: JobDetail | null;
      agents: AgentRecord[];
      settings: Record<string, unknown> | null;
      draft: Draft;
      draftAdapter: AdapterDraft | null;
      live: Record<string, LiveInfo>;
      palette: 'dark' | 'light';
      folds: string[];
      beat: number;
      jobOpen: JobOpen;
      cleared: string | null;
      showAllDone: boolean;
      checks: DoctorReport | null;
      whatsNew: WhatsNew | null;
      removing: RemovalPlan | null;
      agentsLoaded: boolean;
      sprints: SprintSummary[];
      // Finished sprints `podium status --here` did not list.
      olderFinished: { mine: number; others: number };
      board: BoardState;
      sprintPage: number;
    };
  }
}
