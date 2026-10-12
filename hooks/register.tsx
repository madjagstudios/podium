// Podium's hooks module. The mod engine follows `$` only into functions
// declared in this file and reads $.state references only where they are
// declared, so every action and atom lives here; hooks/screens.tsx is pure
// drawing that receives plain data and closures.
import { atom, read, update } from 'claude-code'
import type { Engine, Register } from 'claude-code'
import { callEngine } from '../mod/engine.js'
import { handOver, sprintNewsPass, keepFresh } from '../mod/delivery.js'
import { parseCommand } from '../mod/commands.js'
import { TOOLS, engineCall, formatToolResult } from '../mod/tools.js'
import { agentLabel, organise, threads, sprintNewsHeadline, sprintNewsNotes, foldsLeaving, startedNotice } from '../mod/view.js'
import { askText, isPrEvent, finishedHeadline, finishedMessage, jobLine, shortSummary, summaryPrompt, newlyFinished, paletteName, parseLive, same, statusText } from '../mod/view.js'
import type { AdapterDraft, AgentRecord, AskForm, BoardState, DoctorReport, Draft, JobDetail, JobOpen, JobRecord, LiveInfo, PaneView, RemovalPlan, SprintSummary, WhatsNew } from '../types'
import { PANE, NOTE_CHARS, FOLDS_KEPT } from './state'
import { drawPane, NO_BOARD } from './screens'
import type { PaneModel } from './screens'
import { slimJob, slimSprints, keepBusy, keepShown, fitModel, turnTickets } from '../mod/client.js'
import { jobOpenNext, askOf, withQuestion } from '../mod/jobopen.js'

const TOOL_PREFIX = 'mcp__podium__'

const jobs = atom({ plugin: 'podium', key: 'jobs' } as const, [] as JobRecord[])
const view = atom({ plugin: 'podium', key: 'view' } as const, { screen: 'list', id: null } as PaneView)
const notice = atom({ plugin: 'podium', key: 'notice' } as const, null as string | null)
const detail = atom({ plugin: 'podium', key: 'detail' } as const, null as JobDetail | null)
const agents = atom({ plugin: 'podium', key: 'agents' } as const, [] as AgentRecord[])
const settings = atom({ plugin: 'podium', key: 'settings' } as const, null as Record<string, unknown> | null)
const draft = atom({ plugin: 'podium', key: 'draft' } as const, { agent: 'codex', task: '', permission: 'edit-worktree', includeUncommitted: false, model: '', ticket: '', base: '' } as Draft)
const draftAdapter = atom({ plugin: 'podium', key: 'draftAdapter' } as const, null as AdapterDraft | null)
const live = atom({ plugin: 'podium', key: 'live' } as const, {} as Record<string, LiveInfo>)
const palette = atom({ plugin: 'podium', key: 'palette' } as const, 'dark' as 'dark' | 'light')
// Bumped every 10 s while jobs run, so elapsed and 'quiet for' text move even when no data changed.
const beat = atom({ plugin: 'podium', key: 'beat' } as const, 0)
// What a job's screen has open (see mod/jobopen.js), changed only through jobOpenNext.
const jobOpen = atom({ plugin: 'podium', key: 'jobOpen' } as const, null as JobOpen)
const moveOpen = ($: Engine, action: Record<string, unknown>) => update($, jobOpen, (cur) => jobOpenNext(cur, action) as JobOpen)
// When this chat last pressed Clear (ISO time), and whether Done shows everything.
const cleared = atom({ plugin: 'podium', key: 'cleared' } as const, null as string | null)
const showAllDone = atom({ plugin: 'podium', key: 'showAllDone' } as const, false)
// First-run checks, the update notice and a pending removal.
const checks = atom({ plugin: 'podium', key: 'checks' } as const, null as DoctorReport | null)
const whatsNew = atom({ plugin: 'podium', key: 'whatsNew' } as const, null as WhatsNew | null)
const removing = atom({ plugin: 'podium', key: 'removing' } as const, null as RemovalPlan | null)
const agentsLoaded = atom({ plugin: 'podium', key: 'agentsLoaded' } as const, false)
const sprints = atom({ plugin: 'podium', key: 'sprints' } as const, [] as SprintSummary[])
// Finished sprints `podium status --here` did not list (it sends the newest finished ones).
const olderFinished = atom({ plugin: 'podium', key: 'olderFinished' } as const, { mine: 0, others: 0 } as { mine: number; others: number })
// The board's pane state: which sprint, its open row, what asks to be confirmed, and
// which writer/reviewer picker is open ("<KEY>:<n>" or "<KEY>:all"; one at a time).
const board = atom({ plugin: 'podium', key: 'board' } as const, { sprint: null, open: null, confirm: null, picking: null } as BoardState)
// Which page of sprint cards the list shows (the list draws its sprints a page at a time, listPage).
const sprintPage = atom({ plugin: 'podium', key: 'sprintPage' } as const, 0)
// Folded sections whose state differs from their default, by id ("job:<id>:changes", "list:done"…).
const folds = atom({ plugin: 'podium', key: 'folds' } as const, [] as string[])

type Answer = { ok: true; value: any } | { ok: false; error: { code: string; message: string } }

// Module state that may be lost on a hot reload without harm.
let inflight: Promise<void> | null = null
// When the pane last made sure the PR watcher runs.
let lastWatchCheck = 0
// When the pane last made sure sprint runners run.
let lastSprintCheck = 0
// Ids of desktop Client actions that have finished.
const acked: string[] = []
// Ids of desktop Client presses received; a press is posted again until it shows here.
const seen: string[] = []
// Client presses run in order (an edit lands before the Start it feeds); see ui.message.
let clientWork: Promise<unknown> = Promise.resolve()
let anyWorking = false
let ticks = 0
const delivering = new Set<string>()
// Sprint news whose headline went in but whose delivered mark is not confirmed yet.
const announcedNews = new Set<string>()
// Sprint news being sent right now: a later pass that claims it again skips it.
const newsInFlight = new Set<string>()
// A news pass is running: sprintNewsPass runs one at a time, so a pass waiting on a busy turn is never joined by another.
const newsBusy = { on: false }
// The delivery lock goes stale after a minute; its holder refreshes it this often while its submit waits.
const LOCK_REFRESH_MS = 20_000
// Set inside agent runs Podium itself started (PODIUM_JOB_ID): the mod then does nothing.
let inert = false
// This session's id: dispatches record it so this session gets their messages first.
let sessionId: string | null = null

// Everything the pane draws, as plain data: the terminal draws it, the desktop Client receives it.
async function paneModel($: Engine): Promise<PaneModel> {
  const open = await read($, board)
  const asking = await read($, jobOpen)
  return {
    view: await read($, view), notice: await read($, notice),
    jobs: (await read($, jobs)).map((j) => slimJob(j) as JobRecord), live: await read($, live), detail: withQuestion(await read($, detail), asking) as JobDetail | null,
    agents: await read($, agents), agentsLoaded: await read($, agentsLoaded), settings: await read($, settings),
    draft: await read($, draft), draftAdapter: await read($, draftAdapter), palette: await read($, palette),
    askFor: askOf(asking) as AskForm, cleared: await read($, cleared),
    showAllDone: await read($, showAllDone), checks: await read($, checks), whatsNew: await read($, whatsNew),
    removing: await read($, removing), sprints: slimSprints(await read($, sprints), open) as SprintSummary[], session: sessionId, acked: acked.slice(-50), seen: seen.slice(-100),
    board: open, sprintPage: await read($, sprintPage), olderFinished: await read($, olderFinished),
    folds: await read($, folds), turn: turnTickets(await read($, sprints)),
  }
}

async function chatId($: Engine): Promise<string | null> {
  sessionId ??= await $.session.id().catch(() => null)
  return sessionId
}

async function sessionArgs($: Engine): Promise<string[]> {
  const id = await chatId($)
  return id ? ['--session', id] : []
}

// The list as this chat sees it. It uses the id openPane and refresh
// read beforehand: asked for from inside drawing, it came back empty in the kit.
async function organised($: Engine, list: JobRecord[]) {
  return organise(threads(list), { session: sessionId, now: Date.now(), clearedAt: await read($, cleared), showAll: await read($, showAllDone) })
}

// Background work must never leave an unhandled rejection (a hot reload or a
// closed session can pull state out from under it).
function quietly(work: Promise<unknown>) {
  work.catch(() => {})
}

function engine($: Engine, args: string[], stdin?: string): Promise<Answer> {
  return callEngine((argv: readonly string[], init: object) => $.process.run(argv, init), $.plugin.root, args, { stdin })
}

async function say($: Engine, message: string | null) {
  await update($, notice, () => message)
}

// The sprint the open screen shows: a board's, a ticket's, or a sprint step's (its Back leads to the ticket).
async function shownSprintId($: Engine): Promise<string | null> {
  const shown = await read($, view)
  if ((shown.screen === 'sprint' || shown.screen === 'ticket') && shown.id) return String(shown.id)
  const step = shown.screen === 'detail' && shown.id ? (await read($, jobs)).find((j) => j.id === shown.id) : null
  return step?.sprint?.id ?? null
}

// Reads the job list. Finished jobs are only noted here: delivery submits a
// prompt, which the host refuses from inside a command or tool call (it would
// wait on the turn that call holds), so it runs from the timer and turn.complete.
function refresh($: Engine): Promise<void> {
  inflight ??= (async () => {
    try {
      // This chat's id, read here (never while drawing), so the engine picks this chat's finished sprints apart from others';
      // and the sprint the open board or ticket shows, so it stays listed when it archives behind newer finished ones.
      // A sprint step's own screen counts too: its Back leads to the ticket, which must still be listed.
      const shownSprint = await shownSprintId($)
      const open = shownSprint ? ['--sprint', String(shownSprint)] : []
      const r = await engine($, ['status', '--here', ...(await sessionArgs($)), ...open])
      if (!r.ok) { await say($, r.error.message); return }
      const list: JobRecord[] = r.value.jobs
      anyWorking = list.some((j) => j.status === 'queued' || j.status === 'running')
      if (list.some((j) => j.status === 'in-review') && Date.now() - lastWatchCheck > 60_000) {
        lastWatchCheck = Date.now()
        quietly(engine($, ['pr', 'watch']))
      }
      // Sprints: drawn from the same call; keep their runners alive.
      // A sprint the engine could not read just now keeps its last view (a busy marker never reaches the atom).
      const lastSprints = await read($, sprints)
      // The screen may have changed while the call ran: the sprint it shows now keeps its last view if the answer
      // left it out, so its Back never lands on "no longer listed"; the next refresh names it. One this call named and the
      // engine still left out is really gone (discarded, or not this repo's), so it is not kept.
      const nowShown = await shownSprintId($)
      const sprintList = keepShown(lastSprints, keepBusy(lastSprints, r.value.sprints ?? []), nowShown !== shownSprint ? nowShown : null) as SprintSummary[]
      if (JSON.stringify(sprintList) !== JSON.stringify(lastSprints)) await update($, sprints, () => sprintList)
      const of = r.value.olderFinished ?? {}
      const older = { mine: Number(of.mine) || 0, others: Number(of.others) || 0 }
      if (!same(older, await read($, olderFinished))) await update($, olderFinished, () => older)
      // A finished sprint listed though archived needs no runner.
      if (sprintList.some((s) => !s.finishedAt && !s.draft && !s.unreadable && !s.archived) && Date.now() - lastSprintCheck > 60_000) {
        lastSprintCheck = Date.now()
        quietly(engine($, ['sprint', 'ensure']))
      }
      if (!same(list, await read($, jobs))) await update($, jobs, () => list)
      const org = await organised($, list)
      $.ui.status(statusText([...org.needs, ...org.working].map((t) => t.latest)))
    } finally {
      inflight = null
    }
  })()
  return inflight
}

async function readLive($: Engine) {
  const running = (await read($, jobs)).filter((j) => j.liveFile)
  const next: Record<string, LiveInfo> = {}
  for (const j of running) {
    const text = await $.fs.read(j.liveFile as string).catch(() => '')
    const info = parseLive(typeof text === 'string' ? text : '')
    if (info) next[j.id] = info
  }
  if (!same(next, await read($, live))) await update($, live, () => next)
}

async function loadLook($: Engine) {
  const rows = await $.config.list().catch(() => [])
  const theme = rows.find((row: { key: string }) => row.key === 'theme')
  const name = paletteName(theme ? String(theme.value) : undefined) as 'dark' | 'light'
  if (name !== (await read($, palette))) await update($, palette, () => name)
  const id = await chatId($)
  const clears = await $.store.get('cleared').catch(() => undefined)
  const mine = id && clears && typeof clears === 'object' ? ((clears as Record<string, string>)[id] ?? null) : null
  if (mine !== (await read($, cleared))) await update($, cleared, () => mine)
}

// Clear hides Done up to now, for this chat only; entries older than the
// engine keeps jobs (90 days) are dropped as we go.
async function clearDone($: Engine) {
  const at = new Date().toISOString()
  await update($, cleared, () => at)
  await update($, showAllDone, () => false)
  const id = await chatId($)
  if (!id) return
  const saved = await $.store.get('cleared').catch(() => undefined)
  const all: Record<string, string> = saved && typeof saved === 'object' ? { ...(saved as Record<string, string>) } : {}
  const cutoff = Date.now() - 90 * 86_400_000
  for (const [key, value] of Object.entries(all)) if (!(Date.parse(value) >= cutoff)) delete all[key]
  all[id] = at
  await $.store.set('cleared', all).catch(() => {})
}

async function deliverFinished($: Engine) {
  await refresh($)
  for (const job of newlyFinished(await read($, jobs))) await deliver($, job)
  await deliverSprintNews($)
}

// Sprint news: plans, parked tickets and finished sprints, batched into one
// message. Claim → submit → mark, like jobs; a claim never confirmed expires in 2 minutes.
// News announced whose mark failed waits in `announcedNews` and is never announced twice (sprintNewsPass).
// One pass at a time: a pass that finds one running returns at once (newsBusy, held by sprintNewsPass).
async function deliverSprintNews($: Engine) {
  const session = (await sessionArgs($))[1]
  type News = { id: string; sprint: string; text: string }
  await sprintNewsPass({
    busy: newsBusy,
    announced: announcedNews,
    inFlight: newsInFlight,
    // Only when a sprint this chat may take news for has some (its own, or one with no chat): most refreshes ask
    // nothing, and a sprint whose chat is gone never keeps every other chat asking. A finished sprint listed though archived
    // has no news and is never polled for it.
    hasNews: async () => Boolean(session) && (await read($, sprints)).some((s) => !s.archived && s.news > 0 && (!s.chat || s.chat === session)),
    claim: async () => {
      const r = await engine($, ['sprint', 'inbox', '--session', session as string, '--here'])
      return r.ok ? r.value.messages : []
    },
    tellClaude: async () => {
      const s = await engine($, ['settings'])
      return !s.ok || s.value.tellClaudeWhenDone !== false
    },
    // Details first as a hidden row; if that fails they ride in the visible message. If the submit
    // fails, nothing is marked: the claim expires and it is tried again.
    send: (list: News[]) => handOver({
      append: () => $.session.append({ message: { type: 'user', content: [{ type: 'text', text: sprintNewsNotes(list) }] } } as any),
      headline: sprintNewsHeadline(list),
      details: sprintNewsNotes(list, true), // visible variant: only used if the hidden row fails
      submit: (text: string) => $.prompt.submit({ text }),
    }),
    toast: (list: News[]) => $.ui.toast(sprintNewsHeadline(list)),
    mark: async (ids: string[]) => {
      const r = await engine($, ['sprint', 'delivered', '--ids', ids.join(',')])
      return r.ok ? { failed: r.value.failed ?? [] } : null
    },
  })
}

async function summarise($: Engine, job: JobRecord): Promise<string | null> {
  const full = await engine($, ['result', '--id', job.id, '--full'])
  const output: string | null = full.ok ? full.value.output : null
  if (!output || !output.trim()) return null
  const short = shortSummary(output)
  if (short) {
    // Saved like a model summary, so the pane and podium_result show it too.
    await engine($, ['summary', '--id', job.id, '--text', '-'], short)
    return short
  }
  const r = await $.model.complete({ model: 'haiku', effort: 'low', maxTokens: 400, prompt: summaryPrompt(output) })
  if (!r.isAnswered || !r.text.trim()) return null
  await engine($, ['summary', '--id', job.id, '--text', '-'], r.text.trim())
  return r.text.trim()
}

// Claim → summary → submit → mark delivered. Marking only after the message
// is in means a reload, a refused prompt or an error leaves the job to be retried;
// the engine's claim stops two sessions (or two reloads) delivering it twice.
async function deliver($: Engine, job: JobRecord) {
  if (delivering.has(job.id)) return
  delivering.add(job.id)
  try {
    const me = (await sessionArgs($))[1] ?? 'unknown'
    const claim = await engine($, ['claim', '--id', job.id, '--session', me])
    if (!claim.ok || !claim.value.claimed) return
    // The lock is refreshed from right after the claim until the delivery settles (the summary Haiku
    // writes is covered too, and there is no cap): a submit waiting behind a busy turn never lets it go stale for another
    // chat to take. A refresh answering refreshed:false (another chat took a stale lock) is accepted: the pending submit
    // can't be withdrawn. keepFresh awaits a refresh in flight before it returns, so none lands after the release below.
    const { tell, ok } = await keepFresh(async () => {
      const res = await engine($, ['result', '--id', job.id])
      const summary: string | null = isPrEvent(job) ? null : (res.ok && res.value.summary) || (await summarise($, job))
      const s = await engine($, ['settings'])
      const tell = !s.ok || s.value.tellClaudeWhenDone !== false
      if (!tell) return { tell, ok: true }
      // The details go in first as a row the person doesn't see but Claude reads;
      // the visible message is one line. (Catching our own prompt in a prompt.submit
      // hook only worked in the kit: in the app the notes never arrived.) If the hidden row
      // cannot be added, the details ride in the visible message. A failed submit releases the
      // job to be tried again, never marked with Claude missing the report.
      const ok = await handOver({
        append: () => $.session.append({ message: { type: 'user', content: [{ type: 'text', text: finishedMessage(job, summary) }] } } as any),
        headline: finishedHeadline(job),
        details: finishedMessage(job, summary, true), // visible variant: only used if the hidden row fails
        submit: (text: string) => $.prompt.submit({ text }),
      })
      return { tell, ok }
    }, {
      sleep: () => $.clock.sleep(LOCK_REFRESH_MS),
      refresh: () => engine($, ['claim', '--id', job.id, '--session', me, '--refresh']),
    })
    if (!ok) {
      await engine($, ['release', '--id', job.id])
      return
    }
    await engine($, ['deliver', '--id', job.id])
    // The chat line is the notice: a pop-up only when Claude is not told.
    if (!tell) {
      const line = jobLine(job)
      $.ui.toast(`${line.icon} ${line.who}: ${line.what}`)
    }
    await say($, null)
  } finally {
    delivering.delete(job.id)
  }
}

async function repairSandbox($: Engine, id: string) {
  await moveOpen($, { type: 'repair', id, on: false })
  const r = await engine($, ['repair', '--what', 'muse-sandbox'])
  if (!r.ok) { await say($, r.error.message); return }
  await say($, r.value.repaired
    ? `Repaired: removed ${r.value.removed} piled-up entries. Muse's sandbox should work now; run the job again.`
    : r.value.reason === 'nothing-to-repair' ? "Nothing to repair: Muse's sandbox folder looks healthy." : "Podium can only repair this on Windows.")
}

async function loadAgents($: Engine) {
  const r = await engine($, ['agents'])
  if (r.ok) await update($, agents, () => r.value.agents)
  if (r.ok) await update($, agentsLoaded, () => true)
  else await say($, r.error.message)
}

// The settings, and the project this chat is in (`here`), which Settings → This repo reads.
async function loadSettings($: Engine) {
  const [r, here] = await Promise.all([engine($, ['settings']), engine($, ['here'])])
  if (r.ok) await update($, settings, () => ({ ...r.value, here: here.ok ? String(here.value.project) : null }))
  else await say($, r.error.message)
}

async function showScreen($: Engine, screen: PaneView['screen'], id: string | null = null) {
  await update($, view, () => ({ screen, id }))
  if (screen !== 'list') await say($, null)
  if (['agents', 'agent', 'add-agent', 'new'].includes(screen)) quietly(loadAgents($))
  if (screen === 'settings') quietly(loadSettings($))
}

async function openDetail($: Engine, id: string) {
  await showScreen($, 'detail', id)
  const job = (await read($, jobs)).find((j) => j.id === id)
  const r = await engine($, ['result', '--id', id])
  // A sprint step's diff is read even after its checkpoint: Steps and diff shows it.
  const c = job && (job.hasChanges || job.status === 'needs-review' || job.sprint) ? await engine($, ['changes', '--id', id]) : null
  const changeSet = c && c.ok ? c.value : null
  // A screen (re)opened starts with no question open, as when the question lived on its detail.
  await moveOpen($, { type: 'screenOpened' })
  await update($, detail, () => ({
    id,
    summary: r.ok ? r.value.summary : null,
    output: null,
    changes: changeSet,
    open: changeSet && changeSet.files.length === 1 ? [changeSet.files[0].path] : [],
  }))
}

// The board: one sprint. Opening the same board again (Back from Steps and diff) keeps
// its open row; another sprint's board starts with every row closed.
async function openBoard($: Engine, id: string) {
  await update($, board, (cur) => (cur.sprint === id ? { ...cur, confirm: null, picking: null } : { sprint: id, open: null, confirm: null, picking: null, note: '' }))
  await showScreen($, 'sprint', id)
  quietly(loadAgents($))
}

// A ticket's own screen. The board's state names the ticket (open), so its plan's tasks are sent (slimSprints);
// its notes for the plan stay if it is the same ticket.
async function openTicket($: Engine, id: string, key: string | null) {
  if (!key) { await openBoard($, id); return }
  await update($, board, (cur) => ({ sprint: id, open: key, confirm: null, picking: null, note: cur.sprint === id && cur.open === key ? cur.note ?? '' : '' }))
  await update($, view, () => ({ screen: 'ticket' as const, id, key }))
  await say($, null)
  quietly(loadAgents($))
}

async function backToList($: Engine) {
  // The couldn't-draw note's Back: the screen it leaves also loses its open folds, so it does not reopen the same way.
  const leaving = await read($, view)
  await update($, folds, (cur) => foldsLeaving(cur, leaving))
  await update($, board, () => NO_BOARD)
  await showScreen($, 'list')
}

// A sprint change from the pane: one engine call, its answer as the notice, then the board redraws.
// A repeat of the same press while it runs is ignored (Start checks git and takes a moment).
const sprintBusy = new Set<string>()

// done: the notice once it worked, or a function that makes it from the engine's reply.
async function sprintCall($: Engine, args: string[], done: string | null | ((value: any) => string | null) = null, stdin?: string): Promise<boolean> {
  const key = `${args.join(' ')}\n${stdin ?? ''}`
  if (sprintBusy.has(key)) return false
  sprintBusy.add(key)
  try {
    const r = await engine($, ['sprint', ...args], stdin)
    await say($, r.ok ? (typeof done === 'function' ? done(r.value) : done) : r.error.message)
    // A refresh already running may have read the board before this change, and refresh() hands that one
    // back: let it finish, then read again, so the board never shows the old state after a press.
    if (inflight) await inflight.catch(() => {})
    await refresh($)
    return r.ok
  } finally {
    sprintBusy.delete(key)
  }
}

// Sprint changes from the pane run strictly in order per sprint: each waits for the one before it to
// finish, however long that takes, so Start never overtakes an edit pressed before it. Each press joins its
// sprint's line when it arrives; the same press made again while its twin still waits or runs is dropped.
const sprintLines = new Map<string, { tail: Promise<unknown>; last: string | null }>()

function inSprintOrder(id: string, press: string, work: () => Promise<unknown>): Promise<unknown> {
  const line = sprintLines.get(id) ?? { tail: Promise.resolve(), last: null }
  if (line.last === press) return line.tail
  const run = line.tail.catch(() => {}).then(work)
  const entry = { tail: run, last: press }
  sprintLines.set(id, entry)
  const clear = () => { if (sprintLines.get(id) === entry) sprintLines.delete(id) }
  run.then(clear, clear)
  return run
}

// The pane's sprint changes, and where each names its sprint (the rest are not sprint changes).
const SPRINT_CHANGES: Record<string, (args: unknown[]) => unknown> = {
  sprintAct: (args) => args[1], setSprintOptions: (args) => args[0], moveTicket: (args) => args[0],
  removeTicket: (args) => args[0], assignTicket: (args) => args[0], assignTask: (args) => args[0],
  retryTicket: (args) => args[0], stopTicket: (args) => args[0],
  approvePlan: (args) => args[0], revisePlan: (args) => args[0], setAfter: (args) => args[0],
  takeSprintNews: (args) => args[0],
}

// "Take them here": a sprint whose chat is gone moves to this chat, so its waiting news (and its PR news) comes here;
// the next news pass delivers it.
async function takeSprintNews($: Engine, id: string) {
  const session = await chatId($)
  if (!session) {
    await say($, "Podium doesn't know this chat yet. Try again in a moment.")
    return false
  }
  return sprintCall($, ['adopt', '--id', id, '--session', session, '--here'], "This sprint's updates come to this chat now.")
}

const SPRINT_DONE = {
  start: 'Started.',
  discard: 'Draft discarded.',
  pause: 'Paused. Steps already running finish.',
  resume: null,
} as const

async function sprintAct($: Engine, verb: 'start' | 'discard' | 'pause' | 'resume', id: string) {
  await update($, board, (cur) => ({ ...cur, confirm: null }))
  // Start says what it saved for the repo from the draft's proposal.
  const ok = await sprintCall($, [verb, '--id', id], verb === 'start' ? (v) => startedNotice(v?.applied) : SPRINT_DONE[verb])
  // A discarded draft has no board left to show; the list keeps the notice. Another sprint's board stays.
  const shown = await read($, view)
  if (ok && verb === 'discard' && shown.screen === 'sprint' && shown.id === id) await showScreen($, 'list')
}

// A writer or reviewer pick on the board: the picker closes, then the same engine call as ever.
async function assignAct($: Engine, args: string[]) {
  await update($, board, (cur) => ({ ...cur, picking: null }))
  await sprintCall($, ['assign', ...args])
}

// Stop ends a ticket: the board asked first; the answer clears the question.
async function stopTicketAct($: Engine, id: string, key: string) {
  await update($, board, (cur) => ({ ...cur, confirm: null }))
  await sprintCall($, ['stop', '--id', id, '--ticket', key], `${key} stopped.`)
}

// Ask for changes to a plan: the notes go to its writer; the form closes once Podium has them, and
// stays with the notes if it refused. The press carries the notes as they were when Send was pressed: a Send
// may wait behind other changes in its sprint, and by the time it runs the board may show another ticket's notes. So
// the clean-up closes the form only if it still holds this note (same sprint, ticket and words), or none (Enter can send
// words the board never kept).
async function revisePlanAct($: Engine, id: string, key: string, typed?: string) {
  const text = (typed ?? (await read($, board)).note ?? '').slice(0, NOTE_CHARS).trim()
  if (!text) { await say($, 'Say what should change in the plan first.'); return }
  const ok = await sprintCall($, ['revise', '--id', id, '--ticket', key, '--text', '-'], `${key}'s plan goes back with your notes.`, text)
  const same = (cur: BoardState) => cur.sprint === id && cur.confirm === `revise:${key}` && ['', text].includes((cur.note ?? '').trim())
  if (ok) await update($, board, (cur) => (same(cur) ? { ...cur, confirm: null, note: '' } : cur))
}

// Notes typed for a plan: kept to the engine's length (it cuts them too), which also keeps them within the pane's props.
async function editNote($: Engine, id: string, text: string) {
  const typed = String(text ?? '')
  const note = typed.slice(0, NOTE_CHARS)
  await update($, board, (cur) => (cur.sprint === id ? { ...cur, note } : cur))
  if (typed.length > NOTE_CHARS) await say($, `Your notes were cut to ${NOTE_CHARS.toLocaleString('en-US')} characters.`)
}

async function toggleFull($: Engine, id: string) {
  const current = await read($, detail)
  if (current && current.id === id && current.output) {
    await update($, detail, () => ({ ...current, output: null }))
    return
  }
  const r = await engine($, ['result', '--id', id, '--full'])
  const reply = r.ok ? (r.value.output ?? 'No output was saved.') : r.error.message
  const log = r.ok && r.value.log ? String(r.value.log).trim() : ''
  const output = log ? `${reply.trim()}\n\n── Activity log ──\n${log.slice(-6000)}` : reply
  await update($, detail, (cur) => (cur && cur.id === id ? { ...cur, output: output.slice(-8000) } : { id, summary: null, output: output.slice(-8000), changes: null, open: [] }))
}

async function toggleFile($: Engine, id: string, file: string) {
  await update($, detail, (cur) => (cur && cur.id === id
    ? { ...cur, open: cur.open.includes(file) ? cur.open.filter((f) => f !== file) : [...cur.open, file] }
    : cur))
}

async function fullDiff($: Engine, id: string) {
  const c = await engine($, ['changes', '--id', id, '--full'])
  if (c.ok) await update($, detail, (cur) => (cur && cur.id === id ? { ...cur, changes: c.value } : cur))
}

async function askClaude($: Engine, id: string) {
  const job = (await read($, jobs)).find((j) => j.id === id)
  if (!job) return
  const info = (await read($, live))[id] ?? null
  await $.prompt.fill({ text: askText(job, info, Date.now()), mode: 'replace' })
}

async function act($: Engine, verb: 'cancel' | 'keep' | 'discard', id: string) {
  await moveOpen($, { type: 'confirm', id, what: null })
  const r = await engine($, [verb, '--id', id])
  await say($, r.ok ? null : r.error.message)
  await refresh($)
}

async function rate($: Engine, id: string, value: 'used' | 'discarded') {
  const r = await engine($, ['outcome', '--id', id, '--value', value])
  await say($, r.ok ? null : r.error.message)
  await refresh($)
}

async function setSetting($: Engine, key: string, value: unknown, saved: string | null = null) {
  const r = await engine($, ['settings', 'set', '--key', key, '--value', JSON.stringify(value)])
  if (r.ok) await update($, settings, (cur) => ({ ...r.value, here: cur?.here ?? null }))
  await say($, r.ok ? saved : r.error.message)
  await loadAgents($)
}

async function toggleSetting($: Engine, key: string) {
  const s = (await read($, settings)) ?? {}
  await setSetting($, key, !s[key])
}

async function toggleAgent($: Engine, name: string) {
  const s = ((await read($, settings)) ?? {}) as { disabledAgents?: string[] }
  const off = new Set(s.disabledAgents ?? [])
  if (off.has(name)) off.delete(name)
  else off.add(name)
  await setSetting($, 'disabledAgents', [...off])
}

async function testAgent($: Engine, name: string) {
  await say($, `Testing ${name}…`)
  const r = await engine($, ['adapter', 'test', '--name', name])
  if (!r.ok) { await say($, r.error.message); return }
  const t = r.value
  const why = String(t.stderr || t.output || (t.errors ?? []).join(' ')).trim().slice(0, 200)
  await say($, t.ok ? `${name} works (${(t.ms / 1000).toFixed(1)}s).` : `${name} did not pass the test. ${why}`)
}

async function suggestAgent($: Engine, command: string) {
  if (!command) return
  const r = await engine($, ['adapter', 'suggest', '--command', command])
  if (!r.ok) { await say($, r.error.message); return }
  await update($, draftAdapter, () => r.value.adapter)
  await say($, `Filled in from "${command} --help". Check each field, then Save and test.`)
}

async function saveAgent($: Engine) {
  const pending = await read($, draftAdapter)
  if (!pending) return
  const r = await engine($, ['adapter', 'save', '--json', '-'], JSON.stringify(pending))
  if (!r.ok) { await say($, r.error.message); return }
  await update($, draftAdapter, () => null)
  // The new agent is loaded before its screen opens (it would say "not listed" until then); one load, not showScreen's too.
  await loadAgents($)
  await update($, view, () => ({ screen: 'agent' as const, id: pending.name }))
  await say($, null)
  await testAgent($, pending.name)
}

async function startJob($: Engine, task?: string) {
  const d = await read($, draft)
  const text = task ?? d.task
  if (!text.trim()) { await say($, 'Describe the task first.'); return }
  const args = ['dispatch', '--agent', d.agent, '--permission', d.permission,
    ...(d.includeUncommitted && d.permission === 'edit-worktree' ? ['--include-uncommitted'] : []),
    ...(d.model ? ['--model', d.model] : []),
    ...(d.ticket.trim() ? ['--ticket', d.ticket.trim()] : []),
    ...(d.base.trim() ? ['--base', d.base.trim()] : []),
    ...(await sessionArgs($)),
    '--prompt', '-']
  const r = await engine($, args, text)
  if (!r.ok) { await update($, draft, (cur) => ({ ...cur, task: text })); await say($, r.error.message); return }
  await update($, draft, (cur) => ({ ...cur, task: '' }))
  await say($, ['Started.', ...r.value.warnings.map((w: { message: string }) => w.message)].join(' '))
  await showScreen($, 'list')
  await refresh($)
}

async function startFollowUp($: Engine, latestId: string, typed?: string) {
  const form = askOf(await read($, jobOpen)) as AskForm
  if (!form) return
  const task = (typed ?? form.task).trim()
  if (!task && form.mode !== 'review') { await say($, 'Say what should change first.'); return }
  const r = form.mode === 'review'
    ? await engine($, ['dispatch', '--pr', String(form.number), '--agent', form.agent, ...(await sessionArgs($)), '--prompt', '-'], task)
    : await engine($, ['dispatch', '--follow-up', latestId, '--agent', form.agent, ...(await sessionArgs($)), '--prompt', '-'], task)
  if (!r.ok) { await say($, r.error.message); return }
  await moveOpen($, { type: 'askClose' })
  await say($, null)
  await refresh($)
}

// PR actions take seconds (git push, gh): say so at once, and ignore repeat presses meanwhile.
const prBusy = new Set<string>()

async function prAction($: Engine, args: string[], done: string | null = null, working: string | null = null) {
  const key = args.join(' ')
  if (prBusy.has(key)) return
  prBusy.add(key)
  try {
    if (working) await say($, working)
    const r = await engine($, ['pr', ...args])
    await say($, r.ok ? done : r.error.message)
    await refresh($)
  } finally {
    prBusy.delete(key)
  }
}

async function fixOpen($: Engine, threadId: string, latestId: string, agent: string, kind: 'ci' | 'comments') {
  await openDetail($, latestId)
  const r = await engine($, ['pr', 'fix', '--id', latestId, '--kind', kind])
  if (!r.ok) { await say($, r.error.message); return }
  await openAsk($, { threadId, agent, task: String(r.value.text), mode: 'change' as const })
}

async function openAsk($: Engine, form: NonNullable<AskForm>) {
  await moveOpen($, { type: 'ask', form })
}

async function jobQuestion($: Engine, which: 'confirm' | 'repair', id: string, value: 'discard' | 'cancel' | boolean | null) {
  await moveOpen($, which === 'confirm' ? { type: 'confirm', id, what: value || null } : { type: 'repair', id, on: Boolean(value) })
}

async function setRepoInstructions($: Engine, text: string) {
  const here = await engine($, ['here'])
  if (!here.ok) { await say($, here.error.message); return }
  const cur = ((await read($, settings))?.repoInstructions ?? {}) as Record<string, string>
  await setSetting($, 'repoInstructions', { ...cur, [here.value.project]: text }, text.trim() ? `Saved for ${here.value.project}.` : `Removed for ${here.value.project}.`)
}

// Settings → This repo: this repo's value in one per-repo map; null, '' or [] removes it. The engine refuses a bad
// command name, and its message becomes the notice.
async function setRepoSetting($: Engine, key: string, value: unknown) {
  const here = await engine($, ['here'])
  if (!here.ok) { await say($, here.error.message); return }
  const project = String(here.value.project)
  // Built on the settings as saved now, not as the pane last read them: another chat, the sprint's Start or a hand edit
  // may have changed another repo's value since, and this save must not put the old one back.
  const fresh = await engine($, ['settings'])
  if (!fresh.ok) { await say($, fresh.error.message); return }
  const saved = (fresh.value ?? {})[key]
  const next: Record<string, unknown> = saved && typeof saved === 'object' && !Array.isArray(saved) ? { ...(saved as Record<string, unknown>) } : {}
  if (value === null || value === '' || (Array.isArray(value) && !value.length)) delete next[project]
  else next[project] = value
  await setSetting($, key, next, `Saved for ${project}.`)
}

async function loadChecks($: Engine) {
  const r = await engine($, ['doctor'])
  if (r.ok) await update($, checks, () => r.value)
  const v = await engine($, ['version'])
  if (!v.ok || v.value.previous === v.value.version) return
  if (v.value.previous) await update($, whatsNew, () => ({ version: v.value.version, notes: v.value.notes, open: false }))
  await engine($, ['version', '--seen'])
}

async function tryIt($: Engine) {
  const ready = (await read($, agents)).find((a) => a.installed && a.enabled)
  if (!ready) { await say($, 'No agent is ready yet. Open Agents to see what is installed.'); return }
  const r = await engine($, ['dispatch', '--agent', ready.name, '--permission', 'read-only', ...(await sessionArgs($)), '--prompt', '-'], 'Say hello in one short, friendly line. Do not read or change any files.')
  await say($, r.ok ? `${ready.label} is saying hello.` : r.error.message)
  await refresh($)
}

async function gotIt($: Engine) {
  await engine($, ['welcome', '--done'])
  await update($, checks, (cur) => (cur ? { ...cur, welcomed: true } : cur))
}

async function checkAgain($: Engine) {
  await update($, agentsLoaded, () => false)
  await Promise.all([loadAgents($), loadChecks($)])
}

async function planRemoval($: Engine) {
  const r = await engine($, ['uninstall'])
  if (r.ok) await update($, removing, () => r.value)
  else await say($, r.error.message)
}

async function confirmRemoval($: Engine) {
  const r = await engine($, ['uninstall', '--yes'])
  await update($, removing, () => null)
  await say($, !r.ok ? r.error.message
    : r.value.removed ? "Podium's data is gone. To remove Podium itself: /plugin uninstall podium"
    : `Some things could not be removed: ${r.value.left.join('; ')}. Press Remove again to finish.`)
  await refresh($)
}

async function prune($: Engine) {
  const r = await engine($, ['prune'])
  await say($, r.ok ? `Cleaned up: ${r.value.compressed} compressed, ${r.value.deleted} pruned.` : r.error.message)
}

// Every action the pane can take, each returning its promise (the desktop Client waits for them).
function actions($: Engine) {
  const all = {
    openDetail: (id: string) => openDetail($, id),
    showScreen: (screen: PaneView['screen']) => showScreen($, screen),
    toggleFold: (id: string) => update($, folds, (cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id].slice(-FOLDS_KEPT))),
    confirmJob: (id: string, what: 'discard' | 'cancel' | null) => jobQuestion($, 'confirm', id, what),
    openAgent: (name: string) => showScreen($, 'agent', name),
    browsePr: (id: string) => prAction($, ['browse', '--id', id], 'Opened on GitHub.'),
    act: (verb: 'cancel' | 'keep' | 'discard', id: string) => act($, verb, id),
    rate: (id: string, value: 'used' | 'discarded') => rate($, id, value),
    toggleFull: (id: string) => toggleFull($, id),
    clearDone: () => clearDone($),
    toggleShowAll: () => update($, showAllDone, (cur) => !cur),
    askOpen: (threadId: string, agent: string) => openAsk($, { threadId, agent, task: '' }),
    askEdit: (patch: { agent?: string; task?: string }) => moveOpen($, { type: 'askEdit', patch }),
    askSend: (latestId: string, task?: string) => startFollowUp($, latestId, task),
    askCancel: () => moveOpen($, { type: 'askClose' }),
    askRepair: (id: string, isOn: boolean) => jobQuestion($, 'repair', id, isOn),
    repair: (id: string) => repairSandbox($, id),
    askClaude: (id: string) => askClaude($, id),
    toggleFile: (id: string, file: string) => toggleFile($, id, file),
    fullDiff: (id: string) => fullDiff($, id),
    setSetting: (key: string, value: unknown) => setSetting($, key, value),
    toggleSetting: (key: string) => toggleSetting($, key),
    toggleAgent: (name: string) => toggleAgent($, name),
    testAgent: (name: string) => testAgent($, name),
    suggestAgent: (command: string) => suggestAgent($, command),
    editAdapter: (patch: Partial<AdapterDraft>) => update($, draftAdapter, (cur) => (cur ? { ...cur, ...patch } : cur)),
    saveAgent: () => saveAgent($),
    cancelAgent: () => update($, draftAdapter, () => null),
    editDraft: (patch: Partial<Draft>) => update($, draft, (cur) => ({ ...cur, ...patch })),
    startJob: (task?: string) => startJob($, task),
    prune: () => prune($),
    tryIt: () => tryIt($),
    openPr: (id: string) => prAction($, ['open', '--id', id], 'PR opened.', 'Opening the PR…'),
    pushPr: (id: string) => prAction($, ['push', '--id', id], 'Pushed to the PR.', 'Pushing to the PR…'),
    toggleAutoMerge: (id: string, isOn: boolean) => prAction($, ['auto', '--id', id, '--on', String(isOn)]),
    watchAgain: (id: string) => prAction($, ['watch-again', '--id', id]),
    postReview: (id: string) => prAction($, ['post', '--id', id], 'Review posted.', 'Posting the review…'),
    reviewOpen: (threadId: string, agent: string, number: number) => openAsk($, { threadId, agent, task: '', mode: 'review' as const, number }),
    fixOpen: (threadId: string, latestId: string, agent: string, kind: 'ci' | 'comments') => fixOpen($, threadId, latestId, agent, kind),
    setInstructions: (text: string) => setSetting($, 'instructions', text, text.trim() ? 'Saved.' : 'Removed.'),
    setRepoInstructions: (text: string) => setRepoInstructions($, text),
    setRepoSetting: (key: string, value: unknown) => setRepoSetting($, key, value),
    gotIt: () => gotIt($),
    toggleWhatsNew: () => update($, whatsNew, (cur) => (cur ? { ...cur, open: !cur.open } : cur)),
    dismissWhatsNew: () => update($, whatsNew, () => null),
    checkAgain: () => checkAgain($),
    planRemoval: () => planRemoval($),
    confirmRemoval: () => confirmRemoval($),
    cancelRemoval: () => update($, removing, () => null),
    openBoard: (id: string) => openBoard($, id),
    showSprints: (page: number) => update($, sprintPage, () => (Number.isInteger(page) && page > 0 ? page : 0)),
    sprintAct: (verb: 'start' | 'discard' | 'pause' | 'resume', id: string) => sprintAct($, verb, id),
    askConfirm: (id: string, what: string | null) => update($, board, (cur) => (cur.sprint === id ? { ...cur, confirm: what } : { sprint: id, open: null, confirm: what, picking: null, note: '' })),
    setSprintOptions: (id: string, patch: { mergeWhenGreen?: boolean; atOnce?: number }) => sprintCall($, ['options', '--id', id, ...(patch.mergeWhenGreen === undefined ? [] : ['--merge-when-green', String(patch.mergeWhenGreen)]), ...(patch.atOnce === undefined ? [] : ['--at-once', String(patch.atOnce)])]),
    openTicket: (id: string, key: string | null) => openTicket($, id, key),
    openPicker: (id: string, which: string | null) => update($, board, (cur) => (cur.sprint === id ? { ...cur, picking: which } : { sprint: id, open: null, confirm: null, picking: which, note: '' })),
    moveTicket: (id: string, key: string, to: 'up' | 'down') => sprintCall($, ['move', '--id', id, '--ticket', key, '--to', to]),
    removeTicket: (id: string, key: string) => sprintCall($, ['remove', '--id', id, '--ticket', key]),
    assignTicket: (id: string, key: string, role: 'agent' | 'reviewer', name: string) => assignAct($, ['--id', id, '--ticket', key, `--${role}`, name]),
    assignTask: (id: string, key: string, n: number, role: 'agent' | 'reviewer', name: string) => assignAct($, ['--id', id, '--ticket', key, '--task', String(n), `--${role}`, name]),
    retryTicket: (id: string, key: string, agent?: string) => sprintCall($, ['retry', '--id', id, '--ticket', key, ...(agent ? ['--agent', agent] : [])], agent ? `${key} goes to ${agentLabel(agent)}.` : `${key} tries again.`),
    stopTicket: (id: string, key: string) => stopTicketAct($, id, key),
    approvePlan: (id: string, key: string, whole?: boolean) => sprintCall($, [whole ? 'one-task' : 'approve', '--id', id, '--ticket', key], whole ? `${key} runs as one task.` : `${key} approved.`),
    revisePlan: (id: string, key: string, text?: string) => revisePlanAct($, id, key, text),
    editNote: (id: string, text: string) => editNote($, id, text),
    setAfter: (id: string, key: string, other: string, on: boolean) => sprintCall($, ['after', '--id', id, '--ticket', key, on ? '--add' : '--drop', other]),
    takeSprintNews: (id: string) => takeSprintNews($, id),
    // The "couldn't draw" note's Back: the list, with the board's open row, picker and question closed, so the
    // same board does not open straight back onto the row that could not be drawn.
    backToList: () => backToList($),
  }
  return all
}

// A press of the pane: a sprint change joins its sprint's line (inSprintOrder) now, in press order, and `work`
// runs when the changes before it have finished; anything else runs `work` at once.
function pressed(name: string, args: unknown[], work: () => Promise<unknown>): Promise<unknown> {
  const sprintOf = SPRINT_CHANGES[name]
  return sprintOf ? inSprintOrder(String(sprintOf(args)), `${name} ${JSON.stringify(args)}`, work) : work()
}

// The closures the terminal's pure screens call: each runs one action in the background.
function handlers($: Engine) {
  const a = actions($) as Record<string, (...args: any[]) => Promise<unknown>>
  const out: Record<string, (...args: any[]) => void> = {}
  for (const name of Object.keys(a)) out[name] = (...args: any[]) => { quietly(pressed(name, args, () => a[name](...args))) }
  return out as any
}

async function openPane($: Engine) {
  await chatId($)
  await $.ui.open({ id: PANE, title: 'Podium' })
  quietly(loadAgents($))
  quietly(loadSettings($))
  quietly(loadChecks($))
  await update($, showAllDone, () => false)
  await update($, sprintPage, () => 0)
  await loadLook($)
  await refresh($)
  await readLive($).catch(() => {})
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    if (await $.env.get('PODIUM_JOB_ID').catch(() => undefined)) {
      inert = true
      return started
    }
    sessionId = await $.session.id().catch(() => null)
    for (const tool of TOOLS) await $.tool.register(tool)
    await $.command.register({
      name: 'podium',
      description: 'See and control background agent jobs',
      argumentHint: '[run <agent> <task> | status | cancel <id>]',
    })
    quietly(refresh($))
    quietly(loadAgents($))
    quietly(loadLook($))
    $.clock.every(1000, () => {
      ticks += 1
      if (anyWorking && ticks % 2 === 0) quietly(readLive($))
      if (anyWorking && ticks % 10 === 0) quietly(update($, beat, (n) => n + 1))
      if ((anyWorking && ticks % 3 === 0) || ticks % 15 === 0) quietly(deliverFinished($))
    })
    return started
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (!inert && !e.agentId) await deliverFinished($).catch(() => {})
    return done
  })

  on('tool.call', async ($, e, next) => {
    const name = String(e.tool)
    if (inert || !name.startsWith(TOOL_PREFIX)) return next(e)
    const tool = name.slice(TOOL_PREFIX.length)
    let call
    try {
      call = engineCall(tool, e as unknown as Record<string, unknown>)
    } catch (err) {
      return { deny: String((err as Error).message) }
    }
    const r = await engine($, ['dispatch', 'sprint'].includes(tool) ? [...call.args, ...(await sessionArgs($))] : call.args, call.stdin)
    // A new draft opens on its board: the person looks it over there and presses Start.
    if (tool === 'sprint' && (e as any).action === 'draft' && r.ok && r.value.sprint?.id) {
      await openBoard($, String(r.value.sprint.id))
      quietly(openPane($))
    }
    quietly(refresh($))
    return { result: formatToolResult(tool, r, e as unknown as Record<string, unknown>) }
  })

  on('command.run', { command: 'podium' }, async ($, e) => {
    const cmd = parseCommand(e.args)
    if (cmd.kind === 'open') {
      // /podium opens on the list, with no board row, picker or question open: the pane reopens
      // on the screen it was on, so a screen that breaks would otherwise stay broken across reopening.
      await update($, view, () => ({ screen: 'list' as const, id: null }))
      await update($, board, () => NO_BOARD)
      await openPane($)
      return { text: 'Podium pane opened.' }
    }
    if (cmd.kind === 'usage') return { text: cmd.message }
    if (cmd.kind === 'status') {
      const r = await engine($, ['status', '--here'])
      await refresh($)
      return { text: formatToolResult('status', r) }
    }
    if (cmd.kind === 'cancel') {
      const r = await engine($, ['cancel', '--id', cmd.id])
      quietly(refresh($))
      return { text: formatToolResult('cancel', r) }
    }
    const r = await engine($, ['dispatch', '--agent', cmd.agent, ...(await sessionArgs($)), '--prompt', '-'], cmd.task)
    quietly(refresh($))
    return { text: formatToolResult('dispatch', r) }
  })

  // The desktop Client: runs each posted action and answers with the next model.
  on('ui.message', async ($, e, next) => {
    if (e.element !== 'podium-app') return next(e)
    type Act = { kind: 'act'; id: string; name: string; args?: unknown[] }
    const d = e.data as { kind?: string; acts?: Act[] } | null
    const fresh = (d?.kind === 'acts' && Array.isArray(d.acts) ? d.acts : []).filter((a) => a && a.id && !seen.includes(a.id))
    for (const a of fresh) {
      seen.push(a.id)
      if (seen.length > 400) seen.splice(0, 200)
      const fn = (actions($) as Record<string, (...args: any[]) => Promise<unknown>>)[a.name]
      const done = () => { acked.push(a.id); if (acked.length > 200) acked.splice(0, 100) }
      // In order, but a slow one (Open PR) holds the next back half a second at most. A sprint change also joins
      // its sprint's line as it arrives and waits there for the sprint changes before it, however long they take,
      // so Start never overtakes an edit.
      const nap = (ms: number) => Promise.resolve().then(() => $.clock.sleep(ms)).catch(() => {})
      const before = clientWork
      const args = a.args ?? []
      const run = pressed(a.name, args, () => Promise.race([before, nap(500)]).then(() => (fn ? fn(...args) : undefined))).catch(() => {}).then(done)
      clientWork = run
    }
    // Quick actions (a screen switch) land in this answer; slow ones arrive on a later sync.
    if (fresh.length) await Promise.race([clientWork, Promise.resolve().then(() => $.clock.sleep(80)).catch(() => {})])
    return { props: fitModel(await paneModel($)) }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    await read($, beat)
    // On desktop the app paints a Pane's own redraws only on the next click; a Client paints itself.
    if (e.surface === 'desktop' && ui.Client) {
      const { Client } = ui
      return <Client key="podium-app" module="./client/app.tsx" props={fitModel(await paneModel($))} width="100%" flexGrow={1} />
    }
    return drawPane(ui, await paneModel($), handlers($) as any, Date.now())
  })
}
