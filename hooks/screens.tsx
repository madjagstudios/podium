// The pane's screens: pure drawing. Each takes the element table
// $.ui.resolve(e) returned, plain data read in register.tsx, and the closures
// register.tsx made; none touches `$` or $.state (the engine forbids both here).
import { accessLine, agentLabel, andList, moreSummary, shorten, instructionsSummary, storageSummary, limitsSummary, repoSummary, proposedSummary, NO_CHECK_LINE, waitingNews } from '../mod/view.js'
import type { AdapterDraft, AgentRecord, BoardState, Draft, JobDetail, JobRecord, SprintSummary, SprintTicketSummary, PaneView, TurnTicket } from '../types'
import { LEVEL_LABEL } from './state'
import { CLAUDE_MODELS, PERMISSION_CHOICES } from './state'
import { readiness, removalText, agentLine, agentState, agentNeedsFix } from '../mod/view.js'
import type { DoctorReport, RemovalPlan, WhatsNew } from '../types'
import { organise, threads, checkRows, sprintLines, sprintStatusLine, ticketState, optionsLine, turnLabel, isOpenSprint, ticketSteps, sprintStepLine, NEEDS_YOU_STATES, AT_ONCE_DEFAULT } from '../mod/view.js'
import { PALETTES } from './theme'

import type { ChangeSet, JobDetail } from '../types'
import { codeBlock } from './tiles'
import { fileRows, listPage, turnTickets } from '../mod/client.js'

import type { LiveInfo } from '../types'
import type { Palette, Tone } from './theme'
import { choices, fold, row, tile } from './tiles'
import { doneText, quietText, toneOf, turnItems, isFailedTurn, workingRowLine, doneRowLine, prSub, setupSummary, sprintRowTitle, sprintTone, ticketTone, finishedTone, jobTone } from '../mod/view.js'
import { isFinishedSprint, finishedSprints, finishedSprintLine, finishedSprintTone, isSprintMine, sprintWorkingLine, olderSprintsLine, FINISHED_SPRINTS, FROM_OTHER_CHAT } from '../mod/view.js'
import { attentionLine, isFoldOpen, jobStatusLine, jobDetails, fromAnotherChat, REVIEW_WORDS, ticketStatusLine, whoLine } from '../mod/view.js'


export type Ui = any // the element table $.ui.resolve(e) returned for the drawing surface

export type ListHandlers = {
  openDetail: (id: string) => void
  showScreen: (screen: PaneView['screen']) => void
  toggleFold: (id: string) => void
  openAgent: (name: string) => void
  browsePr: (id: string) => void
  act: (verb: 'cancel' | 'keep' | 'discard', id: string) => void
  askOpen: (threadId: string, agent: string) => void
  askEdit: (patch: { agent?: string; task?: string }) => void
  askSend: (latestId: string, task?: string) => void
  askCancel: () => void
  tryIt: () => void
  gotIt: () => void
  toggleWhatsNew: () => void
  dismissWhatsNew: () => void
  clearDone: () => void
  toggleShowAll: () => void
  openPr: (id: string) => void
  pushPr: (id: string) => void
  toggleAutoMerge: (id: string, isOn: boolean) => void
  watchAgain: (id: string) => void
  postReview: (id: string) => void
  reviewOpen: (threadId: string, agent: string, number: number) => void
  fixOpen: (threadId: string, latestId: string, agent: string, kind: 'ci' | 'comments') => void
  openBoard: (id: string) => void
  // Which page of sprint cards the list shows (listPage).
  showSprints: (page: number) => void
  sprintAct: (verb: 'start' | 'discard' | 'pause' | 'resume', id: string) => void
  askConfirm: (id: string, what: string | null) => void
  setSprintOptions: (id: string, patch: { mergeWhenGreen?: boolean; atOnce?: number }) => void
  openTicket: (id: string, key: string | null) => void
  openPicker: (id: string, which: string | null) => void
  moveTicket: (id: string, key: string, to: 'up' | 'down') => void
  removeTicket: (id: string, key: string) => void
  assignTicket: (id: string, key: string, role: 'agent' | 'reviewer', name: string) => void
  assignTask: (id: string, key: string, n: number, role: 'agent' | 'reviewer', name: string) => void
  retryTicket: (id: string, key: string, agent?: string) => void
  stopTicket: (id: string, key: string) => void
  approvePlan: (id: string, key: string, whole?: boolean) => void
  revisePlan: (id: string, key: string, text?: string) => void
  editNote: (id: string, text: string) => void
  setAfter: (id: string, key: string, other: string, on: boolean) => void
  takeSprintNews: (id: string) => void
  backToList: () => void
}

export type AskFor = { threadId: string; agent: string; task: string; mode?: 'change' | 'review'; number?: number } | null
export type Thread = { id: string; latest: JobRecord; steps: JobRecord[]; isMine?: boolean }
export type Organised = { needs: Thread[]; working: Thread[]; review: Thread[]; done: Thread[]; doneHidden: number; others: Thread[] }

const PERMISSION_SHORT: Record<string, string> = {
  'read-only': 'read only',
  'edit-worktree': 'edit in a separate copy',
  'own-config': "the agent's own settings",
  'full-access': 'full access',
}
const STATUS_WORD: Record<string, string> = {
  done: 'done', 'needs-review': 'changes', failed: 'failed', lost: 'stopped', cancelled: 'cancelled',
  kept: 'kept', discarded: 'thrown away', running: 'working', queued: 'queued', continued: 'continued',
  'in-review': 'in review', merged: 'merged', closed: 'closed',
}

// A thread can continue unless a step is running or the work was kept or thrown away.
export function canContinue(latest: JobRecord) {
  return ['needs-review', 'done', 'failed', 'cancelled', 'lost', 'in-review'].includes(latest.status)
}

function stepLine(s: JobRecord, now: number) {
  const word = s.status === 'continued' ? (STATUS_WORD[s.endStatus ?? ''] ?? 'done') : (STATUS_WORD[s.status] ?? s.status)
  const how = s.resumeFailed ? ' · fresh conversation' : s.resumeFrom ? ' · same conversation' : ''
  const ago = s.endedAt ? ` · ${doneText(s, now).split(' · ').pop()}` : ''
  if (s.kind === 'review') return `review · ${s.agent} · ${s.title} · ${s.posted ? 'posted' : word}${ago}`
  return `${s.step ?? 1} · ${s.agent} · ${s.title}${how} · ${word}${ago}`
}

// Repeats of one step (a review asked for again and again) show as one row with a count:
// the newest stands for them all.
export function groupSteps(steps: JobRecord[]) {
  const same = (a: JobRecord, b: JobRecord) => a.kind === b.kind && a.agent === b.agent && a.title === b.title && a.status === b.status && Boolean(a.posted) === Boolean(b.posted) && a.step === b.step
  const out: { step: JobRecord; count: number }[] = []
  for (const s of steps) {
    const last = out[out.length - 1]
    if (last && same(last.step, s)) last.count += 1
    else out.push({ step: s, count: 1 })
  }
  return out
}

const counted = (line: string, count: number) => (count > 1 ? `${line} · ×${count}` : line)

// Step rows a job's detail lists (the rest are counted in a line), each at most STEP_CHARS long.
const STEP_ROWS = 30
const STEP_CHARS = 160

export function askForm(ui: Ui, p: Palette, t: Thread, ask: NonNullable<AskFor>, agentList: AgentRecord[], go: ListHandlers) {
  const { Box, Text, Button, Input } = ui
  const ready = agentList.filter((x) => x.installed && x.enabled)
  const options = (ready.length ? ready : [{ name: t.latest.agent, label: t.latest.agent }]).map((x) => ({ value: x.name, label: x.label }))
  return (
    <Box key={`askform-${t.id}`} flexDirection="column" gap={1}>
      <Input key="ask-task" label={ask.mode === 'review' ? 'Anything to focus on? (optional)' : 'What should change?'} placeholder={ask.mode === 'review' ? 'e.g. error handling' : 'e.g. make the heading bigger'} value={ask.task} submitLabel="Send"
        onInput={(v: string) => go.askEdit({ task: v })} onSubmit={(v: string) => go.askSend(t.latest.id, v)} />
      {choices(ui, p, 'ask-agent', 'Agent', ask.agent, options, (v) => go.askEdit({ agent: v }))}
      <Text color={p.dim}>{ask.mode === 'review' ? `Runs read-only on PR #${ask.number}'s code.` : `Runs with: ${PERMISSION_SHORT[t.latest.permission] ?? t.latest.permission}, in the same copy.`}</Text>
      <Box flexDirection="row" gap={1}>
        <Button key="ask-send" variant="primary" label="Send" onPress={() => go.askSend(t.latest.id)} />
        <Button key="ask-cancel" label="Cancel" onPress={() => go.askCancel()} />
      </Box>
    </Box>
  )
}

export function backButton(ui: Ui, go: ListHandlers) {
  const { Button } = ui
  return <Button key="back" plain label="← Back" onPress={() => go.showScreen('list')} />
}

// Safe for anything: a board row with a missing writer or reviewer, or one that is not a name, must still draw
// (a throw turns the screen into the "couldn't draw" note). "No agent" reads as a name does ("Reviewer No agent").
const agentName = (a: unknown) => agentLabel(a) || 'No agent'

export type CheckRow = { ok: boolean | null; text: string }

function checkLines(ui: Ui, p: Palette, rows: CheckRow[], prefix: string) {
  const { Text } = ui
  return rows.map((r, i) => (
    <Text key={`${prefix}-${i}`} color={r.ok === false ? p.needs.text : r.ok ? p.ok.text : p.dim} wrap="wrap">{`${r.ok === false ? '✋' : r.ok ? '✓' : '·'} ${r.text}`}</Text>
  ))
}

export type SprintPaging = { ids: string[]; page: number; pages: number; from: number; to: number; total: number; rows?: number }

export const NO_BOARD: BoardState = { sprint: null, open: null, confirm: null, picking: null }

// Rows a capped card was sent without (capRows).
const moreTickets = (n: number) => `… and ${n} more ticket${n === 1 ? '' : 's'}`

const AT_ONCE = [1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: String(n) }))

const MARK: Record<string, string> = { done: '✓', current: '▸', 'to-do': '·' }

// Agents to pick from: the ready ones, plus any already chosen, so a picker always shows its value.
function agentOptions(agentList: AgentRecord[], chosen: string[] = []) {
  const options = agentList.filter((x) => x.installed && x.enabled).map((x) => ({ value: x.name, label: x.label }))
  for (const name of chosen) if (name && !options.some((o) => o.value === name)) options.push({ value: name, label: agentName(name) })
  return options
}

// One thing waiting on the person (Your turn): `open` is where its title leads, `act` what its one button does;
// each names a pane action and its arguments (turnItems in mod/view.js makes them for the list).
export type TurnItem = { id: string; title: string; reason: string; label: string; open: { name: string; args: unknown[] }; act: { name: string; args: unknown[] } }

// A Your turn row: the title (opens its screen), then one primary button and a dim reason beside it, in a tile of `tone`
// (needs: it waits on the person).
export function turnRow(ui: Ui, p: Palette, it: TurnItem, go: ListHandlers, tone: Tone = 'needs') {
  const { Box, Text, Button } = ui
  const call = (a: { name: string; args: unknown[] }) => () => (go as unknown as Record<string, (...args: unknown[]) => void>)[a.name](...a.args)
  const room = ui.columns ? Math.floor((ui.columns - 8) * 1.25) : 0
  return tile(ui, p, tone, `turnitem-${it.id}`, [
    <Button key={`open-${it.id}`} plain label={room > 10 ? shorten(it.title, room) : it.title} onPress={call(it.open)} />,
    <Box key={`turnline-${it.id}`} flexDirection="row" gap={1} alignItems="center">
      <Button key={`turn-${it.id}`} variant="primary" label={it.label} onPress={call(it.act)} />
      <Box key={`turnwhy-${it.id}`} flexShrink={1} minWidth={0}><Text color={p.dim} wrap="truncate-end">{it.reason}</Text></Box>
    </Box>,
  ])
}

// A sprint's board: its name and one status line, the next step (Start sprint on a draft, Resume sprint while
// paused), its own Your turn, one line per ticket (each opens the ticket's screen), folded Options, and at the bottom Pause
// sprint, or on a draft Discard draft… (it asks first).
export function boardScreen(ui: Ui, p: Palette, s: SprintSummary | undefined, board: BoardState, go: ListHandlers, folds: string[] = [], session: string | null = null) {
  const { Box, Text, Button } = ui
  const parts: unknown[] = [backButton(ui, go)]
  if (!s) {
    parts.push(<Text key="gone" color={p.dim}>That sprint is no longer listed.</Text>)
    return <Box flexDirection="column" gap={1}>{parts}</Box>
  }
  if (s.unreadable) {
    parts.push(<Text key="board-head" bold wrap="wrap">{sprintLines(s)[0]}</Text>, <Text key="board-why" color={p.failed.text} wrap="wrap">{s.unreadable}</Text>)
    return <Box flexDirection="column" gap={1}>{parts}</Box>
  }
  const draft = Boolean(s.draft)
  // A finished sprint (archived after it ended or not) is never live: no Pause or Resume.
  const ended = isFinishedSprint(s)
  parts.push(
    <Text key="board-head" bold wrap="wrap">{`${s.name ?? s.id}${draft ? ' · draft' : ''}`}</Text>,
    <Text key="board-status" color={p.dim} wrap="wrap">{draft ? 'Nothing runs until you start it.' : sprintStatusLine(s)}</Text>,
  )
  // No full check for the sprint's repo: until one is set, its PRs open without it. A finished sprint opens no more,
  // and a draft that proposes one gets it at Start.
  if (s.check === false && !s.finishedAt && !s.proposed?.check) parts.push(<Text key="board-no-check" color={p.needs.text} wrap="wrap">{NO_CHECK_LINE}</Text>)
  // News only the sprint's own chat is told: another chat's board says how much waits for it. Not before this chat's
  // id is known (the sprint's own chat would flash it).
  // Take them here moves the sprint to this chat, for a chat that is gone.
  // A finished sprint listed though archived takes no news: never offered.
  if (!draft && !s.archived && (s.news ?? 0) > 0 && session && s.chat && s.chat !== session) {
    parts.push(
      <Text key="board-news" color={p.dim} wrap="wrap">{waitingNews(s.news)}</Text>,
      <Box key="board-news-links" flexDirection="row"><Button key="link-take-news" plain label="Take them here (if its chat is closed)"onPress={() => go.takeSprintNews(s.id)} /></Box>,
    )
  }
  // Sent as its list row when the desktop model was cut to fit (no tickets): opened before Podium sent the board.
  const loading = Boolean(s.brief) && !s.tickets.length
  if (loading) parts.push(<Text key="board-loading" color={p.dim}>Loading…</Text>)
  // Sent as its card only when the model was cut to fit: say what is missing.
  else if (s.brief) parts.push(<Text key="board-brief" color={p.dim} wrap="wrap">This sprint's tasks and review notes are not shown here; ask Claude for them.</Text>)
  // A question open is the one decision: while Discard asks, Start sprint is not drawn; Cancel brings it back.
  const discarding = draft && board.sprint === s.id && board.confirm === 'discard'
  if (draft && !discarding) parts.push(<Box key="board-next" flexDirection="row"><Button key="board-start" variant="primary" label="Start sprint" onPress={() => go.sprintAct('start', s.id)} /></Box>)
  else if (s.paused && !s.finishedAt && !ended) parts.push(<Box key="board-next" flexDirection="row"><Button key="board-resume" variant="primary" label="Resume sprint" onPress={() => go.sprintAct('resume', s.id)} /></Box>)
  const waiting = draft ? [] : s.tickets.filter((t) => NEEDS_YOU_STATES.has(t.state))
  if (waiting.length) {
    parts.push(<Text key="board-turn" bold>{`Your turn · ${waiting.length}`}</Text>)
    for (const t of waiting) {
      const open = { name: 'openTicket', args: [s.id, t.key] }
      parts.push(turnRow(ui, p, { id: `${s.id}-${t.key}`, title: `${t.key} ${t.title}`, reason: t.state === 'parked' ? (t.reason || 'needs you') : ticketState(t), label: turnLabel(t.state), open, act: open }, go))
    }
  }
  // A ticket waiting on the person is in Your turn already: say it once.
  const rest = s.tickets.filter((t) => !waiting.includes(t))
  if (!loading && (rest.length || (s.more ?? 0) > 0)) parts.push(<Text key="board-tickets" bold>{waiting.length ? 'Other tickets' : 'Tickets'}</Text>)
  // One tile per ticket line, coloured by its state (row() keys its button `open-ticket-<KEY>`).
  for (const t of rest) parts.push(row(ui, p, `ticket-${t.key}`, `${t.key} ${t.title} · ${ticketState(t, draft)}`, [], () => go.openTicket(s.id, t.key), undefined, ticketTone(t.state)))
  if (!loading && (s.more ?? 0) > 0) parts.push(<Text key="board-more" color={p.dim} wrap="wrap">{`${moreTickets(s.more ?? 0)} are not shown here; ask Claude for them.`}</Text>)
  // What Claude proposed for the repo with the draft: closed by default, its heading short; inside, the exact
  // values, which are saved for the repo only when the person presses Start.
  if (draft && s.proposed) {
    const rid = `board:${s.id}:repo`
    const pr = s.proposed
    parts.push(fold(ui, p, rid, 'This repo', proposedSummary(pr), isFoldOpen(folds, rid), () => go.toggleFold(rid), () => [
      <Text key="board-repo-what" color={p.dim} wrap="wrap">Claude proposed these. They are saved for this repo when you start the sprint; Discard drops them.</Text>,
      ...(Array.isArray(pr.commands) ? [<Text key="board-repo-commands" wrap="wrap">{`Commands agents may run: ${pr.commands.join(' ') || 'none'}`}</Text>] : []),
      ...(typeof pr.check === 'string' ? [<Text key="board-repo-check" wrap="wrap">{pr.check ? `Full check: ${pr.check}` : 'Full check: none (removes this repo\'s check)'}</Text>] : []),
    ]))
  }
  const oid = `board:${s.id}:options`
  parts.push(fold(ui, p, oid, 'Options', optionsLine(s), isFoldOpen(folds, oid), () => go.toggleFold(oid), () => {
    if (!draft) return [<Text key="options-fixed" color={p.dim} wrap="wrap">{`${s.maxParallel ?? AT_ONCE_DEFAULT} at once · merge when green ${s.autoMerge ? 'on' : 'off'}. Options change only before a sprint starts.`}</Text>]
    const now = String(s.maxParallel ?? AT_ONCE_DEFAULT)
    const atOnce = AT_ONCE.some((o) => o.value === now) ? AT_ONCE : [...AT_ONCE, { value: now, label: now }]
    return [
      <Button key="board-automerge" plain label={`${s.autoMerge ? '☑' : '☐'} Merge when green`} onPress={() => go.setSprintOptions(s.id, { mergeWhenGreen: !s.autoMerge })} />,
      choices(ui, p, 'board-atonce', 'At once', now, atOnce, (v) => go.setSprintOptions(s.id, { atOnce: Number(v) })),
    ]
  }))
  if (draft) {
    if (discarding) {
      parts.push(
        <Text key="board-discard-what" wrap="wrap">Discard this draft? Nothing has run, so nothing else changes.</Text>,
        <Box key="board-discard-confirm" flexDirection="row" gap={1}>
          <Button key="board-discard-yes" variant="primary" label="Discard the draft" onPress={() => go.sprintAct('discard', s.id)} />
          <Button key="board-discard-no" label="Cancel" onPress={() => go.askConfirm(s.id, null)} />
        </Box>,
      )
    } else {
      parts.push(<Box key="board-bottom" flexDirection="row"><Button key="end-board-discard" label="Discard draft…" onPress={() => go.askConfirm(s.id, 'discard')} /></Box>)
    }
  } else if (!s.paused && !s.finishedAt && !ended) {
    parts.push(<Box key="board-bottom" flexDirection="row"><Button key="board-pause" label="Pause sprint" onPress={() => go.sprintAct('pause', s.id)} /></Box>)
  }
  return <Box flexDirection="column" gap={1}>{parts}</Box>
}

// Who works on a ticket, with a Change… per writer/reviewer line that opens its rows of agent buttons (one picker open at a
// time, board.picking: "<KEY>:<n>", "<KEY>:all" or "<KEY>:plan"). The lines that may no longer change are text.
function whoRows(ui: Ui, p: Palette, s: SprintSummary, t: SprintTicketSummary, picking: string | null, agentList: AgentRecord[], go: ListHandlers) {
  const { Box, Text, Button } = ui
  const out: unknown[] = []
  const tasks = t.tasks ?? []
  const who = (agent: string, reviewer: string) => `Writer ${agentName(agent)} · Reviewer ${agentName(reviewer)}`
  const picker = (which: string, line: string, change: string, rows: () => unknown[]) => {
    const id = `${t.key}:${which}`
    const isPicking = picking === id
    out.push(
      <Box key={`who-${t.key}-${which}`} flexDirection="row" flexWrap="wrap" gap={1}>
        <Text color={p.dim}>{line}</Text>
        <Button key={`change-${t.key}-${which}`} label={isPicking ? 'Done' : change} onPress={() => go.openPicker(s.id, isPicking ? null : id)} />
      </Box>,
    )
    if (isPicking) out.push(<Box key={`picker-${t.key}-${which}`} flexDirection="column" paddingLeft={2} gap={1}>{rows()}</Box>)
  }
  if ((t.of ?? 0) === 0 && t.writer) {
    const line = `Plan written by ${agentName(t.writer)} · tasks reviewed by ${agentName(t.reviewer)}`
    if (t.canAssignPlan) {
      picker('plan', line, 'Change…', () => [
        choices(ui, p, `plan-writer-${t.key}`, 'Writer of the plan (and of its tasks)', t.writer ?? '', agentOptions(agentList, [t.writer ?? '']), (v) => go.assignTask(s.id, t.key, 0, 'agent', v)),
        choices(ui, p, `plan-reviewer-${t.key}`, 'Reviewer of its tasks', t.reviewer ?? '', agentOptions(agentList, [t.reviewer ?? '']), (v) => go.assignTask(s.id, t.key, 0, 'reviewer', v)),
      ])
    } else {
      out.push(<Text key={`who-${t.key}-plan`} color={p.dim}>{line}</Text>)
    }
  }
  if (s.draft && tasks.length) {
    // One writer or reviewer for every task; "Several agents" while the tasks differ.
    const one = (role: 'agent' | 'reviewer') => {
      const names = [...new Set(tasks.map((x) => x[role]))]
      return { names, value: names.length === 1 ? names[0] : '' }
    }
    const writer = one('agent')
    const reviewer = one('reviewer')
    const line = writer.value && reviewer.value ? `Every task: ${who(writer.value, reviewer.value)}` : 'Every task: Several agents'
    picker('all', line, 'Change for every task…', () => [
      choices(ui, p, `ticket-writer-${t.key}`, 'Writer for every task', writer.value, agentOptions(agentList, writer.names), (v) => go.assignTicket(s.id, t.key, 'agent', v)),
      choices(ui, p, `ticket-reviewer-${t.key}`, 'Reviewer for every task', reviewer.value, agentOptions(agentList, reviewer.names), (v) => go.assignTicket(s.id, t.key, 'reviewer', v)),
    ])
  }
  for (const x of tasks) {
    const line = `Task ${x.n}: ${who(x.agent, x.reviewer)}`
    if (!x.canAssign) { out.push(<Text key={`who-${t.key}-${x.n}`} color={p.dim}>{line}</Text>); continue }
    picker(String(x.n), line, 'Change…', () => [
      choices(ui, p, `writer-${t.key}-${x.n}`, 'Writer', x.agent, agentOptions(agentList, [x.agent]), (v) => go.assignTask(s.id, t.key, x.n, 'agent', v)),
      choices(ui, p, `reviewer-${t.key}-${x.n}`, 'Reviewer', x.reviewer, agentOptions(agentList, [x.reviewer]), (v) => go.assignTask(s.id, t.key, x.n, 'reviewer', v)),
    ])
  }
  return out
}

// A ticket's own screen: its status line, what the person decides on (the plan's tasks, or why it stopped),
// one next step, then folded Who works on it, Waits for, Plan file and Steps. A draft's ticket changes here: writer and
// reviewer, what it waits for, its place in the order, and Remove from sprint. Stop this ticket… asks first.
export function ticketScreen(ui: Ui, p: Palette, s: SprintSummary | undefined, key: string | null, board: BoardState, agentList: AgentRecord[], go: ListHandlers, folds: string[] = [], waiting = false) {
  const { Box, Text, Button, Input } = ui
  const t = s?.tickets.find((x) => x.key === key)
  const back = s ? <Button key="back" plain label={`← ${s.name ?? 'Sprint'}`} onPress={() => go.openBoard(s.id)} /> : backButton(ui, go)
  if (!s || !t) {
    // The desktop opened it before Podium sent its sprint (sent as its list row, or not on the list's page while the
    // ticket waits in Your turn, `waiting`): it is on its way, not gone.
    const loading = s ? Boolean(s.brief) : waiting
    return (
      <Box flexDirection="column" gap={1}>
        {back}
        {loading
          ? <Text key="ticket-loading" color={p.dim}>Loading…</Text>
          : <Text key="gone" color={p.dim}>That ticket is no longer listed.</Text>}
      </Box>
    )
  }
  const draft = Boolean(s.draft)
  const tasks = t.tasks ?? []
  const planless = (t.of ?? 0) === 0
  const mineBoard = board.sprint === s.id
  const picking = mineBoard ? (board.picking ?? null) : null
  const revising = mineBoard && board.confirm === `revise:${t.key}`
  const stopping = mineBoard && board.confirm === `stop:${t.key}`
  const parts: unknown[] = [
    back,
    // The key, title and status line in one tile, coloured as the ticket's board line is.
    tile(ui, p, ticketTone(t.state), 'ticket-tile', [
      <Text key="ticket-head" bold wrap="wrap">{`${t.key} ${t.title}`}</Text>,
      <Text key="ticket-status" color={NEEDS_YOU_STATES.has(t.state) ? p.needs.text : p.dim} wrap="wrap">{ticketStatusLine(t, draft)}</Text>,
    ]),
  ]
  if (s.brief) parts.push(<Text key="ticket-brief" color={p.dim} wrap="wrap">This ticket's tasks and review notes are not shown here; ask Claude for them.</Text>)
  // What the person decides on: the plan's tasks (titles only), or the reviewer's findings.
  const proposed = t.proposed ?? []
  if (proposed.length) {
    parts.push(<Text key="proposed-head" color={p.dim}>{`Its tasks (${proposed.length + (t.proposedMore ?? 0)}):`}</Text>)
    for (const x of proposed) parts.push(<Text key={`proposed-${x.n}`} wrap="truncate-end">{`· Task ${x.n}: ${x.title}`}</Text>)
    if (t.proposedMore) parts.push(<Text key="proposed-more" color={p.dim}>{`… and ${t.proposedMore} more tasks`}</Text>)
  }
  if (t.state === 'parked' && t.findings) parts.push(<Text key="findings" color={p.dim} wrap="wrap">{t.findings}</Text>)
  // One next step.
  const step: unknown[] = []
  const giving = picking === `${t.key}:give`
  const stuck = tasks.find((x) => x.status === 'current')
  const current = planless ? (t.writer ?? '') : stuck ? (t.giveTo === 'reviewer' ? stuck.reviewer : stuck.agent) : ''
  const others = agentOptions(agentList).filter((o) => o.value !== current)
  if (t.canApprove) step.push(<Button key={`approve-${t.key}`} variant="primary" label="Approve plan" onPress={() => go.approvePlan(s.id, t.key)} />)
  if (t.canOneTask) step.push(<Button key={`one-task-${t.key}`} variant="primary" label="Run as one task" onPress={() => go.approvePlan(s.id, t.key, true)} />)
  if (t.canRevise && !revising) step.push(<Button key={`revise-${t.key}`} label="Ask for changes…" onPress={() => go.askConfirm(s.id, `revise:${t.key}`)} />)
  if (t.canRetry) step.push(<Button key={`retry-${t.key}`} variant="primary" label="Retry" onPress={() => go.retryTicket(s.id, t.key)} />)
  if (t.canRetry && t.giveTo && others.length) step.push(<Button key={`give-${t.key}`} label={giving ? 'Done' : 'Give to another agent…'} onPress={() => go.openPicker(s.id, giving ? null : `${t.key}:give`)} />)
  // As the one next step it is outlined: not `open-`, which look.tsx draws as a text link on desktop.
  const stepsButton = (primary: boolean) => (primary
    ? <Button key={`steps-${t.key}`} variant="primary" label="Steps and diff" onPress={() => go.openDetail(t.latest as string)} />
    : <Button key={`open-steps-${t.key}`} plain label="Steps and diff" onPress={() => go.openDetail(t.latest as string)} />)
  const stepsIsNext = !step.length && Boolean(t.latest) && t.state === 'running'
  if (stepsIsNext) step.push(stepsButton(true))
  // A question or form open is the one decision: while the plan's notes are open or Stop asks, the next step
  // (Approve plan, Run as one task, Retry…) is not drawn, so it can't be pressed with notes unsent; Cancel brings it back.
  const deciding = (t.canRevise && revising) || (t.canStop && stopping)
  if (step.length && !deciding) parts.push(<Box key="next" flexDirection="row" flexWrap="wrap" gap={1}>{step}</Box>)
  if (giving && t.canRetry && t.giveTo && !deciding) {
    const what = planless ? 'to write the plan' : `${t.giveTo === 'reviewer' ? 'to review' : 'to write'}${stuck ? ` task ${stuck.n}` : ''}`
    parts.push(choices(ui, p, `giveto-${t.key}`, `Give it to (${what}):`, '', others, (v) => go.retryTicket(s.id, t.key, v)))
  }
  if (t.canRevise && revising) {
    parts.push(
      <Box key={`revise-form-${t.key}`} flexDirection="column" gap={1}>
        <Input key={`revise-text-${t.key}`} label="What should change in the plan?" placeholder="e.g. split task 2, and add a test for an empty file" value={board.note ?? ''} submitLabel="Send"
          onInput={(v: string) => go.editNote(s.id, v)} onSubmit={(v: string) => go.revisePlan(s.id, t.key, v)} />
        <Text color={p.dim} wrap="wrap">{`${agentName(t.writer)} changes the plan in the same conversation, then it is ready to approve again.`}</Text>
        <Box flexDirection="row" gap={1}>
          <Button key={`revise-send-${t.key}`} variant="primary" label="Send" onPress={() => go.revisePlan(s.id, t.key, board.note ?? '')} />
          <Button key={`revise-cancel-${t.key}`} label="Cancel" onPress={() => go.askConfirm(s.id, null)} />
        </Box>
      </Box>,
    )
  }
  if (t.latest && (!stepsIsNext || deciding)) parts.push(<Box key="links" flexDirection="row">{stepsButton(false)}</Box>)
  // Folded detail.
  const fid = (name: string) => `ticket:${s.id}:${t.key}:${name}`
  const f = (name: string, title: string, summary: string, body: () => unknown[]) => fold(ui, p, fid(name), title, summary, isFoldOpen(folds, fid(name)), () => go.toggleFold(fid(name)), body)
  parts.push(f('who', 'Who works on it', whoLine(t), () => whoRows(ui, p, s, t, picking, agentList, go)))
  const after = t.after ?? []
  const otherKeys = [...new Set([...s.tickets.map((x) => x.key), ...after])].filter((k) => k !== t.key)
  if ((draft && otherKeys.length) || after.length) {
    parts.push(f('after', 'Waits for', after.length ? andList(after) : 'nothing', () => (draft
      ? [
          <Text key="after-what" color={p.dim} wrap="wrap">Starts after these are merged:</Text>,
          <Box key={`after-row-${t.key}`} flexDirection="row" flexWrap="wrap" gap={1}>
            {otherKeys.map((k) => {
              const on = after.includes(k)
              return <Button key={`after-${t.key}-${k}`} label={`${on ? '☑' : '☐'} ${k}`} onPress={() => go.setAfter(s.id, t.key, k, !on)} />
            })}
          </Box>,
        ]
      : [<Text key="after-what" color={p.dim} wrap="wrap">{`Starts when ${andList(after)} ${after.length === 1 ? 'is' : 'are'} merged on GitHub, from the code as merged there.`}</Text>])))
  }
  if (t.plan) parts.push(f('plan', 'Plan file', String(t.plan).split('/').pop() ?? '', () => [<Text key="plan-path" color={p.dim} wrap="wrap">{String(t.plan)}</Text>]))
  if (tasks.length) {
    parts.push(f('steps', 'Steps', `${tasks.filter((x) => x.status === 'done').length} of ${tasks.length} done`, () => tasks.map((x) => (
      <Text key={`task-${t.key}-${x.n}`} wrap="truncate-end">{`${MARK[x.status] ?? '·'} Task ${x.n}: ${x.title}`}</Text>
    ))))
  }
  // A draft's order and Remove; Stop at the bottom, asking first.
  if (draft) {
    // A capped card's rows know their place in the whole sprint (pos).
    const total = s.tickets.length + (s.more ?? 0)
    const at = t.pos ?? s.tickets.indexOf(t)
    const order: unknown[] = []
    if (at > 0) order.push(<Button key={`up-${t.key}`} plain label="Move up" onPress={() => go.moveTicket(s.id, t.key, 'up')} />)
    if (at < total - 1) order.push(<Button key={`down-${t.key}`} plain label="Move down" onPress={() => go.moveTicket(s.id, t.key, 'down')} />)
    if (total > 1) order.push(<Button key={`remove-${t.key}`} label="Remove from sprint" onPress={() => go.removeTicket(s.id, t.key)} />)
    if (order.length) parts.push(<Box key="order" flexDirection="row" flexWrap="wrap" gap={1}>{order}</Box>)
  }
  if (t.canStop) {
    if (stopping) {
      parts.push(
        <Text key="stop-what" wrap="wrap">{`Stop ${t.key}? No more tasks run and no PR is opened. Any work it did stays on its branch.`}</Text>,
        <Box key="stop-confirm" flexDirection="row" gap={1}>
          <Button key={`stop-yes-${t.key}`} variant="primary" label="Stop ticket" onPress={() => go.stopTicket(s.id, t.key)} />
          <Button key={`stop-no-${t.key}`} label="Cancel" onPress={() => go.askConfirm(s.id, null)} />
        </Box>,
      )
    } else {
      parts.push(<Box key="bottom" flexDirection="row"><Button key={`end-stop-${t.key}`} label="Stop this ticket…" onPress={() => go.askConfirm(s.id, `stop:${t.key}`)} /></Box>)
    }
  }
  return <Box flexDirection="column" gap={1}>{parts}</Box>
}

// The first-run welcome: one line on how to start, Try it, and the setup checks folded, open on their own
// only when something needs fixing.
function welcomeCard(ui: Ui, p: Palette, rows: CheckRow[], folds: string[], go: ListHandlers) {
  const { Box, Text, Button } = ui
  const wrong = rows.some((r) => r.ok === false)
  return tile(ui, p, 'neutral', 'welcome', [
    <Text key="welcome-title" bold>Welcome to Podium</Text>,
    <Text key="welcome-how" color={p.dim} wrap="wrap">Hand work to another agent from the chat, or press + New job.</Text>,
    <Box key="welcome-buttons" flexDirection="row" gap={1}>
      <Button key="welcome-try" variant="primary" label="Try it" onPress={() => go.tryIt()} />
      <Button key="welcome-done" label="Got it" onPress={() => go.gotIt()} />
    </Box>,
    fold(ui, p, 'list:setup', 'Your setup', setupSummary(rows), isFoldOpen(folds, 'list:setup', wrong), () => go.toggleFold('list:setup'), () => checkLines(ui, p, rows, 'check')),
  ])
}

const titleOf = (t: Thread) => t.steps[t.steps.length - 1]?.title || t.latest.title || 'Untitled job'

// Finished sprints' rows in the Done or Other chats fold: each opens its board, coloured done or failed,
// and a dim line for the older ones not shown (`older`, exact: the engine counts per fold what it did not list).
function finishedSprintRows(ui: Ui, p: Palette, list: SprintSummary[], older: number, where: string, now: number, go: ListHandlers) {
  const { Text } = ui
  const rows: unknown[] = list.map((s) => row(ui, p, `board-${s.id}`, sprintRowTitle(s), [finishedSprintLine(s, now)], () => go.openBoard(s.id), undefined, finishedSprintTone(s)))
  if (older > 0) rows.push(<Text key={`sprints-older-${where}`} color={p.dim} wrap="wrap">{olderSprintsLine(older)}</Text>)
  return rows
}

// The list: Your turn first (everything waiting on the person, one line and one button each), then Working
// (jobs with a live line, then a row per sprint, a page of them at a time), In review, and Done and other chats' finished
// work, folded. Every row opens its own screen.
export function listScreen(ui: Ui, p: Palette, model: PaneModel, org: Organised, now: number, go: ListHandlers) {
  const { Box, Text, Button } = ui
  const folds = model.folds ?? []
  const parts: unknown[] = []
  const report = model.checks
  if (report && !report.welcomed) parts.push(welcomeCard(ui, p, checkRows(report, model.agentsLoaded ? model.agents : null), folds, go))
  const turn = model.turn ?? turnTickets(model.sprints ?? [])
  const items = turnItems(org, turn.tickets) as TurnItem[]
  const openSprints = (model.sprints ?? []).filter(isOpenSprint)
  const shown = listPage(openSprints, model.sprintPage ?? 0, model.sprintPaging ?? null)
  const done = org.done.filter((t) => !isFailedTurn(t))
  // Finished sprints: this chat's in Done, other chats' in Other chats, the newest FINISHED_SPRINTS of each.
  // On desktop fitModel sent no more, and counts the rest (`olderSprints`); the engine counts, per fold, the archived ones it
  // did not list at all (`olderFinished`), so the "older sprints" line is exact.
  const session = model.session ?? null
  const fin = finishedSprints(model.sprints ?? [], session)
  const finMine = fin.mine.slice(0, FINISHED_SPRINTS)
  const finOthers = fin.others.slice(0, FINISHED_SPRINTS)
  const olderMine = (model.olderSprints?.mine ?? 0) + (model.olderFinished?.mine ?? 0) + fin.mine.length - finMine.length
  const olderOthers = (model.olderSprints?.others ?? 0) + (model.olderFinished?.others ?? 0) + fin.others.length - finOthers.length
  // Clear takes failed jobs out of Your turn too (they are in org.done): it sits in the Done fold, or, when there is no
  // Done fold (every finished job failed), as a quiet link under Your turn.
  const doneFold = Boolean(done.length || org.doneHidden || model.showAllDone || finMine.length || olderMine)
  const hiddenJobs = model.hiddenJobs ?? 0
  const hiddenAtWork = model.hiddenAtWork ?? 0
  const hiddenSprints = model.hiddenSprints ?? 0
  const mine = items.length || org.working.length || org.review.length || done.length || org.doneHidden || model.showAllDone || openSprints.length || hiddenJobs || hiddenSprints || finMine.length || olderMine
  // Nothing of this chat's: the text, with the Other chats fold below it when that has anything, jobs or sprints alike
  // (an empty chat shows the text and the other-chats lane).
  if (!mine) parts.push(<Text key="empty" color={p.dim} wrap="wrap">No jobs in this chat yet. Ask Claude to hand work to another agent, or press + New job.</Text>)
  if (mine) {
    // Your turn.
    const waiting = items.length + turn.more
    parts.push(<Text key="h-turn" bold>{waiting ? `Your turn · ${waiting}` : 'Your turn'}</Text>)
    if (!waiting) parts.push(<Text key="turn-none" color={p.dim}>Nothing needs you right now.</Text>)
    for (const it of items) parts.push(turnRow(ui, p, it, go))
    if (turn.more) parts.push(<Text key="turn-more" color={p.dim} wrap="wrap">{`… and ${turn.more} more sprint ticket${turn.more === 1 ? '' : 's'}; open their boards to see them.`}</Text>)
    if (!doneFold && org.done.length) parts.push(<Box key="turn-links" flexDirection="row"><Button key="link-clear" plain label="Clear stopped jobs" onPress={() => go.clearDone()} /></Box>)
  }
  // Working: jobs, then sprints.
  const working = org.working.length + shown.total
  if (working) {
    parts.push(<Text key="h-working" bold>{`Working · ${working}`}</Text>)
    for (const t of org.working) {
      const info = model.live[t.latest.id]
      parts.push(row(ui, p, t.latest.id, titleOf(t), [workingRowLine(t.latest, now, info ?? null, t.isMine === false), info?.activity ?? 'starting…'], () => go.openDetail(t.latest.id), undefined, 'working'))
    }
    for (const s of shown.sprints) {
      parts.push(row(ui, p, `board-${s.id}`, sprintRowTitle(s), [sprintWorkingLine(s, !isSprintMine(s, session))], () => go.openBoard(s.id), s.unreadable ? p.failed.text : undefined, sprintTone(s)))
    }
    if (shown.pages > 1) {
      const after = shown.total - shown.to
      parts.push(<Text key="sprints-page" color={p.dim} wrap="wrap">{`Sprints ${shown.from}–${shown.to} of ${shown.total}${after > 0 ? ` · ${after} more` : ''}`}</Text>)
      parts.push(
        <Box key="sprints-paging" flexDirection="row" flexWrap="wrap" gap={1}>
          {shown.page > 0 ? <Button key="sprints-earlier" label="Show earlier sprints" onPress={() => go.showSprints(shown.page - 1)} /> : null}
          {after > 0 ? <Button key="sprints-more" label="Show more sprints" onPress={() => go.showSprints(shown.page + 1)} /> : null}
        </Box>,
      )
    }
  }
  // Sprints the desktop pane was not sent (fitModel's last resort).
  if (hiddenSprints > 0) parts.push(<Text key="sprints-hidden" color={p.dim} wrap="wrap">{`${hiddenSprints} more sprint${hiddenSprints === 1 ? ' is' : 's are'} not shown here; ask Claude for ${hiddenSprints === 1 ? 'it' : 'them'}.`}</Text>)
  // In review.
  if (org.review.length) {
    parts.push(<Text key="h-review" bold>{`In review · ${org.review.length}`}</Text>)
    for (const t of org.review) {
      const job = t.latest
      const sub = [job.pr ? prSub(job.pr) : null, t.isMine === false ? FROM_OTHER_CHAT : null].filter(Boolean).join(' · ')
      parts.push(row(ui, p, job.id, job.pr ? `PR #${job.pr.number} ${titleOf(t)}` : titleOf(t), [sub || null], () => go.openDetail(job.id), undefined, 'neutral'))
    }
  }
  // Done, folded. Its Clear also clears failed jobs (Your turn). This chat's finished sprints follow its jobs.
  if (doneFold) {
    parts.push(fold(ui, p, 'list:done', 'Done', String(done.length + finMine.length), isFoldOpen(folds, 'list:done'), () => go.toggleFold('list:done'), () => [
      ...done.map((t) => row(ui, p, t.latest.id, titleOf(t), [doneRowLine(t.latest, now)], () => go.openDetail(t.latest.id), undefined, finishedTone(t.latest))),
      ...finishedSprintRows(ui, p, finMine, olderMine, 'done', now, go),
      <Box key="done-links" flexDirection="row" flexWrap="wrap" gap={1}>
        {org.done.length ? <Button key="link-clear" plain label="Clear" onPress={() => go.clearDone()} /> : null}
        {org.doneHidden > 0 || model.showAllDone ? <Button key="link-done-more" plain label={model.showAllDone ? 'Show fewer' : `Show ${org.doneHidden} more`} onPress={() => go.toggleShowAll()} /> : null}
      </Box>,
    ]))
  }
  // Other chats' finished work, folded: their jobs, then their finished sprints.
  if (org.others.length || finOthers.length || olderOthers) {
    parts.push(fold(ui, p, 'list:others', 'Other chats', String(org.others.length + finOthers.length), isFoldOpen(folds, 'list:others'), () => go.toggleFold('list:others'), () => [
      ...org.others.map((t) => row(ui, p, t.latest.id, titleOf(t), [doneRowLine(t.latest, now)], () => go.openDetail(t.latest.id), undefined, finishedTone(t.latest))),
      ...finishedSprintRows(ui, p, finOthers, olderOthers, 'others', now, go),
    ]))
  }
  // Jobs the desktop pane was not sent (fitModel).
  if (hiddenAtWork > 0) parts.push(<Text key="older-hidden" color={p.dim} wrap="wrap">Some jobs are not shown here; ask Claude for them.</Text>)
  else if (hiddenJobs > 0) parts.push(<Text key="older-hidden" color={p.dim} wrap="wrap">{`${hiddenJobs} finished job${hiddenJobs === 1 ? ' is' : 's are'} not shown here; ask Claude for ${hiddenJobs === 1 ? 'it' : 'them'}.`}</Text>)
  return <Box flexDirection="column" gap={1}>{parts}</Box>
}

export type DetailHandlers = ListHandlers & {
  confirmJob: (id: string, what: 'discard' | 'cancel' | null) => void
  rate: (id: string, value: 'used' | 'discarded') => void
  toggleFull: (id: string) => void
  askClaude: (id: string) => void
  toggleFile: (id: string, file: string) => void
  fullDiff: (id: string) => void
  askRepair: (id: string, isOn: boolean) => void
  repair: (id: string) => void
}

function changeRows(ui: Ui, p: Palette, id: string, set: ChangeSet, open: string[], go: DetailHandlers) {
  const { Box, Text, Button } = ui
  // `more`: files the desktop Client was not sent (fitModel), counted here as the rest are.
  const total = set.files.length + (set.more ?? 0)
  const rows: unknown[] = []
  // The desktop page refuses a tree over 2,000 nodes or 100,000 characters, and each file row adds several nodes and
  // its path three times: draw the first FILE_ROWS only, fewer when their paths are long (fileRows).
  const shown = set.files.slice(0, fileRows(set.files))
  // Full diff fetches the whole job's diff, so it is offered once, under the first open file that was cut.
  const cutOpen = shown.find((f) => open.includes(f.path) && f.isTruncated)
  for (const f of shown) {
    const isOpen = open.includes(f.path)
    const counts = f.added === null ? 'binary file' : `+${f.added} −${f.removed}`
    rows.push(
      <Box key={`row-${f.path}`} flexDirection="row" justifyContent="space-between">
        <Button key={`file-${f.path}`} plain label={`${isOpen ? '▾' : '▸'} ${f.path}`} onPress={() => go.toggleFile(id, f.path)} />
        <Text color={p.dim}>{counts}</Text>
      </Box>,
    )
    if (isOpen && f.patch) rows.push(codeBlock(ui, p, `diff-${f.path}`, f.patch, 'diff'))
    if (f === cutOpen) rows.push(<Button key={`full-${f.path}`} plain label="Full diff" onPress={() => go.fullDiff(id)} />)
  }
  const more = total - shown.length
  if (more > 0) rows.push(<Text key="chg-more" color={p.dim}>{`… and ${more} more file${more === 1 ? '' : 's'}`}</Text>)
  return rows
}

// A job's own screen: the title, one status line, what the agent did (or, while it works, its last lines),
// one next step, then folded detail. Throw away and Stop sit at the bottom and ask first. A sprint's step says the sprint
// manages it, and goes back to its ticket; the sprint keeps or opens its work, so it offers no Keep or Throw away.
export function detailScreen(ui: Ui, p: Palette, job: JobRecord | undefined, d: JobDetail | null, info: LiveInfo | undefined, now: number, go: DetailHandlers, thread: Thread | null = null, ask: AskFor = null, agentList: AgentRecord[] = [], session: string | null = null, folds: string[] = [], prReady = false) {
  const { Box, Text, Button } = ui
  const sprint = job?.sprint ?? null
  const back = sprint ? <Button key="back" plain label={`← ${sprint.ticket}`} onPress={() => go.openTicket(sprint.id, sprint.ticket)} /> : backButton(ui, go)
  if (!job) {
    return (
      <Box flexDirection="column" gap={1}>
        {back}
        <Text color={p.dim}>That job is no longer listed.</Text>
      </Box>
    )
  }
  const id = job.id
  const mine = d && d.id === id ? d : null
  const working = job.status === 'queued' || job.status === 'running'
  const pr = job.pr ?? null
  const threadId = thread?.id ?? job.threadId ?? job.id
  const isLatest = !thread || thread.latest.id === id
  const asking = Boolean(ask && thread && ask.threadId === thread.id && isLatest)
  const tone = toneOf(job)
  const quiet = working ? quietText(info ?? null, now) : null
  const statusColor = pr?.state === 'OPEN' && pr.attention ? p.needs.text : tone === 'needs' ? p.needs.text : tone === 'failed' ? p.failed.text : tone === 'working' ? p.working.text : p.dim
  // An in-review job's status line already says its PR's problem; on any other job with an open PR it is added here.
  const problem = isLatest && pr?.state === 'OPEN' && pr.attention && job.status !== 'in-review' ? attentionLine(pr) : null
  const parts: unknown[] = [
    back,
    // The title and status line in one tile, coloured by the job's state (a PR that needs attention needs the person).
    tile(ui, p, jobTone(job), 'job-tile', [
      <Text key="title" bold wrap="wrap">{job.title || 'Untitled job'}</Text>,
      <Text key="status" color={statusColor} wrap="wrap">{[jobStatusLine(job, now), problem, quiet].filter(Boolean).join(' · ')}</Text>,
    ]),
  ]
  if (sprint) parts.push(<Text key="sprint-managed" color={p.dim} wrap="wrap">The sprint manages this step.</Text>)
  if (working) parts.push(codeBlock(ui, p, 'live', info && info.lines.length ? info.lines.slice(-5).join('\n') : 'Waiting for the first output…'))
  else parts.push(<Text key="summary" wrap="wrap">{mine?.summary ?? job.error ?? 'No summary yet.'}</Text>)
  // What ends something, at the bottom, asking first.
  type Ender = { what: 'discard' | 'cancel'; label: string; ask: string; yes: string }
  const ender: Ender | null = working
    ? { what: 'cancel', label: 'Stop job…', ask: "Stop this job? The agent stops now; what it did so far stays in Podium's copy.", yes: 'Stop job' }
    : !sprint && job.status === 'needs-review' && !pr
      ? { what: 'discard', label: 'Throw away…', ask: 'Throw away these changes? Podium deletes its copy, and the changes with it.', yes: 'Throw away' }
      : !sprint && job.worktree && (['cancelled', 'failed', 'lost'].includes(job.status) || job.committed)
        ? { what: 'discard', label: 'Throw away its copy…', ask: "Delete Podium's copy of this job? Anything committed stays on its branch.", yes: 'Throw away' }
        : null
  const ending = Boolean(ender && mine?.confirm === ender.what)
  // A question or form open is the one decision: while Throw away or Stop asks, Repair asks, or the ask form
  // is open, the next step (Keep changes, Push to PR, Send fix, Ask Claude…) is not drawn; Cancel brings it back.
  const deciding = ending || asking || Boolean(job.warning?.repair === 'muse-sandbox' && mine?.confirmRepair)
  if (job.warning) {
    parts.push(<Text key="warning" color={p.needs.text} wrap="wrap">{`⚠ ${job.warning.message}`}</Text>)
    if (job.warning.repair === 'muse-sandbox') {
      if (mine?.confirmRepair) {
        parts.push(
          <Text key="repair-what" color={p.dim} wrap="wrap">This removes the piled-up "MuseSandboxUsers" deny entries from your Muse config folder (…\.config\muse). Muse adds back the one it needs next time. Nothing else changes.</Text>,
          <Box key="repair-confirm" flexDirection="row" gap={1}>
            <Button key="repair-yes" variant="primary" label="Repair" onPress={() => go.repair(id)} />
            <Button key="repair-no" label="Cancel" onPress={() => go.askRepair(id, false)} />
          </Box>,
        )
      } else {
        parts.push(<Box key="repair-row" flexDirection="row"><Button key="repair" label="Repair Muse's sandbox…" onPress={() => go.askRepair(id, true)} /></Box>)
      }
    }
  }
  // One next step: a primary button, at most one beside it, the rest quiet links.
  const step: unknown[] = []
  const links: unknown[] = []
  const canAsk = !sprint && isLatest && !asking && canContinue(job) && job.kind !== 'review'
  // New changes on an open PR can be pushed to it.
  const canPush = !sprint && isLatest && pr?.state === 'OPEN' && ['needs-review', 'done'].includes(job.status) && Boolean(job.worktree)
  const askButton = (primary: boolean) => (primary
    ? <Button key="ask-detail" variant="primary" label="Ask for changes…" onPress={() => go.askOpen(threadId, job.agent)} />
    : <Button key="ask-detail" label="Ask for changes…" onPress={() => go.askOpen(threadId, job.agent)} />)
  if (working) {
    step.push(<Button key="ask" variant="primary" label="Ask Claude about it" onPress={() => go.askClaude(id)} />)
  } else if (!sprint && job.status === 'needs-review' && !pr) {
    step.push(<Button key="keep" variant="primary" label="Keep changes" onPress={() => go.act('keep', id)} />)
    if (canAsk) step.push(askButton(false))
    if (prReady) links.push(<Button key="link-openpr" plain label="Open a PR instead" onPress={() => go.openPr(id)} />)
  } else if (canPush) {
    step.push(<Button key="push" variant="primary" label="Push to PR" onPress={() => go.pushPr(id)} />)
    if (canAsk) step.push(askButton(false))
  } else if (!sprint && pr && job.status === 'in-review') {
    if (pr.attention === 'ci-failed') step.push(<Button key="fix-ci" variant="primary" label={`Send fix to ${agentName(job.agent)}`} onPress={() => go.fixOpen(threadId, id, job.agent, 'ci')} />)
    else if (pr.comments > 0) step.push(<Button key="fix-comments" variant="primary" label="Answer comments" onPress={() => go.fixOpen(threadId, id, job.agent, 'comments')} />)
    else if (pr.attention && canAsk) step.push(askButton(true))
    // A quiet PR (nothing needs the person) still has one next step: Open on GitHub.
    step.push(step.length
      ? <Button key="browse" label="Open on GitHub" onPress={() => go.browsePr(id)} />
      : <Button key="browse" variant="primary" label="Open on GitHub" onPress={() => go.browsePr(id)} />)
    links.push(<Button key="automerge" plain label={`${pr.autoMerge ? '☑' : '☐'} Merge when green`} onPress={() => go.toggleAutoMerge(id, !pr.autoMerge)} />)
    if (pr.watching === false) links.push(<Button key="link-watch" plain label="Watch again" onPress={() => go.watchAgain(id)} />)
    if (!pr.attention && canAsk) links.push(<Button key="link-ask" plain label="Ask for changes…" onPress={() => go.askOpen(threadId, job.agent)} />)
    links.push(<Button key="link-reviewwith" plain label="Review with…" onPress={() => go.reviewOpen(threadId, job.agent === 'codex' ? 'claude' : 'codex', pr.number)} />)
  } else if (canAsk) {
    step.push(askButton(true))
  }
  // Any other job with an open PR keeps the PR's actions, as quiet links (the in-review step above has its own).
  if (!sprint && isLatest && !working && pr?.state === 'OPEN' && job.status !== 'in-review') {
    links.push(
      <Button key="link-browse" plain label="Open on GitHub" onPress={() => go.browsePr(id)} />,
      <Button key="automerge" plain label={`${pr.autoMerge ? '☑' : '☐'} Merge when green`} onPress={() => go.toggleAutoMerge(id, !pr.autoMerge)} />,
    )
    if (pr.watching === false) links.push(<Button key="link-watch" plain label="Watch again" onPress={() => go.watchAgain(id)} />)
    links.push(<Button key="link-reviewwith" plain label="Review with…" onPress={() => go.reviewOpen(threadId, job.agent === 'codex' ? 'claude' : 'codex', pr.number)} />)
  }
  // A finished review waiting to be posted: one per reviewer, its newest, while the PR is open.
  if (thread && pr?.state === 'OPEN') {
    const toPost = thread.steps.filter((x) => x.kind === 'review' && x.status === 'done' && !x.posted)
    for (const s of toPost.filter((x, i) => toPost.findIndex((y) => y.agent === x.agent) === i)) {
      links.push(<Button key={`link-post-${s.id}`} plain label={`Post ${agentName(s.agent)}'s review to PR #${s.reviewOf?.number ?? pr.number}`} onPress={() => go.postReview(s.id)} />)
    }
  }
  if (step.length && !deciding) parts.push(<Box key="next" flexDirection="row" flexWrap="wrap" gap={1}>{step}</Box>)
  if (asking && thread && ask) parts.push(askForm(ui, p, thread, ask, agentList, go))
  if (links.length) parts.push(<Box key="links" flexDirection="row" flexWrap="wrap" gap={1}>{links}</Box>)
  // Folded detail: each only when it has something in it.
  const f = (name: string, title: string, summary: string, body: () => unknown[]) => {
    const fid = `job:${id}:${name}`
    return fold(ui, p, fid, title, summary, isFoldOpen(folds, fid), () => go.toggleFold(fid), body)
  }
  const set = mine?.changes ?? null
  const counts = set ? { files: set.files.length + (set.more ?? 0), added: set.added, removed: set.removed } : job.changes ?? null
  const c = job.committed ?? null
  if ((counts && counts.files) || c) {
    const summary = counts && counts.files
      ? `${counts.files} file${counts.files === 1 ? '' : 's'} · +${counts.added} −${counts.removed}`
      : `${c?.count} commit${c?.count === 1 ? '' : 's'} on ${c?.branch ?? 'a detached HEAD'}`
    parts.push(f('changes', 'Changes', summary, () => [
      ...(c && c.commits.length ? [codeBlock(ui, p, 'commits', c.commits.map((x) => `${x.sha} ${x.subject}`).join('\n'))] : []),
      ...(job.leftovers ? [<Text key="leftovers" color={p.needs.text} wrap="wrap">The agent also left uncommitted edits in Podium's copy.</Text>] : []),
      ...(set && set.files.length ? changeRows(ui, p, id, set, mine?.open ?? [], go) : []),
      ...(counts && counts.files && !set ? [<Text key="changes-loading" color={p.dim}>Loading the changes…</Text>] : []),
    ]))
  }
  // The PR's checks, and its review state. The heading stays short: the status line already says what failed.
  if (pr) {
    const ck = pr.checks ?? { total: 0, passed: 0, failed: 0, running: 0, failing: [] }
    const short = !ck.total ? 'none' : ck.failed ? `${ck.failed} failed` : ck.running ? `${ck.running} running` : `${ck.passed} of ${ck.total} passed`
    parts.push(f('checks', 'Checks', short, () => [
      ...(ck.failing ?? []).map((name: string, i: number) => <Text key={`failing-${i}`} color={p.failed.text} wrap="wrap">{`✗ ${name}`}</Text>),
      <Text key="checks-all" color={p.dim} wrap="wrap">{`${ck.passed} passed · ${ck.failed} failed · ${ck.running} running`}</Text>,
      <Text key="checks-review" color={p.dim} wrap="wrap">{`review: ${REVIEW_WORDS[pr.review ?? ''] ?? 'none yet'}`}</Text>,
      ...(pr.watching === false ? [<Text key="unwatched" color={p.dim} wrap="wrap">Podium stopped watching this PR after 7 days.</Text>] : []),
    ]))
  }
  // Comments, when there are any (the review state is said once, under Checks; a PR's problem, in the status line).
  if (pr && pr.comments > 0) {
    parts.push(f('comments', 'Comments', String(pr.comments), () => [
      <Text key="comments-count" color={p.dim} wrap="wrap">{`${pr.comments} comment${pr.comments === 1 ? '' : 's'} and reviews on GitHub.`}</Text>,
    ]))
  }
  if (thread && thread.steps.length > 1) {
    parts.push(f('steps', 'Steps', String(thread.steps.length), () => {
      // The newest STEP_ROWS rows (and the open step's, if older): a long thread must not crowd the desktop page's
      // 2,000 elements on its own. A sprint's steps say what each did, one row each; a thread's are grouped.
      const rows = sprint ? thread.steps.map((step) => ({ step, count: 1 })) : groupSteps(thread.steps)
      const listed = rows.filter((r, i) => i < STEP_ROWS || r.step.id === id)
      const out: unknown[] = listed.map(({ step: s, count }) => {
        const line = s.sprint ? sprintStepLine(s, thread.steps, now) : stepLine(s, now)
        return <Button key={`step-${s.id}`} plain label={shorten(counted(`${s.id === id ? '● ' : ''}${line}`, count), STEP_CHARS)} onPress={() => go.openDetail(s.id)} />
      })
      const unlisted = rows.filter((r) => !listed.includes(r)).reduce((n, r) => n + r.count, 0)
      if (unlisted) out.push(<Text key="steps-more" color={p.dim}>{`… ${unlisted} earlier step${unlisted === 1 ? '' : 's'} not listed`}</Text>)
      return out
    }))
  }
  // Full output is fetched when opened (toggleFull), so its fold state is whether it is loaded.
  parts.push(fold(ui, p, `job:${id}:output`, 'Full output', '', Boolean(mine?.output), () => go.toggleFull(id), () => [codeBlock(ui, p, 'full-output', mine?.output ?? '')]))
  parts.push(f('details', 'Details', '', () => jobDetails(job, !job.sprint && fromAnotherChat(thread?.steps ?? [job], session)).map((line: string, i: number) => <Text key={`detail-${i}`} color={p.dim} wrap="wrap">{line}</Text>)))
  // At the bottom: what ends something, asking first, and the rating.
  if (ender && ending) {
    parts.push(
      <Text key="end-what" wrap="wrap">{ender.ask}</Text>,
      <Box key="end-confirm" flexDirection="row" gap={1}>
        <Button key={`${ender.what}-yes`} variant="primary" label={ender.yes} onPress={() => go.act(ender.what, id)} />
        <Button key={`${ender.what}-no`} label="Cancel" onPress={() => go.confirmJob(id, null)} />
      </Box>,
    )
  }
  const bottom: unknown[] = []
  if (ender && mine?.confirm !== ender.what) bottom.push(<Button key={`end-${ender.what}`} label={ender.label} onPress={() => go.confirmJob(id, ender.what)} />)
  if (!working) {
    const rated = job.outcomeSource === 'user' ? job.outcome : null
    bottom.push(
      <Button key="up" plain label={rated === 'used' ? '👍 ✓' : '👍'} onPress={() => go.rate(id, 'used')} />,
      <Button key="down" plain label={rated === 'discarded' ? '👎 ✓' : '👎'} onPress={() => go.rate(id, 'discarded')} />,
    )
  }
  if (bottom.length) parts.push(<Box key="bottom" flexDirection="row" flexWrap="wrap" gap={1}>{bottom}</Box>)
  return <Box flexDirection="column" gap={1}>{parts}</Box>
}

// The steps listed under a job's detail: its thread's, or for a sprint step its ticket's.
function stepsFor(list: JobRecord[], job: JobRecord | undefined): Thread | null {
  if (!job) return null
  if (job.sprint) {
    const steps = ticketSteps(list, job.sprint)
    return steps.length ? { id: `sprint-${job.sprint.id}-${job.sprint.ticket}`, latest: steps[0], steps } : null
  }
  return threads(list).find((t) => t.steps.some((s) => s.id === job.id)) ?? null
}

export type FormHandlers = ListHandlers & {
  setSetting: (key: string, value: unknown) => void
  toggleSetting: (key: string) => void
  toggleAgent: (name: string) => void
  testAgent: (name: string) => void
  suggestAgent: (command: string) => void
  editAdapter: (patch: Partial<AdapterDraft>) => void
  saveAgent: () => void
  cancelAgent: () => void
  editDraft: (patch: Partial<Draft>) => void
  startJob: (task?: string) => void
  prune: () => void
  setInstructions: (text: string) => void
  setRepoInstructions: (text: string) => void
  setRepoSetting: (key: string, value: unknown) => void
  checkAgain: () => void
  planRemoval: () => void
  confirmRemoval: () => void
  cancelRemoval: () => void
}

// Agents: one line per agent (it opens the agent's screen), Fix where one needs attention, + Add an agent,
// and the setup checks folded, open on their own when something needs fixing.
export function agentsScreen(ui: Ui, p: Palette, list: AgentRecord[], go: FormHandlers, setup: CheckRow[] = [], folds: string[] = []) {
  const { Box, Text, Button } = ui
  const parts: unknown[] = [backButton(ui, go), <Text key="agents-head" bold>Agents</Text>]
  for (const a of list) {
    parts.push(tile(ui, p, readiness(a).tone, `agentrow-${a.name}`, [
      <Box key={`agentline-${a.name}`} flexDirection="row" gap={1} alignItems="center">
        <Button key={`open-agent-${a.name}`} plain label={agentLine(a)} onPress={() => go.openAgent(a.name)} />
        {agentNeedsFix(a) ? <Button key={`fix-${a.name}`} variant="primary" label="Fix" onPress={() => go.openAgent(a.name)} /> : null}
      </Box>,
    ]))
  }
  parts.push(<Box key="agents-add" flexDirection="row"><Button key="add-agent" label="+ Add an agent" onPress={() => go.showScreen('add-agent')} /></Box>)
  const wrong = setup.some((r) => r.ok === false)
  parts.push(fold(ui, p, 'agents:setup', 'Your setup', setupSummary(setup), isFoldOpen(folds, 'agents:setup', wrong), () => go.toggleFold('agents:setup'), () => [
    ...checkLines(ui, p, setup, 'agent-check'),
    <Button key="check-again" plain label="Check again" onPress={() => go.checkAgain()} />,
  ]))
  return <Box flexDirection="column" gap={1}>{parts}</Box>
}

// One agent's screen: its state and version, what to do about it (Test, or Switch on), its default access
// and stats folded, and Switch off at the bottom.
export function agentScreen(ui: Ui, p: Palette, a: AgentRecord | undefined, go: FormHandlers, folds: string[] = []) {
  const { Box, Text, Button } = ui
  const back = <Button key="back" plain label="← Agents" onPress={() => go.showScreen('agents')} />
  if (!a) {
    return (
      <Box flexDirection="column" gap={1}>
        {back}
        <Text key="gone" color={p.dim}>That agent is no longer listed.</Text>
      </Box>
    )
  }
  const ready = readiness(a)
  const stats = a.stats ?? { jobs: 0, used: 0 }
  const jobs = `${stats.jobs} job${stats.jobs === 1 ? '' : 's'}`
  const parts: unknown[] = [
    back,
    // The name and status line in one tile, coloured by how ready the agent is.
    tile(ui, p, ready.tone, 'agent-tile', [
      <Text key="agent-head" bold>{a.label}</Text>,
      <Text key="agent-status" color={ready.tone === 'ok' ? p.dim : p[ready.tone].text} wrap="wrap">{[agentState(a), a.version, a.installed ? (a.verified ? 'tested' : 'not tested yet') : null].filter(Boolean).join(' · ')}</Text>,
    ]),
  ]
  if (ready.note) parts.push(<Text key="agent-fix" color={p[ready.tone].text} wrap="wrap">{ready.note}</Text>)
  if (!a.installed) parts.push(<Text key="agent-missing" color={p.dim} wrap="wrap">Install it, then press Check again on Agents.</Text>)
  else if (!a.enabled) parts.push(<Box key="agent-next" flexDirection="row"><Button key={`toggle-${a.name}`} variant="primary" label="Switch on" onPress={() => go.toggleAgent(a.name)} /></Box>)
  else parts.push(<Box key="agent-next" flexDirection="row"><Button key={`test-${a.name}`} variant="primary" label="Test" onPress={() => go.testAgent(a.name)} /></Box>)
  if (a.installed) {
    const accessId = `agent:${a.name}:access`
    const level = PERMISSION_CHOICES.find((c) => c.value === a.defaultPermission)?.label ?? a.defaultPermission
    parts.push(fold(ui, p, accessId, 'Default access', level, isFoldOpen(folds, accessId), () => go.toggleFold(accessId), () => [
      choices(ui, p, `defperm-${a.name}`, '', a.defaultPermission, PERMISSION_CHOICES, (value) => go.setSetting(`defaultPermission.${a.name}`, value)),
    ]))
    const statsId = `agent:${a.name}:stats`
    parts.push(fold(ui, p, statsId, 'Stats', `${jobs} · ${stats.used} 👍`, isFoldOpen(folds, statsId), () => go.toggleFold(statsId), () => [
      <Text key="stats-text" color={p.dim} wrap="wrap">{`${jobs} run for you; you marked ${stats.used} useful.`}</Text>,
    ]))
  }
  if (a.installed && a.enabled) parts.push(<Box key="agent-bottom" flexDirection="row"><Button key={`toggle-${a.name}`} label="Switch off" onPress={() => go.toggleAgent(a.name)} /></Box>)
  return <Box flexDirection="column" gap={1}>{parts}</Box>
}

// Add an agent: its command, then the form Podium fills in from its --help (unchanged).
export function addAgentScreen(ui: Ui, p: Palette, pending: AdapterDraft | null, go: FormHandlers) {
  const { Box, Text, Button, Input } = ui
  return (
    <Box flexDirection="column" gap={1}>
      <Button key="back" plain label="← Agents" onPress={() => go.showScreen('agents')} />
      <Text key="add-head" bold>Add an agent</Text>
      {pending
        ? adapterForm(ui, p, pending, go)
        : <Input key="add-command" label="Its command" placeholder="e.g. gemini, opencode, aider" submitLabel="Look it up" onSubmit={(value: string) => go.suggestAgent(value.trim())} />}
      {pending ? null : <Text key="add-how" color={p.dim} wrap="wrap">Podium reads its --help to fill in the rest; you check it before saving.</Text>}
    </Box>
  )
}

function adapterForm(ui: Ui, p: Palette, ad: AdapterDraft, go: FormHandlers) {
  const { Box, Text, Button, Input } = ui
  const words = (v: string) => v.split(/\s+/).filter(Boolean)
  const level = (name: keyof AdapterDraft['permissions']) => (
    <Input key={`level-${name}`} label={LEVEL_LABEL[name]} value={ad.permissions[name].join(' ')}
      onSubmit={(v: string) => go.editAdapter({ permissions: { ...ad.permissions, [name]: words(v) } })} />
  )
  const fileFlag = ad.promptVia === 'file'
    ? [<Input key="promptFileFlag" label="Prompt file option" value={ad.promptFileFlag ?? ''} onSubmit={(v: string) => go.editAdapter({ promptFileFlag: v.trim() })} />]
    : []
  return (
    <Box flexDirection="column" gap={1}>
      <Text color={p.dim}>{`Command: ${ad.command}. Press Enter in a field to keep a change.`}</Text>
      <Input key="label" label="Name shown" value={ad.label} onSubmit={(v: string) => go.editAdapter({ label: v.trim() })} />
      <Input key="baseArgs" label="Run it with (arguments)" value={ad.baseArgs.join(' ')} onSubmit={(v: string) => go.editAdapter({ baseArgs: words(v) })} />
      {choices(ui, p, 'promptVia', 'Send the task by', ad.promptVia, [{ value: 'stdin', label: 'Standard input' }, { value: 'file', label: 'A prompt file' }], (v) => go.editAdapter({ promptVia: v as AdapterDraft['promptVia'] }))}
      {fileFlag}
      <Input key="modelFlag" label="Model option (optional)" value={ad.modelFlag ?? ''} onSubmit={(v: string) => go.editAdapter({ modelFlag: v.trim() || null })} />
      <Text color={p.dim}>Arguments for each permission level:</Text>
      {level('read-only')}
      {level('edit-worktree')}
      {level('own-config')}
      {level('full-access')}
      <Box flexDirection="row" gap={1}>
        <Button key="save-agent" variant="primary" label="Save and test" onPress={() => go.saveAgent()} />
        <Button key="cancel-agent" label="Cancel" onPress={() => go.cancelAgent()} />
      </Box>
    </Box>
  )
}

const MERGE_CHOICES = [
  { value: 'default', label: 'Repo default' }, { value: 'merge', label: 'Merge' }, { value: 'squash', label: 'Squash' }, { value: 'rebase', label: 'Rebase' },
]

// The merge method as the engine reads it (repoSettings): a known one in any case, else the repo's default.
const mergeChoice = (m: unknown) => {
  const v = String(m ?? '').toLowerCase()
  return MERGE_CHOICES.some((o) => o.value === v) ? v : 'default'
}

// Settings → This repo: the commands agents may run while editing, the full check before a sprint ticket's PR, one
// commit per sprint PR, and the merge method; each saves for the repo this chat is in (`here`).
function repoRows(ui: Ui, p: Palette, s: Record<string, any>, go: FormHandlers) {
  const { Text, Button, Input } = ui
  const here = s.here ?? null
  if (!here) return [<Text key="repo-none" color={p.dim} wrap="wrap">Open Podium from a chat in a repo to set these.</Text>]
  // The settings file may have been edited by hand: a value of the wrong kind draws as not set.
  const listed = s.repoCommands?.[here]
  const commands: string[] = Array.isArray(listed) ? listed.filter((c: unknown) => typeof c === 'string') : []
  const check = s.repoCheck?.[here]
  const squash = s.repoSquash?.[here] !== false
  return [
    <Text key="repo-name" color={p.dim} wrap="wrap">{`For ${here}.`}</Text>,
    <Input key="repo-commands" label="Commands agents may run while editing" value={commands.join(' ')} placeholder="e.g. dotnet npm"
      onSubmit={(v: string) => go.setRepoSetting('repoCommands', v.split(/[\s,]+/).filter(Boolean))} />,
    <Input key="repo-check" label="Full check before a sprint PR" value={typeof check === 'string' ? check : ''} placeholder="e.g. dotnet build && dotnet test"
      onSubmit={(v: string) => go.setRepoSetting('repoCheck', v.trim())} />,
    <Button key="repo-squash" plain label={`${squash ? '☑' : '☐'} One commit per sprint PR`} onPress={() => go.setRepoSetting('repoSquash', squash ? false : null)} />,
    choices(ui, p, 'repo-merge', 'Merge method', mergeChoice(s.repoMergeMethod?.[here]), MERGE_CHOICES, (v) => go.setRepoSetting('repoMergeMethod', v === 'default' ? null : v)),
  ]
}

// Settings: Tell Claude on top; the rest folded, each heading showing its value; Remove Podium's data last,
// asking first.
export function settingsScreen(ui: Ui, p: Palette, s: Record<string, any> | null, go: FormHandlers, removing: RemovalPlan | null = null, folds: string[] = []) {
  const { Box, Text, Button, Input } = ui
  if (!s) {
    return (
      <Box flexDirection="column" gap={1}>
        {backButton(ui, go)}
        <Text color={p.dim}>Loading settings…</Text>
      </Box>
    )
  }
  const number = (key: string, label: string, value: number) => (
    <Input key={key} label={label} value={String(value)}
      onSubmit={(v: string) => { const n = Number(v); if (Number.isFinite(n) && n >= 0) go.setSetting(key, n) }} />
  )
  const f = (name: string, title: string, summary: string, body: () => unknown[]) => {
    const id = `settings:${name}`
    return fold(ui, p, id, title, summary, isFoldOpen(folds, id), () => go.toggleFold(id), body)
  }
  return (
    <Box flexDirection="column" gap={1}>
      {backButton(ui, go)}
      <Text key="settings-head" bold>Settings</Text>
      <Button key="tell" plain label={`${s.tellClaudeWhenDone ? '☑' : '☐'} Tell Claude when a job finishes`} onPress={() => go.toggleSetting('tellClaudeWhenDone')} />
      {f('instructions', 'Instructions for every agent', instructionsSummary(s), () => [
        <Input key="instructions" label="All repos" value={String(s.instructions ?? '')} placeholder="e.g. Follow AGENTS.md and the skills in …" onSubmit={(v: string) => go.setInstructions(v)} />,
        <Input key="repo-instructions" label="This repo (added after)" value="" placeholder="Only for the repo this chat is in" onSubmit={(v: string) => go.setRepoInstructions(v)} />,
        <Text key="instructions-note" color={p.dim} wrap="wrap">Added to the start of every job's prompt, including follow-ups and reviews.</Text>,
      ])}
      {f('repo', 'This repo', repoSummary(s, s.here ?? null), () => repoRows(ui, p, s, go))}
      {f('storage', 'Storage', storageSummary(s), () => [
        number('retention.compressDays', 'Compress full output after (days)', s.retention.compressDays),
        number('retention.deleteDays', 'Delete full output after (days)', s.retention.deleteDays),
        <Button key="prune" label="Clean up now" onPress={() => go.prune()} />,
      ])}
      {f('limits', 'Limits', limitsSummary(s), () => [
        number('worktreeWarnMB', 'Warn before copying repos larger than (MB)', s.worktreeWarnMB),
        number('longJobMinutes', 'Ask about long jobs after (minutes)', s.longJobMinutes),
        <Text key="limits-note" color={p.dim} wrap="wrap">Default access is set for each agent in Agents.</Text>,
      ])}
      {removing
        ? [
            <Text key="remove-text" wrap="wrap">{`${removalText(removing)} Your repos and agents' branches stay.`}</Text>,
            <Box key="remove-buttons" flexDirection="row" gap={1}>
              <Button key="remove-confirm" variant="primary" label="Remove everything" onPress={() => go.confirmRemoval()} />
              <Button key="remove-cancel" label="Cancel" onPress={() => go.cancelRemoval()} />
            </Box>,
          ]
        : <Box key="settings-bottom" flexDirection="column" gap={1}>
            <Text key="remove-help" color={p.dim} wrap="wrap">Removes every job, Podium's copies and its settings. Your repos and agents' branches stay.</Text>
            <Box flexDirection="row"><Button key="end-remove-data" label="Remove Podium's data…" onPress={() => go.planRemoval()} /></Box>
          </Box>}
    </Box>
  )
}

// New job: who and what, one line for the access level the job will use, Start job; everything else under
// More options (folded).
export function newJobScreen(ui: Ui, p: Palette, d: Draft, list: AgentRecord[], go: FormHandlers, standing = false, folds: string[] = []) {
  const { Box, Text, Button, Input } = ui
  const ready = list.filter((x) => x.installed && x.enabled)
  if (!ready.length) {
    return (
      <Box flexDirection="column" gap={1}>
        {backButton(ui, go)}
        <Text color={p.dim}>No agents are ready. Open Agents to see what is installed.</Text>
      </Box>
    )
  }
  const pick = (name: string) => go.editDraft({ agent: name, model: '', permission: ready.find((x) => x.name === name)?.defaultPermission ?? d.permission })
  const moreId = 'new:more'
  return (
    <Box flexDirection="column" gap={1}>
      {backButton(ui, go)}
      <Text key="new-head" bold>New job</Text>
      {choices(ui, p, 'who', 'Who', d.agent, ready.map((x) => ({ value: x.name, label: x.label })), pick)}
      <Input key="task" label="What should it do?" placeholder="It can't see this chat, so say everything it needs" value={d.task} submitLabel="Start"
        onInput={(value: string) => go.editDraft({ task: value })}
        onSubmit={(value: string) => go.startJob(value)} />
      <Text key="access-line" color={d.permission === 'full-access' ? p.failed.text : p.dim} wrap="wrap">{`${accessLine(d.permission)}${standing ? ' · + your standing instructions' : ''}`}</Text>
      <Box key="new-next" flexDirection="row"><Button key="start" variant="primary" label="Start job" onPress={() => go.startJob()} /></Box>
      {fold(ui, p, moreId, 'More options', moreSummary(d), isFoldOpen(folds, moreId), () => go.toggleFold(moreId), () => [
        choices(ui, p, 'access', 'Access', d.permission, PERMISSION_CHOICES, (value) => go.editDraft({ permission: value })),
        d.permission === 'edit-worktree' && !d.base.trim()
          ? <Button key="uncommitted" plain label={`${d.includeUncommitted ? '☑' : '☐'} Include my uncommitted changes`} onPress={() => go.editDraft({ includeUncommitted: !d.includeUncommitted })} />
          : null,
        <Input key="ticket" label="Ticket (optional)" value={d.ticket} onInput={(v: string) => go.editDraft({ ticket: v })} onSubmit={(v: string) => go.editDraft({ ticket: v })} />,
        <Input key="base" label="Start from branch (optional)" placeholder="e.g. feat/oc-11-chapter-3" value={d.base} onInput={(v: string) => go.editDraft({ base: v })} onSubmit={(v: string) => go.editDraft({ base: v })} />,
        d.agent === 'claude'
          ? choices(ui, p, 'model', 'Model', d.model, CLAUDE_MODELS, (value) => go.editDraft({ model: value }))
          : <Input key="agent-model" label="Model (optional)" value={d.model} onInput={(v: string) => go.editDraft({ model: v })} onSubmit={(v: string) => go.editDraft({ model: v })} />,
      ].filter(Boolean))}
    </Box>
  )
}

// ---- The whole pane from plain data ----
// The terminal draws it from Podium's state; on desktop a Client draws it in the
// app's own view (the app paints a Pane's plugin redraws only on the next click).

export type PaneModel = {
  view: PaneView
  notice: string | null
  jobs: JobRecord[]
  live: Record<string, LiveInfo>
  detail: JobDetail | null
  agents: AgentRecord[]
  agentsLoaded: boolean
  settings: Record<string, any> | null
  draft: Draft
  draftAdapter: AdapterDraft | null
  palette: 'dark' | 'light'
  // Folded sections whose state differs from their default, by id.
  folds?: string[]
  // Sprint tickets waiting on the person (Your turn), across every sprint.
  turn?: { tickets: TurnTicket[]; more: number }
  askFor: AskFor
  cleared: string | null
  showAllDone: boolean
  checks: DoctorReport | null
  whatsNew: WhatsNew | null
  removing: RemovalPlan | null
  sprints?: SprintSummary[]
  board?: BoardState
  session: string | null
  acked?: string[]
  // Desktop Client presses Podium has received (it skips them if posted again).
  seen?: string[]
  // Lane jobs left out of the desktop Client's props to keep them under the bound (fitModel).
  hiddenJobs?: number
  // Of those, jobs still at work (fitModel's last resort leaves even them out).
  hiddenAtWork?: number
  // Sprints left out of the desktop Client's props (fitModel's last resort).
  hiddenSprints?: number
  // Finished sprints not sent to the desktop Client, per fold (fitModel: at most FINISHED_SPRINTS a fold are sent).
  olderSprints?: { mine: number; others: number }
  // Finished sprints `podium status --here` did not list (it sends the newest PANE_FINISHED), from either fold.
  olderFinished?: { mine: number; others: number }
  // The page of sprint cards the list shows (listPage).
  sprintPage?: number
  // On desktop, the page fitModel sent: the ids on it, and where it is in the whole list.
  sprintPaging?: SprintPaging | null
}

export function paneScreen(ui: Ui, model: PaneModel, go: FormHandlers & DetailHandlers, now: number) {
  const { Box, Text, Button } = ui
  const p = PALETTES[model.palette]
  const v = model.view
  const list = model.jobs
  const org = organise(threads(list), { session: model.session, now, clearedAt: model.cleared, showAll: model.showAllDone })
  const report = model.checks
  const fresh = model.whatsNew
  const rows = report ? checkRows(report, model.agentsLoaded ? model.agents : null) : []
  const body =
    v.screen === 'detail' && v.id ? detailScreen(ui, p, list.find((j) => j.id === v.id), model.detail, model.live[v.id], now, go, stepsFor(list, list.find((j) => j.id === v.id)), model.askFor, model.agents, model.session ?? null, model.folds ?? [], Boolean(model.checks?.gh.installed && model.checks.gh.signedIn))
    : v.screen === 'ticket' && v.id ? ticketScreen(ui, p, (model.sprints ?? []).find((s) => s.id === v.id), v.key ?? model.board?.open ?? null, model.board ?? NO_BOARD, model.agents, go, model.folds ?? [], (model.turn?.tickets ?? []).some((x) => x.sprint === v.id && x.key === (v.key ?? model.board?.open)))
    : v.screen === 'sprint' && v.id ? boardScreen(ui, p, (model.sprints ?? []).find((s) => s.id === v.id), model.board ?? NO_BOARD, go, model.folds ?? [], model.session ?? null)
    : v.screen === 'agent' && v.id ? agentScreen(ui, p, model.agents.find((a) => a.name === v.id), go, model.folds ?? [])
    : v.screen === 'add-agent' ? addAgentScreen(ui, p, model.draftAdapter, go)
    : v.screen === 'agents' ? agentsScreen(ui, p, model.agents, go, rows, model.folds ?? [])
    : v.screen === 'settings' ? settingsScreen(ui, p, model.settings, go, model.removing, model.folds ?? [])
    : v.screen === 'new' ? newJobScreen(ui, p, model.draft, model.agents, go, Boolean(String(model.settings?.instructions ?? '').trim()), model.folds ?? [])
    : listScreen(ui, p, model, org, now, go)
  return (
    <Box flexDirection="column" gap={1}>
      <Box key="header" flexDirection="row" justifyContent="space-between" alignItems="center">
        <Text bold>Podium</Text>
        <Box key="header-links" flexDirection="row" gap={1} alignItems="center">
          <Button key="link-agents" plain label="Agents" onPress={() => go.showScreen('agents')} />
          <Button key="link-settings" plain label="Settings" onPress={() => go.showScreen('settings')} />
          <Button key="new" variant="primary" label="+ New job" onPress={() => go.showScreen('new')} />
        </Box>
      </Box>
      {model.notice ? [<Text key="notice" color={p.needs.text} wrap="wrap">{model.notice}</Text>] : []}
      {model.settings?.tellClaudeWhenDone === false
        ? [
            <Box key="tell-off" flexDirection="row" gap={1}>
              <Text color={p.needs.text}>Claude isn't told when jobs finish.</Text>
              <Button key="tell-on" plain label="Turn on" onPress={() => go.setSetting('tellClaudeWhenDone', true)} />
            </Box>,
          ]
        : []}
      {fresh ? [
        <Box key="whats-new-row" flexDirection="row" gap={1}>
          <Text color={p.ok.text}>{`Updated to ${fresh.version}`}</Text>
          {fresh.notes ? <Button key="whats-new" plain label={fresh.open ? "Hide what's new" : "What's new"} onPress={() => go.toggleWhatsNew()} /> : null}
          <Button key="whats-new-close" plain label="✕" onPress={() => go.dismissWhatsNew()} />
        </Box>,
        fresh.open && fresh.notes ? <Text key="whats-new-notes" color={p.dim}>{fresh.notes}</Text> : null,
      ] : []}
      {body}
    </Box>
  )
}

// The pane, or, if a screen throws while drawing, a note saying so. A throw unmounts a desktop
// Client (a blank pane) and skips the terminal's render; the pane reopens on the same screen, so it
// would stay blank. The note shows the error and a way back to the list. Both surfaces draw through this.
export function drawPane(ui: Ui, model: PaneModel, go: FormHandlers & DetailHandlers, now: number) {
  try {
    return paneScreen(ui, model, go, now)
  } catch (err) {
    return drawFailed(ui, model, go, 'Something on this screen went wrong.', String((err as Error | null)?.message ?? err), !isListView(model.view))
  }
}

// Whether a view draws the list (paneScreen's fallback): Back leads there, so a note on it offers no Back.
export function isListView(v: PaneModel['view']) {
  return !((['detail', 'sprint', 'ticket', 'agent'].includes(v.screen) && v.id) || ['agents', 'add-agent', 'settings', 'new'].includes(v.screen))
}

// The note drawn in place of a screen that can't be drawn: what happened in plain words, the technical reason dim
// below it, and Back to the list (which also closes the board's open row, picker and question: reopening the same
// board keeps them, and could lead straight back here). The desktop Client also draws it in place of a tree the page
// would refuse (hooks/client/app.tsx); when that screen is the list itself (and even its short list can't be drawn),
// there is nothing to go back to, so the note has no Back (it would lead to the same note, a loop).
export function drawFailed(ui: Ui, model: PaneModel, go: FormHandlers & DetailHandlers, plain: string, why: string, canGoBack = true) {
  const { Box, Text, Button } = ui
  const p = PALETTES[model.palette] ?? PALETTES.dark
  return (
    <Box flexDirection="column" gap={1}>
      <Text key="draw-failed" bold wrap="wrap">{plain}</Text>
      <Text key="draw-failed-why" color={p.dim} wrap="wrap">{why.length > 300 ? `${why.slice(0, 299)}…` : why}</Text>
      {canGoBack
        ? <Box key="draw-failed-row" flexDirection="row">
            <Button key="draw-failed-back" variant="primary" label="Back to the list" onPress={() => go.backToList()} />
          </Box>
        : <Text key="draw-failed-ask" wrap="wrap">Ask Claude about your jobs and sprints.</Text>}
    </Box>
  )
}

// Every action the pane can call, by name: the desktop Client posts these to Podium.
// tests/handler-names.test.js checks it against actions() in register.tsx.
export const HANDLER_NAMES = [
  'openDetail', 'showScreen', 'act', 'rate', 'toggleFull', 'clearDone', 'toggleShowAll',
  'askOpen', 'askEdit', 'askSend', 'askCancel', 'askRepair', 'repair', 'askClaude', 'toggleFile',
  'fullDiff', 'setSetting', 'toggleSetting', 'toggleAgent', 'testAgent', 'suggestAgent', 'editAdapter', 'saveAgent',
  'cancelAgent', 'editDraft', 'startJob', 'prune', 'tryIt', 'openPr', 'pushPr', 'toggleAutoMerge',
  'watchAgain', 'postReview', 'reviewOpen', 'fixOpen', 'setInstructions', 'setRepoInstructions', 'setRepoSetting', 'gotIt', 'toggleWhatsNew',
  'dismissWhatsNew', 'checkAgain', 'planRemoval', 'confirmRemoval', 'cancelRemoval',
  'openBoard', 'showSprints', 'sprintAct', 'askConfirm', 'setSprintOptions',
  'openTicket', 'openPicker', 'moveTicket', 'removeTicket', 'assignTicket', 'assignTask', 'retryTicket', 'stopTicket',
  'backToList', 'approvePlan', 'revisePlan', 'editNote', 'setAfter', 'takeSprintNews',
  'toggleFold', 'confirmJob', 'openAgent', 'browsePr',
] as const
