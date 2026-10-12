// Kit tests for the mod (`claude plugin test .`). How the kit behaves (Claude Code 2.1.28x):
// - session.start runs before each test body, so /podium and the mcp__podium__* tools are ready.
// - Test hooks stand for the engine beneath the plugin. One standing in for a `$` call
//   (process.run, ui.open, model.complete, fs.read, prompt.fill) answers { value: <result> }; one
//   answering an event (turn.complete, prompt.submit) returns the result itself ({ text } or { drop }).
//   A prompt.submit hook answering { value } makes the submit fail, which the mod now notices.
// - The kit has no ui.open (stub it), ui.status or ui.toast (dropped with a note, harmless).
// - The kit has no session.append, and a test hook cannot answer it: on('session.append', ...) is never called, though the kit's own
//   error suggests it. So in the kit the hidden row always fails and delivery takes the fallback: one submit, headline first
//   with the details after it, then marked. The row-succeeds path (headline only) is tested on mod/delivery.js
//   (tests/mod-delivery.test.js), and the row itself in the app.
// - $.command.run needs args ('' for none); $.tool.call takes the tool's arguments at the top level.
// - $.ui.mount({ plugin, surface, component, props, requestId }); find({ type, text: /re/ }), press({ key }),
//   input({ key, text }) resolve after the handler's unawaited work settles.
// - A timer set in session.start is not driven by a mock.clock made in the test body: drive
//   delivery with $.turn.complete instead.
// - $.fs.read sees Windows paths (backslashes) even when given forward slashes: normalise before matching.
// - mounted.drawn() returns the whole drawn tree, props included; find() without a type matches Button labels too.
// - PODIUM_JOB_ID cannot be set before session.start in the kit, so the inert path is checked with a real Claude job.
import { test, expect, mock } from 'claude-code/testing'
import { pageProblem, pageSize, cardCost, capRows, CARD_ROWS, wordsDrawn } from '../mod/client.js'
import { clientLook } from './client/look'
import { PALETTES } from './theme'
import { drawFailed, isListView } from './screens'

type Job = Record<string, unknown>

// Desktop draws the pane in a Client: look inside it, and let its outbox and sync run.
const APP = 'podium-app'
async function look(pane: any, q: any) { return (await pane.find({ ...q, in: APP }).catch(() => undefined)) ?? pane.find(q) }
async function lookAll(pane: any, q: any) { const inner = await pane.findAll({ ...q, in: APP }).catch(() => []); return inner.length ? inner : pane.findAll(q) }
async function drawnAll(pane: any) { return pane.drawn({ in: APP }).catch(() => pane.drawn()) }
// The desktop page throws away (blanks) a Client tree it cannot draw, and the kit draws it anyway: every settle (so
// every tap and type) checks the Client's tree against the page's own rules (pageProblem in mod/client.js). The
// Client never hands the page such a tree: it draws the "couldn't draw" note instead (as drawPane does for a screen
// that throws, on both surfaces), so that tree always passes. The note itself is what fails a test, unless the
// test expects it (allowNote).
const notesAllowed = new WeakSet<object>()
function allowNote(pane: any) { notesAllowed.add(pane); return pane }
async function pageCheck(pane: any) {
  const tree = await pane.drawn({ in: APP }).catch(() => undefined)
  if (tree != null) expect(pageProblem(tree)).toBe(null)
  if (notesAllowed.has(pane)) return
  const text = JSON.stringify((tree ?? await pane.drawn().catch(() => null)) ?? null)
  // Its Back button's key (Text elements keep none), or its words when it has no Back (on the list itself).
  const note = text.includes('"draw-failed-back"') ? (text.match(/(This screen has too much|Something on this screen)[^"]*/)?.[0] ?? "the couldn't-draw note")
    : text.match(/(This screen has too much|Something on this screen)[^"]*/)?.[0] ?? null
  expect(note).toBe(null)
  // The list's own fallback (a short list with no job cards) is the same failure, met another way.
  expect(text.match(/This list is too long for this pane[^"]*/)?.[0] ?? null).toBe(null)
}
async function settle(pane: any) { await pane.advance(100).catch(() => {}); await pane.advance(100).catch(() => {}); await pageCheck(pane) }
async function tap(pane: any, t: any) { const r = await pane.press(t); await settle(pane); return r }
async function type(pane: any, t: any) { const r = await pane.input(t); await settle(pane); return r }
// Opens every closed fold on the screen, including folds that appear inside others ("no information lost").
async function openFolds(pane: any) {
  for (let round = 0; round < 10; round += 1) {
    const keys: string[] = []
    const walk = (n: any) => {
      if (!n || typeof n !== 'object') return
      if (Array.isArray(n)) { n.forEach(walk); return }
      const key = String(n.props?.key ?? n.key ?? '')
      if (n.type === 'Button' && key.startsWith('fold-') && String(n.props?.label ?? '').startsWith('▸')) keys.push(key)
      for (const c of n.children ?? []) walk(c)
    }
    walk(await drawnAll(pane))
    if (!keys.length) return
    for (const key of keys) await tap(pane, { key })
  }
}
// The keys of the screen's primary buttons, leaving out the header's + New job (one per state).
async function primaryKeys(pane: any) {
  const keys: string[] = []
  const walk = (n: any) => {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) { n.forEach(walk); return }
    if (n.type === 'Button' && n.props?.variant === 'primary') keys.push(String(n.props?.key ?? n.key))
    for (const c of n.children ?? []) walk(c)
  }
  walk(await drawnAll(pane))
  return keys.filter((k) => k !== 'new')
}
// Opens a ticket from the board: its line under the tickets (open-ticket-<KEY>), or its title in Your turn (open-<sprint>-<KEY>).
async function openTicketOf(pane: any, key: string) {
  const found: string[] = []
  const walk = (n: any) => {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) { n.forEach(walk); return }
    const k = String(n.props?.key ?? n.key ?? '')
    if (n.type === 'Button' && (k === `open-ticket-${key}` || (/^open-/.test(k) && !k.startsWith('open-board-') && k.endsWith(`-${key}`)))) found.push(k)
    for (const c of n.children ?? []) walk(c)
  }
  walk(await drawnAll(pane))
  if (!found.length) throw new Error(`no line for ${key} is drawn`)
  await tap(pane, { key: found[0] })
}
async function drawnText(pane: any) { return JSON.stringify(await drawnAll(pane)) }

// Delivery runs after a turn ends (and on the poll timer): the host refuses
// prompt.submit from inside a command's or tool's own turn.
async function endTurn($: any) {
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
}
const job = (over: Job = {}): Job => ({
  id: 'j1', agent: 'codex', title: 'Review the branch', ticket: 'ABC-4', status: 'done', permission: 'read-only',
  createdAt: '2026-10-05T11:56:00Z', startedAt: '2026-10-05T11:56:00Z', endedAt: '2026-10-05T12:00:00Z',
  isLong: false, delivered: false, hasChanges: false, outcome: null, outcomeSource: null, error: null, model: null, worktree: null, ...over,
})

function fakeEngine(state: { jobs: Job[]; calls: string[][]; summary?: string | null }) {
  return (argv: readonly string[]) => {
    const args = argv.slice(2)
    state.calls.push([...args])
    const id = args[args.indexOf('--id') + 1]
    let body: unknown
    switch (args[0]) {
      case 'status': {
        // As the engine: a sprint named with --sprint (the open board's) comes back beside the rest (`named`, by id).
        // One not named is counted among this chat's older finished ones instead, as the engine counts it.
        const asked = args.includes('--sprint') ? args[args.indexOf('--sprint') + 1] : null
        const named = asked ? (state as any).named?.[asked] : null
        const unnamed = Object.keys((state as any).named ?? {}).filter((id) => id !== asked).length
        const older = (state as any).olderFinished ?? { mine: 0, others: 0 }
        body = { jobs: state.jobs, sprints: [...((state as any).sprints ?? []), ...(named ? [named] : [])], olderFinished: { ...older, mine: older.mine + unnamed } }
        break
      }
      case 'result': body = { job: state.jobs.find((j) => j.id === id), summary: state.summary ?? null, output: (state as any).output ?? 'full output', hasDiff: false }; break
      case 'deliver': state.jobs = state.jobs.map((j) => (j.id === id ? { ...j, delivered: true } : j)); body = { job: state.jobs.find((j) => j.id === id) }; break
      case 'settings': { const base = { tellClaudeWhenDone: (state as any).tell ?? true, longJobMinutes: 30, worktreeWarnMB: 500, retention: { compressDays: 30, deleteDays: 90 }, defaultPermission: {}, disabledAgents: [], pinned: [], ...((state as any).saved ?? {}) }; body = args[1] === 'set' ? { ...base, [args[args.indexOf('--key') + 1]]: JSON.parse(args[args.indexOf('--value') + 1]) } : base; break }
      case 'agents': body = { agents: (state as any).agentList ?? [{ name: 'codex', label: 'Codex', installed: true, version: 'codex-cli 1', signedIn: true, verified: true, source: 'builtin', enabled: true, defaultPermission: 'edit-worktree', stats: { jobs: 0, used: 0 } }, { name: 'muse', label: 'Muse', installed: true, version: '1.4.2', signedIn: null, verified: true, source: 'builtin', enabled: true, defaultPermission: 'edit-worktree', stats: { jobs: 0, used: 0 } }], errors: [] }; break
      case 'dispatch': body = { job: job({ id: 'j2', status: 'queued' }), warnings: [], permissionText: 'Codex will only read files' }; break
      case 'keep': body = { job: { ...state.jobs[0], status: 'kept' } }; break
      case 'summary': body = { job: state.jobs[0] }; break
      case 'changes': body = (state as any).changeSet ?? { files: [
        { path: 'tests/payout.test.ts', added: 2, removed: 0, patch: '@@ -0,0 +1,2 @@\n+one\n+two', isTruncated: false },
        { path: 'src/round.ts', added: 1, removed: 1, patch: '@@ -1 +1 @@\n-old\n+new', isTruncated: false },
      ], added: 3, removed: 1 }; break
      case 'claim': body = { claimed: !state.jobs.find((j) => j.id === id)?.delivered && ((state as any).claim ?? true) }; break
      case 'release': body = { released: true }; break
      case 'repair': body = { repaired: true, removed: 1787, folder: 'C:\\x' }; break
      case 'doctor': body = (state as any).doctor ?? { node: { ok: true, version: '22.3.0' }, git: { ok: true, version: '2.45.1' }, gh: { installed: true, signedIn: true, version: '2.96.0' }, tellClaude: true, welcomed: true }; break
      case 'welcome': (state as any).welcomed = true; body = { welcomed: true }; break
      case 'version': body = (state as any).version ?? { version: '0.1.0', previous: '0.1.0', notes: null }; break
      case 'uninstall': body = args.includes('--yes') ? { removed: true, bytes: 1048576, left: [] } : { bytes: 1048576, unkept: 2, running: 1, copies: 3 }; break
      case 'pr': {
        const sub = args[1]
        const j = state.jobs.find((x) => x.id === id) as any
        if (sub === 'open') { Object.assign(j, { status: 'in-review', pr: { number: 12, url: 'https://github.com/o/r/pull/12', branch: 'feat/x', base: 'main', state: 'OPEN', checks: { total: 0, passed: 0, failed: 0, running: 0, failing: [] }, review: null, mergeable: 'UNKNOWN', comments: 0, autoMerge: false, attention: null } }); body = { job: j } }
        else if (sub === 'auto') { j.pr.autoMerge = args[args.indexOf('--on') + 1] === 'true'; body = { job: j } }
        else if (sub === 'push') { j.status = 'in-review'; body = { job: j } }
        else if (sub === 'fix') body = { text: 'CI failed on PR #12 (test). Fix it.' }
        else if (sub === 'watch') body = { started: false }
        else body = { job: j }
        break
      }
      case 'here': body = { project: 'repo' }; break
      case 'sprint': {
        const sub = args[1]
        if (sub === 'inbox') { body = { messages: (state as any).inbox ?? [] }; (state as any).inbox = [] }
        else if (sub === 'delivered') body = (state as any).deliveredFails > 0 && (state as any).deliveredFails-- ? { error: { code: 'sprint-busy', message: 'The sprint is busy. Try again in a moment.' } } : { marked: 1, failed: [] }
        else if (sub === 'ensure') body = { started: [] }
        else if (sub === 'after' && (state as any).afterError) body = { error: { code: 'bad-after', message: (state as any).afterError } }
        else if (sub === 'draft') body = { sprint: ((state as any).sprints ?? [])[0] }
        else if (sub === 'start' && (state as any).applied) body = { sprint: ((state as any).sprints ?? [])[0], applied: (state as any).applied }
        else body = { sprints: (state as any).sprints ?? [] }
        break
      }
      default: body = { error: { code: 'unknown-command', message: args[0] } }
    }
    return { value: { exitCode: 0, stdout: JSON.stringify(body) + '\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  }
}

// The kit's session.append always fails, so here the hidden details row can never be added: the details
// go in the visible message after the headline. The hidden-row path (headline only) is tested on the
// pure helper (tests/mod-delivery.test.js) and in the app.
test('a finished job whose hidden details row cannot be added goes in as one message, headline first, then is marked delivered', async ($, on) => {
  on('turn.complete', () => ({ text: '' }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
  const state = { jobs: [job()], calls: [] as string[][], summary: 'All fine.\n' }
  const prompts: string[] = []
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  on('prompt.submit', (_$, e) => { prompts.push(e.text); return { text: e.text } })
  await endTurn($)
  await endTurn($)
  expect(prompts.length).toBe(1)
  expect(prompts[0].startsWith('Podium: Codex finished "Review the branch".')).toBe(true)
  expect(prompts[0]).toContain('All fine.')
  expect(prompts[0]).toContain('Job j1.')
  expect(prompts[0]).not.toContain('Do not repeat their line')
  const claim = state.calls.findIndex((c) => c[0] === 'claim')
  const deliver = state.calls.findIndex((c) => c[0] === 'deliver')
  expect(claim).toBeGreaterThanOrEqual(0)
  expect(deliver).toBeGreaterThan(claim)
  expect(state.calls.filter((c) => c[0] === 'deliver').length).toBe(1)
  expect(state.calls.some((c) => c[0] === 'release')).toBe(false)
})

test('without a summary, Haiku writes one and the engine stores it', async ($, on) => {
  on('turn.complete', () => ({ text: '' }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
  const state = { jobs: [job()], calls: [] as string[][], summary: null, output: 'Step done.\n'.repeat(80) }
  const prompts: string[] = []
  const heads: string[] = []
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  on('model.complete', (_$, e) => { expect(e.model).toBe('haiku'); return { value: { isAnswered: true, text: 'Short summary.', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } } })
  on('prompt.submit', (_$, e) => { heads.push(e.text); prompts.push(e.text); return { text: e.text } })
  await endTurn($)
  expect(state.calls.some((c) => c[0] === 'summary')).toBe(true)
  // The kit has no hidden row, so Haiku's summary rides in the visible message under the headline.
  expect(prompts.length).toBe(1)
  expect(prompts[0].startsWith('Podium: Codex finished "Review the branch".')).toBe(true)
  expect(prompts[0]).toContain('Short summary.')
})

// The lock is renewed from right after the claim, so the time Haiku takes over a summary is covered too.
test('the delivery lock is renewed from the claim on, while Haiku writes the summary', async ($, on) => {
  on('turn.complete', () => ({ text: '' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const state = { jobs: [job()], calls: [] as string[][], summary: null, output: 'Step done.\n'.repeat(80) }
  const renewed = () => state.calls.some((c) => c[0] === 'claim' && c.includes('--refresh'))
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  // Each 20-second wait between renewals passes at once here.
  on('clock.sleep', async () => { await new Promise((r) => setTimeout(r, 5)); return { value: undefined } })
  // Haiku answers only once the lock has been renewed (or after a second, failing the test below).
  on('model.complete', async () => {
    for (let i = 0; i < 100 && !renewed(); i++) await new Promise((r) => setTimeout(r, 10))
    return { value: { isAnswered: true, text: 'Short summary.', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }
  })
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  await endTurn($)
  const claimAt = state.calls.findIndex((c) => c[0] === 'claim' && !c.includes('--refresh'))
  const renewAt = state.calls.findIndex((c) => c[0] === 'claim' && c.includes('--refresh'))
  const summaryAt = state.calls.findIndex((c) => c[0] === 'summary')
  expect(claimAt).toBeGreaterThan(-1)
  expect(renewAt).toBeGreaterThan(claimAt)
  expect(summaryAt).toBeGreaterThan(renewAt)
  expect(state.calls.some((c) => c[0] === 'deliver')).toBe(true)
})

test('the dispatch tool sends the task on stdin and reports the permission', async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
  const state = { jobs: [] as Job[], calls: [] as string[][] }
  let stdin: string | undefined
  on('process.run', (_$, e) => { if (e.argv[2] === 'dispatch') stdin = e.init?.stdin; return fakeEngine(state)(e.argv) })
  const r = await $.tool.call({ tool: 'mcp__podium__dispatch', agent: 'codex', task: 'List the files', permission: 'read-only' } as any)
  expect(stdin).toBe('List the files')
  expect(String(r.result)).toMatch(/Started job j2\. Codex will only read files\./)
})

// The hook hands the tool's input to formatToolResult, so a sprint step asked for by id is shown with its sprint.
test('the status tool by a sprint step\'s id says which sprint it is part of; the full list leaves it out', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const step = job({ id: 'sa1', title: 'ABC-12 task 2: Round the payouts', status: 'running', delivered: true, sprint: { id: 's1', ticket: 'ABC-12', task: 2, role: 'author' } })
  const state = { jobs: [step], calls: [] as string[][], sprints: [{ id: 's1', name: 'Oct week 2', tickets: [] }] }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  const byId = await $.tool.call({ tool: 'mcp__podium__status', id: 'sa1' } as any)
  expect(String(byId.result)).toMatch(/sa1/)
  expect(String(byId.result)).toMatch(/part of sprint Oct week 2, ABC-12 task 2 \(writer\)/)
  const list = await $.tool.call({ tool: 'mcp__podium__status' } as any)
  expect(String(list.result)).not.toMatch(/part of sprint/)
  expect(String(list.result)).toMatch(/Sprints: use the sprint tool/)
})

test('/podium usage and run', async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
  const state = { jobs: [] as Job[], calls: [] as string[][] }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  expect((await $.command.run({ command: 'podium', args: 'dance' })).text).toMatch(/^Usage:/)
  expect((await $.command.run({ command: 'podium', args: 'run codex list the files' })).text).toMatch(/Started job j2/)
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the pane lists jobs and opens a job's detail on ${surface}`, async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    const state = { jobs: [job({ status: 'needs-review', permission: 'edit-worktree', delivered: true })], calls: [] as string[][], summary: 'Added a file.' }
    on('process.run', (_$, e) => fakeEngine(state)(e.argv))
    await $.command.run({ command: 'podium', args: '' })
    const pane = await $.ui.mount({ plugin: 'podium', surface, component: 'Pane', props: { title: 'Podium', isFocused: true, bodyColumns: 40 }, requestId: 'podium' })
    expect(await look(pane, { type: 'Button', text: /Review the branch/ })).toBeTruthy()
    await tap(pane, { key: 'open-j1' })
    expect(await look(pane, { type: 'Text', text: /Added a file\./ })).toBeTruthy()
    await tap(pane, { key: 'keep' })
    expect(state.calls.some((c) => c[0] === 'keep')).toBe(true)
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`Agents, Settings and New job draw and act on ${surface}`, async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    const state = { jobs: [] as Job[], calls: [] as string[][] }
    let stdin: string | undefined
    on('process.run', (_$, e) => { if (e.argv[2] === 'dispatch') stdin = e.init?.stdin; return fakeEngine(state)(e.argv) })
    await $.command.run({ command: 'podium', args: '' })
    const pane = await $.ui.mount({ plugin: 'podium', surface, component: 'Pane', props: { title: 'Podium', isFocused: true, bodyColumns: 60 }, requestId: 'podium' })
    await tap(pane, { key: 'link-agents' })
    expect(await look(pane, { text: /Codex/ })).toBeTruthy()
    // The job count is on the agent's own screen, in its Stats fold's heading.
    await tap(pane, { key: 'open-agent-codex' })
    expect(await look(pane, { text: /0 jobs/ })).toBeTruthy()
    await tap(pane, { key: 'back' })
    await tap(pane, { key: 'back' })
    await tap(pane, { key: 'link-settings' })
    await tap(pane, { key: 'tell' })
    expect(state.calls.some((c) => c[0] === 'settings' && c[1] === 'set' && c.includes('tellClaudeWhenDone') && c.includes('false'))).toBe(true)
    await tap(pane, { key: 'back' })
    await tap(pane, { key: 'new' })
    await tap(pane, { key: 'fold-new:more' })
    await tap(pane, { key: 'access-read-only' })
    await type(pane, { key: 'ticket', text: 'ABC-6' })
    await type(pane, { key: 'base', text: 'feat/x' })
    await type(pane, { key: 'task', text: 'List the files' })
    expect(stdin).toBe('List the files')
    const dispatched = state.calls.find((c) => c[0] === 'dispatch') ?? []
    expect(dispatched).toContain('read-only')
    expect(dispatched).toContain('ABC-6')
    expect(dispatched).toContain('feat/x')
  })
}

const liveText = (activity: string) => JSON.stringify({ v: 1, updatedAt: new Date().toISOString(), activity, lines: ['step one', activity], bytes: 20 })

for (const surface of ['terminal', 'desktop'] as const) {
  // The list's sections group jobs (Your turn, Working, Done folded); a running job's row carries its live line.
  test(`the list groups jobs, a running job shows its live activity, and Done opens and closes on ${surface}`, async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    const state = {
      jobs: [
        job({ id: 'r1', status: 'running', title: 'Review the auth branch', endedAt: null, liveFile: '/data/r1/live.json' }),
        job({ id: 'n1', status: 'needs-review', title: 'Add tests', permission: 'edit-worktree', changes: { files: 3, added: 84, removed: 6 } }),
        job({ id: 'd1', status: 'done', delivered: true }),
      ],
      calls: [] as string[][],
    }
    on('process.run', (_$, e) => fakeEngine(state)(e.argv))
    on('fs.read', (_$, e) => (String(e.path).split('\\').join('/').endsWith('r1/live.json') ? { value: liveText('reading src/auth/session.ts') } : { deny: 'missing' }))
    await $.command.run({ command: 'podium', args: '' })
    const pane = await $.ui.mount({ plugin: 'podium', surface, component: 'Pane', props: { title: 'Podium', isFocused: true, bodyColumns: 60 }, requestId: 'podium' })
    await settle(pane)
    expect(await look(pane, { type: 'Text', text: /^Your turn · 1$/ })).toBeTruthy()
    expect(await look(pane, { key: 'turn-n1' })).toBeTruthy()
    expect(await look(pane, { type: 'Text', text: /^Working · 1$/ })).toBeTruthy()
    expect(await look(pane, { type: 'Text', text: /reading src\/auth\/session\.ts/ })).toBeTruthy()
    expect(await look(pane, { key: 'open-d1' })).toBeFalsy()
    await tap(pane, { key: 'fold-list:done' })
    expect(await look(pane, { key: 'open-d1' })).toBeTruthy()
    await tap(pane, { key: 'fold-list:done' })
    expect(await look(pane, { key: 'open-d1' })).toBeFalsy()
    // The changes' summary is on the job's screen (counted from the diff it loads).
    await tap(pane, { key: 'open-n1' })
    expect(await look(pane, { type: 'Button', text: /▸ Changes · \d+ files? · \+\d+ −\d+/ })).toBeTruthy()
  })
}

test('an unchanged status poll writes no state', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const state = { jobs: [job({ delivered: true })], calls: [] as string[][] }
  const writes: string[] = []
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  on('state.set', (_$, e, next) => { writes.push(String((e as any).key)); return next(e) })
  await $.command.run({ command: 'podium', args: 'status' })
  const before = writes.filter((k) => k === 'jobs').length
  await $.command.run({ command: 'podium', args: 'status' })
  expect(writes.filter((k) => k === 'jobs').length).toBe(before)
})

test('tiles use theme keys, so they follow the app\'s light or dark mode', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('config.list', () => ({ value: [{ key: 'theme', label: 'Theme', kind: 'enum', value: 'light', provider: { kind: 'core' } }] }))
  const state = { jobs: [job({ status: 'running', endedAt: null, liveFile: '/x/live.json' })], calls: [] as string[][] }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await $.ui.mount({ plugin: 'podium', surface: 'desktop', component: 'Pane', props: { title: 'Podium', isFocused: true, bodyColumns: 60 }, requestId: 'podium' })
  const tree = JSON.stringify(await drawnAll(pane))
  expect(tree).toContain('"backgroundColor":"background"')
  expect(tree).toContain('"borderColor":"suggestion"')
  expect(tree).not.toMatch(/"(backgroundColor|borderColor)":"#/)
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`review shows files and expands a diff on ${surface}`, async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    const state = { jobs: [job({ status: 'needs-review', permission: 'edit-worktree', delivered: true, changes: { files: 2, added: 3, removed: 1 } })], calls: [] as string[][], summary: 'Added tests.' }
    on('process.run', (_$, e) => fakeEngine(state)(e.argv))
    await $.command.run({ command: 'podium', args: '' })
    const pane = await $.ui.mount({ plugin: 'podium', surface, component: 'Pane', props: { title: 'Podium', isFocused: true, bodyColumns: 60 }, requestId: 'podium' })
    await tap(pane, { key: 'open-j1' })
    expect(await look(pane, { text: /tests\/payout\.test\.ts/ })).toBeFalsy()
    await tap(pane, { key: 'fold-job:j1:changes' })
    expect(await look(pane, { text: /tests\/payout\.test\.ts/ })).toBeTruthy()
    expect(await look(pane, { text: /\+one/ })).toBeFalsy()
    await tap(pane, { key: 'file-tests/payout.test.ts' })
    expect(await look(pane, { text: /\+one/ })).toBeTruthy()
    await tap(pane, { key: 'keep' })
    expect(state.calls.some((c) => c[0] === 'keep')).toBe(true)
  })
}

test('Ask Claude about it fills the prompt box and never submits', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const state = { jobs: [job({ status: 'running', endedAt: null, liveFile: '/d/j1/live.json' })], calls: [] as string[][] }
  const filled: string[] = []
  let submitted = 0
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  on('fs.read', () => ({ value: liveText('reading src/a.ts') }))
  on('prompt.fill', (_$, e) => { filled.push(String((e as any).text)); return { value: { isFilled: true } } })
  on('prompt.submit', (_$, e) => { submitted++; return { text: (e as any).text } })
  await $.command.run({ command: 'podium', args: '' })
  const pane = await $.ui.mount({ plugin: 'podium', surface: 'desktop', component: 'Pane', props: { title: 'Podium', isFocused: true, bodyColumns: 60 }, requestId: 'podium' })
  await tap(pane, { key: 'open-j1' })
  await tap(pane, { key: 'ask' })
  expect(filled.length).toBe(1)
  expect(filled[0]).toMatch(/^About Podium job "Review the branch"/)
  expect(filled[0]).toMatch(/reading src\/a\.ts/)
  expect(submitted).toBe(0)
})

const committed = { branch: 'feat/agent-work', head: 'abc', count: 2, commits: [{ sha: 'a1b2c3d', subject: 'Add roster' }, { sha: 'e4f5a6b', subject: 'Fix names' }] }

for (const surface of ['terminal', 'desktop'] as const) {
  test(`committed work shows its branch and commits and offers no Keep on ${surface}`, async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    const state = { jobs: [job({ status: 'done', delivered: true, permission: 'edit-worktree', committed })], calls: [] as string[][] }
    on('process.run', (_$, e) => fakeEngine(state)(e.argv))
    await $.command.run({ command: 'podium', args: '' })
    const pane = await $.ui.mount({ plugin: 'podium', surface, component: 'Pane', props: { title: 'Podium', isFocused: true, bodyColumns: 60 }, requestId: 'podium' })
    // Done is folded on the list: its row says where the work was committed.
    await tap(pane, { key: 'fold-list:done' })
    expect(await look(pane, { text: /^Codex · committed to feat\/agent-work .+ ago$/ })).toBeTruthy()
    await tap(pane, { key: 'open-j1' })
    expect(await look(pane, { text: /^Codex finished .+ ago · 2 commits on feat\/agent-work$/ })).toBeTruthy()
    expect(await look(pane, { text: /a1b2c3d Add roster/ })).toBeFalsy()
    await tap(pane, { key: 'fold-job:j1:changes' })
    expect(await look(pane, { text: /a1b2c3d Add roster/ })).toBeTruthy()
    expect(await look(pane, { key: 'keep' })).toBeFalsy()
  })
}

test('a claim refused elsewhere means no message from this session', async ($, on) => {
  on('turn.complete', () => ({ text: '' }))
  const state = { jobs: [job()], calls: [] as string[][], claim: false }
  const prompts: string[] = []
  const heads: string[] = []
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  on('prompt.submit', (_$, e) => { heads.push(e.text); prompts.push(e.text); return { text: e.text } })
  await endTurn($)
  expect(prompts.length).toBe(0)
  expect(state.calls.some((c) => c[0] === 'deliver')).toBe(false)
})

test('a failed submit releases the claim and leaves the job undelivered', async ($, on) => {
  on('turn.complete', () => ({ text: '' }))
  const state = { jobs: [job()], calls: [] as string[][], summary: 'ok' }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  on('prompt.submit', () => { throw new Error('reloaded') })
  await endTurn($)
  expect(state.calls.some((c) => c[0] === 'release')).toBe(true)
  expect(state.calls.some((c) => c[0] === 'deliver')).toBe(false)
})

// A prompt a hook dropped still counts as delivered: tests/mod-delivery.test.js.

test('dispatches record this session', async ($, on) => {
  const state = { jobs: [] as Job[], calls: [] as string[][] }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  on('session.id', () => ({ value: 'sess-1' }))
  await $.tool.call({ tool: 'mcp__podium__dispatch', agent: 'codex', task: 'List the files', permission: 'read-only' } as any)
  expect(state.calls.find((c) => c[0] === 'dispatch')).toContain('sess-1')
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`a broken sandbox is explained, and Repair asks before it runs on ${surface}`, async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    const warning = { code: 'sandbox-broken', message: "Muse couldn't run any commands: its own safety sandbox can't start on this computer.", repair: 'muse-sandbox' }
    const state = { jobs: [job({ agent: 'muse', status: 'done', delivered: true, warning })], calls: [] as string[][] }
    on('process.run', (_$, e) => fakeEngine(state)(e.argv))
    await $.command.run({ command: 'podium', args: '' })
    const pane = await $.ui.mount({ plugin: 'podium', surface, component: 'Pane', props: { title: 'Podium', isFocused: true, bodyColumns: 60 }, requestId: 'podium' })
    // Done is folded on the list; the warning is on the job's screen.
    await tap(pane, { key: 'fold-list:done' })
    await tap(pane, { key: 'open-j1' })
    expect(await look(pane, { text: /safety sandbox can't start/ })).toBeTruthy()
    await tap(pane, { key: 'repair' })
    expect(state.calls.some((c) => c[0] === 'repair')).toBe(false)
    expect(await look(pane, { text: /MuseSandboxUsers/ })).toBeTruthy()
    await tap(pane, { key: 'repair-yes' })
    expect(state.calls.some((c) => c[0] === 'repair' && c.includes('muse-sandbox'))).toBe(true)
    expect(await look(pane, { text: /removed 1787/ })).toBeTruthy()
  })
}

test('the pane warns when Claude is not told about finished jobs, and Turn on fixes it', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const state = { jobs: [] as Job[], calls: [] as string[][], tell: false }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await $.ui.mount({ plugin: 'podium', surface: 'desktop', component: 'Pane', props: { title: 'Podium', isFocused: true, bodyColumns: 60 }, requestId: 'podium' })
  expect(await look(pane, { text: /Claude isn't told when jobs finish/ })).toBeTruthy()
  await tap(pane, { key: 'tell-on' })
  expect(state.calls.some((c) => c[0] === 'settings' && c[1] === 'set' && c.includes('tellClaudeWhenDone') && c.includes('true'))).toBe(true)
})

test('a short answer is its own summary, with no model call', async ($, on) => {
  on('turn.complete', () => ({ text: '' }))
  const state = { jobs: [job()], calls: [] as string[][], summary: null, output: 'Hello!' }
  const prompts: string[] = []
  const heads: string[] = []
  let modelCalls = 0
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  on('model.complete', () => { modelCalls++; return { value: { isAnswered: true, text: 'x', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } } })
  on('prompt.submit', (_$, e) => { heads.push(e.text); prompts.push(e.text); return { text: e.text } })
  await endTurn($)
  expect(modelCalls).toBe(0)
  expect(state.calls.some((c) => c[0] === 'summary')).toBe(true)
})

test('a diff bigger than the desktop allows still draws, cut with a note', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const patch = '@@ -0,0 +1,700 @@\n' + Array.from({ length: 700 }, (_, i) => `+  <div class="key" data-op="op${i}">button number ${i}</div>`).join('\n')
  const state = {
    jobs: [job({ status: 'needs-review', permission: 'edit-worktree', delivered: true, changes: { files: 1, added: 700, removed: 0 } })],
    calls: [] as string[][],
    changeSet: { files: [{ path: 'calculator.html', added: 700, removed: 0, patch, isTruncated: false }], added: 700, removed: 0 },
  }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await $.ui.mount({ plugin: 'podium', surface: 'desktop', component: 'Pane', props: { title: 'Podium', isFocused: true, bodyColumns: 60 }, requestId: 'podium' })
  await tap(pane, { key: 'open-j1' })
  await tap(pane, { key: 'fold-job:j1:changes' })
  expect(await look(pane, { text: /more characters not shown$|^… [0-9,]+ more lines$/ })).toBeTruthy()
  expect(await look(pane, { key: 'keep' })).toBeTruthy()
})

const threadJobs = () => [
  job({ id: 'j2', threadId: 'j1', step: 2, followUpOf: 'j1', status: 'needs-review', permission: 'edit-worktree', delivered: true, title: 'Add CSS', agent: 'claude', createdAt: '2026-10-05T12:05:00Z', resumeFrom: 'sess-1', changes: { files: 1, added: 9, removed: 0 } }),
  job({ id: 'j1', threadId: 'j1', step: 1, status: 'continued', endStatus: 'needs-review', permission: 'edit-worktree', delivered: true, title: 'Build the calculator', agent: 'claude', createdAt: '2026-10-05T12:00:00Z' }),
]

for (const surface of ['terminal', 'desktop'] as const) {
  // A thread is one row on the list; its steps and Ask for changes are on its screen.
  test(`a thread draws as one row, its screen lists its steps, and Ask for changes sends a follow-up on ${surface}`, async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    const state = { jobs: threadJobs(), calls: [] as string[][] }
    let stdin: string | undefined
    on('process.run', (_$, e) => { if (e.argv[2] === 'dispatch') stdin = e.init?.stdin; return fakeEngine(state)(e.argv) })
    await $.command.run({ command: 'podium', args: '' })
    const pane = await $.ui.mount({ plugin: 'podium', surface, component: 'Pane', props: { title: 'Podium', isFocused: true, bodyColumns: 70 }, requestId: 'podium' })
    await settle(pane)
    expect((await lookAll(pane, { key: 'open-j2' })).length).toBe(1)
    expect(await look(pane, { key: 'open-j1' })).toBeFalsy()
    expect(await look(pane, { type: 'Button', text: /Build the calculator/ })).toBeTruthy()
    await tap(pane, { key: 'open-j2' })
    expect(await look(pane, { type: 'Button', text: /▸ Steps · 2/ })).toBeTruthy()
    await tap(pane, { key: 'fold-job:j2:steps' })
    expect(await look(pane, { text: /2 · claude · Add CSS · same conversation/ })).toBeTruthy()
    await tap(pane, { key: 'ask-detail' })
    await tap(pane, { key: 'ask-agent-muse' })
    await type(pane, { key: 'ask-task', text: 'Fix the layout' })
    const call = state.calls.find((c) => c[0] === 'dispatch') ?? []
    expect(call.slice(0, 5)).toEqual(['dispatch', '--follow-up', 'j2', '--agent', 'muse'])
    expect(stdin).toBe('Fix the layout')
  })
}

test('the thread detail lists its steps and opens an earlier one', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const state = { jobs: threadJobs(), calls: [] as string[][], summary: 'ok' }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await $.ui.mount({ plugin: 'podium', surface: 'desktop', component: 'Pane', props: { title: 'Podium', isFocused: true, bodyColumns: 70 }, requestId: 'podium' })
  await tap(pane, { key: 'open-j2' })
  expect(await look(pane, { type: 'Button', text: /▸ Steps · 2/ })).toBeTruthy()
  expect(await look(pane, { key: 'ask-detail' })).toBeTruthy()
  await tap(pane, { key: 'fold-job:j2:steps' })
  await tap(pane, { key: 'step-j1' })
  expect(await look(pane, { text: /Build the calculator/ })).toBeTruthy()
  expect(await look(pane, { key: 'ask-detail' })).toBeFalsy()
})

test('the dispatch tool continues a job with followUp', async ($, on) => {
  const state = { jobs: [] as Job[], calls: [] as string[][] }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.tool.call({ tool: 'mcp__podium__dispatch', agent: 'codex', task: 'Review it', followUp: 'j2' } as any)
  const call = state.calls.find((c) => c[0] === 'dispatch') ?? []
  expect(call[call.indexOf('--follow-up') + 1]).toBe('j2')
})

// Each chat sees its own work.
for (const surface of ['terminal', 'desktop'] as const) {
  test(`other chats' active work shows with a label, and their finished work waits in a folded section on ${surface}`, async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('session.id', () => ({ value: 'me' }))
    const state = {
      jobs: [
        job({ id: 'm1', delivered: true, title: 'Mine done', origin: { session: 'me' } }),
        job({ id: 'o1', status: 'needs-review', delivered: true, permission: 'edit-worktree', title: 'Their review', origin: { session: 'other' } }),
        job({ id: 'o3', status: 'running', endedAt: null, title: 'Their run', origin: { session: 'other' } }),
        job({ id: 'o2', delivered: true, title: 'Their old work', origin: { session: 'other' } }),
        job({ id: 'o4', status: 'in-review', delivered: true, permission: 'edit-worktree', title: 'Their PR', pr: { ...PR, attention: null, checks: { total: 1, passed: 1, failed: 0, running: 0, failing: [] } }, origin: { session: 'other' } }),
      ],
      calls: [] as string[][],
    }
    on('process.run', (_$, e) => fakeEngine(state)(e.argv))
    await $.command.run({ command: 'podium', args: '' })
    const pane = await $.ui.mount({ plugin: 'podium', surface, component: 'Pane', props: { title: 'Podium', isFocused: true, bodyColumns: 70 }, requestId: 'podium' })
    await settle(pane)
    expect(await look(pane, { text: /Their review/ })).toBeTruthy()
    expect(await look(pane, { text: /Their run/ })).toBeTruthy()
    // Text keeps no key in the kit's drawing, so count the label: the other chat's Your turn, Working and In review rows
    // have it, this chat's work does not.
    expect(await look(pane, { type: 'Text', text: /^Codex finished · changes to review · from another chat$/ })).toBeTruthy()
    expect(await look(pane, { type: 'Text', text: /^1 of 1 checks passed · review: none yet · from another chat$/ })).toBeTruthy()
    expect((await lookAll(pane, { type: 'Text', text: /· from another chat$/ })).length).toBe(3)
    // This chat's finished work is folded too.
    expect(await look(pane, { text: /Mine done/ })).toBeFalsy()
    await tap(pane, { key: 'fold-list:done' })
    expect(await look(pane, { text: /Mine done/ })).toBeTruthy()
    expect(await look(pane, { type: 'Button', text: /▸ Other chats · 1/ })).toBeTruthy()
    expect(await look(pane, { text: /Their old work/ })).toBeFalsy()
    await tap(pane, { key: 'fold-list:others' })
    expect(await look(pane, { text: /Their old work/ })).toBeTruthy()
    // The job's own screen says where it came from, in its Details; this chat's job does not.
    await tap(pane, { key: 'open-o1' })
    await tap(pane, { key: 'fold-job:o1:details' })
    expect(await look(pane, { type: 'Text', text: /^Origin: another chat$/ })).toBeTruthy()
    await tap(pane, { key: 'back' })
    await tap(pane, { key: 'open-m1' })
    await tap(pane, { key: 'fold-job:m1:details' })
    expect(await look(pane, { type: 'Text', text: /^Job id: m1$/ })).toBeTruthy()
    expect(await look(pane, { type: 'Text', text: /^Origin: another chat$/ })).toBeFalsy()
  })
}

test('Clear empties Done, Show more brings it back, and Clear survives reopening the pane', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.id', () => ({ value: 'me' }))
  mock.store(on)
  const old = (n: number) => job({ id: `m${n}`, delivered: true, title: `Old ${n}`, createdAt: `2026-01-0${n}T10:00:00Z`, startedAt: `2026-01-0${n}T10:00:00Z`, endedAt: `2026-01-0${n}T10:05:00Z`, origin: { session: 'me' } })
  const state = { jobs: [1, 2, 3, 4, 5, 6, 7].map(old), calls: [] as string[][] }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  let pane = await $.ui.mount({ plugin: 'podium', surface: 'desktop', component: 'Pane', props: { title: 'Podium', isFocused: true, bodyColumns: 70 }, requestId: 'podium' })
  await settle(pane)
  // Done is folded: open it to see its rows, Clear and Show more.
  await tap(pane, { key: 'fold-list:done' })
  expect(await look(pane, { key: 'open-m7' })).toBeTruthy()
  expect(await look(pane, { key: 'open-m2' })).toBeFalsy()
  expect(await look(pane, { text: /Show 2 more/ })).toBeTruthy()
  await tap(pane, { key: 'link-clear' })
  expect(await look(pane, { key: 'open-m7' })).toBeFalsy()
  expect(await look(pane, { text: /Show 7 more/ })).toBeTruthy()
  await tap(pane, { key: 'link-done-more' })
  expect(await look(pane, { key: 'open-m1' })).toBeTruthy()
  expect(await look(pane, { text: /Show fewer/ })).toBeTruthy()
  await pane.unmount()
  await $.command.run({ command: 'podium', args: '' })
  pane = await $.ui.mount({ plugin: 'podium', surface: 'desktop', component: 'Pane', props: { title: 'Podium', isFocused: true, bodyColumns: 70 }, requestId: 'podium' })
  await settle(pane)
  await openFolds(pane)
  expect(await look(pane, { key: 'open-m7' })).toBeFalsy()
  expect(await look(pane, { text: /Show 7 more/ })).toBeTruthy()
})

// A failed job waits in Your turn until it is cleared, so Clear is there even with no Done rows.
for (const surface of ['terminal', 'desktop'] as const) {
  test(`a chat whose only finished job failed can clear it from Your turn on ${surface}`, async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('session.id', () => ({ value: 'me' }))
    mock.store(on)
    const state = { jobs: [job({ id: 'f1', status: 'failed', title: 'Update the docs', error: 'codex exited with code 1', delivered: true, origin: { session: 'me' } })], calls: [] as string[][] }
    on('process.run', (_$, e) => fakeEngine(state)(e.argv))
    await $.command.run({ command: 'podium', args: '' })
    const pane = await $.ui.mount({ plugin: 'podium', surface, component: 'Pane', props: { title: 'Podium', isFocused: true, bodyColumns: 70 }, requestId: 'podium' })
    await settle(pane)
    expect(await look(pane, { type: 'Text', text: /^Your turn · 1$/ })).toBeTruthy()
    expect(await look(pane, { key: 'turn-f1' })).toBeTruthy()
    expect(await look(pane, { key: 'fold-list:done' })).toBeFalsy()
    await tap(pane, { key: 'link-clear' })
    expect(await look(pane, { key: 'turn-f1' })).toBeFalsy()
    expect(await look(pane, { key: 'open-f1' })).toBeFalsy()
    expect(await look(pane, { type: 'Text', text: /^Your turn$/ })).toBeTruthy()
    expect(await look(pane, { key: 'link-clear' })).toBeFalsy()
    await pane.unmount()
  })
}

test('a chat with no work of its own says so and still offers other chats\' work', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.id', () => ({ value: 'me' }))
  const state = { jobs: [job({ id: 'o2', delivered: true, title: 'Their old work', origin: { session: 'other' } })], calls: [] as string[][] }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await $.ui.mount({ plugin: 'podium', surface: 'desktop', component: 'Pane', props: { title: 'Podium', isFocused: true, bodyColumns: 70 }, requestId: 'podium' })
  await settle(pane)
  expect(await look(pane, { text: /No jobs in this chat yet/ })).toBeTruthy()
  expect(await look(pane, { type: 'Button', text: /▸ Other chats · 1/ })).toBeTruthy()
})

// Install path.
const NEW_USER = { node: { ok: true, version: '22.3.0' }, git: { ok: true, version: '2.45.1' }, gh: { installed: false, signedIn: false, version: null }, tellClaude: true, welcomed: false }

for (const surface of ['terminal', 'desktop'] as const) {
  test(`a first run shows the welcome card; Try it starts a read-only job and Got it hides the card on ${surface}`, async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    let stdin: string | undefined
    const state = { jobs: [] as Job[], calls: [] as string[][], doctor: NEW_USER }
    on('process.run', (_$, e) => { if (e.argv[2] === 'dispatch') stdin = e.init?.stdin; return fakeEngine(state)(e.argv) })
    await $.command.run({ command: 'podium', args: '' })
    const pane = await $.ui.mount({ plugin: 'podium', surface, component: 'Pane', props: { title: 'Podium', isFocused: true, bodyColumns: 80 }, requestId: 'podium' })
    await settle(pane)
    expect(await look(pane, { text: /Welcome to Podium/ })).toBeTruthy()
    // The setup checks are folded when nothing needs fixing.
    await tap(pane, { key: 'fold-list:setup' })
    expect(await look(pane, { text: /Node 22\.3\.0/ })).toBeTruthy()
    expect(await look(pane, { text: /GitHub CLI not installed/ })).toBeTruthy()
    await tap(pane, { key: 'welcome-try' })
    const call = state.calls.find((c) => c[0] === 'dispatch') ?? []
    expect(call[call.indexOf('--permission') + 1]).toBe('read-only')
    expect(call[call.indexOf('--agent') + 1]).toBe('codex')
    expect(stdin).toMatch(/hello/i)
    await tap(pane, { key: 'welcome-done' })
    expect(state.calls.some((c) => c[0] === 'welcome' && c.includes('--done'))).toBe(true)
    expect(await look(pane, { text: /Welcome to Podium/ })).toBeFalsy()
  })
}

test('after an update the pane says so once, with what is new', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const state = { jobs: [] as Job[], calls: [] as string[][], version: { version: '0.2.0', previous: '0.1.0', notes: '- Sprints' } }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await $.ui.mount({ plugin: 'podium', surface: 'desktop', component: 'Pane', props: { title: 'Podium', isFocused: true, bodyColumns: 80 }, requestId: 'podium' })
  expect(await look(pane, { text: /Updated to 0\.2\.0/ })).toBeTruthy()
  expect(state.calls.some((c) => c[0] === 'version' && c.includes('--seen'))).toBe(true)
  await tap(pane, { key: 'whats-new' })
  expect(await look(pane, { text: /- Sprints/ })).toBeTruthy()
  await tap(pane, { key: 'whats-new-close' })
  expect(await look(pane, { text: /Updated to 0\.2\.0/ })).toBeFalsy()
})

test('Remove Podium\'s data asks first, with what will be lost, then removes', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const state = { jobs: [] as Job[], calls: [] as string[][] }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await $.ui.mount({ plugin: 'podium', surface: 'desktop', component: 'Pane', props: { title: 'Podium', isFocused: true, bodyColumns: 80 }, requestId: 'podium' })
  await tap(pane, { key: 'link-settings' })
  await tap(pane, { key: 'end-remove-data' })
  expect(await look(pane, { text: /2 jobs with unkept changes will be lost/ })).toBeTruthy()
  expect(state.calls.some((c) => c[0] === 'uninstall' && c.includes('--yes'))).toBe(false)
  await tap(pane, { key: 'remove-confirm' })
  expect(state.calls.some((c) => c[0] === 'uninstall' && c.includes('--yes'))).toBe(true)
  expect(await look(pane, { text: /\/plugin uninstall podium/ })).toBeTruthy()
})

// PRs.
const PR = { number: 12, url: 'https://github.com/o/r/pull/12', branch: 'feat/x', base: 'main', state: 'OPEN', checks: { total: 3, passed: 2, failed: 1, running: 0, failing: ['test (windows)'], failedRunId: '102' }, review: null, mergeable: 'MERGEABLE', comments: 0, autoMerge: false, attention: 'ci-failed' }
const GH_READY = { node: { ok: true, version: '22' }, git: { ok: true, version: '2.45' }, gh: { installed: true, signedIn: true, version: '2.9' }, tellClaude: true, welcomed: true }
const mountPane = ($: any) => $.ui.mount({ plugin: 'podium', surface: 'desktop', component: 'Pane', props: { title: 'Podium', isFocused: true, bodyColumns: 80 }, requestId: 'podium' })

test('Open PR on a ready job\'s screen makes it an In review PR with Merge when green', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const state = { jobs: [job({ id: 'n1', status: 'needs-review', delivered: true, permission: 'edit-worktree', changes: { files: 1, added: 3, removed: 0 } })], calls: [] as string[][], doctor: GH_READY }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await mountPane($)
  await settle(pane)
  await tap(pane, { key: 'open-n1' })
  expect(await look(pane, { key: 'end-discard' })).toBeTruthy()
  await tap(pane, { key: 'link-openpr' })
  expect(state.calls.some((c) => c[0] === 'pr' && c[1] === 'open')).toBe(true)
  expect(await look(pane, { text: /PR #12/ })).toBeTruthy()
  expect(await look(pane, { key: 'end-discard' })).toBeFalsy()
  await tap(pane, { key: 'automerge' })
  expect(state.calls.some((c) => c[0] === 'pr' && c[1] === 'auto' && c.includes('true'))).toBe(true)
  await tap(pane, { key: 'back' })
  expect(await look(pane, { type: 'Text', text: /^In review · 1$/ })).toBeTruthy()
  expect(await look(pane, { type: 'Button', text: /PR #12 Review the branch/ })).toBeTruthy()
})

test('without a signed-in GitHub CLI there is no Open PR button', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const state = { jobs: [job({ id: 'n1', status: 'needs-review', delivered: true, permission: 'edit-worktree', changes: { files: 1, added: 3, removed: 0 } })], calls: [] as string[][], doctor: { ...GH_READY, gh: { installed: false, signedIn: false, version: null } } }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await mountPane($)
  await settle(pane)
  await tap(pane, { key: 'open-n1' })
  expect(await look(pane, { key: 'link-openpr' })).toBeFalsy()
  expect(await look(pane, { key: 'end-discard' })).toBeTruthy()
})

test('a failing PR needs you, and Send pre-fills the change form with the failure', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const state = { jobs: [job({ id: 'p1', status: 'in-review', delivered: true, permission: 'edit-worktree', pr: PR })], calls: [] as string[][] }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await mountPane($)
  await settle(pane)
  expect(await look(pane, { type: 'Text', text: /^Your turn · 1$/ })).toBeTruthy()
  expect(await look(pane, { text: /checks failed: test \(windows\)/ })).toBeTruthy()
  await tap(pane, { key: 'turn-p1' })
  expect(state.calls.some((c) => c[0] === 'pr' && c[1] === 'fix' && c.includes('ci'))).toBe(true)
  expect(JSON.stringify(await drawnAll(pane))).toMatch(/CI failed on PR #12 \(test\)\. Fix it\./)
  await tap(pane, { key: 'ask-send' })
  const call = state.calls.find((c) => c[0] === 'dispatch') ?? []
  expect(call.slice(0, 3)).toEqual(['dispatch', '--follow-up', 'p1'])
})

test('a finished follow-up on a PR offers Push to PR instead of Keep', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const state = { jobs: [job({ id: 'p2', status: 'needs-review', delivered: true, permission: 'edit-worktree', worktree: '/c', pr: { ...PR, attention: null, checks: { total: 0, passed: 0, failed: 0, running: 0, failing: [] } }, changes: { files: 1, added: 1, removed: 0 } })], calls: [] as string[][], doctor: GH_READY }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await mountPane($)
  await settle(pane)
  await tap(pane, { key: 'open-p2' })
  expect(await look(pane, { key: 'push' })).toBeTruthy()
  expect(await look(pane, { key: 'keep' })).toBeFalsy()
  expect(await look(pane, { key: 'link-openpr' })).toBeFalsy()
  expect(await look(pane, { key: 'end-discard' })).toBeFalsy()
  await tap(pane, { key: 'push' })
  expect(state.calls.some((c) => c[0] === 'pr' && c[1] === 'push')).toBe(true)
})

test('Review with… sends a read-only review of the PR, and a finished review can be posted', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const open = { ...PR, attention: null, checks: { total: 0, passed: 0, failed: 0, running: 0, failing: [] } }
  const state = { jobs: [
    job({ id: 'r1', threadId: 'p3', step: null, kind: 'review', reviewOf: { number: 12, url: open.url }, status: 'done', delivered: true, createdAt: '2026-10-05T11:58:00Z', agent: 'claude' }),
    job({ id: 'p3', threadId: 'p3', status: 'in-review', delivered: true, permission: 'edit-worktree', pr: open }),
  ], calls: [] as string[][] }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await mountPane($)
  await settle(pane)
  await tap(pane, { key: 'open-p3' })
  await tap(pane, { key: 'link-post-r1' })
  expect(state.calls.some((c) => c[0] === 'pr' && c[1] === 'post' && c.includes('r1'))).toBe(true)
  await tap(pane, { key: 'link-reviewwith' })
  await tap(pane, { key: 'ask-send' })
  const call = state.calls.find((c) => c[0] === 'dispatch') ?? []
  expect(call[call.indexOf('--pr') + 1]).toBe('12')
})

test('standing instructions are set in Settings and shown on New job', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const state = { jobs: [] as Job[], calls: [] as string[][] }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await mountPane($)
  await tap(pane, { key: 'link-settings' })
  await tap(pane, { key: 'fold-settings:instructions' })
  await type(pane, { key: 'instructions', text: 'Follow AGENTS.md.' })
  expect(state.calls.some((c) => c[0] === 'settings' && c.includes('instructions'))).toBe(true)
  expect(await look(pane, { type: 'Text', text: /^Saved\.$/ })).toBeTruthy()
  await tap(pane, { key: 'new' })
  expect(await look(pane, { type: 'Text', text: / · \+ your standing instructions$/ })).toBeTruthy()
})

// The desktop pane is a Client.
test('on desktop the pane is a Client: navigation is immediate and data arrives by sync', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  // Jobs at work, so their rows are on the list (Done is folded).
  const state = { jobs: [job({ id: 'd1', status: 'running', endedAt: null, delivered: true, title: 'First' })], calls: [] as string[][] }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await $.ui.mount({ plugin: 'podium', surface: 'desktop', component: 'Pane', props: { title: 'Podium', isFocused: true, bodyColumns: 80 }, requestId: 'podium' })
  // The pane's own tree is just the Client; everything visible is drawn inside it.
  const outer = (await pane.drawn()) as any
  expect(outer.type).toBe('Client')
  expect(outer.props.key).toBe('podium-app')
  expect(await pane.find({ text: /First/, in: APP })).toBeTruthy()
  await pane.press({ key: 'link-agents' })
  expect(await pane.find({ text: /Your setup/, in: APP })).toBeTruthy()
  await pane.press({ key: 'back' })
  await settle(pane)
  state.jobs = [...state.jobs, job({ id: 'd2', status: 'running', endedAt: null, delivered: true, title: 'Second' })]
  await $.command.run({ command: 'podium', args: '' })
  await pane.advance(1100)
  await settle(pane)
  expect(await pane.find({ text: /Second/, in: APP })).toBeTruthy()
})

// The Client paints Buttons without chrome and Inputs without a border,
// so its table wraps them (hooks/client/look.tsx). The terminal keeps its own.
test('in the desktop Client, buttons sit in their own rows and fields have a box and a label above', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const state = { jobs: [] as Job[], calls: [] as string[][] }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await $.ui.mount({ plugin: 'podium', surface: 'desktop', component: 'Pane', props: { title: 'Podium', isFocused: true, bodyColumns: 80 }, requestId: 'podium' })
  await tap(pane, { key: 'new' })
  const tree = (await pane.drawn({ in: APP })) as any
  const parentOf = (node: any, test: (n: any) => boolean, parent: any = null): any => {
    if (!node || typeof node !== 'object') return null
    if (test(node)) return parent
    for (const c of [].concat(node.children ?? [])) { const hit = parentOf(c, test, node); if (hit) return hit }
    return null
  }
  const startBox = parentOf(tree, (n) => n.type === 'Button' && n.props?.key === 'start')
  expect(startBox?.type).toBe('Box')
  expect(startBox?.props?.backgroundColor).toBeTruthy()
  const taskBox = parentOf(tree, (n) => n.type === 'Input' && n.props?.key === 'task')
  expect(taskBox?.props?.borderStyle).toBe('round')
  // Anything that acts is outlined; a control whose symbol says so (▸ More options) stays text.
  expect(parentOf(tree, (n) => n.type === 'Button' && n.props?.key === 'back')?.props?.borderStyle).toBe('round')
  expect(parentOf(tree, (n) => n.type === 'Button' && n.props?.key === 'more')?.props?.borderStyle).toBeUndefined()
  expect(await look(pane, { text: /What should it do\?/ })).toBeTruthy()
})

test('a review asked for three times shows as one row with a count and one Post button', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const open = { ...PR, attention: null, checks: { total: 0, passed: 0, failed: 0, running: 0, failing: [] } }
  const review = (id: string, at: string) => job({ id, threadId: 'p3', step: null, kind: 'review', reviewOf: { number: 12, url: open.url }, status: 'done', delivered: true, createdAt: at, agent: 'claude', title: 'Review PR #12' })
  const state = { jobs: [
    review('r1', '2026-10-05T11:56:00Z'), review('r2', '2026-10-05T11:57:00Z'), review('r3', '2026-10-05T11:58:00Z'),
    job({ id: 'p3', threadId: 'p3', status: 'in-review', delivered: true, permission: 'edit-worktree', pr: open }),
  ], calls: [] as string[][] }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await mountPane($)
  await settle(pane)
  // The job's screen lists its steps (folded) and its Post links.
  await tap(pane, { key: 'open-p3' })
  await tap(pane, { key: 'fold-job:p3:steps' })
  expect(await look(pane, { text: /Review PR #12.*×3/ })).toBeTruthy()
  expect((await lookAll(pane, { text: /Post Claude's review/ })).filter((n: any) => n.type === 'Button').length).toBe(1)
})

test('in the desktop Client a long row title is cut to one line', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const long = 'Count slowly from 1 to 60, printing one number per second, and then say which numbers were prime and why each one is prime'
  const state = { jobs: [job({ id: 'l1', status: 'done', delivered: true, title: long })], calls: [] as string[][] }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await $.ui.mount({ plugin: 'podium', surface: 'desktop', component: 'Pane', props: { title: 'Podium', isFocused: true, bodyColumns: 60 }, requestId: 'podium' })
  await pane.resize({ columns: 60, rows: 40, in: APP })
  await settle(pane)
  await tap(pane, { key: 'fold-list:done' })
  const title = (await lookAll(pane, { key: 'open-l1' })).find((n: any) => n.type === 'Button') as any
  expect(title.props.label.endsWith('… ›')).toBe(true)
  // A row has no badge beside it: the whole width, about 1.25 characters a cell (row in hooks/tiles.tsx), and " ›".
  expect(title.props.label.length).toBeLessThanOrEqual(Math.floor((60 - 4) * 1.25) + 2)
})

// A Client's props count toward its tree's 100,000 characters: a long history must not blank the desktop pane.
test('on desktop a long history still draws: the newest jobs, a line for the older ones, and their details open', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const day = Date.UTC(2026, 8, 1)
  const old = (i: number) => job({
    id: `h${i}`, title: `History job ${i}: tidy the payout rounding`, status: 'kept', delivered: true, permission: 'edit-worktree',
    createdAt: new Date(day + i * 600_000).toISOString(), startedAt: new Date(day + i * 600_000).toISOString(), endedAt: new Date(day + i * 600_000 + 60_000).toISOString(),
    committed: { branch: `podium/h${i}`, head: 'abc1234', count: 1, commits: [{ sha: 'a1b2c3d', subject: 'Round payouts half-even' }] },
  })
  const state = { jobs: Array.from({ length: 400 }, (_, i) => old(i)), calls: [] as string[][] }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await mountPane($)
  await settle(pane)
  await tap(pane, { key: 'fold-list:done' })
  expect(await look(pane, { text: /History job 399/ })).toBeTruthy()
  expect(await look(pane, { text: /^\d+ finished jobs are not shown here; ask Claude for them\.$/ })).toBeTruthy()
  await tap(pane, { key: 'open-h399' })
  expect(await look(pane, { key: 'fold-job:h399:output' })).toBeTruthy()
  expect(await look(pane, { text: /History job 399/ })).toBeTruthy()
})

// When even the jobs at work are too many to send, the list must not call them finished.
test('on desktop, when even the jobs at work are too many to send, the list says some jobs are not shown', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const running = (i: number) => job({ id: `r${i}`, title: `Running job ${i}: ${'tidy the payout rounding '.repeat(8)}`, status: 'running', endedAt: null, permission: 'edit-worktree', worktree: `C:/w/r${i}`, delivered: true })
  const state = { jobs: Array.from({ length: 500 }, (_, i) => running(i)), calls: [] as string[][] }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await mountPane($)
  await settle(pane)
  expect(await look(pane, { text: /^Some jobs are not shown here; ask Claude for them\.$/ })).toBeTruthy()
  expect(await look(pane, { text: /finished jobs? (is|are) not shown/ })).toBeFalsy()
  await pane.unmount()
})

// Sprints in the pane and the chat.
const SPRINT = {
  id: 's1', name: 'Oct week 2', paused: false, finishedAt: null, autoMerge: false, news: 0,
  tickets: [
    { key: 'ABC-11', title: 'Login form', state: 'running', task: 2, of: 3, phase: 'review', agent: 'claude', reason: null, findings: null, pr: null, reviews: 1 },
    { key: 'ABC-12', title: 'Payouts', state: 'parked', task: 1, of: 2, phase: null, agent: 'codex', reason: 'Review failed twice on task 1', findings: 'x', pr: null, reviews: 0 },
  ],
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`a sprint shows as one row, its waiting ticket is in Your turn, and its jobs stay off the list, on ${surface}`, async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    const state = { jobs: [job({ id: 'sj', title: 'ABC-11 task 2: Add b', status: 'needs-review', delivered: true, sprint: { id: 's1', ticket: 'ABC-11', task: 2, role: 'author' } })], calls: [] as string[][], sprints: [SPRINT] }
    on('process.run', (_$, e) => fakeEngine(state)(e.argv))
    await $.command.run({ command: 'podium', args: '' })
    const pane = await $.ui.mount({ plugin: 'podium', surface, component: 'Pane', props: { title: 'Podium', isFocused: true, bodyColumns: 100 }, requestId: 'podium' })
    await settle(pane)
    expect(await look(pane, { type: 'Button', text: /Sprint · Oct week 2/ })).toBeTruthy()
    expect(await look(pane, { type: 'Text', text: /^0 of 2 done · 1 of 3 running: ABC-11$/ })).toBeTruthy()
    expect(await look(pane, { type: 'Button', text: /ABC-12 Payouts/ })).toBeTruthy()
    expect(await look(pane, { type: 'Text', text: /^Oct week 2 · Review failed twice on task 1$/ })).toBeTruthy()
    expect(await look(pane, { key: 'turn-s1-ABC-12' })).toBeTruthy()
    expect(await look(pane, { text: /ABC-11 task 2: Add b/ })).toBeFalsy()
    await pane.unmount()
  })
}

// As for jobs, the kit's session.append always fails: the news is claimed for this chat, and one message
// (headline first, then the details) goes in and is marked delivered.
test('sprint news is claimed for the sprint\'s chat; with no hidden row the details follow the headline, then it is marked', async ($, on) => {
  on('turn.complete', () => ({ text: '' }))
  on('session.id', () => ({ value: 'chat-1' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const state = { jobs: [] as Job[], calls: [] as string[][], sprints: [{ ...SPRINT, news: 1 }], inbox: [{ id: 's1:1', sprint: 'Oct week 2', text: 'ABC-12 (Payouts) needs you: Review failed twice on task 1\nStill broken.' }] }
  const heads: string[] = []
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  on('prompt.submit', (_$, e) => { heads.push(e.text); return { text: e.text } })
  await endTurn($)
  await endTurn($)
  expect(state.calls.some((c) => c[0] === 'sprint' && c[1] === 'inbox' && c.includes('chat-1') && c.includes('--here'))).toBe(true)
  expect(heads.length).toBe(1)
  expect(heads[0].startsWith('Podium: ABC-12 (Payouts) needs you: Review failed twice on task 1')).toBe(true)
  expect(heads[0]).toContain('Still broken.')
  expect(heads[0]).toContain('[Podium] Sprint updates:')
  expect(heads[0]).not.toContain('Do not repeat their line')
  expect(state.calls.filter((c) => c[0] === 'sprint' && c[1] === 'delivered')).toEqual([['sprint', 'delivered', '--ids', 's1:1']])
})

// Smoke run 2026-10-08: "Podium: 2 sprint updates" made no sense on its own. The headline names each update.
test('a batch of sprint news goes in as one message whose headline names each update', async ($, on) => {
  on('turn.complete', () => ({ text: '' }))
  on('session.id', () => ({ value: 'chat-1' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const inbox = [
    { id: 's1:1', sprint: 'Oct week 2', text: 'ABC-12 (Payouts) needs you: Review failed twice on task 1\nStill broken.' },
    { id: 's1:2', sprint: 'Oct week 2', text: 'ABC-11 (Login form): its plan is ready to approve.\nThe plan is docs/x.md.' },
  ]
  const state = { jobs: [] as Job[], calls: [] as string[][], sprints: [{ ...SPRINT, news: 2 }], inbox }
  const heads: string[] = []
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  on('prompt.submit', (_$, e) => { heads.push(e.text); return { text: e.text } })
  await endTurn($)
  await endTurn($)
  expect(heads.length).toBe(1)
  expect(heads[0].split('\n')[0]).toBe('Podium: ABC-12 (Payouts) needs you: Review failed twice on task 1 · ABC-11 (Login form): its plan is ready to approve')
  expect(heads[0]).toContain('Still broken.')
  expect(heads[0]).toContain('The plan is docs/x.md.')
  expect(heads[0]).not.toContain('sprint updates\n')
  expect(state.calls.filter((c) => c[0] === 'sprint' && c[1] === 'delivered')).toEqual([['sprint', 'delivered', '--ids', 's1:1,s1:2']])
})

test('sprint news whose message cannot be submitted is not marked, so it is tried again', async ($, on) => {
  on('turn.complete', () => ({ text: '' }))
  on('session.id', () => ({ value: 'chat-1' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const state = { jobs: [] as Job[], calls: [] as string[][], sprints: [{ ...SPRINT, news: 1 }], inbox: [{ id: 's1:1', sprint: 'Oct week 2', text: 'ABC-12 (Payouts) needs you' }] }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  on('prompt.submit', () => { throw new Error('reloaded') })
  await endTurn($)
  expect(state.calls.some((c) => c[0] === 'sprint' && c[1] === 'inbox')).toBe(true)
  expect(state.calls.some((c) => c[0] === 'sprint' && c[1] === 'delivered')).toBe(false)
})

test('with no sprints, the sprint inbox is never asked for', async ($, on) => {
  on('turn.complete', () => ({ text: '' }))
  on('session.id', () => ({ value: 'chat-1' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const state = { jobs: [] as Job[], calls: [] as string[][], inbox: [{ id: 's1:1', sprint: 'Oct week 2', text: 'ABC-12 (Payouts) needs you' }] }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  await endTurn($)
  await endTurn($)
  expect(state.calls.some((c) => c[0] === 'sprint' && c[1] === 'inbox')).toBe(false)
})

test('with sprints but no news, the sprint inbox is not asked for', async ($, on) => {
  on('turn.complete', () => ({ text: '' }))
  on('session.id', () => ({ value: 'chat-1' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const state = { jobs: [] as Job[], calls: [] as string[][], sprints: [SPRINT], inbox: [{ id: 's1:1', sprint: 'Oct week 2', text: 'ABC-12 (Payouts) needs you' }] }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  await endTurn($)
  await endTurn($)
  expect(state.calls.some((c) => c[0] === 'status')).toBe(true)
  expect(state.calls.some((c) => c[0] === 'sprint' && c[1] === 'inbox')).toBe(false)
})

test('with Claude not told, sprint news is a toast and is still marked delivered', async ($, on) => {
  on('turn.complete', () => ({ text: '' }))
  on('session.id', () => ({ value: 'chat-1' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const toasts: string[] = []
  on('ui.toast', (_$, e: any) => { toasts.push(typeof e === 'string' ? e : (e.text ?? e.message ?? JSON.stringify(e))); return { value: undefined } })
  const state = { jobs: [] as Job[], calls: [] as string[][], tell: false, sprints: [{ ...SPRINT, news: 1 }], inbox: [{ id: 's1:1', sprint: 'Oct week 2', text: 'ABC-12 (Payouts) needs you: Review failed twice on task 1' }] }
  const heads: string[] = []
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  on('prompt.submit', (_$, e) => { heads.push(e.text); return { text: e.text } })
  await endTurn($)
  await endTurn($)
  expect(heads).toEqual([])
  expect(toasts.some((t) => t.includes('Podium: ABC-12 (Payouts) needs you: Review failed twice on task 1'))).toBe(true)
  expect(state.calls.find((c) => c[0] === 'sprint' && c[1] === 'delivered')).toEqual(['sprint', 'delivered', '--ids', 's1:1'])
})

test('sprint news whose delivered mark failed is marked again, and never announced twice', async ($, on) => {
  on('turn.complete', () => ({ text: '' }))
  on('session.id', () => ({ value: 'chat-1' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const toasts: string[] = []
  on('ui.toast', (_$, e: any) => { toasts.push(typeof e === 'string' ? e : (e.text ?? e.message ?? JSON.stringify(e))); return { value: undefined } })
  // Claude isn't told here, so the news goes out as a toast (the kit cannot complete a session.append).
  const news = { id: 's1:1', sprint: 'Oct week 2', text: 'ABC-12 (Payouts) needs you: Review failed twice on task 1' }
  const state = { jobs: [] as Job[], calls: [] as string[][], tell: false, sprints: [{ ...SPRINT, news: 1 }], inbox: [news], deliveredFails: 2 }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  const delivered = () => state.calls.filter((c) => c[0] === 'sprint' && c[1] === 'delivered')
  await endTurn($)
  expect(toasts.filter((t) => t.includes('ABC-12 (Payouts) needs you')).length).toBe(1)
  expect(delivered().length).toBe(1)
  // Its claim expired before the mark went in: the inbox hands the same news back.
  state.inbox = [news]
  await endTurn($)
  expect(toasts.filter((t) => t.includes('ABC-12 (Payouts) needs you')).length).toBe(1)
  expect(delivered().length).toBe(3)
  expect(delivered().every((c) => c[3] === 's1:1')).toBe(true)
})

// A sprint whose saved state can't be read stays in the pane, saying so.
test('a sprint whose saved state cannot be read shows as a row saying so, and its board says why', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const card = { id: 's9', name: null, unreadable: "The sprint's saved state C:\\data\\sprints\\s9\\state\\000000000002.json is damaged (empty or not valid JSON).", draft: false, discarded: false, paused: false, finishedAt: null, autoMerge: false, maxParallel: null, news: 0, tickets: [] }
  const state = { jobs: [] as Job[], calls: [] as string[][], sprints: [card] }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await mountPane($)
  await settle(pane)
  expect(await look(pane, { type: 'Button', text: /^Sprint s9 ›$/ })).toBeTruthy()
  expect(await look(pane, { type: 'Text', text: /^Podium can't read this sprint's saved state$/ })).toBeTruthy()
  expect(await look(pane, { text: /No jobs in this chat yet/ })).toBeFalsy()
  await tap(pane, { key: 'open-board-s9' })
  expect(await look(pane, { text: /^Sprint s9: Podium can't read this sprint's saved state$/ })).toBeTruthy()
  expect(await look(pane, { text: /000000000002\.json is damaged/ })).toBeTruthy()
})

// An older state file still names the sprint, so the card is headed with the name.
test('a sprint whose saved state cannot be read is headed with its name when one is known', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const card = { id: '20261007-124611-75dc', name: 'Smoke 4', unreadable: "The sprint's saved state is damaged.", draft: false, discarded: false, paused: false, finishedAt: null, autoMerge: false, maxParallel: null, news: 0, tickets: [] }
  const state = { jobs: [] as Job[], calls: [] as string[][], sprints: [card] }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await mountPane($)
  await settle(pane)
  expect(await look(pane, { type: 'Button', text: /^Sprint Smoke 4 ›$/ })).toBeTruthy()
  expect(await look(pane, { text: /20261007-124611-75dc/ })).toBeFalsy()
  await tap(pane, { key: 'open-board-20261007-124611-75dc' })
  expect(await look(pane, { text: /^Sprint Smoke 4: Podium can't read this sprint's saved state$/ })).toBeTruthy()
  await pane.unmount()
})

// The board.
const task = (n: number, status: string, agent = 'muse', reviewer = 'codex') => ({ n, title: `Task ${n} title`, agent, reviewer, status, canAssign: status === 'to-do' })
const LIVE = {
  id: 's1', name: 'Oct week 2', draft: false, discarded: false, paused: false, finishedAt: null, autoMerge: false, maxParallel: 3, news: 0,
  tickets: [
    { key: 'ABC-11', title: 'Login form', state: 'running', task: 2, of: 3, phase: 'author', agent: 'muse', reason: null, findings: null, pr: null, reviews: 1, latest: 'sa0', tasks: [task(1, 'done'), task(2, 'current'), task(3, 'to-do')], canRetry: false, giveTo: null, canStop: false },
    { key: 'ABC-12', title: 'Payouts', state: 'parked', task: 2, of: 2, phase: null, agent: 'muse', reason: 'Review failed twice on task 2', findings: 'Missing test for rounding.', pr: null, reviews: 1, latest: 'sa1', tasks: [task(1, 'done'), { ...task(2, 'current'), canAssign: true }], canRetry: true, giveTo: 'reviewer', canStop: true },
  ],
}
const DRAFT = {
  ...LIVE, id: 's2', name: 'Oct week 3', draft: true,
  tickets: [
    { key: 'ABC-21', title: 'Export', state: 'pending', task: 1, of: 2, phase: null, agent: 'muse', reason: null, findings: null, pr: null, reviews: 0, latest: null, tasks: [task(1, 'to-do'), task(2, 'to-do')], canRetry: false, giveTo: null, canStop: false },
    { key: 'ABC-22', title: 'Import', state: 'pending', task: 1, of: 1, phase: null, agent: 'muse', reason: null, findings: null, pr: null, reviews: 0, latest: null, tasks: [task(1, 'to-do')], canRetry: false, giveTo: null, canStop: false },
  ],
}
// Plans waiting for the person, and "after".
const planTicket = (over: Record<string, unknown> = {}) => ({
  key: 'ABC-31', title: 'Export to CSV', state: 'plan-ready', task: 0, of: 0, phase: null, agent: 'muse', reason: null, findings: null, pr: null, reviews: 0,
  latest: 'sp1', tasks: [], canRetry: false, giveTo: null, canStop: true,
  plan: 'docs/plans/2026-10-07-abc-31-export-to-csv.md', writer: 'muse', reviewer: 'codex', canAssignPlan: true, after: [], waitingOn: [],
  proposed: [{ n: 1, title: 'Add the export button' }, { n: 2, title: 'Write the CSV' }], canApprove: true, canRevise: true, canOneTask: false, ...over,
})
const PLANS = {
  ...LIVE, id: 's3', name: 'Oct week 4',
  tickets: [
    planTicket(),
    planTicket({ key: 'ABC-32', title: 'Import', state: 'no-tasks', reason: "Couldn't find tasks in this plan", plan: 'docs/plans/2026-10-07-abc-32-import.md', proposed: null, canApprove: false, canOneTask: true }),
    { key: 'ABC-33', title: 'Reports', state: 'pending', task: 1, of: 1, phase: null, agent: 'muse', reason: null, findings: null, pr: null, reviews: 0, latest: null, tasks: [task(1, 'to-do')], canRetry: false, giveTo: null, canStop: true, after: ['ABC-31'], waitingOn: ['ABC-31'] },
  ],
}
const PLANLESS = {
  ...DRAFT, id: 's4', name: 'Oct week 5',
  tickets: [
    { ...DRAFT.tickets[0], key: 'ABC-41', title: 'Export', task: 0, of: 0, tasks: [], plan: null, writer: 'muse', reviewer: 'codex', canAssignPlan: true, after: [], waitingOn: [] },
    { ...DRAFT.tickets[1], key: 'ABC-42', title: 'Import', after: ['ABC-41'], waitingOn: [] },
  ],
}
const said =(state: { calls: string[][] }, line: string) => state.calls.some((c) => c.join(' ') === line)

test('Open board shows one sprint at once on desktop, with its buttons and rows; Back returns to the list', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const state = { jobs: [] as Job[], calls: [] as string[][], sprints: [LIVE] }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await mountPane($)
  await settle(pane)
  await pane.press({ key: 'open-board-s1' })
  // A navigation press: the Client draws the board before Podium answers.
  expect(await pane.find({ text: /▸ Options · 3 at once\s*$/, in: APP })).toBeTruthy()
  await settle(pane)
  expect(await look(pane, { key: 'open-s1-ABC-12' })).toBeTruthy()
  expect(await look(pane, { text: /Review failed twice on task 2/ })).toBeTruthy()
  await tap(pane, { key: 'board-pause' })
  expect(said(state, 'sprint pause --id s1')).toBe(true)
  await tap(pane, { key: 'back' })
  expect(await look(pane, { key: 'open-board-s1' })).toBeTruthy()
})

// The Client draws a pressed ticket at once from the sprint it holds, so it never flashes "no longer listed".
test('on desktop, a Your turn sprint ticket opens at once, never as "no longer listed"', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const state = { jobs: [] as Job[], calls: [] as string[][], sprints: [LIVE] }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await mountPane($)
  await settle(pane)
  await pane.press({ key: 'turn-s1-ABC-12' })
  // A navigation press: the Client draws the ticket before Podium answers.
  expect(await pane.find({ text: /no longer listed/, in: APP }).catch(() => undefined)).toBeFalsy()
  expect(await pane.find({ text: /^ABC-12 Payouts$/, in: APP })).toBeTruthy()
  await settle(pane)
  expect(await look(pane, { text: /no longer listed/ })).toBeFalsy()
  expect(await look(pane, { text: /^ABC-12 Payouts$/ })).toBeTruthy()
  await pane.unmount()
})

test('the draft board sets Merge when green and At once, starts, and discards after asking', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const state = { jobs: [] as Job[], calls: [] as string[][], sprints: [DRAFT] }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await mountPane($)
  await settle(pane)
  await tap(pane, { key: 'open-board-s2' })
  expect(await look(pane, { text: /^Nothing runs until you start it.$/ })).toBeTruthy()
  // Options are folded: open them to change them.
  await tap(pane, { key: 'fold-board:s2:options' })
  await tap(pane, { key: 'board-automerge' })
  expect(said(state, 'sprint options --id s2 --merge-when-green true')).toBe(true)
  // At once is a row of buttons; the chosen one (3) does nothing.
  await tap(pane, { key: 'board-atonce-3' })
  expect(state.calls.some((c) => c[0] === 'sprint' && c[1] === 'options' && c.includes('--at-once'))).toBe(false)
  await tap(pane, { key: 'board-atonce-2' })
  expect(said(state, 'sprint options --id s2 --at-once 2')).toBe(true)
  await tap(pane, { key: 'board-start' })
  expect(said(state, 'sprint start --id s2')).toBe(true)
  await tap(pane, { key: 'end-board-discard' })
  await tap(pane, { key: 'board-discard-yes' })
  expect(said(state, 'sprint discard --id s2')).toBe(true)
  expect(await look(pane, { key: 'open-board-s2' })).toBeTruthy()
})

// A slow edit must finish before the Start it feeds, however long it takes, so Start never launches with Merge when
// green still on.
test('on desktop, a slow Merge when green change finishes before Start begins', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const state = { jobs: [] as Job[], calls: [] as string[][], sprints: [DRAFT] }
  const seenBy: string[] = []
  on('process.run', async (_$, e) => {
    const verb = e.argv[2] === 'sprint' ? e.argv[3] : null
    if (verb === 'options' || verb === 'start') seenBy.push(`${verb} begins`)
    if (verb === 'options') await new Promise((r) => setTimeout(r, 900))
    if (verb === 'options') seenBy.push('options ends')
    return fakeEngine(state)(e.argv)
  })
  await $.command.run({ command: 'podium', args: '' })
  const pane = await mountPane($)
  await settle(pane)
  await tap(pane, { key: 'open-board-s2' })
  await tap(pane, { key: 'fold-board:s2:options' })
  await pane.press({ key: 'board-automerge' })
  await pane.press({ key: 'board-start' })
  for (let i = 0; i < 60 && !seenBy.includes('start begins'); i++) { await pane.advance(100).catch(() => {}); await new Promise((r) => setTimeout(r, 50)) }
  expect(seenBy).toEqual(['options begins', 'options ends', 'start begins'])
  await settle(pane)
  await pane.unmount()
})

// Two realistic 30-ticket sprints and 200 jobs still fit with every sprint on the list.
const bigSprint = (id: string, name: string) => ({
  ...LIVE, id, name, autoMerge: true,
  tickets: Array.from({ length: 30 }, (_, i) => {
    const key = `PAY-${100 + i}`
    const state = i < 3 ? 'running' : i < 12 ? 'parked' : i < 18 ? 'pr-open' : 'pending'
    return {
      key, title: `Payouts ${i}: round half-even across every currency and keep the ledger totals in step with the reports`,
      state, task: 2, of: 8, phase: state === 'running' ? 'author' : null, agent: 'codex',
      reason: state === 'parked' ? `Review failed twice on task 2: ${'the rounding still drifts on negative amounts and the ledger test is missing. '.repeat(3)}` : null,
      findings: state === 'parked' ? `Findings for ${key}: ${'The reviewer found that the rounding drifts on negative amounts; add a ledger test. '.repeat(20)}` : null,
      pr: state === 'pr-open' ? { number: 200 + i, url: `https://github.com/o/r/pull/${200 + i}` } : null, reviews: 1, latest: `${id}-st${i}`,
      tasks: Array.from({ length: 8 }, (_, n) => ({ ...task(n + 1, n < 1 ? 'done' : n === 1 ? 'current' : 'to-do', 'codex', 'claude'), title: `Task ${n + 1}: ${'make the payout rounding and the ledger agree on every currency '.repeat(2)}` })),
      canRetry: state === 'parked', giveTo: state === 'parked' ? 'writer' : null, canStop: state !== 'pr-open',
    }
  }),
})
test('on desktop, a large sprint board and 200 jobs still show every sprint card with Open board and Pause, and the board opens', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const big = bigSprint('s-big', 'Payouts sprint')
  const steps = Array.from({ length: 150 }, (_, i) => {
    const t = big.tickets[i % 30]
    return job({ id: `s-big-st${i}`, title: `${t.key} task 2: ${t.title}`, status: i < 3 ? 'running' : 'done', endedAt: i < 3 ? null : '2026-10-05T12:00:00Z', delivered: true, permission: 'edit-worktree', worktree: `C:/w/${t.key}`, sprint: { id: 's-big', ticket: t.key, task: 2, role: 'author' } })
  })
  const older = Array.from({ length: 50 }, (_, i) => job({ id: `f${i}`, title: `Finished job ${i}: tidy the payout rounding`, status: 'kept', delivered: true, committed: { branch: `podium/f${i}`, head: 'abc1234', count: 1, commits: [{ sha: 'a1b2c3d', subject: 'Round payouts half-even' }] } }))
  const state = { jobs: [...steps, ...older], calls: [] as string[][], sprints: [big, bigSprint('s-two', 'Ledger sprint')] }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await mountPane($)
  await settle(pane)
  // Each sprint is a row (its Pause is on its board); the parked tickets of both are in Your turn.
  for (const id of ['s-big', 's-two']) expect(await look(pane, { key: `open-board-${id}` })).toBeTruthy()
  expect(await look(pane, { type: 'Button', text: /Sprint · Payouts sprint/ })).toBeTruthy()
  expect((await lookAll(pane, { type: 'Text', text: /^6 of 30 done · 3 of 3 running: PAY-100, PAY-101, PAY-102$/ })).length).toBe(2)
  expect(await look(pane, { type: 'Text', text: /^Your turn · 18$/ })).toBeTruthy()
  expect(await look(pane, { key: 'turn-s-big-PAY-103' })).toBeTruthy()
  expect(await look(pane, { type: 'Text', text: /^Payouts sprint · Review failed twice on task 2/ })).toBeTruthy()
  expect(await look(pane, { text: /No jobs in this chat yet/ })).toBeFalsy()
  await tap(pane, { key: 'open-board-s-big' })
  await settle(pane)
  expect(await look(pane, { key: 'board-pause' })).toBeTruthy()
  expect(await look(pane, { text: /not shown here; ask Claude for them/ })).toBeFalsy()
  // A ticket opens its own screen; Back returns to the board, whose Pause still works.
  await openTicketOf(pane, 'PAY-103')
  expect(await look(pane, { text: /^Findings for PAY-103/ })).toBeTruthy()
  expect(await look(pane, { text: /No jobs in this chat yet/ })).toBeFalsy()
  await tap(pane, { key: 'back' })
  await tap(pane, { key: 'board-pause' })
  expect(said(state, 'sprint pause --id s-big')).toBe(true)
  await pane.unmount()
})

// 15 saved drafts of 30 ordinary tickets were over the desktop's bound even as cards (about 111,783
// characters): the props would be refused and the pane go blank or stale. Each card now keeps a few rows.
const draftSprint = (id: string, name: string, tickets = 30, taskTitle = 'do the next part of the export') => ({
  ...LIVE, id, name, draft: true,
  tickets: Array.from({ length: tickets }, (_, i) => ({
    key: `${id.toUpperCase()}-${100 + i}`, title: `Ticket ${i}: tidy the export screen and keep its totals in step`, state: 'pending',
    task: 1, of: 3, phase: null, agent: 'codex', reason: null, findings: null, pr: null, reviews: 0, latest: null,
    tasks: Array.from({ length: 3 }, (_, n) => ({ ...task(n + 1, 'to-do', 'codex', 'claude'), title: `Task ${n + 1}: ${taskTitle}` })),
    canRetry: false, giveTo: null, canStop: false,
  })),
})
test('on desktop, 15 drafts of 30 tickets show every card with Open board and a "more tickets" line, and a board opens whole', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const drafts = Array.from({ length: 15 }, (_, i) => draftSprint(`d${String(i).padStart(2, '0')}`, `Draft sprint ${i}`))
  const jobs = [job({ id: 'r1', title: 'Fix the login form', status: 'running', endedAt: null }), ...Array.from({ length: 20 }, (_, i) => job({ id: `f${i}`, title: `Finished job ${i}`, status: 'kept', delivered: true }))]
  const state = { jobs, calls: [] as string[][], sprints: drafts }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await mountPane($)
  await settle(pane)
  // A page of rows at a time: every draft, over the pages, as a row that opens its board and says it is a
  // draft of 30 tickets (Start and Discard are on its board).
  const seen = new Set<string>()
  let lines = 0
  for (let page = 0; page < 10; page++) {
    for (const d of drafts) {
      if (!(await look(pane, { key: `open-board-${d.id}` }))) continue
      seen.add(d.id)
    }
    lines += (await lookAll(pane, { type: 'Text', text: /^Draft · 30 tickets · not started$/ })).length
    expect(await look(pane, { text: /Fix the login form/ })).toBeTruthy()
    expect(await look(pane, { text: /more sprints? (is|are) not shown here/ })).toBeFalsy()
    if (!(await look(pane, { key: 'sprints-more' }))) break
    await tap(pane, { key: 'sprints-more' })
  }
  expect(seen.size).toBe(15)
  expect(lines).toBe(15)
  while (await look(pane, { key: 'sprints-earlier' })) await tap(pane, { key: 'sprints-earlier' })
  expect(await look(pane, { type: 'Button', text: /^Sprint · Draft sprint 7 ›$/ })).toBeTruthy()
  await tap(pane, { key: 'open-board-d07' })
  await settle(pane)
  expect(await look(pane, { key: 'board-start' })).toBeTruthy()
  expect(await look(pane, { key: 'open-ticket-D07-129' })).toBeTruthy()
  expect(await look(pane, { text: /more tickets? are not shown here/ })).toBeFalsy()
  await openTicketOf(pane, 'D07-129')
  await tap(pane, { key: 'fold-ticket:d07:D07-129:steps' })
  expect(await look(pane, { text: /^· Task 3: Task 3: do the next part of the export$/ })).toBeTruthy()
  expect(await look(pane, { key: 'up-D07-129' })).toBeTruthy()
  await tap(pane, { key: 'back' })
  expect(await look(pane, { key: 'board-start' })).toBeTruthy()
  await tap(pane, { key: 'back' })
  expect(await look(pane, { key: 'open-board-d14' })).toBeTruthy()
  await pane.unmount()
})

// 60 saved drafts fit the model's budget, but drawn as 60 cards the list was past the desktop page's
// bounds, so the Client drew the "couldn't draw" note, whose Back led to the same list. The list now draws a page of
// sprint rows (running first, then those that need you, then the rest newest first) and a "more sprints" control.
const sixtyDrafts = () => Array.from({ length: 60 }, (_, i) => draftSprint(`d${String(i).padStart(2, '0')}`, `Draft sprint ${i}`, 4))
async function pageTo(pane: any, id: string) {
  for (let i = 0; i < 30 && !(await look(pane, { key: `open-board-${id}` })); i++) {
    expect(await look(pane, { key: 'sprints-more' })).toBeTruthy()
    await tap(pane, { key: 'sprints-more' })
  }
  expect(await look(pane, { key: `open-board-${id}` })).toBeTruthy()
}
test('on desktop, 60 saved drafts draw a page of rows with a "more sprints" control, and paging reaches the last draft, whose Discard works', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const state = { jobs: [] as Job[], calls: [] as string[][], sprints: sixtyDrafts() }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await mountPane($)
  await settle(pane)
  // Newest first, each a row that opens its board (its Start and Discard are there); the oldest is on a later page.
  expect(await look(pane, { key: 'open-board-d59' })).toBeTruthy()
  expect(await look(pane, { key: 'open-board-d00' })).toBeFalsy()
  expect(await look(pane, { text: /^Sprints 1–\d+ of 60 · \d+ more$/ })).toBeTruthy()
  expect(await look(pane, { key: 'sprints-earlier' })).toBeFalsy()
  await tap(pane, { key: 'sprints-more' })
  expect(await look(pane, { key: 'open-board-d59' })).toBeFalsy()
  expect(await look(pane, { key: 'sprints-earlier' })).toBeTruthy()
  await pageTo(pane, 'd00')
  expect(await look(pane, { text: /^Sprints \d+–60 of 60$/ })).toBeTruthy()
  expect(await look(pane, { key: 'sprints-more' })).toBeFalsy()
  await tap(pane, { key: 'open-board-d00' })
  expect(await look(pane, { key: 'board-start' })).toBeTruthy()
  await tap(pane, { key: 'end-board-discard' })
  await tap(pane, { key: 'board-discard-yes' })
  expect(said(state, 'sprint discard --id d00')).toBe(true)
  // The list again (a discarded draft's board closes), and back to its first page.
  expect(await look(pane, { key: 'sprints-earlier' })).toBeTruthy()
  for (let i = 0; i < 30 && (await look(pane, { key: 'sprints-earlier' })); i++) await tap(pane, { key: 'sprints-earlier' })
  expect(await look(pane, { key: 'open-board-d59' })).toBeTruthy()
  await pane.unmount()
})

test('on desktop, 60 drafts beside a running sprint and jobs: the running sprint comes first, the jobs still show, and every draft can be reached', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const running = { ...LIVE, id: 'a-run', name: 'Running sprint' }
  const jobs = [
    ...Array.from({ length: 5 }, (_, i) => job({ id: `r${i}`, title: `Running job ${i}: fix the export`, status: 'running', endedAt: null })),
    ...Array.from({ length: 20 }, (_, i) => job({ id: `f${i}`, title: `Finished job ${i}`, status: 'kept', delivered: true })),
    ...Array.from({ length: 12 }, (_, i) => job({ id: `a-run-st${i}`, title: `ABC-11 task 2: Login form`, status: i ? 'done' : 'running', endedAt: i ? '2026-10-05T12:00:00Z' : null, delivered: true, sprint: { id: 'a-run', ticket: 'ABC-11', task: 2, role: 'author' } })),
  ]
  const state = { jobs, calls: [] as string[][], sprints: [...sixtyDrafts().slice(0, 30), running, ...sixtyDrafts().slice(30)] }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await mountPane($)
  await settle(pane)
  expect(await look(pane, { key: 'open-board-a-run' })).toBeTruthy()
  expect(await look(pane, { type: 'Text', text: /^0 of 2 done · 1 of 3 running: ABC-11$/ })).toBeTruthy()
  expect(await look(pane, { key: 'turn-a-run-ABC-12' })).toBeTruthy()
  expect(await look(pane, { key: 'open-board-d59' })).toBeTruthy()
  expect(await look(pane, { text: /^Sprints 1–\d+ of 61 · \d+ more$/ })).toBeTruthy()
  expect(await look(pane, { text: /Running job 4: fix the export/ })).toBeTruthy()
  expect(await look(pane, { key: 'sprints-more' })).toBeTruthy()
  await pageTo(pane, 'd00')
  expect(await look(pane, { text: /Running job 4: fix the export/ })).toBeTruthy()
  await tap(pane, { key: 'open-board-d00' })
  await settle(pane)
  expect(await look(pane, { key: 'board-start' })).toBeTruthy()
  await pane.unmount()
})

function drawnByKey(n: any, key: string): any {
  if (!n || typeof n !== 'object') return null
  if (n.props?.key === key || n.key === key) return n
  for (const c of n.children ?? []) { const f = drawnByKey(c, key); if (f) return f }
  return null
}
// The list's page of sprints is sized by what a row costs (cardCost in mod/client.js): never less than the row the kit draws.
test('on desktop, a sprint row never draws more than cardCost says it costs', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const unreadable = { id: 'u1', name: 'Broken sprint', unreadable: 'Podium could not show this sprint (the state file is damaged).', draft: false, discarded: false, paused: false, finishedAt: null, autoMerge: false, maxParallel: null, news: 0, tickets: [] }
  const sprints = [draftSprint('d01', 'Draft sprint 1', 4), draftSprint('d02', `Long ${'name '.repeat(80)}`, 30), { ...LIVE, id: 'a-run' }, bigSprint('s-big', 'Payouts sprint'), unreadable]
  const state = { jobs: [] as Job[], calls: [] as string[][], sprints }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await mountPane($)
  await settle(pane)
  const tree = await pane.drawn({ in: APP })
  for (const s of sprints) {
    const drawn = drawnByKey(tree, `item-board-${s.id}`)
    expect(drawn).toBeTruthy()
    const got = pageSize(drawn)
    const cost = cardCost(capRows(s, CARD_ROWS))
    expect(got.nodes).toBeLessThanOrEqual(cost.nodes)
    expect(got.chars).toBeLessThanOrEqual(cost.chars)
  }
  await pane.unmount()
})

// When the list itself was what the page would refuse, the note's Back led back to the same list. The
// list now falls back to a short one (the header and a page of sprint rows, no job rows), so no note leads to itself.
const TOO_LONG = /This list is too long for this pane, so it shows only your sprints\. Ask Claude about your jobs\./
test('on desktop, a list the page would refuse draws a short list instead, and the note\'s Back can\'t loop', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  // 300 small jobs at work fit the model but their rows draw more than the page's 2,000 elements and texts. (A
  // row draws fewer elements than a card did, so 150 jobs as rows no longer overflow it: 1,234 elements, 82,674 characters.)
  const jobs = Array.from({ length: 300 }, (_, i) => ({ id: `r${i}`, agent: 'codex', title: `Running job ${i}`, status: 'running', permission: 'read-only', createdAt: '2026-10-05T11:56:00Z' }))
  const many = { ...LIVE, tickets: [{ ...LIVE.tickets[1], tasks: Array.from({ length: 600 }, (_, i) => ({ ...task(i + 1, 'done'), title: `T${i + 1}` })) }] }
  const state = { jobs, calls: [] as string[][], sprints: [many, ...sixtyDrafts()] }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  const pane = allowNote(await mountPane($))
  await settle(pane)
  expect(await look(pane, { text: TOO_LONG })).toBeTruthy()
  expect(await look(pane, { key: 'draw-failed-back' })).toBeFalsy()
  expect(await look(pane, { text: TOO_MUCH })).toBeFalsy()
  expect(await look(pane, { key: 'open-board-s1' })).toBeTruthy()
  expect(await look(pane, { key: 'turn-s1-ABC-12' })).toBeTruthy()
  expect(await look(pane, { key: 'sprints-more' })).toBeTruthy()
  expect(await look(pane, { text: /^Some jobs are not shown here; ask Claude for them\.$/ })).toBeTruthy()
  // A ticket's Steps and Who works on it, open, that the page would refuse (600 tasks): the note, whose Back goes to the
  // short list, never to the note again.
  await tap(pane, { key: 'open-board-s1' })
  await openTicketOf(pane, 'ABC-12')
  await tap(pane, { key: 'fold-ticket:s1:ABC-12:steps' })
  await tap(pane, { key: 'fold-ticket:s1:ABC-12:who' })
  expect(await look(pane, { text: TOO_MUCH })).toBeTruthy()
  await tap(pane, { key: 'draw-failed-back' })
  expect(await look(pane, { text: TOO_MUCH })).toBeFalsy()
  expect(await look(pane, { key: 'draw-failed-back' })).toBeFalsy()
  expect(await look(pane, { text: TOO_LONG })).toBeTruthy()
  expect(await look(pane, { key: 'open-board-s1' })).toBeTruthy()
  // Paging still works there, and reaches the oldest draft.
  await pageTo(pane, 'd00')
  expect(pageProblem(await pane.drawn({ in: APP }))).toBe(null)
  await pane.unmount()
})

// The note on the list itself (its short list can't be drawn either, or the list throws) offers no Back: Back leads
// to the list, so it would only show the same note again.
test('a note on the list itself has no Back to the list; on any other screen it has one', async () => {
  const ui = clientLook({ Box: 'Box', Text: 'Text', Button: 'Button', Input: 'Input' }, PALETTES.dark) as any
  const go = { backToList: () => {} } as any
  const model = { palette: 'dark', view: { screen: 'list', id: null } } as any
  for (const [view, isList] of [[{ screen: 'list', id: null }, true], [{ screen: 'sprint', id: null }, true], [{ screen: 'detail', id: null }, true], [{ screen: 'sprint', id: 's1' }, false], [{ screen: 'detail', id: 'j1' }, false], [{ screen: 'settings', id: null }, false]] as const) {
    expect(isListView(view as any)).toBe(isList)
    const drawn = JSON.stringify(drawFailed(ui, { ...model, view }, go, 'This screen has too much to show here.', 'why', !isListView(view as any)))
    expect(drawn.includes('draw-failed-back')).toBe(!isList)
    expect(drawn.includes('Ask Claude about your jobs and sprints.')).toBe(isList)
  }
})

// ---- Settings ----
for (const surface of ['terminal', 'desktop'] as const) {
  test(`Settings: Tell Claude on top, the rest folded with their values, Remove last and asking first, on ${surface}`, async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    const state = { jobs: [] as Job[], calls: [] as string[][] }
    on('process.run', (_$, e) => fakeEngine(state)(e.argv))
    await $.command.run({ command: 'podium', args: '' })
    const pane = await $.ui.mount({ plugin: 'podium', surface, component: 'Pane', props: { title: 'Podium', isFocused: true, bodyColumns: 80 }, requestId: 'podium' })
    await settle(pane)
    await tapFirst(pane, ['link-settings', 'settings'])
    expect(await look(pane, { type: 'Button', text: /☑ Tell Claude when a job finishes/ })).toBeTruthy()
    expect(await look(pane, { type: 'Button', text: /▸ Instructions for every agent · none/ })).toBeTruthy()
    expect(await look(pane, { type: 'Button', text: /▸ Storage · 30 \/ 90 days/ })).toBeTruthy()
    expect(await look(pane, { type: 'Button', text: /▸ Limits · 500 MB, 30 min/ })).toBeTruthy()
    expect(await look(pane, { key: 'prune' })).toBeFalsy()
    await tap(pane, { key: 'fold-settings:storage' })
    await tap(pane, { key: 'prune' })
    expect(state.calls.some((c) => c[0] === 'prune')).toBe(true)
    await tap(pane, { key: 'end-remove-data' })
    expect(await look(pane, { type: 'Text', text: /This deletes 1\.0 MB of Podium's data/ })).toBeTruthy()
    expect(state.calls.some((c) => c[0] === 'uninstall' && c.includes('--yes'))).toBe(false)
    await tap(pane, { key: 'remove-confirm' })
    expect(state.calls.some((c) => c[0] === 'uninstall' && c.includes('--yes'))).toBe(true)
    await pane.unmount()
  })
}

test('nothing Settings showed before is lost: open every fold', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const state = { jobs: [] as Job[], calls: [] as string[][] }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await mountPane($)
  await settle(pane)
  await tapFirst(pane, ['link-settings', 'settings'])
  await openFolds(pane)
  const text = await drawnText(pane)
  for (const fact of ['Tell Claude when a job finishes', 'All repos', 'This repo', "Added to the start of every job's prompt", 'Compress full output after (days)', 'Delete full output after (days)', 'Clean up now', 'Warn before copying repos larger than (MB)', 'Ask about long jobs after (minutes)', "Removes every job, Podium's copies and its settings", "Remove Podium's data"]) expect(text).toContain(fact)
  await pane.unmount()
})

test('on desktop, a sprint too big to send whole opens as a board with its first rows and says how many more', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const huge = draftSprint('dh', 'Huge draft', 150, 'make the export and the ledger agree on every currency and every rounding rule '.repeat(4))
  const state = { jobs: [] as Job[], calls: [] as string[][], sprints: [huge] }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await mountPane($)
  await settle(pane)
  // Its card fits whole (no tasks); its board, with every task, does not.
  expect(await look(pane, { key: 'open-board-dh' })).toBeTruthy()
  await tap(pane, { key: 'open-board-dh' })
  await settle(pane)
  expect(await look(pane, { key: 'board-start' })).toBeTruthy()
  expect(await look(pane, { text: /^Huge draft · draft$/ })).toBeTruthy()
  expect(await look(pane, { text: /^… and \d+ more tickets are not shown here; ask Claude for them\.$/ })).toBeTruthy()
  await openTicketOf(pane, 'DH-104')
  await tap(pane, { key: 'fold-ticket:dh:DH-104:steps' })
  expect(await look(pane, { text: /^· Task 1: Task 1: make the export/ })).toBeTruthy()
  // The last row it has can still move down: the sprint goes on past it.
  expect(await look(pane, { key: 'down-DH-104' })).toBeTruthy()
  await pane.unmount()
})

test('the sprint tool makes a draft and its board opens in the pane', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const state = { jobs: [] as Job[], calls: [] as string[][], sprints: [DRAFT] }
  let stdin: string | undefined
  on('process.run', (_$, e) => { if (e.argv[2] === 'sprint' && e.argv[3] === 'draft') stdin = e.init?.stdin; return fakeEngine(state)(e.argv) })
  const r = await $.tool.call({ tool: 'mcp__podium__sprint', action: 'draft', name: 'Oct week 3', tickets: [{ key: 'ABC-21', plan: 'p.md', agent: 'muse', reviewer: 'codex' }] } as any)
  expect(String(r.result)).toMatch(/This is a draft: nothing runs yet/)
  expect(JSON.parse(stdin ?? '{}').name).toBe('Oct week 3')
  // The tool opens the pane on the board itself (/podium would open on the list); the sprint arrives
  // with the pane's first refresh, a sync later.
  const pane = await mountPane($)
  for (let i = 0; i < 20 && !(await look(pane, { key: 'board-start' })); i++) await settle(pane)
  expect(await look(pane, { text: /^Nothing runs until you start it.$/ })).toBeTruthy()
  expect(await look(pane, { key: 'board-start' })).toBeTruthy()
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`a board row opens to its tasks; Retry, Give to another agent, a reviewer pick, Stop after asking, and Steps and diff, on ${surface}`, async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    const state = { jobs: [job({ id: 'sa1', title: 'ABC-12 task 2: Round the payouts', status: 'done', delivered: true, sprint: { id: 's1', ticket: 'ABC-12', task: 2, role: 'author' } })], calls: [] as string[][], sprints: [LIVE] }
    on('process.run', (_$, e) => fakeEngine(state)(e.argv))
    await $.command.run({ command: 'podium', args: '' })
    const pane = await $.ui.mount({ plugin: 'podium', surface, component: 'Pane', props: { title: 'Podium', isFocused: true, bodyColumns: 100 }, requestId: 'podium' })
    await settle(pane)
    await tap(pane, { key: 'open-board-s1' })
    expect(await look(pane, { text: /Missing test for rounding\./ })).toBeFalsy()
    await openTicketOf(pane, 'ABC-12')
    // The row opens the ticket's own screen: why it stopped; Steps and Who works on it are folds.
    expect(await look(pane, { text: /Missing test for rounding\./ })).toBeTruthy()
    expect(await look(pane, { text: /^✓ Task 1: Task 1 title$/ })).toBeFalsy()
    await tap(pane, { key: 'fold-ticket:s1:ABC-12:steps' })
    expect(await look(pane, { text: /^✓ Task 1: Task 1 title$/ })).toBeTruthy()
    await tap(pane, { key: 'fold-ticket:s1:ABC-12:who' })
    expect(await look(pane, { text: /^Task 1: Writer Muse · Reviewer Codex$/ })).toBeTruthy()
    expect(await look(pane, { key: 'retry-ABC-11' })).toBeFalsy()
    await tap(pane, { key: 'retry-ABC-12' })
    expect(said(state, 'sprint retry --id s1 --ticket ABC-12')).toBe(true)
    // Give to another agent…: one button per other ready agent, never the stuck task's own reviewer.
    expect(await look(pane, { key: 'giveto-ABC-12-muse' })).toBeFalsy()
    await tap(pane, { key: 'give-ABC-12' })
    expect(await look(pane, { text: /^Give it to \(to review task 2\):$/ })).toBeTruthy()
    expect(await look(pane, { key: 'giveto-ABC-12-codex' })).toBeFalsy()
    await tap(pane, { key: 'giveto-ABC-12-muse' })
    expect(said(state, 'sprint retry --id s1 --ticket ABC-12 --agent muse')).toBe(true)
    await tap(pane, { key: 'change-ABC-12-2' })
    await tap(pane, { key: 'reviewer-ABC-12-2-muse' })
    expect(said(state, 'sprint assign --id s1 --ticket ABC-12 --task 2 --reviewer muse')).toBe(true)
    await tap(pane, { key: 'end-stop-ABC-12' })
    expect(await look(pane, { text: /^Stop ABC-12\?/ })).toBeTruthy()
    expect(state.calls.some((c) => c[0] === 'sprint' && c[1] === 'stop')).toBe(false)
    await tap(pane, { key: 'stop-yes-ABC-12' })
    expect(said(state, 'sprint stop --id s1 --ticket ABC-12')).toBe(true)
    expect(await look(pane, { text: /^Stop ABC-12\?/ })).toBeFalsy()
    await tap(pane, { key: 'open-steps-ABC-12' })
    expect(await look(pane, { text: /ABC-12 task 2: Round the payouts/ })).toBeTruthy()
    await pane.unmount()
  })
}

test('a draft row moves, sets writers and reviewers for every task or one, and is removed', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const state = { jobs: [] as Job[], calls: [] as string[][], sprints: [DRAFT] }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await mountPane($)
  await settle(pane)
  await tap(pane, { key: 'open-board-s2' })
  await openTicketOf(pane, 'ABC-21')
  expect(await look(pane, { key: 'up-ABC-21' })).toBeFalsy()
  await tap(pane, { key: 'down-ABC-21' })
  expect(said(state, 'sprint move --id s2 --ticket ABC-21 --to down')).toBe(true)
  await tap(pane, { key: 'fold-ticket:s2:ABC-21:who' })
  await tap(pane, { key: 'change-ABC-21-all' })
  await tap(pane, { key: 'ticket-writer-ABC-21-codex' })
  expect(said(state, 'sprint assign --id s2 --ticket ABC-21 --agent codex')).toBe(true)
  await tap(pane, { key: 'change-ABC-21-2' })
  await tap(pane, { key: 'reviewer-ABC-21-2-muse' })
  expect(said(state, 'sprint assign --id s2 --ticket ABC-21 --task 2 --reviewer muse')).toBe(true)
  await tap(pane, { key: 'remove-ABC-21' })
  expect(said(state, 'sprint remove --id s2 --ticket ABC-21')).toBe(true)
  // Back from the ticket's screen is the board.
  await tap(pane, { key: 'back' })
  expect(await look(pane, { key: 'board-start' })).toBeTruthy()
})

// Buttons, not dropdowns: a redraw shut an open dropdown, and dark mode hid its options.
const ask = (state: { calls: string[][] }) => state.calls.some((c) => c[0] === 'sprint' && c[1] === 'assign')
for (const surface of ['terminal', 'desktop'] as const) {
  test(`a task's Change… opens its Writer and Reviewer buttons, one picker at a time; a pick assigns and closes it, on ${surface}`, async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    const state = { jobs: [] as Job[], calls: [] as string[][], sprints: [DRAFT] }
    on('process.run', (_$, e) => fakeEngine(state)(e.argv))
    await $.command.run({ command: 'podium', args: '' })
    const pane = await $.ui.mount({ plugin: 'podium', surface, component: 'Pane', props: { title: 'Podium', isFocused: true, bodyColumns: 100 }, requestId: 'podium' })
    await settle(pane)
    await tap(pane, { key: 'open-board-s2' })
    await openTicketOf(pane, 'ABC-21')
    await tap(pane, { key: 'fold-ticket:s2:ABC-21:who' })
    expect(await look(pane, { text: /^Every task: Writer Muse · Reviewer Codex$/ })).toBeTruthy()
    expect((await lookAll(pane, { text: /^Task \d: Writer Muse · Reviewer Codex$/ })).length).toBe(2)
    expect(await look(pane, { key: 'writer-ABC-21-1-codex' })).toBeFalsy()
    expect(await look(pane, { text: /^\s*Change…\s*$/ })).toBeTruthy()
    await tap(pane, { key: 'change-ABC-21-1' })
    expect(await look(pane, { key: 'writer-ABC-21-1-codex' })).toBeTruthy()
    expect(await look(pane, { key: 'reviewer-ABC-21-1-muse' })).toBeTruthy()
    expect(await look(pane, { text: /^\s*Done\s*$/ })).toBeTruthy()
    // The chosen agent's button does nothing.
    await tap(pane, { key: 'writer-ABC-21-1-muse' })
    expect(ask(state)).toBe(false)
    expect(await look(pane, { key: 'writer-ABC-21-1-codex' })).toBeTruthy()
    // One picker open at a time across the board.
    await tap(pane, { key: 'change-ABC-21-2' })
    expect(await look(pane, { key: 'writer-ABC-21-1-codex' })).toBeFalsy()
    expect(await look(pane, { key: 'writer-ABC-21-2-codex' })).toBeTruthy()
    // Done closes it.
    await tap(pane, { key: 'change-ABC-21-2' })
    expect(await look(pane, { key: 'writer-ABC-21-2-codex' })).toBeFalsy()
    // A pick assigns that task and closes the picker.
    await tap(pane, { key: 'change-ABC-21-1' })
    await tap(pane, { key: 'writer-ABC-21-1-codex' })
    expect(said(state, 'sprint assign --id s2 --ticket ABC-21 --task 1 --agent codex')).toBe(true)
    expect(await look(pane, { key: 'writer-ABC-21-1-codex' })).toBeFalsy()
    // Change for every task… assigns the whole ticket.
    expect(await look(pane, { text: /^\s*Change for every task…\s*$/ })).toBeTruthy()
    await tap(pane, { key: 'change-ABC-21-all' })
    await tap(pane, { key: 'ticket-reviewer-ABC-21-codex' })
    expect(said(state, 'sprint assign --id s2 --ticket ABC-21 --reviewer codex')).toBe(false)
    await tap(pane, { key: 'ticket-reviewer-ABC-21-muse' })
    expect(said(state, 'sprint assign --id s2 --ticket ABC-21 --reviewer muse')).toBe(true)
    expect(await look(pane, { key: 'ticket-reviewer-ABC-21-muse' })).toBeFalsy()
    // Opening another ticket's screen closes an open picker.
    await tap(pane, { key: 'change-ABC-21-1' })
    await tap(pane, { key: 'back' })
    await openTicketOf(pane, 'ABC-22')
    await tap(pane, { key: 'back' })
    await openTicketOf(pane, 'ABC-21')
    expect(await look(pane, { key: 'writer-ABC-21-1-codex' })).toBeFalsy()
    await pane.unmount()
  })
}

test('a draft ticket whose tasks have different agents says Several agents, and a pick sets every task', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const MIXED = { ...DRAFT, tickets: [{ ...DRAFT.tickets[0], tasks: [task(1, 'to-do', 'muse'), task(2, 'to-do', 'codex')] }, DRAFT.tickets[1]] }
  const state = { jobs: [] as Job[], calls: [] as string[][], sprints: [MIXED] }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await mountPane($)
  await settle(pane)
  await tap(pane, { key: 'open-board-s2' })
  await openTicketOf(pane, 'ABC-21')
  await tap(pane, { key: 'fold-ticket:s2:ABC-21:who' })
  expect(await look(pane, { text: /^Every task: Several agents$/ })).toBeTruthy()
  await tap(pane, { key: 'change-ABC-21-all' })
  await tap(pane, { key: 'ticket-writer-ABC-21-muse' })
  expect(said(state, 'sprint assign --id s2 --ticket ABC-21 --agent muse')).toBe(true)
})

const ADAPTER = {
  name: 'gemini', label: 'Gemini', command: 'gemini', baseArgs: ['-p'], promptVia: 'stdin', modelFlag: null, versionArgs: ['--version'],
  permissions: { 'read-only': [], 'edit-worktree': [], 'own-config': [], 'full-access': [] }, verified: false,
}
const CLAUDE_AGENT = { name: 'claude', label: 'Claude', installed: true, version: '2.1', signedIn: true, verified: true, source: 'builtin', enabled: true, defaultPermission: 'edit-worktree', stats: { jobs: 0, used: 0 } }
const answer = (body: unknown) => ({ value: { exitCode: 0, stdout: JSON.stringify(body) + '\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the ask form's agent, an agent's default permission, Send the task by and New job's model are buttons on ${surface}`, async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    const state = { jobs: [] as Job[], calls: [] as string[][] }
    on('process.run', (_$, e) => {
      const args = e.argv.slice(2)
      if (args[0] === 'agents') { const r = fakeEngine(state)(e.argv); const body = JSON.parse(r.value.stdout); return answer({ ...body, agents: [...body.agents, CLAUDE_AGENT] }) }
      if (args[0] === 'adapter' && args[1] === 'suggest') { state.calls.push([...args]); return answer({ adapter: ADAPTER }) }
      return fakeEngine(state)(e.argv)
    })
    await $.command.run({ command: 'podium', args: '' })
    const pane = await $.ui.mount({ plugin: 'podium', surface, component: 'Pane', props: { title: 'Podium', isFocused: true, bodyColumns: 100 }, requestId: 'podium' })
    await tap(pane, { key: 'link-agents' })
    // An agent's default access is on its own screen, in the Default access fold.
    await tap(pane, { key: 'open-agent-codex' })
    await tap(pane, { key: 'fold-agent:codex:access' })
    // Codex's default is Edit in a separate copy: pressing it again changes nothing.
    await tap(pane, { key: 'defperm-codex-edit-worktree' })
    expect(state.calls.some((c) => c[0] === 'settings' && c[1] === 'set')).toBe(false)
    await tap(pane, { key: 'defperm-codex-read-only' })
    expect(said(state, 'settings set --key defaultPermission.codex --value "read-only"')).toBe(true)
    await tap(pane, { key: 'back' })
    await tap(pane, { key: 'add-agent' })
    await type(pane, { key: 'add-command', text: 'gemini' })
    expect(await look(pane, { key: 'promptFileFlag' })).toBeFalsy()
    await tap(pane, { key: 'promptVia-stdin' })
    expect(await look(pane, { key: 'promptFileFlag' })).toBeFalsy()
    await tap(pane, { key: 'promptVia-file' })
    expect(await look(pane, { key: 'promptFileFlag' })).toBeTruthy()
    await tap(pane, { key: 'cancel-agent' })
    await tap(pane, { key: 'back' })
    await tap(pane, { key: 'new' })
    await tap(pane, { key: 'who-claude' })
    await tap(pane, { key: 'fold-new:more' })
    await tap(pane, { key: 'model-opus' })
    await type(pane, { key: 'task', text: 'List the files' })
    const dispatched = state.calls.find((c) => c[0] === 'dispatch') ?? []
    expect(dispatched.slice(0, 2)).toEqual(['dispatch', '--agent'])
    expect(dispatched[2]).toBe('claude')
    expect(dispatched[dispatched.indexOf('--model') + 1]).toBe('opus')
    await pane.unmount()
  })
}

// Save and test loads the agents once, before the new agent's screen opens.
test('Save and test opens the new agent\'s screen with it already listed, loading the agents once', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const state = { jobs: [] as Job[], calls: [] as string[][] }
  let saved = false
  on('process.run', (_$, e) => {
    const args = e.argv.slice(2)
    if (args[0] === 'agents') {
      state.calls.push([...args])
      const r = fakeEngine({ jobs: [], calls: [] })(e.argv)
      const body = JSON.parse(r.value.stdout)
      return answer({ ...body, agents: saved ? [...body.agents, { ...CLAUDE_AGENT, name: 'gemini', label: 'Gemini', verified: false, source: 'user' }] : body.agents })
    }
    if (args[0] === 'adapter' && args[1] === 'suggest') { state.calls.push([...args]); return answer({ adapter: ADAPTER }) }
    if (args[0] === 'adapter' && args[1] === 'save') { state.calls.push([...args]); saved = true; return answer({ adapter: ADAPTER }) }
    if (args[0] === 'adapter' && args[1] === 'test') { state.calls.push([...args]); return answer({ ok: true, ms: 1200 }) }
    return fakeEngine(state)(e.argv)
  })
  await $.command.run({ command: 'podium', args: '' })
  const pane = await mountPane($)
  await settle(pane)
  await tap(pane, { key: 'link-agents' })
  await tap(pane, { key: 'add-agent' })
  await type(pane, { key: 'add-command', text: 'gemini' })
  const before = state.calls.length
  await tap(pane, { key: 'save-agent' })
  const after = state.calls.slice(before).map((c) => c.slice(0, 2).join(' '))
  expect(after.filter((c) => c === 'agents').length).toBe(1)
  expect(after.indexOf('agents')).toBeLessThan(after.indexOf('adapter test'))
  expect(await look(pane, { type: 'Text', text: /^Gemini$/ })).toBeTruthy()
  expect(await look(pane, { text: /no longer listed/ })).toBeFalsy()
  await pane.unmount()
})

test('a Discard that finishes after another board opened leaves that board showing', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const NEXT = { ...DRAFT, id: 's3', name: 'Oct week 4' }
  const state = { jobs: [] as Job[], calls: [] as string[][], sprints: [NEXT, DRAFT] }
  let release = () => {}
  const gate = new Promise<void>((r) => { release = r })
  on('process.run', async (_$, e) => { if (e.argv[2] === 'sprint' && e.argv[3] === 'discard') await gate; return fakeEngine(state)(e.argv) })
  await $.command.run({ command: 'podium', args: '' })
  const pane = await $.ui.mount({ plugin: 'podium', surface: 'terminal', component: 'Pane', props: { title: 'Podium', isFocused: true, bodyColumns: 100 }, requestId: 'podium' })
  await settle(pane)
  // Discard is on the draft's board.
  await tap(pane, { key: 'open-board-s2' })
  await tap(pane, { key: 'end-board-discard' })
  const pressed = pane.press({ key: 'board-discard-yes' })
  // While s2's Discard is still running, a new draft (s3) opens on its board.
  await $.tool.call({ tool: 'mcp__podium__sprint', action: 'draft', name: 'Oct week 4', tickets: [{ key: 'ABC-21', plan: 'p.md', agent: 'muse', reviewer: 'codex' }] } as any)
  release()
  await pressed
  await settle(pane)
  expect(said(state, 'sprint discard --id s2')).toBe(true)
  expect(await look(pane, { key: 'board-start' })).toBeTruthy()
  // The board showing is s3's (s2's draft board has a Start too).
  expect(await look(pane, { text: /^Oct week 4 · draft$/ })).toBeTruthy()
  expect(await look(pane, { text: /Oct week 3/ })).toBeFalsy()
  expect(await look(pane, { key: 'open-board-s3' })).toBeFalsy()
  await pane.unmount()
})

test('Cancel on the Stop ticket question clears it and stops nothing', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const state = { jobs: [] as Job[], calls: [] as string[][], sprints: [LIVE] }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await $.ui.mount({ plugin: 'podium', surface: 'terminal', component: 'Pane', props: { title: 'Podium', isFocused: true, bodyColumns: 100 }, requestId: 'podium' })
  await settle(pane)
  await tap(pane, { key: 'open-board-s1' })
  await openTicketOf(pane, 'ABC-12')
  await tap(pane, { key: 'end-stop-ABC-12' })
  expect(await look(pane, { text: /^Stop ABC-12\?/ })).toBeTruthy()
  await tap(pane, { key: 'stop-no-ABC-12' })
  expect(await look(pane, { text: /^Stop ABC-12\?/ })).toBeFalsy()
  expect(await look(pane, { key: 'stop-yes-ABC-12' })).toBeFalsy()
  expect(await look(pane, { key: 'end-stop-ABC-12' })).toBeTruthy()
  expect(state.calls.some((c) => c[0] === 'sprint' && c[1] === 'stop')).toBe(false)
  await pane.unmount()
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`a sprint step's detail shows its diff and the ticket's steps, no Keep, Throw away or Ask for changes, and goes back to its ticket, on ${surface}`, async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    const where = { id: 's1', ticket: 'ABC-12' }
    const state = {
      jobs: [
        job({ id: 'sa1', title: 'ABC-12 task 2: Round the payouts', status: 'needs-review', permission: 'edit-worktree', hasChanges: true, worktree: '/c', delivered: true, threadId: 'sa0', step: 2, createdAt: '2026-10-05T11:58:00Z', sprint: { ...where, task: 2, role: 'author' } }),
        job({ id: 'sr1', title: 'Review ABC-12 task 1: Add a', status: 'done', delivered: true, createdAt: '2026-10-05T11:57:00Z', sprint: { ...where, task: 1, role: 'reviewer' } }),
      ],
      calls: [] as string[][], summary: 'Rounded the payouts.', sprints: [LIVE],
    }
    on('process.run', (_$, e) => fakeEngine(state)(e.argv))
    await $.command.run({ command: 'podium', args: '' })
    const pane = await $.ui.mount({ plugin: 'podium', surface, component: 'Pane', props: { title: 'Podium', isFocused: true, bodyColumns: 100 }, requestId: 'podium' })
    await settle(pane)
    await tap(pane, { key: 'open-board-s1' })
    await openTicketOf(pane, 'ABC-12')
    await tap(pane, { key: 'open-steps-ABC-12' })
    expect(await look(pane, { text: /^The sprint manages this step\.$/ })).toBeTruthy()
    expect(await look(pane, { type: 'Button', text: /▸ Steps · 2/ })).toBeTruthy()
    await tap(pane, { key: 'fold-job:sa1:changes' })
    expect(await look(pane, { text: /src\/round\.ts/ })).toBeTruthy()
    for (const key of ['keep', 'discard', 'end-discard', 'ask-detail']) expect(await look(pane, { key })).toBeFalsy()
    // Back goes to the step's ticket, and its Back to the board.
    expect(await look(pane, { type: 'Button', text: /← ABC-12/ })).toBeTruthy()
    await tap(pane, { key: 'back' })
    expect(await look(pane, { text: /Missing test for rounding\./ })).toBeTruthy()
    expect(await look(pane, { key: 'board-pause' })).toBeFalsy()
    await tap(pane, { key: 'back' })
    expect(await look(pane, { key: 'board-pause' })).toBeTruthy()
    await pane.unmount()
  })
}

// A sprint step's Steps list says what each step did, newest first, not its number in a follow-up chain.
for (const surface of ['terminal', 'desktop'] as const) {
  test(`a sprint step's Steps list says what each step did, with no step number or "same conversation", on ${surface}`, async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    const where = { id: 's1', ticket: 'ABC-12' }
    const state = {
      jobs: [
        job({ id: 'sr2', agent: 'codex', title: 'Review ABC-12 task 2: Round the payouts', status: 'running', delivered: true, createdAt: '2026-10-05T11:59:00Z', sprint: { ...where, task: 2, role: 'reviewer' } }),
        job({ id: 'sf1', agent: 'claude', title: 'ABC-12 task 2: fix what the reviewer found', status: 'done', permission: 'edit-worktree', delivered: true, threadId: 'sa1', step: 4, followUpOf: 'sa1', resumeFrom: 'x', createdAt: '2026-10-05T11:58:00Z', startedAt: '2026-10-05T11:58:00Z', endedAt: '2026-10-05T11:58:30Z', sprint: { ...where, task: 2, role: 'author' } }),
        job({ id: 'sr1', agent: 'codex', title: 'Review ABC-12 task 2: Round the payouts', status: 'done', delivered: true, createdAt: '2026-10-05T11:57:00Z', startedAt: '2026-10-05T11:57:00Z', endedAt: '2026-10-05T11:57:30Z', sprint: { ...where, task: 2, role: 'reviewer' } }),
        job({ id: 'sa1', agent: 'claude', title: 'ABC-12 task 2: Round the payouts', status: 'continued', endStatus: 'done', permission: 'edit-worktree', delivered: true, threadId: 'sa1', step: 1, createdAt: '2026-10-05T11:56:00Z', startedAt: '2026-10-05T11:56:00Z', endedAt: '2026-10-05T11:56:30Z', sprint: { ...where, task: 2, role: 'author' } }),
      ],
      calls: [] as string[][], summary: 'Rounded the payouts.', sprints: [LIVE],
    }
    on('process.run', (_$, e) => fakeEngine(state)(e.argv))
    await $.command.run({ command: 'podium', args: '' })
    const pane = await $.ui.mount({ plugin: 'podium', surface, component: 'Pane', props: { title: 'Podium', isFocused: true, bodyColumns: 100 }, requestId: 'podium' })
    await settle(pane)
    await tap(pane, { key: 'open-board-s1' })
    await openTicketOf(pane, 'ABC-12')
    await tap(pane, { key: 'open-steps-ABC-12' })
    expect(await look(pane, { type: 'Button', text: /▸ Steps · 4/ })).toBeTruthy()
    await tap(pane, { key: 'fold-job:sa1:steps' })
    expect(await look(pane, { text: /Codex reviewing task 2 · working( ›)?$/ })).toBeTruthy()
    expect(await look(pane, { text: /^Claude fixed task 2 · \d+[hms] .*ago( ›)?$/ })).toBeTruthy()
    expect(await look(pane, { text: /^Codex reviewed task 2 · failed · \d+[hms] .*ago( ›)?$/ })).toBeTruthy()
    // the step on screen (sa1, opened from Steps and diff) is the one the list marks
    expect(await look(pane, { text: /^● Claude wrote task 2 · \d+[hms] .*ago( ›)?$/ })).toBeTruthy()
    for (const old of [/same conversation/, /^(● )?\d · /, /· 4 ·/, /^review · /]) expect(await look(pane, { text: old })).toBeFalsy()
    await pane.unmount()
  })
}

// Every finished state: a checkpointed step (done, no longer hasChanges) still reads and shows its diff;
// a failed, stopped or lost one offers no Throw away its copy.
for (const status of ['done', 'failed', 'cancelled', 'lost'] as const) {
  test(`a ${status} sprint step's detail says the sprint manages it and offers no Keep, Throw away, Open PR or follow-ups`, async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    const state = {
      jobs: [job({ id: 'sa1', title: 'ABC-12 task 2: Round the payouts', status, permission: 'edit-worktree', hasChanges: false, worktree: '/c', delivered: true, sprint: { id: 's1', ticket: 'ABC-12', task: 2, role: 'author' } })],
      calls: [] as string[][], sprints: [LIVE],
    }
    on('process.run', (_$, e) => fakeEngine(state)(e.argv))
    await $.command.run({ command: 'podium', args: '' })
    const pane = await $.ui.mount({ plugin: 'podium', surface: 'terminal', component: 'Pane', props: { title: 'Podium', isFocused: true, bodyColumns: 100 }, requestId: 'podium' })
    await settle(pane)
    await tap(pane, { key: 'open-board-s1' })
    await openTicketOf(pane, 'ABC-12')
    await tap(pane, { key: 'open-steps-ABC-12' })
    expect(await look(pane, { text: /^The sprint manages this step\.$/ })).toBeTruthy()
    expect(state.calls.some((c) => c.join(' ') === 'changes --id sa1')).toBe(true)
    await tap(pane, { key: 'fold-job:sa1:changes' })
    expect(await look(pane, { text: /src\/round\.ts/ })).toBeTruthy()
    for (const key of ['keep', 'discard', 'end-discard', 'ask-detail', 'openpr-sa1', 'link-openpr']) expect(await look(pane, { key })).toBeFalsy()
    expect(await look(pane, { text: /^(Keep changes|Throw away|Throw away its copy|Ask for changes…|Open PR)$/ })).toBeFalsy()
    await pane.unmount()
  })
}

test('a board press waits for a fresh read: a refresh already in flight (read before the change) does not leave the old board showing', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const state = { jobs: [] as Job[], calls: [] as string[][], sprints: [DRAFT] as any[] }
  let hold = false
  let release = () => {}
  const gate = new Promise<void>((r) => { release = r })
  on('process.run', async (_$, e) => {
    const sub = e.argv[2]
    if (sub === 'sprint' && e.argv[3] === 'move') state.sprints = [{ ...DRAFT, tickets: [...DRAFT.tickets].reverse() }]
    const answer = fakeEngine(state)(e.argv) // answered from the state as it is now
    if (sub === 'status' && hold) { hold = false; await gate }
    return answer
  })
  await $.command.run({ command: 'podium', args: '' })
  const pane = await $.ui.mount({ plugin: 'podium', surface: 'terminal', component: 'Pane', props: { title: 'Podium', isFocused: true, bodyColumns: 100 }, requestId: 'podium' })
  await settle(pane)
  await tap(pane, { key: 'open-board-s2' })
  await openTicketOf(pane, 'ABC-21')
  expect(await look(pane, { key: 'up-ABC-21' })).toBeFalsy()
  // A refresh starts and reads the board as it is, then waits on the gate.
  hold = true
  await $.tool.call({ tool: 'mcp__podium__cancel', id: 'nothing' } as any)
  const pressed = pane.press({ key: 'down-ABC-21' })
  for (let i = 0; i < 100 && !said(state, 'sprint move --id s2 --ticket ABC-21 --to down'); i++) await new Promise((r) => setTimeout(r, 5))
  expect(said(state, 'sprint move --id s2 --ticket ABC-21 --to down')).toBe(true)
  release()
  await pressed
  await settle(pane)
  // ABC-21 moved down, so it can move up now. The stale read would still show it first.
  expect(await look(pane, { key: 'up-ABC-21' })).toBeTruthy()
  expect(state.calls.filter((c) => c[0] === 'sprint' && c[1] === 'move').length).toBe(1)
  await pane.unmount()
})

// Safety nets: a screen that throws while drawing says so instead of leaving the pane blank,
// and /podium opens on the list, so a screen that breaks can't keep the pane blank across reopening.
// A finished job whose commits came as text, not a list (malformed engine data): its card draws (it shows only the
// count), but its detail lists the commits, so drawing it throws.
const WENT_WRONG = /^Something on this screen went wrong\.$/
for (const surface of ['terminal', 'desktop'] as const) {
  test(`a screen that can't be drawn says so, with the error and Back to the list, on ${surface}`, async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    const odd = job({ committed: { branch: 'podium/j1', head: 'abc1234', count: 1, commits: 'a1b2c3d Round payouts' } })
    const state = { jobs: [odd], calls: [] as string[][] }
    on('process.run', (_$, e) => fakeEngine(state)(e.argv))
    await $.command.run({ command: 'podium', args: '' })
    const pane = allowNote(await $.ui.mount({ plugin: 'podium', surface, component: 'Pane', props: { title: 'Podium', isFocused: true, bodyColumns: 100 }, requestId: 'podium' }))
    await settle(pane)
    // Its row (in Done, folded) draws.
    await tap(pane, { key: 'fold-list:done' })
    expect(await look(pane, { text: /^Codex · committed to podium\/j1 .+ ago$/ })).toBeTruthy()
    await tap(pane, { key: 'open-j1' })
    // The commits are in the Changes fold, drawn only once it is open.
    await tap(pane, { key: 'fold-job:j1:changes' })
    expect(await look(pane, { text: WENT_WRONG })).toBeTruthy()
    expect(await look(pane, { text: /is not a function/ })).toBeTruthy()
    await tap(pane, { key: 'draw-failed-back' })
    expect(await look(pane, { text: WENT_WRONG })).toBeFalsy()
    // The list's own folds stay open; the job screen's are dropped, so it reopens with Changes closed, not on the note.
    expect(await look(pane, { key: 'open-j1' })).toBeTruthy()
    await tap(pane, { key: 'open-j1' })
    expect(await look(pane, { text: WENT_WRONG })).toBeFalsy()
    expect(await look(pane, { key: 'fold-job:j1:changes' })).toBeTruthy()
    await pane.unmount()
  })
}

// A writer or reviewer that is not a name (malformed data) draws as it is, and a missing one as No agent (a number must not throw and turn the whole board row into the note).
const ODD_NAMES = { ...LIVE, tickets: [LIVE.tickets[0], { ...LIVE.tickets[1], tasks: [{ ...task(1, 'done'), reviewer: 42 as any }, { ...LIVE.tickets[1].tasks[1], reviewer: null as any }] }] }
for (const surface of ['terminal', 'desktop'] as const) {
  test(`a board row whose reviewer is a number or missing still draws, on ${surface}`, async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    const state = { jobs: [] as Job[], calls: [] as string[][], sprints: [ODD_NAMES] }
    on('process.run', (_$, e) => fakeEngine(state)(e.argv))
    await $.command.run({ command: 'podium', args: '' })
    const pane = await $.ui.mount({ plugin: 'podium', surface, component: 'Pane', props: { title: 'Podium', isFocused: true, bodyColumns: 100 }, requestId: 'podium' })
    await settle(pane)
    await tap(pane, { key: 'open-board-s1' })
    await openTicketOf(pane, 'ABC-12')
    await tap(pane, { key: 'fold-ticket:s1:ABC-12:who' })
    expect(await look(pane, { text: /^Task 1: Writer Muse · Reviewer 42$/ })).toBeTruthy()
    expect(await look(pane, { text: /^Task 2: Writer Muse · Reviewer No agent$/ })).toBeTruthy()
    await pane.unmount()
  })
}

test('/podium after a sprint board opens on the list, with the board\'s rows closed', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const state = { jobs: [] as Job[], calls: [] as string[][], sprints: [LIVE] }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  let pane = await mountPane($)
  await settle(pane)
  await tap(pane, { key: 'open-board-s1' })
  await openTicketOf(pane, 'ABC-12')
  await tap(pane, { key: 'end-stop-ABC-12' })
  expect(await look(pane, { text: /^Stop ABC-12\?/ })).toBeTruthy()
  await pane.unmount()
  await $.command.run({ command: 'podium', args: '' })
  pane = await mountPane($)
  await settle(pane)
  expect(await look(pane, { key: 'open-board-s1' })).toBeTruthy()
  expect(await look(pane, { key: 'board-pause' })).toBeFalsy()
  await tap(pane, { key: 'open-board-s1' })
  expect(await look(pane, { text: /Missing test for rounding\./ })).toBeFalsy()
  expect(await look(pane, { text: /^Stop ABC-12\?/ })).toBeFalsy()
  await pane.unmount()
})

// The desktop page cannot draw a Code element and blanked the whole pane when Steps and
// diff opened a step's one changed file. The Client draws code as Text lines, and its tree passes the page's rules.
const TOO_MUCH = /^This screen has too much to show here\. Close some open files, or ask Claude\.$/
const typesIn = (node: any, out = new Set<string>()): Set<string> => {
  if (node && typeof node === 'object') { if (typeof node.type === 'string') out.add(node.type); for (const c of [].concat(node.children ?? [])) typesIn(c, out) }
  return out
}
test('on desktop, Steps and diff of a sprint step opens its one file as Text lines the page can draw', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const state = {
    jobs: [job({ id: 'sa1', title: 'ABC-12 task 2: Round the payouts', status: 'done', permission: 'edit-worktree', hasChanges: false, worktree: '/c', delivered: true, sprint: { id: 's1', ticket: 'ABC-12', task: 2, role: 'author' } })],
    calls: [] as string[][], sprints: [LIVE],
    changeSet: { files: [{ path: 'src/round.ts', added: 1, removed: 1, patch: '@@ -1 +1 @@\n-const pay = Math.floor(x)\n+const pay = Math.round(x)', isTruncated: false }], added: 1, removed: 1 },
  }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await mountPane($)
  await settle(pane)
  await tap(pane, { key: 'open-board-s1' })
  await openTicketOf(pane, 'ABC-12')
  await tap(pane, { key: 'open-steps-ABC-12' })
  await tap(pane, { key: 'fold-job:sa1:changes' })
  const added = await pane.find({ text: /^\+const pay = Math\.round\(x\)$/, in: APP }) as any
  const removed = await pane.find({ text: /^-const pay = Math\.floor\(x\)$/, in: APP }) as any
  expect(added?.type).toBe('Text')
  expect(added?.props?.color).toBe('success')
  expect(removed?.type).toBe('Text')
  expect(removed?.props?.color).toBe('error')
  const tree = await pane.drawn({ in: APP })
  expect([...typesIn(tree)].filter((t) => ['Code', 'Link', 'Markdown'].includes(t))).toEqual([])
  expect(pageProblem(tree)).toBe(null)
  await pane.unmount()
})

test('on desktop, an ordinary job\'s expanded diff and full output draw as Text lines the page can draw', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const state = { jobs: [job({ status: 'needs-review', permission: 'edit-worktree', delivered: true, changes: { files: 2, added: 3, removed: 1 } })], calls: [] as string[][], summary: 'Added tests.' }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await mountPane($)
  await tap(pane, { key: 'open-j1' })
  await tap(pane, { key: 'fold-job:j1:changes' })
  await tap(pane, { key: 'file-src/round.ts' })
  expect(((await pane.find({ text: /^\+new$/, in: APP })) as any)?.props?.color).toBe('success')
  expect(((await pane.find({ text: /^-old$/, in: APP })) as any)?.props?.color).toBe('error')
  await tap(pane, { key: 'fold-job:j1:output' })
  expect(await pane.find({ text: /^full output$/, in: APP })).toBeTruthy()
  const tree = await pane.drawn({ in: APP })
  expect(typesIn(tree).has('Code')).toBe(false)
  expect(pageProblem(tree)).toBe(null)
  await pane.unmount()
})

test('on desktop, a job with 400 changed files draws 150 rows and a "more files" line, and Keep and Throw away stay reachable', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const files = Array.from({ length: 400 }, (_, i) => ({ path: `src/file${i}.ts`, added: 1, removed: 0, patch: '@@ -0,0 +1 @@\n+x', isTruncated: false }))
  const state = { jobs: [job({ status: 'needs-review', permission: 'edit-worktree', delivered: true, changes: { files: 400, added: 400, removed: 0 } })], calls: [] as string[][], changeSet: { files, added: 400, removed: 0 } }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await mountPane($)
  await tap(pane, { key: 'open-j1' })
  expect(await pane.find({ text: TOO_MUCH, in: APP })).toBeFalsy()
  expect(await pane.find({ text: /^▸ Changes · 400 files · \+400 −0$/, in: APP })).toBeTruthy()
  await tap(pane, { key: 'fold-job:j1:changes' })
  expect(((await pane.findAll({ type: 'Button', in: APP })) as any[]).filter((b) => String(b.key).startsWith('file-src/')).length).toBe(150)
  expect(await pane.find({ key: 'file-src/file149.ts', in: APP })).toBeTruthy()
  expect(await pane.find({ key: 'file-src/file150.ts', in: APP })).toBeFalsy()
  expect(await pane.find({ text: /^… and 250 more files$/, in: APP })).toBeTruthy()
  expect(pageProblem(await pane.drawn({ in: APP }))).toBe(null)
  // A file among the shown rows still opens its diff, and the page still accepts the tree.
  await tap(pane, { key: 'file-src/file3.ts' })
  expect(await pane.find({ text: /^\+x$/, in: APP })).toBeTruthy()
  expect(await pane.find({ key: 'keep', in: APP })).toBeTruthy()
  expect(await pane.find({ key: 'end-discard', in: APP })).toBeTruthy()
  await pane.unmount()
})

test('on desktop, a screen the page would refuse shows why, with Back to the list, instead of a blank pane', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  // Changed files stop at 150 rows now; a ticket with very many tasks is what still outgrows the page.
  const many = { ...LIVE, tickets: [{ ...LIVE.tickets[1], tasks: Array.from({ length: 600 }, (_, i) => ({ ...task(i + 1, 'done'), title: `T${i + 1}` })) }] }
  const state = { jobs: [] as Job[], calls: [] as string[][], sprints: [many] }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  const pane = allowNote(await mountPane($))
  await settle(pane)
  await tap(pane, { key: 'open-board-s1' })
  await openTicketOf(pane, 'ABC-12')
  await tap(pane, { key: 'fold-ticket:s1:ABC-12:steps' })
  await tap(pane, { key: 'fold-ticket:s1:ABC-12:who' })
  // Plain words first; the checker's reason (its size, 100,000 characters, or its element count, 2,000, whichever
  // it meets first) dim below.
  expect(await pane.find({ text: TOO_MUCH, in: APP })).toBeTruthy()
  expect(await pane.find({ text: /^The screen has .*more than the desktop pane's (2,000|100,000)\.$/, in: APP })).toBeTruthy()
  expect(pageProblem(await pane.drawn({ in: APP }))).toBe(null)
  await tap(pane, { key: 'draw-failed-back' })
  expect(await pane.find({ text: TOO_MUCH, in: APP })).toBeFalsy()
  expect(await pane.find({ key: 'open-board-s1', in: APP })).toBeTruthy()
  // Back also closed the row that could not be drawn: the same board opens again, with its rows closed.
  await tap(pane, { key: 'open-board-s1' })
  expect(await pane.find({ text: TOO_MUCH, in: APP })).toBeFalsy()
  expect(await pane.find({ key: 'open-s1-ABC-12', in: APP })).toBeTruthy()
  expect(await pane.find({ key: 'task-ABC-12-1', in: APP })).toBeFalsy()
  expect(await pane.find({ text: /^T1$|Task 1: T1/, in: APP })).toBeFalsy()
  // The ticket's own folds were dropped too: it opens again with Steps and Who closed, not on the note.
  await openTicketOf(pane, 'ABC-12')
  expect(await pane.find({ text: TOO_MUCH, in: APP })).toBeFalsy()
  expect(await pane.find({ key: 'fold-ticket:s1:ABC-12:steps', in: APP })).toBeTruthy()
  await pane.unmount()
})

// The detail's worst case stays under the page's 2,000 elements and texts on its own: 150 file rows (the
// rest a "more files" line), every one of them open, a diff longer than the screen's code lines, the full output,
// and a thread of 60 steps.
test('on desktop, a detail with 150 open files, a long diff, the full output and 60 steps still draws', { timeout: 30_000 }, async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const earlier = Array.from({ length: 59 }, (_, i) => job({ id: `t${i + 1}`, threadId: 't1', step: i + 1, title: `Step ${i + 1}: adjust the rounding`, status: 'continued', endStatus: 'done', permission: 'edit-worktree', delivered: true, createdAt: new Date(Date.UTC(2026, 9, 5, 8, i)).toISOString(), endedAt: new Date(Date.UTC(2026, 9, 5, 8, i, 30)).toISOString() }))
  const latest = job({ id: 'w', threadId: 't1', step: 60, title: 'Step 60: adjust the rounding', status: 'needs-review', permission: 'edit-worktree', worktree: 'C:/w/w', delivered: true, changes: { files: 400, added: 2000, removed: 0 }, createdAt: '2026-10-05T10:00:00Z', endedAt: '2026-10-05T10:05:00Z' })
  const long = `@@ -0,0 +1,400 @@\n${Array.from({ length: 400 }, (_, i) => `+line ${i}`).join('\n')}`
  const files = Array.from({ length: 400 }, (_, i) => ({ path: `src/f${i}.ts`, added: i ? 3 : 400, removed: 0, patch: i ? '@@ -0,0 +1,3 @@\n+a\n+b\n+c' : long, isTruncated: true }))
  const state = { jobs: [...earlier, latest], calls: [] as string[][], summary: 'Rounded every payout.', changeSet: { files, added: 2000, removed: 0 }, output: Array.from({ length: 2000 }, (_, i) => `output line ${i}`).join('\n') }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await mountPane($)
  await settle(pane)
  await tap(pane, { key: 'open-w' })
  await tap(pane, { key: 'fold-job:w:changes' })
  // Pressed 25 at a time, then a settle (the Client posts every unconfirmed press): each step stays inside the kit's time.
  for (let i = 0; i < 150; i++) {
    await pane.press({ key: `file-src/f${i}.ts` })
    if (i % 25 === 24) await settle(pane)
  }
  expect(((await pane.findAll({ type: 'Button', in: APP })) as any[]).filter((b) => /^▾ src\/f\d+\.ts$/.test(String(b.props?.label ?? b.label ?? ''))).length).toBe(150)
  await tap(pane, { key: 'fold-job:w:output' })
  await tap(pane, { key: 'fold-job:w:steps' })
  // settle checked the tree against the page's rules and found no note; these say what the screen kept.
  expect(await pane.find({ text: /^\+line 0$/, in: APP })).toBeTruthy()
  expect(await pane.find({ text: /^… and 250 more files$/, in: APP })).toBeTruthy()
  expect(await pane.find({ key: 'keep', in: APP })).toBeTruthy()
  expect(await pane.find({ key: 'fold-job:w:output', in: APP })).toBeTruthy()
  expect(((await pane.findAll({ type: 'Button', in: APP })) as any[]).filter((b) => String(b.key).startsWith('step-')).length).toBe(30)
  expect(await pane.find({ text: /^… 30 earlier steps not listed$/, in: APP })).toBeTruthy()
  expect(pageProblem(await pane.drawn({ in: APP }))).toBe(null)
  await pane.unmount()
})

// Through `h` a link's text arrives as its children (a list), and the desktop drew only the address.
test('on desktop a link keeps its text, with the address dim after it', async () => {
  const ui = clientLook({ Box: 'Box', Text: 'Text', Button: 'Button', Input: 'Input' }, PALETTES.dark)
  const drawn = JSON.stringify((ui.Link as any)({ href: 'https://github.com/o/r/pull/12', children: ['PR #12'] }))
  expect(drawn).toContain('PR #12')
  expect(drawn).toContain(' https://github.com/o/r/pull/12')
})

// A quiet link is text with no outline; a button that ends something is outlined in the danger colour.
test('on desktop a quiet link has no outline and an ender is outlined in the danger colour', async () => {
  const ui = clientLook({ Box: 'Box', Text: 'Text', Button: 'Button', Input: 'Input' }, PALETTES.dark)
  const link = JSON.stringify((ui.Button as any)({ key: 'link-watch', label: 'Watch again', onPress: () => {} }))
  expect(link).not.toContain('borderStyle')
  expect(link).toContain('"plain":true')
  const ender = JSON.stringify((ui.Button as any)({ key: 'end-discard', label: 'Throw away…', onPress: () => {} }))
  expect(ender).toContain(`"borderColor":"${PALETTES.dark.failed.edge}"`)
  const plainButton = JSON.stringify((ui.Button as any)({ key: 'browse', label: 'Open on GitHub', onPress: () => {} }))
  expect(plainButton).toContain(`"borderColor":"${PALETTES.dark.neutral.edge}"`)
})

// An `open-` key draws as a text link on desktop, so a running ticket's one primary step is `steps-<KEY>`.
test('on desktop a running ticket\'s Steps and diff is its outlined primary button', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const state = { jobs: [] as Job[], calls: [] as string[][], sprints: [LIVE] }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await mountPane($)
  await settle(pane)
  await tap(pane, { key: 'open-board-s1' })
  await openTicketOf(pane, 'ABC-11')
  expect(await primaryKeys(pane)).toEqual(['steps-ABC-11'])
  expect(await look(pane, { key: 'open-steps-ABC-11' })).toBeFalsy()
  const parentOf = (node: any, test: (n: any) => boolean, parent: any = null): any => {
    if (!node || typeof node !== 'object') return null
    if (test(node)) return parent
    for (const c of [].concat(node.children ?? [])) { const hit = parentOf(c, test, node); if (hit) return hit }
    return null
  }
  const box = parentOf(await pane.drawn({ in: APP }), (n) => n.type === 'Button' && n.props?.key === 'steps-ABC-11')
  expect(box?.props?.borderStyle).toBe('round')
  expect(box?.props?.backgroundColor).toBeTruthy()
  await pane.unmount()
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`a plan waiting on the board shows its path and tasks; Approve, and Ask for changes with notes, on ${surface}`, async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    const state = { jobs: [] as Job[], calls: [] as string[][], sprints: [PLANS] }
    const notes: string[] = []
    on('process.run', (_$, e) => { if (e.argv[2] === 'sprint' && e.argv[3] === 'revise') notes.push(String(e.init?.stdin)); return fakeEngine(state)(e.argv) })
    await $.command.run({ command: 'podium', args: '' })
    const pane = await $.ui.mount({ plugin: 'podium', surface, component: 'Pane', props: { title: 'Podium', isFocused: true, bodyColumns: 100 }, requestId: 'podium' })
    await settle(pane)
    // The list: the sprint's row, and its plans waiting in Your turn; the board has a line per ticket.
    expect(await look(pane, { type: 'Button', text: /Sprint · Oct week 4/ })).toBeTruthy()
    expect(await look(pane, { type: 'Text', text: /^0 of 3 done$/ })).toBeTruthy()
    expect(await look(pane, { type: 'Text', text: /^Oct week 4 · plan ready$/ })).toBeTruthy()
    expect(await look(pane, { key: 'turn-s3-ABC-31' })).toBeTruthy()
    await tap(pane, { key: 'open-board-s3' })
    expect(await look(pane, { type: 'Button', text: /ABC-33 Reports · starts after ABC-31/ })).toBeTruthy()
    await openTicketOf(pane, 'ABC-31')
    // The plan's path is in the Plan file fold, who wrote it in Who works on it.
    expect(await look(pane, { text: /^docs\/plans\/2026-10-07-abc-31-export-to-csv\.md$/ })).toBeFalsy()
    await tap(pane, { key: 'fold-ticket:s3:ABC-31:plan' })
    expect(await look(pane, { text: /^docs\/plans\/2026-10-07-abc-31-export-to-csv\.md$/ })).toBeTruthy()
    expect(await look(pane, { text: /^Its tasks \(2\):$/ })).toBeTruthy()
    expect(await look(pane, { text: /^· Task 2: Write the CSV$/ })).toBeTruthy()
    await tap(pane, { key: 'fold-ticket:s3:ABC-31:who' })
    expect(await look(pane, { text: /^Plan written by Muse · tasks reviewed by Codex$/ })).toBeTruthy()
    expect(await look(pane, { key: 'one-task-ABC-31' })).toBeFalsy()
    await tap(pane, { key: 'revise-ABC-31' })
    expect(await look(pane, { key: 'revise-ABC-31' })).toBeFalsy()
    // Send with nothing typed asks for the notes and sends nothing.
    await tap(pane, { key: 'revise-send-ABC-31' })
    expect(await look(pane, { text: /^Say what should change in the plan first\.$/ })).toBeTruthy()
    expect(notes).toEqual([])
    await type(pane, { key: 'revise-text-ABC-31', text: 'Split task 2' })
    expect(said(state, 'sprint revise --id s3 --ticket ABC-31 --text -')).toBe(true)
    expect(notes).toEqual(['Split task 2'])
    expect(await look(pane, { key: 'revise-text-ABC-31' })).toBeFalsy()
    await tap(pane, { key: 'approve-ABC-31' })
    expect(said(state, 'sprint approve --id s3 --ticket ABC-31')).toBe(true)
    await pane.unmount()
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`notes typed for a plan survive a sync and a Stop question, and Send hands them over and clears the box, on ${surface}`, async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    const state = { jobs: [] as Job[], calls: [] as string[][], sprints: [PLANS] }
    const notes: string[] = []
    on('process.run', (_$, e) => { if (e.argv[2] === 'sprint' && e.argv[3] === 'revise') notes.push(String(e.init?.stdin)); return fakeEngine(state)(e.argv) })
    await $.command.run({ command: 'podium', args: '' })
    const pane = await $.ui.mount({ plugin: 'podium', surface, component: 'Pane', props: { title: 'Podium', isFocused: true, bodyColumns: 100 }, requestId: 'podium' })
    await settle(pane)
    await tap(pane, { key: 'open-board-s3' })
    await openTicketOf(pane, 'ABC-31')
    await tap(pane, { key: 'revise-ABC-31' })
    const typed = async () => (await look(pane, { key: 'revise-text-ABC-31' }))?.props?.value
    // Typing without pressing Enter keeps the words in the box, through a sync.
    await pane.input({ key: 'revise-text-ABC-31', text: 'Split task 2', kind: 'change' })
    await settle(pane)
    expect(await typed()).toBe('Split task 2')
    await pane.advance(5000).catch(() => {})
    await settle(pane)
    expect(await typed()).toBe('Split task 2')
    expect(notes).toEqual([])
    // A Stop question, then Cancel, brings the box back with the same words.
    await tap(pane, { key: 'end-stop-ABC-31' })
    expect(await look(pane, { key: 'revise-text-ABC-31' })).toBeFalsy()
    await tap(pane, { key: 'stop-no-ABC-31' })
    await tap(pane, { key: 'revise-ABC-31' })
    expect(await typed()).toBe('Split task 2')
    expect(state.calls.some((c) => c[0] === 'sprint' && c[1] === 'stop')).toBe(false)
    // Send hands the typed words over on stdin, and the box is empty for the next time.
    await tap(pane, { key: 'revise-send-ABC-31' })
    expect(said(state, 'sprint revise --id s3 --ticket ABC-31 --text -')).toBe(true)
    expect(notes).toEqual(['Split task 2'])
    expect(await look(pane, { key: 'revise-text-ABC-31' })).toBeFalsy()
    await tap(pane, { key: 'revise-ABC-31' })
    expect(await typed()).toBe('')
    await pane.unmount()
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`an "after" the engine refuses as a loop shows the engine's words on the board, on ${surface}`, async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    const message = 'These tickets wait for each other, so none of them could start: ABC-41 → ABC-42 → ABC-41.'
    const state = { jobs: [] as Job[], calls: [] as string[][], sprints: [PLANLESS], afterError: message }
    on('process.run', (_$, e) => fakeEngine(state)(e.argv))
    await $.command.run({ command: 'podium', args: '' })
    const pane = await $.ui.mount({ plugin: 'podium', surface, component: 'Pane', props: { title: 'Podium', isFocused: true, bodyColumns: 100 }, requestId: 'podium' })
    await settle(pane)
    await tap(pane, { key: 'open-board-s4' })
    await openTicketOf(pane, 'ABC-41')
    await tap(pane, { key: 'fold-ticket:s4:ABC-41:after' })
    await tap(pane, { key: 'after-ABC-41-ABC-42' })
    expect(said(state, 'sprint after --id s4 --ticket ABC-41 --add ABC-42')).toBe(true)
    expect(await look(pane, { text: message })).toBeTruthy()
    await pane.unmount()
  })
}

// Notes are cut in the pane. The box's value is bounded by the hosts (the terminal refuses an Input value
// over 10,000 characters; the desktop page over 16,384), below the engine's 20,000: the box keeps 10,000 and says so.
for (const surface of ['terminal', 'desktop'] as const) {
  test(`notes for a plan are cut to 10,000 characters, saying so, on ${surface}`, async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    const state = { jobs: [] as Job[], calls: [] as string[][], sprints: [PLANS] }
    const notes: string[] = []
    on('process.run', (_$, e) => { if (e.argv[2] === 'sprint' && e.argv[3] === 'revise') notes.push(String(e.init?.stdin)); return fakeEngine(state)(e.argv) })
    await $.command.run({ command: 'podium', args: '' })
    const pane = await $.ui.mount({ plugin: 'podium', surface, component: 'Pane', props: { title: 'Podium', isFocused: true, bodyColumns: 100 }, requestId: 'podium' })
    await settle(pane)
    await tap(pane, { key: 'open-board-s3' })
    await openTicketOf(pane, 'ABC-31')
    await tap(pane, { key: 'revise-ABC-31' })
    await pane.input({ key: 'revise-text-ABC-31', text: 'n'.repeat(25_000), kind: 'change' })
    await settle(pane)
    expect(String((await look(pane, { key: 'revise-text-ABC-31' }))?.props?.value ?? '').length).toBe(10_000)
    expect(await look(pane, { text: /^Your notes were cut to 10,000 characters\.$/ })).toBeTruthy()
    await tap(pane, { key: 'revise-send-ABC-31' })
    expect(notes.map((x) => x.length)).toEqual([10_000])
    await pane.unmount()
  })
}

// Only the open row draws a plan's task titles, so only it gets them in the props.
for (const surface of ['terminal', 'desktop'] as const) {
  test(`with 30 plans waiting, only the open row's task titles are sent, and it draws them, on ${surface}`, async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    const titles = Array.from({ length: 30 }, (_, i) => ({ n: i + 1, title: `Step ${i + 1} of the plan` }))
    const many = { ...PLANS, id: 's9', name: 'Big plans', tickets: Array.from({ length: 30 }, (_, i) => planTicket({ key: `ABC-${100 + i}`, title: `Ticket ${i}`, proposed: titles })) }
    const state = { jobs: [] as Job[], calls: [] as string[][], sprints: [many] }
    on('process.run', (_$, e) => fakeEngine(state)(e.argv))
    await $.command.run({ command: 'podium', args: '' })
    const pane = await $.ui.mount({ plugin: 'podium', surface, component: 'Pane', props: { title: 'Podium', isFocused: true, bodyColumns: 100 }, requestId: 'podium' })
    await settle(pane)
    // On desktop the Client's props are the model: which rows carry their plan's titles.
    const sentRows = async () => {
      const outer = (await pane.drawn()) as any
      const model = outer?.props?.props ?? outer?.props
      return (model?.sprints ?? []).flatMap((s: any) => (s.tickets ?? []).filter((t: any) => t.proposed).map((t: any) => t.key))
    }
    await tap(pane, { key: 'open-board-s9' })
    if (surface === 'desktop') expect(await sentRows()).toEqual([])
    await openTicketOf(pane, 'ABC-107')
    expect(await look(pane, { text: /^Its tasks \(30\):$/ })).toBeTruthy()
    expect(await look(pane, { text: /^· Task 30: Step 30 of the plan$/ })).toBeTruthy()
    if (surface === 'desktop') expect(await sentRows()).toEqual(['ABC-107'])
    await tap(pane, { key: 'back' })
    await openTicketOf(pane, 'ABC-108')
    expect(await look(pane, { text: /^Its tasks \(30\):$/ })).toBeTruthy()
    if (surface === 'desktop') expect(await sentRows()).toEqual(['ABC-108'])
    await pane.unmount()
  })
}

// A Send waiting behind another change in its sprint read the notes only when it ran, so switching tickets in
// between sent the next ticket's notes; and the clean-up after a send cleared notes typed on another sprint's board.
// Send carries the notes as they were when pressed, and clears only that same note.
for (const surface of ['terminal', 'desktop'] as const) {
  test(`a Send waiting behind another change sends its own ticket's notes, and keeps the next ticket's, on ${surface}`, async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    const state = { jobs: [] as Job[], calls: [] as string[][], sprints: [PLANS] }
    const notes: string[] = []
    let release = () => {}
    const gate = new Promise<void>((r) => { release = r })
    on('process.run', async (_$, e) => {
      const verb = e.argv[2] === 'sprint' ? e.argv[3] : null
      if (verb === 'one-task') await gate
      if (verb === 'revise') notes.push(`${e.argv[e.argv.indexOf('--ticket') + 1]}: ${String(e.init?.stdin)}`)
      return fakeEngine(state)(e.argv)
    })
    await $.command.run({ command: 'podium', args: '' })
    const pane = await $.ui.mount({ plugin: 'podium', surface, component: 'Pane', props: { title: 'Podium', isFocused: true, bodyColumns: 100 }, requestId: 'podium' })
    await settle(pane)
    await tap(pane, { key: 'open-board-s3' })
    // Run as one task on another ticket holds the sprint's line, so the Send waits behind it. (Approve is not drawn while
    // the notes are open.)
    await openTicketOf(pane, 'ABC-32')
    const approving = pane.press({ key: 'one-task-ABC-32' })
    await settle(pane)
    await tap(pane, { key: 'back' })
    await openTicketOf(pane, 'ABC-31')
    await tap(pane, { key: 'revise-ABC-31' })
    await type(pane, { key: 'revise-text-ABC-31', text: 'Notes for A', kind: 'change' })
    const sending = pane.press({ key: 'revise-send-ABC-31' })
    await settle(pane)
    await tap(pane, { key: 'back' })
    await openTicketOf(pane, 'ABC-32')
    await tap(pane, { key: 'revise-ABC-32' })
    await type(pane, { key: 'revise-text-ABC-32', text: 'Notes for B', kind: 'change' })
    expect(notes).toEqual([])
    release()
    await approving
    await sending
    for (let i = 0; i < 20 && !notes.length; i++) await settle(pane)
    expect(notes).toEqual(['ABC-31: Notes for A'])
    expect((await look(pane, { key: 'revise-text-ABC-32' }))?.props?.value).toBe('Notes for B')
    await pane.unmount()
  })
}

// Send carries the notes from the press, and on desktop the last words typed may not have come back in the model yet.
test('on desktop, Send pressed before Podium has answered the typing sends the words typed', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const state = { jobs: [] as Job[], calls: [] as string[][], sprints: [PLANS] }
  const notes: string[] = []
  on('process.run', (_$, e) => { if (e.argv[2] === 'sprint' && e.argv[3] === 'revise') notes.push(String(e.init?.stdin)); return fakeEngine(state)(e.argv) })
  await $.command.run({ command: 'podium', args: '' })
  const pane = await $.ui.mount({ plugin: 'podium', surface: 'desktop', component: 'Pane', props: { title: 'Podium', isFocused: true, bodyColumns: 100 }, requestId: 'podium' })
  await settle(pane)
  await tap(pane, { key: 'open-board-s3' })
  await openTicketOf(pane, 'ABC-31')
  await tap(pane, { key: 'revise-ABC-31' })
  await pane.input({ key: 'revise-text-ABC-31', text: 'Quick notes', kind: 'change' })
  await pane.press({ key: 'revise-send-ABC-31' })
  for (let i = 0; i < 20 && !notes.length; i++) await settle(pane)
  expect(notes).toEqual(['Quick notes'])
  expect(await look(pane, { key: 'revise-text-ABC-31' })).toBeFalsy()
  await pane.unmount()
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`a Send in one sprint does not clear notes typed on another sprint's board, on ${surface}`, async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    const OTHER = { ...PLANS, id: 's5', name: 'Oct week 6' }
    const state = { jobs: [] as Job[], calls: [] as string[][], sprints: [PLANS, OTHER] }
    const notes: string[] = []
    let release = () => {}
    const gate = new Promise<void>((r) => { release = r })
    on('process.run', async (_$, e) => {
      if (e.argv[2] === 'sprint' && e.argv[3] === 'revise') {
        notes.push(`${e.argv[e.argv.indexOf('--id') + 1]}: ${String(e.init?.stdin)}`)
        await gate
      }
      return fakeEngine(state)(e.argv)
    })
    await $.command.run({ command: 'podium', args: '' })
    const pane = await $.ui.mount({ plugin: 'podium', surface, component: 'Pane', props: { title: 'Podium', isFocused: true, bodyColumns: 100 }, requestId: 'podium' })
    await settle(pane)
    await tap(pane, { key: 'open-board-s3' })
    await openTicketOf(pane, 'ABC-31')
    await tap(pane, { key: 'revise-ABC-31' })
    await type(pane, { key: 'revise-text-ABC-31', text: 'Sprint 1 notes', kind: 'change' })
    const sending = pane.press({ key: 'revise-send-ABC-31' })
    for (let i = 0; i < 20 && !notes.length; i++) await settle(pane)
    expect(notes).toEqual(['s3: Sprint 1 notes'])
    // While sprint 1's Send is with Podium, the same ticket key on sprint 2's board gets notes of its own.
    await tap(pane, { key: 'back' })
    await tap(pane, { key: 'back' })
    await tap(pane, { key: 'open-board-s5' })
    await openTicketOf(pane, 'ABC-31')
    await tap(pane, { key: 'revise-ABC-31' })
    await type(pane, { key: 'revise-text-ABC-31', text: 'Sprint 2 notes', kind: 'change' })
    release()
    await sending
    await settle(pane)
    await settle(pane)
    expect(await look(pane, { type: 'Button', text: /← Oct week 6/ })).toBeTruthy()
    expect((await look(pane, { key: 'revise-text-ABC-31' }))?.props?.value).toBe('Sprint 2 notes')
    expect(notes).toEqual(['s3: Sprint 1 notes'])
    await pane.unmount()
  })
}

test('a plan with no tasks offers Run as one task and Ask for changes, not Approve; Cancel closes the notes', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const state = { jobs: [] as Job[], calls: [] as string[][], sprints: [PLANS] }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await mountPane($)
  await settle(pane)
  await tap(pane, { key: 'open-board-s3' })
  await openTicketOf(pane, 'ABC-32')
  expect(await look(pane, { text: /^No tasks found in the plan · run it as one task, or ask for changes$/ })).toBeTruthy()
  await tap(pane, { key: 'fold-ticket:s3:ABC-32:plan' })
  expect(await look(pane, { text: /^docs\/plans\/2026-10-07-abc-32-import\.md$/ })).toBeTruthy()
  expect(await look(pane, { key: 'approve-ABC-32' })).toBeFalsy()
  await tap(pane, { key: 'revise-ABC-32' })
  await tap(pane, { key: 'revise-cancel-ABC-32' })
  expect(await look(pane, { key: 'revise-text-ABC-32' })).toBeFalsy()
  expect(state.calls.some((c) => c[0] === 'sprint' && c[1] === 'revise')).toBe(false)
  await tap(pane, { key: 'one-task-ABC-32' })
  expect(said(state, 'sprint one-task --id s3 --ticket ABC-32')).toBe(true)
})

test('a ticket waiting for another says what it waits for', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const state = { jobs: [] as Job[], calls: [] as string[][], sprints: [PLANS] }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await mountPane($)
  await settle(pane)
  await tap(pane, { key: 'open-board-s3' })
  await openTicketOf(pane, 'ABC-33')
  expect(await look(pane, { text: /^Starts when ABC-31 is merged on GitHub$/ })).toBeTruthy()
  expect(await look(pane, { type: 'Button', text: /▸ Waits for · ABC-31/ })).toBeTruthy()
  await tap(pane, { key: 'fold-ticket:s3:ABC-33:after' })
  expect(await look(pane, { text: /^Starts when ABC-31 is merged on GitHub, from the code as merged there\.$/ })).toBeTruthy()
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`a draft ticket with no plan says who plans it, its planner changes, and "after" is set and cleared with buttons, on ${surface}`, async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    const state = { jobs: [] as Job[], calls: [] as string[][], sprints: [PLANLESS] }
    on('process.run', (_$, e) => fakeEngine(state)(e.argv))
    await $.command.run({ command: 'podium', args: '' })
    const pane = await $.ui.mount({ plugin: 'podium', surface, component: 'Pane', props: { title: 'Podium', isFocused: true, bodyColumns: 100 }, requestId: 'podium' })
    await settle(pane)
    // The list shows the draft as a row; its board has a line per ticket, and who plans it is on the ticket's screen.
    expect(await look(pane, { type: 'Text', text: /^Draft · 2 tickets · not started$/ })).toBeTruthy()
    await tap(pane, { key: 'open-board-s4' })
    expect(await look(pane, { type: 'Button', text: /ABC-41 Export · no plan yet/ })).toBeTruthy()
    expect(await look(pane, { type: 'Button', text: /ABC-42 Import · 1 task · after ABC-41/ })).toBeTruthy()
    await openTicketOf(pane, 'ABC-41')
    expect(await look(pane, { text: /^No plan yet · Muse plans it first$/ })).toBeTruthy()
    await tap(pane, { key: 'fold-ticket:s4:ABC-41:who' })
    expect(await look(pane, { text: /^Plan written by Muse · tasks reviewed by Codex$/ })).toBeTruthy()
    expect(await look(pane, { key: 'change-ABC-41-all' })).toBeFalsy()
    await tap(pane, { key: 'change-ABC-41-plan' })
    await tap(pane, { key: 'plan-writer-ABC-41-codex' })
    expect(said(state, 'sprint assign --id s4 --ticket ABC-41 --task 0 --agent codex')).toBe(true)
    await tap(pane, { key: 'fold-ticket:s4:ABC-41:after' })
    expect(await look(pane, { text: /^Starts after these are merged:$/ })).toBeTruthy()
    await tap(pane, { key: 'after-ABC-41-ABC-42' })
    expect(said(state, 'sprint after --id s4 --ticket ABC-41 --add ABC-42')).toBe(true)
    await tap(pane, { key: 'back' })
    await openTicketOf(pane, 'ABC-42')
    await tap(pane, { key: 'fold-ticket:s4:ABC-42:after' })
    expect(await look(pane, { text: /☑ ABC-41/ })).toBeTruthy()
    await tap(pane, { key: 'after-ABC-42-ABC-41' })
    expect(said(state, 'sprint after --id s4 --ticket ABC-42 --drop ABC-41')).toBe(true)
    await pane.unmount()
  })
}

test('on desktop, a plan of 40 tasks shows its first 30 titles and how many more', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const many = planTicket({ proposed: Array.from({ length: 40 }, (_, i) => ({ n: i + 1, title: `Step ${i + 1}: ${'make the export and the import agree on every column '.repeat(3)}` })) })
  const state = { jobs: [] as Job[], calls: [] as string[][], sprints: [{ ...PLANS, tickets: [many] }] }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await mountPane($)
  await settle(pane)
  await tap(pane, { key: 'open-board-s3' })
  await openTicketOf(pane, 'ABC-31')
  expect(await look(pane, { text: /^Its tasks \(40\):$/ })).toBeTruthy()
  expect(await look(pane, { text: /^· Task 30: Step 30:/ })).toBeTruthy()
  expect(await look(pane, { text: /^· Task 31: / })).toBeFalsy()
  expect(await look(pane, { text: /^… and 10 more tasks$/ })).toBeTruthy()
})

test('the plan steps\' detail says they wrote and changed the plan, and that the sprint manages them', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const where = { id: 's3', ticket: 'ABC-31', task: 0, role: 'author', plan: true }
  const state = {
    jobs: [
      job({ id: 'sp0', title: 'ABC-31: write the plan', agent: 'muse', status: 'done', delivered: true, createdAt: '2026-10-05T11:50:00Z', startedAt: '2026-10-05T11:50:00Z', endedAt: '2026-10-05T11:52:00Z', sprint: where }),
      job({ id: 'sp1', title: 'ABC-31: change the plan', agent: 'muse', status: 'done', delivered: true, step: 2, sprint: where }),
    ],
    calls: [] as string[][], sprints: [PLANS],
  }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await mountPane($)
  await settle(pane)
  await tap(pane, { key: 'open-board-s3' })
  await openTicketOf(pane, 'ABC-31')
  await tap(pane, { key: 'open-steps-ABC-31' })
  expect(await look(pane, { text: /^The sprint manages this step\.$/ })).toBeTruthy()
  // The Steps fold (two steps): the open step is marked ●.
  await tap(pane, { key: 'fold-job:sp1:steps' })
  expect(await look(pane, { text: /^Muse wrote the plan · / })).toBeTruthy()
  expect(await look(pane, { text: /^● Muse changed the plan · / })).toBeTruthy()
})

// ---- First view ----
// The most words each screen may draw on desktop before any fold or tap on it, for fixed fixtures. A new screen adds
// its own.
const MAX_WORDS: Record<string, number> = {
  list: 179, 'job-review': 57, 'job-pr': 40, 'job-working': 37, 'board-running': 48, 'board-draft': 75,
  'ticket-plan': 79, new: 56, agents: 85, settings: 105, welcome: 77,
  agent: 25, 'add-agent': 29, 'job-failed': 28, 'job-done': 24,
}
const firstViewJobs = (): Job[] => [
  job({ id: 'r1', status: 'running', title: 'Review the auth branch', endedAt: null, liveFile: '/data/r1/live.json', delivered: true, origin: { session: 'chat-1' } }),
  job({ id: 'n1', status: 'needs-review', title: 'Add tests', permission: 'edit-worktree', changes: { files: 2, added: 3, removed: 1 }, hasChanges: true, worktree: 'C:\\podium\\n1', delivered: true, origin: { session: 'chat-1' } }),
  job({ id: 'p1', status: 'in-review', title: 'Fix rounding', permission: 'edit-worktree', pr: PR, delivered: true, origin: { session: 'chat-1' } }),
  job({ id: 'd1', status: 'done', delivered: true, origin: { session: 'chat-1' } }),
  job({ id: 'f1', status: 'failed', title: 'Update the docs', error: 'codex exited with code 1', delivered: true, origin: { session: 'chat-1' } }),
  job({ id: 'o1', status: 'done', title: 'Other chat work', delivered: true, origin: { session: 'chat-2' } }),
]
// Presses the first of `keys` that is drawn.
async function tapFirst(pane: any, keys: string[]) {
  for (const key of keys) {
    if (await look(pane, { key })) { await tap(pane, { key }); return }
  }
  throw new Error(`none of ${keys.join(', ')} is drawn`)
}
const FIRST_VIEWS: { name: string; state: () => any; go: (pane: any) => Promise<void> }[] = [
  { name: 'list', state: () => ({ jobs: firstViewJobs(), calls: [], sprints: [LIVE, DRAFT], doctor: GH_READY }), go: async () => {} },
  { name: 'job-review', state: () => ({ jobs: firstViewJobs(), calls: [], summary: 'Added two tests for rounding.', doctor: GH_READY }), go: (pane) => tapFirst(pane, ['open-n1']) },
  { name: 'job-pr', state: () => ({ jobs: firstViewJobs(), calls: [], summary: 'Fixed the rounding.', doctor: GH_READY }), go: (pane) => tapFirst(pane, ['open-p1']) },
  { name: 'job-working', state: () => ({ jobs: firstViewJobs(), calls: [], doctor: GH_READY }), go: (pane) => tapFirst(pane, ['open-r1']) },
  { name: 'board-running', state: () => ({ jobs: [], calls: [], sprints: [LIVE], doctor: GH_READY }), go: (pane) => tapFirst(pane, ['open-board-s1']) },
  { name: 'board-draft', state: () => ({ jobs: [], calls: [], sprints: [DRAFT], doctor: GH_READY }), go: (pane) => tapFirst(pane, ['open-board-s2']) },
  {
    name: 'ticket-plan', state: () => ({ jobs: [], calls: [], sprints: [PLANS], doctor: GH_READY }),
    go: async (pane) => { await tapFirst(pane, ['open-board-s3']); await tapFirst(pane, ['open-s3-ABC-31', 'open-ticket-ABC-31', 'ticket-ABC-31']) },
  },
  { name: 'new', state: () => ({ jobs: [], calls: [], doctor: GH_READY }), go: (pane) => tapFirst(pane, ['new']) },
  { name: 'agents', state: () => ({ jobs: [], calls: [], doctor: GH_READY }), go: (pane) => tapFirst(pane, ['link-agents', 'agents']) },
  { name: 'settings', state: () => ({ jobs: [], calls: [], doctor: GH_READY }), go: (pane) => tapFirst(pane, ['link-settings', 'settings']) },
  { name: 'welcome', state: () => ({ jobs: [], calls: [], doctor: NEW_USER }), go: async () => {} },
  { name: 'agent', state: () => ({ jobs: [], calls: [], doctor: GH_READY }), go: async (pane) => { await tapFirst(pane, ['link-agents']); await tapFirst(pane, ['open-agent-codex']) } },
  { name: 'add-agent', state: () => ({ jobs: [], calls: [], doctor: GH_READY }), go: async (pane) => { await tapFirst(pane, ['link-agents']); await tapFirst(pane, ['add-agent']) } },
  { name: 'job-failed', state: () => ({ jobs: firstViewJobs(), calls: [], summary: null, doctor: GH_READY }), go: (pane) => tapFirst(pane, ['open-f1']) },
  { name: 'job-done', state: () => ({ jobs: firstViewJobs(), calls: [], summary: 'The branch looks fine.', doctor: GH_READY }), go: async (pane) => { await tapFirst(pane, ['fold-list:done']); await tapFirst(pane, ['open-d1']) } },
]
for (const v of FIRST_VIEWS) {
  test(`first view: the ${v.name} screen draws no more words than its MAX_WORDS entry`, async ($, on) => {
    const state = v.state()
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('session.id', () => ({ value: 'chat-1' }))
    on('process.run', (_$, e) => fakeEngine(state)(e.argv))
    on('fs.read', (_$, e) => (String(e.path).split('\\').join('/').endsWith('r1/live.json') ? { value: liveText('reading src/auth/session.ts') } : { deny: 'missing' }))
    await $.command.run({ command: 'podium', args: '' })
    const pane = await mountPane($)
    await settle(pane)
    await v.go(pane)
    const words = wordsDrawn(await pane.drawn({ in: APP }))
    await pane.unmount()
    expect(words).toBeLessThanOrEqual(MAX_WORDS[v.name])
  })
}

// ---- A job's own screen ----
const CI_JOB = () => job({ id: 'p1', status: 'in-review', title: 'Fix rounding', permission: 'edit-worktree', pr: PR, delivered: true })
for (const surface of ['terminal', 'desktop'] as const) {
  test(`a job with changes to review: one status line, Keep changes first, Changes folded, Throw away asks first, on ${surface}`, async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    const state = { jobs: [job({ id: 'n1', status: 'needs-review', title: 'Add tests', permission: 'edit-worktree', changes: { files: 2, added: 3, removed: 1 }, hasChanges: true, worktree: 'C:\\podium\\n1', delivered: true })], calls: [] as string[][], summary: 'Added two tests for rounding.' }
    on('process.run', (_$, e) => fakeEngine(state)(e.argv))
    await $.command.run({ command: 'podium', args: '' })
    const pane = await $.ui.mount({ plugin: 'podium', surface, component: 'Pane', props: { title: 'Podium', isFocused: true, bodyColumns: 80 }, requestId: 'podium' })
    await settle(pane)
    await tap(pane, { key: 'open-n1' })
    expect(await look(pane, { type: 'Text', text: /^Codex finished .+ ago · changes to review$/ })).toBeTruthy()
    expect(await look(pane, { type: 'Text', text: /^Added two tests for rounding\.$/ })).toBeTruthy()
    expect(await primaryKeys(pane)).toEqual(['keep'])
    expect(await look(pane, { key: 'ask-detail' })).toBeTruthy()
    expect(await look(pane, { type: 'Button', text: /▸ Changes · 2 files · \+3 −1/ })).toBeTruthy()
    expect(await look(pane, { text: /tests\/payout\.test\.ts/ })).toBeFalsy()
    await tap(pane, { key: 'fold-job:n1:changes' })
    expect(await look(pane, { text: /tests\/payout\.test\.ts/ })).toBeTruthy()
    await tap(pane, { key: 'end-discard' })
    expect(await look(pane, { type: 'Text', text: /^Throw away these changes\?/ })).toBeTruthy()
    expect(state.calls.some((c) => c[0] === 'discard')).toBe(false)
    await tap(pane, { key: 'discard-yes' })
    expect(state.calls.some((c) => c[0] === 'discard' && c.includes('n1'))).toBe(true)
    await pane.unmount()
  })

  test(`a PR whose checks failed: Send fix first, Open on GitHub beside it, the checks folded, on ${surface}`, async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    const state = { jobs: [CI_JOB()], calls: [] as string[][], summary: 'Fixed the rounding.' }
    on('process.run', (_$, e) => fakeEngine(state)(e.argv))
    await $.command.run({ command: 'podium', args: '' })
    const pane = await $.ui.mount({ plugin: 'podium', surface, component: 'Pane', props: { title: 'Podium', isFocused: true, bodyColumns: 80 }, requestId: 'podium' })
    await settle(pane)
    await tap(pane, { key: 'open-p1' })
    expect(await look(pane, { type: 'Text', text: /^PR #12 · checks failed: test \(windows\)$/ })).toBeTruthy()
    expect(await primaryKeys(pane)).toEqual(['fix-ci'])
    expect(await look(pane, { type: 'Button', text: /Send fix to Codex/ })).toBeTruthy()
    expect(await look(pane, { type: 'Button', text: /☐ Merge when green/ })).toBeTruthy()
    expect(await look(pane, { type: 'Button', text: /▸ Checks · 1 failed/ })).toBeTruthy()
    await tap(pane, { key: 'browse' })
    expect(state.calls.some((c) => c.join(' ') === 'pr browse --id p1')).toBe(true)
    await tap(pane, { key: 'fix-ci' })
    expect(state.calls.some((c) => c[0] === 'pr' && c[1] === 'fix' && c.includes('ci'))).toBe(true)
    expect(await look(pane, { key: 'ask-task' })).toBeTruthy()
    await pane.unmount()
  })

  test(`a working job: its last lines, Ask Claude about it, and Stop asks first, on ${surface}`, async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    const state = { jobs: [job({ id: 'r1', status: 'running', title: 'Review the auth branch', endedAt: null, liveFile: '/data/r1/live.json' })], calls: [] as string[][] }
    on('process.run', (_$, e) => fakeEngine(state)(e.argv))
    on('fs.read', () => ({ value: liveText('reading src/auth/session.ts') }))
    await $.command.run({ command: 'podium', args: '' })
    const pane = await $.ui.mount({ plugin: 'podium', surface, component: 'Pane', props: { title: 'Podium', isFocused: true, bodyColumns: 80 }, requestId: 'podium' })
    await settle(pane)
    await tap(pane, { key: 'open-r1' })
    expect(await look(pane, { type: 'Text', text: /^Codex · working .+ · read only/ })).toBeTruthy()
    expect(await look(pane, { text: /reading src\/auth\/session\.ts/ })).toBeTruthy()
    expect(await primaryKeys(pane)).toEqual(['ask'])
    await tap(pane, { key: 'end-cancel' })
    expect(state.calls.some((c) => c[0] === 'cancel')).toBe(false)
    await tap(pane, { key: 'cancel-yes' })
    expect(state.calls.some((c) => c[0] === 'cancel' && c.includes('r1'))).toBe(true)
    await pane.unmount()
  })
}

// A follow-up with new changes on an open PR keeps the PR's actions.
for (const surface of ['terminal', 'desktop'] as const) {
  test(`a follow-up with new changes on an open PR: Push to PR is the one primary, the PR's actions are quiet links, on ${surface}`, async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    const quietPr = { ...PR, attention: null, checks: { total: 1, passed: 1, failed: 0, running: 0, failing: [], failedRunId: null }, watching: false }
    const state = { jobs: [job({ id: 'f1', status: 'needs-review', title: 'Round half-even', permission: 'edit-worktree', pr: quietPr, changes: { files: 1, added: 2, removed: 0 }, hasChanges: true, worktree: 'C:\\podium\\f1', delivered: true })], calls: [] as string[][], summary: 'Rounded half-even.' }
    on('process.run', (_$, e) => fakeEngine(state)(e.argv))
    await $.command.run({ command: 'podium', args: '' })
    const pane = await $.ui.mount({ plugin: 'podium', surface, component: 'Pane', props: { title: 'Podium', isFocused: true, bodyColumns: 80 }, requestId: 'podium' })
    await settle(pane)
    await tap(pane, { key: 'open-f1' })
    expect(await look(pane, { type: 'Text', text: /^Codex finished .+ ago · new changes for PR #12$/ })).toBeTruthy()
    expect(await primaryKeys(pane)).toEqual(['push'])
    for (const key of ['ask-detail', 'link-browse', 'automerge', 'link-watch', 'link-reviewwith']) expect(await look(pane, { key })).toBeTruthy()
    expect(await look(pane, { key: 'browse' })).toBeFalsy()
    await tap(pane, { key: 'link-browse' })
    expect(state.calls.some((c) => c.join(' ') === 'pr browse --id f1')).toBe(true)
    await tap(pane, { key: 'push' })
    expect(state.calls.some((c) => c[0] === 'pr' && c[1] === 'push' && c.includes('f1'))).toBe(true)
    await pane.unmount()
  })
}

// A question or form open is the one decision. While it is open the screen's next step is not
// drawn (so it can't be pressed with the question unanswered or notes unsent); Cancel brings it back. The full primary set
// is asserted in each state, on both surfaces.
// The ask form: Send, and its agent picker's chosen agent (a picker draws its value as primary, as New job's Who does).
const ASKING = ['ask-agent-codex', 'ask-send']
const QUIET_PR = { ...PR, attention: null, comments: 0, checks: { total: 3, passed: 3, failed: 0, running: 0, failing: [], failedRunId: null } }
async function mountOn($: any, on: any, surface: string, state: any) {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('process.run', (_$: any, e: any) => fakeEngine(state)(e.argv))
  on('fs.read', () => ({ value: liveText('reading src/auth/session.ts') }))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await $.ui.mount({ plugin: 'podium', surface, component: 'Pane', props: { title: 'Podium', isFocused: true, bodyColumns: 100 }, requestId: 'podium' })
  await settle(pane)
  return pane
}
for (const surface of ['terminal', 'desktop'] as const) {
  test(`a job's Throw away question and its ask form each stand alone: Keep changes is back after Cancel, on ${surface}`, async ($, on) => {
    const state = { jobs: [job({ id: 'n1', status: 'needs-review', title: 'Add tests', permission: 'edit-worktree', changes: { files: 2, added: 3, removed: 1 }, hasChanges: true, worktree: 'C:\\podium\\n1', delivered: true })], calls: [] as string[][], summary: 'Added two tests.' }
    const pane = await mountOn($, on, surface, state)
    await tap(pane, { key: 'open-n1' })
    expect(await primaryKeys(pane)).toEqual(['keep'])
    await tap(pane, { key: 'end-discard' })
    expect(await primaryKeys(pane)).toEqual(['discard-yes'])
    expect(await look(pane, { key: 'keep' })).toBeFalsy()
    await tap(pane, { key: 'discard-no' })
    expect(await primaryKeys(pane)).toEqual(['keep'])
    await tap(pane, { key: 'ask-detail' })
    expect(await primaryKeys(pane)).toEqual(ASKING)
    expect(await look(pane, { key: 'keep' })).toBeFalsy()
    await tap(pane, { key: 'ask-cancel' })
    expect(await primaryKeys(pane)).toEqual(['keep'])
    expect(state.calls.some((c) => c[0] === 'discard' || c[0] === 'keep')).toBe(false)
    await pane.unmount()
  })

  test(`a working job's Stop question stands alone: Ask Claude about it is back after Cancel, on ${surface}`, async ($, on) => {
    const state = { jobs: [job({ id: 'r1', status: 'running', title: 'Review the auth branch', endedAt: null, liveFile: '/data/r1/live.json' })], calls: [] as string[][] }
    const pane = await mountOn($, on, surface, state)
    await tap(pane, { key: 'open-r1' })
    expect(await primaryKeys(pane)).toEqual(['ask'])
    await tap(pane, { key: 'end-cancel' })
    expect(await primaryKeys(pane)).toEqual(['cancel-yes'])
    await tap(pane, { key: 'cancel-no' })
    expect(await primaryKeys(pane)).toEqual(['ask'])
    await pane.unmount()
  })

  test(`a PR's Send fix form stands alone: Send is the one primary, Send fix is back after Cancel, on ${surface}`, async ($, on) => {
    const state = { jobs: [CI_JOB()], calls: [] as string[][], summary: 'Fixed the rounding.' }
    const pane = await mountOn($, on, surface, state)
    await tap(pane, { key: 'open-p1' })
    expect(await primaryKeys(pane)).toEqual(['fix-ci'])
    await tap(pane, { key: 'fix-ci' })
    expect(await primaryKeys(pane)).toEqual(ASKING)
    await tap(pane, { key: 'ask-cancel' })
    expect(await primaryKeys(pane)).toEqual(['fix-ci'])
    await pane.unmount()
  })

  test(`a follow-up's ask form stands alone: Push to PR is back after Cancel, on ${surface}`, async ($, on) => {
    const state = { jobs: [job({ id: 'f1', status: 'needs-review', title: 'Round half-even', permission: 'edit-worktree', pr: QUIET_PR, changes: { files: 1, added: 2, removed: 0 }, hasChanges: true, worktree: 'C:\\podium\\f1', delivered: true })], calls: [] as string[][], summary: 'Rounded.' }
    const pane = await mountOn($, on, surface, state)
    await tap(pane, { key: 'open-f1' })
    expect(await primaryKeys(pane)).toEqual(['push'])
    await tap(pane, { key: 'ask-detail' })
    expect(await primaryKeys(pane)).toEqual(ASKING)
    await tap(pane, { key: 'ask-cancel' })
    expect(await primaryKeys(pane)).toEqual(['push'])
    await pane.unmount()
  })

  test(`a quiet PR (no attention, no comments) has one primary, Open on GitHub, on ${surface}`, async ($, on) => {
    const state = { jobs: [job({ id: 'q1', status: 'in-review', title: 'Green work', permission: 'edit-worktree', pr: QUIET_PR, delivered: true })], calls: [] as string[][], summary: 'ok' }
    const pane = await mountOn($, on, surface, state)
    await tap(pane, { key: 'open-q1' })
    expect(await primaryKeys(pane)).toEqual(['browse'])
    expect(await look(pane, { type: 'Button', text: /☐ Merge when green/ })).toBeTruthy()
    await tap(pane, { key: 'browse' })
    expect(state.calls.some((c) => c.join(' ') === 'pr browse --id q1')).toBe(true)
    await pane.unmount()
  })

  test(`a draft board's Discard question stands alone: Start sprint is back after Cancel, on ${surface}`, async ($, on) => {
    const state = { jobs: [] as Job[], calls: [] as string[][], sprints: [DRAFT] }
    const pane = await mountOn($, on, surface, state)
    await tap(pane, { key: 'open-board-s2' })
    expect(await primaryKeys(pane)).toEqual(['board-start'])
    await tap(pane, { key: 'end-board-discard' })
    expect(await primaryKeys(pane)).toEqual(['board-discard-yes'])
    expect(await look(pane, { key: 'board-start' })).toBeFalsy()
    await tap(pane, { key: 'board-discard-no' })
    expect(await primaryKeys(pane)).toEqual(['board-start'])
    expect(said(state, 'sprint start --id s2')).toBe(false)
    await pane.unmount()
  })

  test(`a plan's notes stand alone: Approve plan and Run as one task can't be pressed while they are open, on ${surface}`, async ($, on) => {
    const state = { jobs: [] as Job[], calls: [] as string[][], sprints: [PLANS] }
    const pane = await mountOn($, on, surface, state)
    await openTicketScreen(pane, 's3', 'ABC-31')
    expect(await primaryKeys(pane)).toEqual(['approve-ABC-31'])
    await tap(pane, { key: 'revise-ABC-31' })
    expect(await primaryKeys(pane)).toEqual(['revise-send-ABC-31'])
    expect(await look(pane, { key: 'approve-ABC-31' })).toBeFalsy()
    await tap(pane, { key: 'revise-cancel-ABC-31' })
    expect(await primaryKeys(pane)).toEqual(['approve-ABC-31'])
    await tap(pane, { key: 'end-stop-ABC-31' })
    expect(await primaryKeys(pane)).toEqual(['stop-yes-ABC-31'])
    await tap(pane, { key: 'stop-no-ABC-31' })
    expect(await primaryKeys(pane)).toEqual(['approve-ABC-31'])
    await tap(pane, { key: 'back' })
    await openTicketOf(pane, 'ABC-32')
    expect(await primaryKeys(pane)).toEqual(['one-task-ABC-32'])
    await tap(pane, { key: 'revise-ABC-32' })
    expect(await primaryKeys(pane)).toEqual(['revise-send-ABC-32'])
    expect(await look(pane, { key: 'one-task-ABC-32' })).toBeFalsy()
    expect(state.calls.some((c) => c[0] === 'sprint' && ['approve', 'one-task'].includes(c[1]))).toBe(false)
    await pane.unmount()
  })

  test(`a parked ticket's Stop question stands alone: Retry is back after Cancel, on ${surface}`, async ($, on) => {
    const state = { jobs: [] as Job[], calls: [] as string[][], sprints: [LIVE] }
    const pane = await mountOn($, on, surface, state)
    await openTicketScreen(pane, 's1', 'ABC-12')
    expect(await primaryKeys(pane)).toEqual(['retry-ABC-12'])
    await tap(pane, { key: 'end-stop-ABC-12' })
    expect(await primaryKeys(pane)).toEqual(['stop-yes-ABC-12'])
    expect(await look(pane, { key: 'retry-ABC-12' })).toBeFalsy()
    await tap(pane, { key: 'stop-no-ABC-12' })
    expect(await primaryKeys(pane)).toEqual(['retry-ABC-12'])
    await pane.unmount()
  })
}

// On a job's screen the ask form, the ender's question and Repair's question are exclusive in state:
// opening one closes the others, so their answers are never primary together. Full primary set at each step, both surfaces.
const SANDBOX_WARNING = { code: 'sandbox-broken', message: "Muse couldn't run any commands: its own safety sandbox can't start on this computer.", repair: 'muse-sandbox' }
for (const surface of ['terminal', 'desktop'] as const) {
  test(`notes typed in Ask for changes, then Throw away…: only its question is open; Cancel brings back Keep changes, on ${surface}`, async ($, on) => {
    const state = { jobs: [job({ id: 'n1', status: 'needs-review', title: 'Add tests', permission: 'edit-worktree', changes: { files: 2, added: 3, removed: 1 }, hasChanges: true, worktree: 'C:\\podium\\n1', delivered: true })], calls: [] as string[][], summary: 'Added two tests.' }
    const pane = await mountOn($, on, surface, state)
    await tap(pane, { key: 'open-n1' })
    await tap(pane, { key: 'ask-detail' })
    await type(pane, { key: 'ask-task', text: 'make the heading bigger', kind: 'change' })
    expect(await primaryKeys(pane)).toEqual(ASKING)
    await tap(pane, { key: 'end-discard' })
    expect(await primaryKeys(pane)).toEqual(['discard-yes'])
    expect(await look(pane, { key: 'ask-task' })).toBeFalsy()
    expect(await look(pane, { key: 'ask-send' })).toBeFalsy()
    await tap(pane, { key: 'discard-no' })
    expect(await primaryKeys(pane)).toEqual(['keep'])
    expect(await look(pane, { key: 'ask-task' })).toBeFalsy()
    // And the other way: the ask form opened after the question closes it.
    await tap(pane, { key: 'end-discard' })
    await tap(pane, { key: 'discard-no' })
    await tap(pane, { key: 'ask-detail' })
    expect(await primaryKeys(pane)).toEqual(ASKING)
    await tap(pane, { key: 'ask-cancel' })
    expect(await primaryKeys(pane)).toEqual(['keep'])
    expect(state.calls.some((c) => ['discard', 'keep', 'dispatch'].includes(c[0]))).toBe(false)
    await pane.unmount()
  })

  test(`with Throw away its copy… asking, Review with… opens its form and closes the question, on ${surface}`, async ($, on) => {
    const state = { jobs: [job({ id: 'x1', status: 'failed', title: 'Round half-even', permission: 'edit-worktree', pr: QUIET_PR, worktree: 'C:\\podium\\x1', delivered: true, error: 'codex exited with code 1' })], calls: [] as string[][], summary: null }
    const pane = await mountOn($, on, surface, state)
    await tap(pane, { key: 'open-x1' })
    expect(await primaryKeys(pane)).toEqual(['ask-detail'])
    await tap(pane, { key: 'end-discard' })
    expect(await primaryKeys(pane)).toEqual(['discard-yes'])
    await tap(pane, { key: 'link-reviewwith' })
    expect(await look(pane, { key: 'discard-yes' })).toBeFalsy()
    expect((await primaryKeys(pane)).filter((k) => !k.startsWith('ask-agent-'))).toEqual(['ask-send'])
    await tap(pane, { key: 'ask-cancel' })
    expect(await primaryKeys(pane)).toEqual(['ask-detail'])
    expect(state.calls.some((c) => c[0] === 'discard')).toBe(false)
    await pane.unmount()
  })

  test(`Repair's question and the ask form never stand together; Cancel brings back Ask for changes, on ${surface}`, async ($, on) => {
    const state = { jobs: [job({ agent: 'muse', status: 'done', delivered: true, warning: SANDBOX_WARNING })], calls: [] as string[][] }
    const pane = await mountOn($, on, surface, state)
    await tap(pane, { key: 'fold-list:done' })
    await tap(pane, { key: 'open-j1' })
    expect(await primaryKeys(pane)).toEqual(['ask-detail'])
    await tap(pane, { key: 'ask-detail' })
    await type(pane, { key: 'ask-task', text: 'try again', kind: 'change' })
    expect((await primaryKeys(pane)).filter((k) => !k.startsWith('ask-agent-'))).toEqual(['ask-send'])
    await tap(pane, { key: 'repair' })
    expect(await primaryKeys(pane)).toEqual(['repair-yes'])
    expect(await look(pane, { key: 'ask-task' })).toBeFalsy()
    await tap(pane, { key: 'repair-no' })
    expect(await primaryKeys(pane)).toEqual(['ask-detail'])
    await tap(pane, { key: 'repair' })
    await tap(pane, { key: 'repair-no' })
    await tap(pane, { key: 'ask-detail' })
    expect(await look(pane, { key: 'repair-yes' })).toBeFalsy()
    await tap(pane, { key: 'ask-cancel' })
    expect(await primaryKeys(pane)).toEqual(['ask-detail'])
    expect(state.calls.some((c) => c[0] === 'repair')).toBe(false)
    await pane.unmount()
  })

  // Presses that overlap (fired without waiting for each other) still leave at most one open, since
  // the form and both questions are one value changed in one update. The answer shown is one primary (the form's agent
  // picker aside).
  test(`overlapping presses of Ask for changes, Throw away… and Repair… leave at most one open, in any order, on ${surface}`, async ($, on) => {
    const answers = ['ask-send', 'discard-yes', 'repair-yes']
    const shownAnswers = async (pane: any) => (await primaryKeys(pane)).filter((k) => !k.startsWith('ask-agent-'))
    const state = { jobs: [job({ id: 'n1', agent: 'muse', status: 'needs-review', title: 'Add tests', permission: 'edit-worktree', changes: { files: 2, added: 3, removed: 1 }, hasChanges: true, worktree: 'C:\\podium\\n1', delivered: true, warning: SANDBOX_WARNING })], calls: [] as string[][], summary: 'Added two tests.' }
    const pane = await mountOn($, on, surface, state)
    await tap(pane, { key: 'open-n1' })
    for (const order of [['ask-detail', 'end-discard'], ['end-discard', 'ask-detail'], ['ask-detail', 'repair', 'end-discard'], ['repair', 'end-discard', 'ask-detail'], ['end-discard', 'repair', 'ask-detail']]) {
      expect(await primaryKeys(pane)).toEqual(['keep'])
      // Fired together, none waiting for the one before.
      await Promise.all(order.map((key) => pane.press({ key }).catch(() => undefined)))
      await settle(pane)
      const shown = await shownAnswers(pane)
      expect(shown.length).toBe(1)
      expect(answers).toContain(shown[0])
      // Whatever is open, Cancel brings back the next step.
      const cancel = shown[0] === 'ask-send' ? 'ask-cancel' : shown[0] === 'discard-yes' ? 'discard-no' : 'repair-no'
      await tap(pane, { key: cancel })
    }
    expect(await primaryKeys(pane)).toEqual(['keep'])
    expect(state.calls.some((c) => ['discard', 'keep', 'repair', 'dispatch'].includes(c[0]))).toBe(false)
    await pane.unmount()
  })
}

// A PR's problem shows on the status line of any latest job with an open PR, not only an in-review one.
test('a follow-up on an open PR that GitHub refused to merge says so on its status line', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const blocked = { ...PR, attention: 'blocked', blocked: 'Required review missing', checks: { total: 1, passed: 1, failed: 0, running: 0, failing: [], failedRunId: null } }
  const state = { jobs: [job({ id: 'b1', status: 'needs-review', title: 'Round half-even', permission: 'edit-worktree', pr: blocked, changes: { files: 1, added: 2, removed: 0 }, hasChanges: true, worktree: 'C:\\podium\\b1', delivered: true })], calls: [] as string[][], summary: 'ok' }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await mountPane($)
  await settle(pane)
  await tap(pane, { key: 'open-b1' })
  expect(await look(pane, { type: 'Text', text: /^Codex finished .+ ago · new changes for PR #12 · GitHub refused the merge: Required review missing$/ })).toBeTruthy()
  await pane.unmount()
})

// The PR's actions belong to the thread's latest step, as the card's did: an earlier step opened from Steps shows none.
test('an earlier step of a thread with an open PR offers no PR actions', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const quietPr = { ...PR, attention: null, checks: { total: 1, passed: 1, failed: 0, running: 0, failing: [], failedRunId: null } }
  const state = {
    jobs: [
      job({ id: 'g2', threadId: 'g1', step: 2, followUpOf: 'g1', status: 'needs-review', title: 'Round half-even', permission: 'edit-worktree', pr: quietPr, changes: { files: 1, added: 2, removed: 0 }, hasChanges: true, worktree: 'C:\\podium\\g2', delivered: true, createdAt: '2026-10-05T12:05:00Z' }),
      job({ id: 'g1', threadId: 'g1', step: 1, status: 'done', title: 'Round half-even', permission: 'edit-worktree', pr: quietPr, worktree: 'C:\\podium\\g2', delivered: true, createdAt: '2026-10-05T12:00:00Z' }),
    ],
    calls: [] as string[][], summary: 'ok',
  }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await mountPane($)
  await settle(pane)
  await tap(pane, { key: 'open-g2' })
  expect(await look(pane, { key: 'push' })).toBeTruthy()
  expect(await look(pane, { key: 'link-browse' })).toBeTruthy()
  await tap(pane, { key: 'fold-job:g2:steps' })
  await tap(pane, { key: 'step-g1' })
  for (const key of ['push', 'link-browse', 'automerge', 'link-reviewwith']) expect(await look(pane, { key })).toBeFalsy()
  await pane.unmount()
})

// Opening a CI job's folds shows its summary, PR details, metadata and output.
test('a CI job shows its details once its folds are open', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const state = { jobs: [CI_JOB()], calls: [] as string[][], summary: 'Fixed the rounding.', output: 'the whole output' }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await mountPane($)
  await settle(pane)
  await tap(pane, { key: 'open-p1' })
  await openFolds(pane)
  const text = await drawnText(pane)
  for (const fact of ['Fix rounding', 'Fixed the rounding.', 'PR #12', 'test (windows)', '2 passed', 'review: none yet', 'https://github.com/o/r/pull/12', 'feat/x', 'Ticket: ABC-4', 'Job id: p1', 'the whole output', 'Codex could edit files in a separate copy']) {
    expect(text).toContain(fact)
  }
  await pane.unmount()
})

// The failed and done job screens, and the add-agent screen, lose nothing either.
for (const [id, facts, open] of [
  ['f1', ['Update the docs', 'stopped with an error', 'codex exited with code 1', 'the whole output', 'Ticket: ABC-4', 'Access: Codex', 'Agent: Codex', 'Job id: f1', '👍', '👎'], ['open-f1']],
  ['d1', ['Review the branch', 'Codex finished', 'The branch looks fine.', 'the whole output', 'Ticket: ABC-4', 'Agent: Codex', 'Job id: d1', 'Ask for changes'], ['fold-list:done', 'open-d1']],
] as const) {
  test(`nothing a ${id === 'f1' ? 'failed' : 'done'} job showed before is lost: open every fold on its screen`, async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('session.id', () => ({ value: 'chat-1' }))
    const state = { jobs: firstViewJobs(), calls: [] as string[][], summary: id === 'd1' ? 'The branch looks fine.' : null, output: 'the whole output', doctor: GH_READY }
    on('process.run', (_$, e) => fakeEngine(state)(e.argv))
    on('fs.read', () => ({ deny: 'missing' }))
    await $.command.run({ command: 'podium', args: '' })
    const pane = await mountPane($)
    await settle(pane)
    for (const key of open) await tap(pane, { key })
    await openFolds(pane)
    const text = await drawnText(pane)
    for (const fact of facts) expect(text).toContain(fact)
    await pane.unmount()
  })
}

test('nothing the add-agent screen showed before is lost', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const state = { jobs: [] as Job[], calls: [] as string[][] }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await mountPane($)
  await settle(pane)
  await tapFirst(pane, ['link-agents'])
  await tap(pane, { key: 'add-agent' })
  await openFolds(pane)
  const text = await drawnText(pane)
  for (const fact of ['Add an agent', 'Its command', 'e.g. gemini, opencode, aider', 'Look it up', '--help', '← Agents']) expect(text).toContain(fact)
  await pane.unmount()
})

// ---- A ticket's own screen ----
const openTicketScreen = async (pane: any, sprint: string, key: string) => {
  await tapFirst(pane, [`open-board-${sprint}`])
  await tapFirst(pane, [`open-${sprint}-${key}`, `open-ticket-${key}`, `ticket-${key}`])
}
for (const surface of ['terminal', 'desktop'] as const) {
  test(`a plan waiting opens on its own screen: its tasks, Approve plan first, who and the plan file folded, on ${surface}`, async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    const state = { jobs: [] as Job[], calls: [] as string[][], sprints: [PLANS] }
    on('process.run', (_$, e) => fakeEngine(state)(e.argv))
    await $.command.run({ command: 'podium', args: '' })
    const pane = await $.ui.mount({ plugin: 'podium', surface, component: 'Pane', props: { title: 'Podium', isFocused: true, bodyColumns: 100 }, requestId: 'podium' })
    await settle(pane)
    await openTicketScreen(pane, 's3', 'ABC-31')
    expect(await look(pane, { type: 'Text', text: /^ABC-31 Export to CSV$/ })).toBeTruthy()
    expect(await look(pane, { type: 'Text', text: /^Plan ready · check it, then approve$/ })).toBeTruthy()
    expect(await look(pane, { type: 'Text', text: /· Task 1: Add the export button/ })).toBeTruthy()
    expect(await primaryKeys(pane)).toEqual(['approve-ABC-31'])
    expect(await look(pane, { key: 'revise-ABC-31' })).toBeTruthy()
    expect(await look(pane, { type: 'Button', text: /▸ Who works on it · Muse writes, Codex reviews/ })).toBeTruthy()
    expect(await look(pane, { type: 'Button', text: /▸ Plan file · 2026-10-07-abc-31-export-to-csv\.md/ })).toBeTruthy()
    expect(await look(pane, { key: 'end-stop-ABC-31' })).toBeTruthy()
    await tap(pane, { key: 'approve-ABC-31' })
    expect(said(state, 'sprint approve --id s3 --ticket ABC-31')).toBe(true)
    await tap(pane, { key: 'back' })
    expect(await look(pane, { key: 'open-s3-ABC-31' })).toBeTruthy()
    await pane.unmount()
  })

  test(`a parked ticket: why, Retry first, Give to another agent… then its buttons, and Stop asks first, on ${surface}`, async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    const state = { jobs: [] as Job[], calls: [] as string[][], sprints: [LIVE] }
    on('process.run', (_$, e) => fakeEngine(state)(e.argv))
    await $.command.run({ command: 'podium', args: '' })
    const pane = await $.ui.mount({ plugin: 'podium', surface, component: 'Pane', props: { title: 'Podium', isFocused: true, bodyColumns: 100 }, requestId: 'podium' })
    await settle(pane)
    await openTicketScreen(pane, 's1', 'ABC-12')
    expect(await look(pane, { type: 'Text', text: /^Review failed twice on task 2$/ })).toBeTruthy()
    expect(await look(pane, { type: 'Text', text: /^Missing test for rounding\.$/ })).toBeTruthy()
    expect(await primaryKeys(pane)).toEqual(['retry-ABC-12'])
    expect(await look(pane, { key: 'giveto-ABC-12-muse' })).toBeFalsy()
    await tap(pane, { key: 'give-ABC-12' })
    await tap(pane, { key: 'giveto-ABC-12-muse' })
    expect(said(state, 'sprint retry --id s1 --ticket ABC-12 --agent muse')).toBe(true)
    await tap(pane, { key: 'end-stop-ABC-12' })
    expect(said(state, 'sprint stop --id s1 --ticket ABC-12')).toBe(false)
    await tap(pane, { key: 'stop-yes-ABC-12' })
    expect(said(state, 'sprint stop --id s1 --ticket ABC-12')).toBe(true)
    await pane.unmount()
  })

  test(`a draft ticket's changes live on its screen: who, what it waits for, its place and Remove, on ${surface}`, async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    const state = { jobs: [] as Job[], calls: [] as string[][], sprints: [DRAFT] }
    on('process.run', (_$, e) => fakeEngine(state)(e.argv))
    await $.command.run({ command: 'podium', args: '' })
    const pane = await $.ui.mount({ plugin: 'podium', surface, component: 'Pane', props: { title: 'Podium', isFocused: true, bodyColumns: 100 }, requestId: 'podium' })
    await settle(pane)
    await openTicketScreen(pane, 's2', 'ABC-22')
    expect(await look(pane, { type: 'Text', text: /^1 task · nothing runs until the sprint starts$/ })).toBeTruthy()
    await tap(pane, { key: 'fold-ticket:s2:ABC-22:who' })
    await tap(pane, { key: 'change-ABC-22-all' })
    await tap(pane, { key: 'ticket-writer-ABC-22-codex' })
    expect(said(state, 'sprint assign --id s2 --ticket ABC-22 --agent codex')).toBe(true)
    await tap(pane, { key: 'fold-ticket:s2:ABC-22:after' })
    await tap(pane, { key: 'after-ABC-22-ABC-21' })
    expect(said(state, 'sprint after --id s2 --ticket ABC-22 --add ABC-21')).toBe(true)
    await tap(pane, { key: 'up-ABC-22' })
    expect(said(state, 'sprint move --id s2 --ticket ABC-22 --to up')).toBe(true)
    await tap(pane, { key: 'remove-ABC-22' })
    expect(said(state, 'sprint remove --id s2 --ticket ABC-22')).toBe(true)
    await pane.unmount()
  })
}

test('a sprint step\'s screen goes back to its ticket', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const step = job({ id: 'sa1', title: 'ABC-12 task 2: Add b', status: 'done', delivered: true, sprint: { id: 's1', ticket: 'ABC-12', task: 2, role: 'author' } })
  const state = { jobs: [step], calls: [] as string[][], sprints: [LIVE] }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await mountPane($)
  await settle(pane)
  await openTicketScreen(pane, 's1', 'ABC-12')
  await tap(pane, { key: 'open-steps-ABC-12' })
  expect(await look(pane, { type: 'Button', text: /← ABC-12/ })).toBeTruthy()
  await tap(pane, { key: 'back' })
  expect(await look(pane, { type: 'Text', text: /^Review failed twice on task 2$/ })).toBeTruthy()
  await pane.unmount()
})

test('nothing a plan\'s row showed before is lost: open every fold on its ticket\'s screen', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const state = { jobs: [] as Job[], calls: [] as string[][], sprints: [PLANS] }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await mountPane($)
  await settle(pane)
  await openTicketScreen(pane, 's3', 'ABC-31')
  await openFolds(pane)
  const text = await drawnText(pane)
  for (const fact of ['ABC-31', 'Export to CSV', 'Add the export button', 'Write the CSV', 'docs/plans/2026-10-07-abc-31-export-to-csv.md', 'Muse', 'Codex']) expect(text).toContain(fact)
  await pane.unmount()
})

// ---- The sprint board ----
for (const surface of ['terminal', 'desktop'] as const) {
  test(`a running board: its status line, its own Your turn, one line per ticket, Options folded, Pause at the bottom, on ${surface}`, async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    const state = { jobs: [] as Job[], calls: [] as string[][], sprints: [LIVE] }
    on('process.run', (_$, e) => fakeEngine(state)(e.argv))
    await $.command.run({ command: 'podium', args: '' })
    const pane = await $.ui.mount({ plugin: 'podium', surface, component: 'Pane', props: { title: 'Podium', isFocused: true, bodyColumns: 120 }, requestId: 'podium' })
    await settle(pane)
    await tap(pane, { key: 'open-board-s1' })
    expect(await look(pane, { type: 'Text', text: /^Oct week 2$/ })).toBeTruthy()
    expect(await look(pane, { type: 'Text', text: /^0 of 2 done · 1 of 3 running: ABC-11$/ })).toBeTruthy()
    expect(await look(pane, { type: 'Text', text: /^Your turn · 1$/ })).toBeTruthy()
    expect(await look(pane, { type: 'Button', text: /See why/ })).toBeTruthy()
    expect(await look(pane, { type: 'Text', text: /Review failed twice on task 2/ })).toBeTruthy()
    expect(await look(pane, { type: 'Button', text: /ABC-11 Login form · task 2 of 3 · Muse working/ })).toBeTruthy()
    expect(await look(pane, { type: 'Button', text: /▸ Options · 3 at once\s*$/ })).toBeTruthy()
    // A ticket in Your turn is not listed again under the tickets (say it once).
    expect(await look(pane, { type: 'Text', text: /^Other tickets$/ })).toBeTruthy()
    expect(await look(pane, { key: 'open-ticket-ABC-12' })).toBeFalsy()
    expect(await primaryKeys(pane)).toEqual(['turn-s1-ABC-12'])
    await tap(pane, { key: 'board-pause' })
    expect(said(state, 'sprint pause --id s1')).toBe(true)
    await tap(pane, { key: 'turn-s1-ABC-12' })
    expect(await look(pane, { type: 'Text', text: /^ABC-12 Payouts$/ })).toBeTruthy()
    await pane.unmount()
  })

  test(`a paused board offers Resume sprint first, and no Pause, on ${surface}`, async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    const state = { jobs: [] as Job[], calls: [] as string[][], sprints: [{ ...LIVE, paused: true }] }
    on('process.run', (_$, e) => fakeEngine(state)(e.argv))
    await $.command.run({ command: 'podium', args: '' })
    const pane = await $.ui.mount({ plugin: 'podium', surface, component: 'Pane', props: { title: 'Podium', isFocused: true, bodyColumns: 120 }, requestId: 'podium' })
    await settle(pane)
    await tap(pane, { key: 'open-board-s1' })
    expect((await primaryKeys(pane))[0]).toBe('board-resume')
    expect(await look(pane, { key: 'board-pause' })).toBeFalsy()
    await tap(pane, { key: 'board-resume' })
    expect(said(state, 'sprint resume --id s1')).toBe(true)
    await pane.unmount()
  })

  test(`a draft board: Start sprint first, its tickets, Options folded, Discard asks first, on ${surface}`, async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    const state = { jobs: [] as Job[], calls: [] as string[][], sprints: [DRAFT] }
    on('process.run', (_$, e) => fakeEngine(state)(e.argv))
    await $.command.run({ command: 'podium', args: '' })
    const pane = await $.ui.mount({ plugin: 'podium', surface, component: 'Pane', props: { title: 'Podium', isFocused: true, bodyColumns: 120 }, requestId: 'podium' })
    await settle(pane)
    await tap(pane, { key: 'open-board-s2' })
    expect(await look(pane, { type: 'Text', text: /^Oct week 3 · draft$/ })).toBeTruthy()
    expect(await look(pane, { type: 'Text', text: /^Nothing runs until you start it\.$/ })).toBeTruthy()
    expect(await primaryKeys(pane)).toEqual(['board-start'])
    expect(await look(pane, { type: 'Button', text: /ABC-21 Export · 2 tasks/ })).toBeTruthy()
    await tap(pane, { key: 'fold-board:s2:options' })
    await tap(pane, { key: 'board-automerge' })
    expect(said(state, 'sprint options --id s2 --merge-when-green true')).toBe(true)
    await tap(pane, { key: 'board-atonce-2' })
    expect(said(state, 'sprint options --id s2 --at-once 2')).toBe(true)
    await tap(pane, { key: 'end-board-discard' })
    expect(said(state, 'sprint discard --id s2')).toBe(false)
    await tap(pane, { key: 'board-discard-yes' })
    expect(said(state, 'sprint discard --id s2')).toBe(true)
    await pane.unmount()
  })
}

test('nothing a board showed before is lost: open every fold on it', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const state = { jobs: [] as Job[], calls: [] as string[][], sprints: [LIVE] }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await mountPane($)
  await settle(pane)
  await tap(pane, { key: 'open-board-s1' })
  await openFolds(pane)
  const text = await drawnText(pane)
  for (const fact of ['Oct week 2', 'ABC-11', 'Login form', 'ABC-12', 'Payouts', '3 at once', 'merge when green off', 'Review failed twice on task 2', '0 of 2 done']) expect(text).toContain(fact)
  await pane.unmount()
})

// ---- The main list ----
const GREEN = { ...PR, checks: { total: 3, passed: 3, failed: 0, running: 0, failing: [] }, attention: null }
const listJobs = (): Job[] => [...firstViewJobs(), job({ id: 'g1', status: 'in-review', title: 'Green work', permission: 'edit-worktree', pr: GREEN, delivered: true, origin: { session: 'chat-1' } })]
for (const surface of ['terminal', 'desktop'] as const) {
  test(`the list: Your turn first with one button each, then Working, In review, and Done and Other chats folded, on ${surface}`, async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('session.id', () => ({ value: 'chat-1' }))
    const state = { jobs: listJobs(), calls: [] as string[][], sprints: [LIVE, DRAFT], doctor: GH_READY }
    on('process.run', (_$, e) => fakeEngine(state)(e.argv))
    on('fs.read', (_$, e) => (String(e.path).split('\\').join('/').endsWith('r1/live.json') ? { value: liveText('reading src/auth/session.ts') } : { deny: 'missing' }))
    await $.command.run({ command: 'podium', args: '' })
    const pane = await $.ui.mount({ plugin: 'podium', surface, component: 'Pane', props: { title: 'Podium', isFocused: true, bodyColumns: 120 }, requestId: 'podium' })
    await settle(pane)
    expect(await look(pane, { key: 'link-agents' })).toBeTruthy()
    expect(await look(pane, { key: 'link-settings' })).toBeTruthy()
    expect(await look(pane, { type: 'Text', text: /^\d+ working$/ })).toBeFalsy()
    expect(await look(pane, { type: 'Text', text: /^Your turn · 4$/ })).toBeTruthy()
    expect(await look(pane, { type: 'Button', text: /^\s*Review\s*$/ })).toBeTruthy()
    expect(await look(pane, { type: 'Button', text: /Send fix to Codex/ })).toBeTruthy()
    expect(await look(pane, { type: 'Button', text: /See what happened/ })).toBeTruthy()
    expect(await look(pane, { type: 'Button', text: /See why/ })).toBeTruthy()
    expect((await primaryKeys(pane)).sort()).toEqual(['turn-f1', 'turn-n1', 'turn-p1', 'turn-s1-ABC-12'])
    expect(await look(pane, { type: 'Text', text: /^Working · 3$/ })).toBeTruthy()
    expect(await look(pane, { type: 'Text', text: /reading src\/auth\/session\.ts/ })).toBeTruthy()
    expect(await look(pane, { type: 'Button', text: /Sprint · Oct week 2/ })).toBeTruthy()
    expect(await look(pane, { type: 'Text', text: /^0 of 2 done · 1 of 3 running: ABC-11$/ })).toBeTruthy()
    expect(await look(pane, { type: 'Text', text: /^Draft · 2 tickets · not started$/ })).toBeTruthy()
    expect(await look(pane, { type: 'Text', text: /^In review · 1$/ })).toBeTruthy()
    expect(await look(pane, { type: 'Text', text: /^3 of 3 checks passed · review: none yet$/ })).toBeTruthy()
    expect(await look(pane, { type: 'Button', text: /▸ Done · 1/ })).toBeTruthy()
    expect(await look(pane, { type: 'Button', text: /▸ Other chats · 1/ })).toBeTruthy()
    expect(await look(pane, { key: 'open-d1' })).toBeFalsy()
    await tap(pane, { key: 'fold-list:done' })
    expect(await look(pane, { key: 'open-d1' })).toBeTruthy()
    expect(await look(pane, { type: 'Text', text: /^Codex · finished .+ ago$/ })).toBeTruthy()
    await tap(pane, { key: 'turn-p1' })
    expect(state.calls.some((c) => c[0] === 'pr' && c[1] === 'fix')).toBe(true)
    expect(await look(pane, { key: 'ask-task' })).toBeTruthy()
    await pane.unmount()
  })

  test(`a first run shows a short welcome, Try it first, and the setup checks folded unless something is wrong, on ${surface}`, async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    const state = { jobs: [] as Job[], calls: [] as string[][], doctor: NEW_USER }
    on('process.run', (_$, e) => fakeEngine(state)(e.argv))
    await $.command.run({ command: 'podium', args: '' })
    const pane = await $.ui.mount({ plugin: 'podium', surface, component: 'Pane', props: { title: 'Podium', isFocused: true, bodyColumns: 100 }, requestId: 'podium' })
    await settle(pane)
    expect(await look(pane, { type: 'Text', text: /^Hand work to another agent from the chat, or press \+ New job\.$/ })).toBeTruthy()
    expect(await primaryKeys(pane)).toEqual(['welcome-try'])
    expect(await look(pane, { type: 'Button', text: /▸ Your setup · all good/ })).toBeTruthy()
    expect(await look(pane, { text: /Node 22\.3\.0/ })).toBeFalsy()
    await pane.unmount()
  })
}

test('a first run with something to fix opens the setup checks on their own', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const state = { jobs: [] as Job[], calls: [] as string[][], doctor: { ...NEW_USER, node: { ok: false, version: '18.0.0' } } }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await mountPane($)
  await settle(pane)
  expect(await look(pane, { type: 'Button', text: /▾ Your setup · 1 thing to fix/ })).toBeTruthy()
  expect(await look(pane, { text: /Podium needs Node 22 or newer/ })).toBeTruthy()
  await pane.unmount()
})

test('nothing the list showed before is lost: every item is on the list or one fold away', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.id', () => ({ value: 'chat-1' }))
  const state = { jobs: listJobs(), calls: [] as string[][], sprints: [LIVE, DRAFT], doctor: GH_READY }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  on('fs.read', (_$, e) => (String(e.path).split('\\').join('/').endsWith('r1/live.json') ? { value: liveText('reading src/auth/session.ts') } : { deny: 'missing' }))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await mountPane($)
  await settle(pane)
  await openFolds(pane)
  const text = await drawnText(pane)
  for (const fact of ['Review the auth branch', 'reading src/auth/session.ts', 'Add tests', 'Fix rounding', 'test (windows)', 'Green work', 'PR #12', 'Review the branch', 'Update the docs', 'Other chat work', 'Oct week 2', 'Oct week 3', 'Review failed twice on task 2']) expect(text).toContain(fact)
  await pane.unmount()
})

// ---- State colours on rows and screen heads ----
// Colour adds no words (the first-view word counts above still hold). Every colour is a theme key (hooks/theme.ts): `needs`
// is the warning edge, `working` suggestion, `done` success, `failed` error, `neutral` promptBorder.
const EDGE = { needs: 'warning', working: 'suggestion', done: 'success', failed: 'error', neutral: 'promptBorder' }
const edgeOf = (tree: any, key: string) => drawnByKey(tree, key)?.props?.borderColor
const tileOf = (tree: any, key: string) => drawnByKey(tree, key)?.props
const noHex = (tree: any) => expect(JSON.stringify(tree)).not.toMatch(/"(backgroundColor|borderColor)":"#/)
// A sprint with a ticket in every state the board colours.
const ticketIn = (key: string, state: string, over: Record<string, unknown> = {}) => ({ ...LIVE.tickets[0], key, title: `Ticket ${key}`, state, pr: null, ...over })
const MIXED = {
  ...LIVE, id: 's6', name: 'Oct week 6',
  tickets: [
    ticketIn('MIX-1', 'running'), ticketIn('MIX-2', 'pr-open', { pr: { number: 5 } }), ticketIn('MIX-3', 'merged', { pr: { number: 6 } }),
    ticketIn('MIX-4', 'stopped'), ticketIn('MIX-5', 'closed', { pr: { number: 7 } }), ticketIn('MIX-6', 'pending'),
  ],
}
const RUNNING_ONLY = { ...LIVE, id: 's5', name: 'Oct week 7', tickets: [LIVE.tickets[0]] }
const UNREADABLE = { id: 'u1', name: 'Broken sprint', unreadable: 'Podium could not show this sprint (the state file is damaged).', draft: false, discarded: false, paused: false, finishedAt: null, autoMerge: false, maxParallel: null, news: 0, tickets: [] }
const coloursState = () => ({
  jobs: [...listJobs(), job({ id: 'c1', status: 'cancelled', title: 'Stopped by me', delivered: true, origin: { session: 'chat-1' } }), job({ id: 'o2', status: 'cancelled', title: 'Other chat stopped', delivered: true, origin: { session: 'chat-2' } })],
  calls: [] as string[][], sprints: [LIVE, DRAFT, RUNNING_ONLY, UNREADABLE, MIXED], doctor: GH_READY, summary: 'Added two tests for rounding.',
})
async function mountColours($: any, on: any, state: any, columns = 100) {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.id', () => ({ value: 'chat-1' }))
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  on('fs.read', (_$, e) => (String(e.path).split('\\').join('/').endsWith('r1/live.json') ? { value: liveText('reading src/auth/session.ts') } : { deny: 'missing' }))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await $.ui.mount({ plugin: 'podium', surface: 'desktop', component: 'Pane', props: { title: 'Podium', isFocused: true, bodyColumns: columns }, requestId: 'podium' })
  await settle(pane)
  return pane
}

test('the list: every row sits in a tile coloured by its state', async ($, on) => {
  const pane = await mountColours($, on, coloursState())
  await openFolds(pane)
  const tree = await pane.drawn({ in: APP })
  // Your turn: needs (a job to review, a PR to fix, a failed job, a parked sprint ticket).
  for (const key of ['turnitem-n1', 'turnitem-p1', 'turnitem-f1', 'turnitem-s1-ABC-12']) expect(edgeOf(tree, key)).toBe(EDGE.needs)
  expect(tileOf(tree, 'turnitem-n1')?.backgroundColor).toBe('userMessageBackground')
  // Working jobs, and a sprint by what its tickets need.
  expect(edgeOf(tree, 'item-r1')).toBe(EDGE.working)
  expect(edgeOf(tree, 'item-board-s1')).toBe(EDGE.needs)
  expect(edgeOf(tree, 'item-board-s5')).toBe(EDGE.working)
  expect(edgeOf(tree, 'item-board-s6')).toBe(EDGE.working)
  expect(edgeOf(tree, 'item-board-s2')).toBe(EDGE.neutral)
  expect(edgeOf(tree, 'item-board-u1')).toBe(EDGE.failed)
  // In review: neutral.
  expect(edgeOf(tree, 'item-g1')).toBe(EDGE.neutral)
  // Done and Other chats: done, or failed for a cancelled job.
  expect(edgeOf(tree, 'item-d1')).toBe(EDGE.done)
  expect(edgeOf(tree, 'item-c1')).toBe(EDGE.failed)
  expect(edgeOf(tree, 'item-o1')).toBe(EDGE.done)
  expect(edgeOf(tree, 'item-o2')).toBe(EDGE.failed)
  // Left bare: the folds' headings and the section headings.
  expect(drawnByKey(tree, 'foldbox-list:done')?.props?.borderColor).toBeUndefined()
  expect(drawnByKey(tree, 'h-working')?.props?.borderColor).toBeUndefined()
  noHex(tree)
  // The row's button is still inside its tile, so a press still opens the job.
  await tap(pane, { key: 'open-d1' })
  expect(await look(pane, { key: 'job-tile' })).toBeTruthy()
  await pane.unmount()
})

test('a job\'s own screen: its title and status line sit together in one tile coloured by its state', async ($, on) => {
  const pane = await mountColours($, on, coloursState())
  const cases: [string, string][] = [['r1', EDGE.working], ['n1', EDGE.needs], ['p1', EDGE.needs], ['f1', EDGE.failed], ['g1', EDGE.neutral]]
  for (const [id, edge] of cases) {
    await tap(pane, { key: `open-${id}` })
    const tree = await pane.drawn({ in: APP })
    expect(edgeOf(tree, 'job-tile')).toBe(edge)
    const tile = drawnByKey(tree, 'job-tile')
    expect(JSON.stringify(tile)).toContain('"bold":true')
    expect(JSON.stringify(tile)).toMatch(/Codex|Review|Add tests|Fix rounding|Update the docs|Green work/)
    // The Back button is outside the tile.
    expect(JSON.stringify(tile)).not.toContain('"back"')
    noHex(tree)
    await tap(pane, { key: 'back' })
  }
  await tap(pane, { key: 'fold-list:done' })
  await tap(pane, { key: 'open-d1' })
  expect(edgeOf(await pane.drawn({ in: APP }), 'job-tile')).toBe(EDGE.done)
  await pane.unmount()
})

test('the board: Your turn rows are needs, and each ticket line is coloured by its state', async ($, on) => {
  const pane = await mountColours($, on, coloursState())
  await tap(pane, { key: 'open-board-s1' })
  let tree = await pane.drawn({ in: APP })
  expect(edgeOf(tree, 'turnitem-s1-ABC-12')).toBe(EDGE.needs)
  expect(edgeOf(tree, 'item-ticket-ABC-11')).toBe(EDGE.working)
  noHex(tree)
  await tap(pane, { key: 'back' })
  await tap(pane, { key: 'open-board-s6' })
  tree = await pane.drawn({ in: APP })
  expect(edgeOf(tree, 'item-ticket-MIX-1')).toBe(EDGE.working)
  expect(edgeOf(tree, 'item-ticket-MIX-2')).toBe(EDGE.done)
  expect(edgeOf(tree, 'item-ticket-MIX-3')).toBe(EDGE.done)
  expect(edgeOf(tree, 'item-ticket-MIX-4')).toBe(EDGE.failed)
  expect(edgeOf(tree, 'item-ticket-MIX-5')).toBe(EDGE.failed)
  expect(edgeOf(tree, 'item-ticket-MIX-6')).toBe(EDGE.neutral)
  // The line is still one button that opens the ticket.
  await tap(pane, { key: 'open-ticket-MIX-2' })
  expect(await look(pane, { key: 'ticket-tile' })).toBeTruthy()
  await pane.unmount()
})

test('a board with a draft: its ticket lines are neutral', async ($, on) => {
  const pane = await mountColours($, on, coloursState())
  await tap(pane, { key: 'open-board-s2' })
  const tree = await pane.drawn({ in: APP })
  expect(edgeOf(tree, 'item-ticket-ABC-21')).toBe(EDGE.neutral)
  await pane.unmount()
})

test('a ticket\'s screen: key, title and status line sit together in one tile, coloured as its board line is', async ($, on) => {
  const pane = await mountColours($, on, coloursState())
  await tap(pane, { key: 'open-board-s1' })
  await openTicketOf(pane, 'ABC-11')
  let tree = await pane.drawn({ in: APP })
  expect(edgeOf(tree, 'ticket-tile')).toBe(EDGE.working)
  expect(JSON.stringify(drawnByKey(tree, 'ticket-tile'))).toContain('ABC-11 Login form')
  await tap(pane, { key: 'back' })
  await openTicketOf(pane, 'ABC-12')
  tree = await pane.drawn({ in: APP })
  expect(edgeOf(tree, 'ticket-tile')).toBe(EDGE.needs)
  noHex(tree)
  await tap(pane, { key: 'back' })
  await tap(pane, { key: 'back' })
  await tap(pane, { key: 'open-board-s6' })
  for (const [key, edge] of [['MIX-2', EDGE.done], ['MIX-4', EDGE.failed], ['MIX-6', EDGE.neutral]]) {
    await openTicketOf(pane, key)
    expect(edgeOf(await pane.drawn({ in: APP }), 'ticket-tile')).toBe(edge)
    await tap(pane, { key: 'back' })
  }
  await pane.unmount()
})

test('Agents: each agent row and each agent\'s screen head is coloured by its readiness', async ($, on) => {
  const agent = (name: string, over: Record<string, unknown> = {}) => ({ name, label: name[0].toUpperCase() + name.slice(1), installed: true, version: '1', signedIn: true, verified: true, source: 'builtin', enabled: true, defaultPermission: 'edit-worktree', stats: { jobs: 0, used: 0 }, ...over })
  const state: any = { ...coloursState(), agentList: [agent('codex'), agent('muse', { signedIn: false }), agent('gemini', { installed: false, version: null }), agent('aider', { enabled: false })] }
  const pane = await mountColours($, on, state)
  await tapFirst(pane, ['link-agents', 'agents'])
  const tree = await pane.drawn({ in: APP })
  expect(edgeOf(tree, 'agentrow-codex')).toBe(EDGE.done)
  expect(edgeOf(tree, 'agentrow-muse')).toBe(EDGE.needs)
  expect(edgeOf(tree, 'agentrow-gemini')).toBe(EDGE.neutral)
  expect(edgeOf(tree, 'agentrow-aider')).toBe(EDGE.neutral)
  noHex(tree)
  // The Fix button of a row that needs it is still there, inside its tile.
  expect(JSON.stringify(drawnByKey(tree, 'agentrow-muse'))).toContain('"fix-muse"')
  for (const [name, edge] of [['codex', EDGE.done], ['muse', EDGE.needs], ['gemini', EDGE.neutral]]) {
    await tap(pane, { key: `open-agent-${name}` })
    expect(edgeOf(await pane.drawn({ in: APP }), 'agent-tile')).toBe(edge)
    await tap(pane, { key: 'back' })
  }
  await pane.unmount()
})

// ---- New job ----
for (const surface of ['terminal', 'desktop'] as const) {
  test(`New job asks who and what, says the access in one line, and keeps the rest under More options, on ${surface}`, async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    const state = { jobs: [] as Job[], calls: [] as string[][] }
    let stdin: string | undefined
    on('process.run', (_$, e) => { if (e.argv[2] === 'dispatch') stdin = e.init?.stdin; return fakeEngine(state)(e.argv) })
    await $.command.run({ command: 'podium', args: '' })
    const pane = await $.ui.mount({ plugin: 'podium', surface, component: 'Pane', props: { title: 'Podium', isFocused: true, bodyColumns: 80 }, requestId: 'podium' })
    await settle(pane)
    await tap(pane, { key: 'new' })
    expect(await look(pane, { key: 'who-codex' })).toBeTruthy()
    expect(await look(pane, { key: 'who-muse' })).toBeTruthy()
    expect(await look(pane, { type: 'Text', text: /^Works in a separate copy · you review before keeping$/ })).toBeTruthy()
    expect(await primaryKeys(pane)).toEqual(['who-codex', 'start'])
    expect(await look(pane, { type: 'Button', text: /▸ More options · separate copy/ })).toBeTruthy()
    expect(await look(pane, { key: 'ticket' })).toBeFalsy()
    await tap(pane, { key: 'fold-new:more' })
    await tap(pane, { key: 'access-read-only' })
    expect(await look(pane, { type: 'Text', text: /^Only reads files · changes nothing$/ })).toBeTruthy()
    await type(pane, { key: 'ticket', text: 'ABC-6' })
    await type(pane, { key: 'base', text: 'feat/x' })
    await type(pane, { key: 'task', text: 'List the files' })
    expect(stdin).toBe('List the files')
    const dispatched = state.calls.find((c) => c[0] === 'dispatch') ?? []
    expect(dispatched).toContain('read-only')
    expect(dispatched).toContain('ABC-6')
    expect(dispatched).toContain('feat/x')
    await pane.unmount()
  })
}

test('nothing New job showed before is lost: open More options', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const state = { jobs: [] as Job[], calls: [] as string[][] }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await mountPane($)
  await settle(pane)
  await tap(pane, { key: 'new' })
  await openFolds(pane)
  const text = await drawnText(pane)
  for (const fact of ['Codex', 'Muse', 'What should it do?', 'Start job', 'Edit in a separate copy', 'Read only', "Agent's own settings", 'Full access', 'Ticket', 'Start from branch', 'Model', 'Include my uncommitted changes']) expect(text).toContain(fact)
  await pane.unmount()
})

// ---- Agents ----
// The agents call with Codex changed by `codexOver` (signed out, switched off…).
const agentsBody = (codexOver: Record<string, unknown>) => ({ agents: [
  { name: 'codex', label: 'Codex', installed: true, version: 'codex-cli 1', signedIn: true, verified: true, source: 'builtin', enabled: true, defaultPermission: 'edit-worktree', stats: { jobs: 4, used: 3 }, ...codexOver },
  { name: 'muse', label: 'Muse', installed: true, version: '1.4.2', signedIn: null, verified: true, source: 'builtin', enabled: true, defaultPermission: 'edit-worktree', stats: { jobs: 0, used: 0 } },
], errors: [] })
for (const surface of ['terminal', 'desktop'] as const) {
  test(`Agents: one line each, Fix where one needs it, its own screen, and setup folded, on ${surface}`, async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    const state = { jobs: [] as Job[], calls: [] as string[][] }
    on('process.run', (_$, e) => (e.argv[2] === 'agents' ? answer(agentsBody({ signedIn: false })) : fakeEngine(state)(e.argv)))
    await $.command.run({ command: 'podium', args: '' })
    const pane = await $.ui.mount({ plugin: 'podium', surface, component: 'Pane', props: { title: 'Podium', isFocused: true, bodyColumns: 80 }, requestId: 'podium' })
    await settle(pane)
    await tapFirst(pane, ['link-agents', 'agents'])
    expect(await look(pane, { type: 'Button', text: /Codex · not signed in/ })).toBeTruthy()
    expect(await look(pane, { type: 'Button', text: /Muse · ready/ })).toBeTruthy()
    expect(await primaryKeys(pane)).toEqual(['fix-codex'])
    expect(await look(pane, { type: 'Button', text: /▸ Your setup · all good/ })).toBeTruthy()
    await tap(pane, { key: 'fix-codex' })
    expect(await look(pane, { type: 'Text', text: /Not signed in: run "codex login" once, then press Test\./ })).toBeTruthy()
    expect(await look(pane, { type: 'Button', text: /▸ Stats · 4 jobs · 3 👍/ })).toBeTruthy()
    await tap(pane, { key: 'test-codex' })
    expect(state.calls.some((c) => c[0] === 'adapter' && c[1] === 'test' && c.includes('codex'))).toBe(true)
    await tap(pane, { key: 'fold-agent:codex:access' })
    await tap(pane, { key: 'defperm-codex-read-only' })
    expect(state.calls.some((c) => c[0] === 'settings' && c[1] === 'set' && c.includes('defaultPermission.codex'))).toBe(true)
    await tap(pane, { key: 'toggle-codex' })
    expect(state.calls.some((c) => c[0] === 'settings' && c[1] === 'set' && c.includes('disabledAgents'))).toBe(true)
    await tap(pane, { key: 'back' })
    await tap(pane, { key: 'add-agent' })
    expect(await look(pane, { key: 'add-command' })).toBeTruthy()
    await pane.unmount()
  })
}

test('nothing Agents showed before is lost: the list, the screen of each agent and the setup checks, folds open', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const state = { jobs: [] as Job[], calls: [] as string[][] }
  on('process.run', (_$, e) => (e.argv[2] === 'agents' ? answer(agentsBody({})) : fakeEngine(state)(e.argv)))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await mountPane($)
  await settle(pane)
  await tapFirst(pane, ['link-agents', 'agents'])
  await openFolds(pane)
  const list = await drawnText(pane)
  for (const fact of ['Codex', 'Muse', 'Node 22.3.0', 'git 2.45.1', 'Check again', 'Add an agent']) expect(list).toContain(fact)
  await tap(pane, { key: 'open-agent-codex' })
  await openFolds(pane)
  const one = await drawnText(pane)
  for (const fact of ['codex-cli 1', 'tested', '4 jobs', '3 👍', 'Edit in a separate copy', 'Read only', 'Switch off', 'Test']) expect(one).toContain(fact)
  await pane.unmount()
})

// The chat line is the notice; a pop-up only when the chat is not told.
test('a finished job told to the chat brings no pop-up; with Claude not told, it is only a pop-up', async ($, on) => {
  on('turn.complete', () => ({ text: '' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const toasts: string[] = []
  on('ui.toast', (_$, e: any) => { toasts.push(typeof e === 'string' ? e : (e.text ?? e.message ?? JSON.stringify(e))); return { value: undefined } })
  const state: any = { jobs: [job()], calls: [] as string[][], summary: 'All fine.' }
  const prompts: string[] = []
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  on('prompt.submit', (_$, e) => { prompts.push(e.text); return { text: e.text } })
  await endTurn($)
  expect(prompts.length).toBe(1)
  expect(toasts).toEqual([])
  state.jobs = [job({ id: 'j2', title: 'Second job' })]
  state.tell = false
  await endTurn($)
  expect(prompts.length).toBe(1)
  expect(toasts.some((t) => t.includes('Second job'))).toBe(true)
})

// ---- Per-repo settings ----
test('Settings → This repo: its heading says what is set, and each field saves for this repo', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const state = { jobs: [] as Job[], calls: [] as string[][] }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await mountPane($)
  await tap(pane, { key: 'link-settings' })
  expect(await look(pane, { type: 'Button', text: /▸ This repo · nothing set/ })).toBeTruthy()
  await tap(pane, { key: 'fold-settings:repo' })
  await type(pane, { key: 'repo-commands', text: 'dotnet' })
  expect(said(state, 'settings set --key repoCommands --value {"repo":["dotnet"]}')).toBe(true)
  expect(await look(pane, { type: 'Text', text: /^Saved for repo\.$/ })).toBeTruthy()
  expect(await look(pane, { type: 'Button', text: /▾ This repo · dotnet/ })).toBeTruthy()
  await type(pane, { key: 'repo-check', text: 'dotnet build && dotnet test' })
  expect(said(state, 'settings set --key repoCheck --value {"repo":"dotnet build && dotnet test"}')).toBe(true)
  await tap(pane, { key: 'repo-squash' })
  expect(said(state, 'settings set --key repoSquash --value {"repo":false}')).toBe(true)
  await tap(pane, { key: 'repo-merge-squash' })
  expect(said(state, 'settings set --key repoMergeMethod --value {"repo":"squash"}')).toBe(true)
  await pane.unmount()
})

test('a board warns while its repo has no full check', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const state = { jobs: [] as Job[], calls: [] as string[][], sprints: [{ ...LIVE, check: false }, { ...DRAFT, check: true }] }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await mountPane($)
  await settle(pane)
  await tap(pane, { key: 'open-board-s1' })
  expect(await look(pane, { type: 'Text', text: /^No full check for this repo: PRs open without one$/ })).toBeTruthy()
  await tap(pane, { key: 'back' })
  await tap(pane, { key: 'open-board-s2' })
  expect(await look(pane, { type: 'Text', text: /No full check/ })).toBeFalsy()
  await pane.unmount()
})

// Claude proposes the repo's commands and check with a draft; the person confirms with Start.
test('a draft board folds what Claude proposed for the repo, draws no more words than without it, and Start says what it saved', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.id', () => ({ value: 'chat-1' }))
  const proposed = { commands: ['dotnet'], check: 'dotnet build && dotnet test' }
  const state: any = { jobs: [] as Job[], calls: [] as string[][], sprints: [{ ...DRAFT, check: false }], doctor: GH_READY }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  const firstView = async () => {
    await $.command.run({ command: 'podium', args: '' })
    const pane = await mountPane($)
    await settle(pane)
    await tap(pane, { key: 'open-board-s2' })
    return { pane, words: wordsDrawn(await pane.drawn({ in: APP })) }
  }
  const plain = await firstView()
  expect(await look(plain.pane, { type: 'Text', text: /^No full check for this repo: PRs open without one$/ })).toBeTruthy()
  expect(await look(plain.pane, { key: 'fold-board:s2:repo' })).toBeFalsy()
  await plain.pane.unmount()
  state.sprints = [{ ...DRAFT, check: false, proposed }]
  const { pane, words } = await firstView()
  expect(words).toBeLessThanOrEqual(plain.words)
  expect(words).toBeLessThanOrEqual(MAX_WORDS['board-draft'])
  // Closed by default, its heading short; the proposed check stands in for the missing one.
  expect(await look(pane, { type: 'Button', text: /^▸ This repo · dotnet · full check$/ })).toBeTruthy()
  expect(await look(pane, { type: 'Text', text: /No full check/ })).toBeFalsy()
  expect(await look(pane, { text: /dotnet build && dotnet test/ })).toBeFalsy()
  await tap(pane, { key: 'fold-board:s2:repo' })
  expect(await look(pane, { type: 'Text', text: /^Full check: dotnet build && dotnet test$/ })).toBeTruthy()
  expect(await look(pane, { type: 'Text', text: /^Commands agents may run: dotnet$/ })).toBeTruthy()
  expect(await look(pane, { type: 'Text', text: /saved for this repo when you start the sprint/ })).toBeTruthy()
  state.applied = proposed
  await tap(pane, { key: 'board-start' })
  expect(said(state, 'sprint start --id s2')).toBe(true)
  expect(await look(pane, { type: 'Text', text: /^Started\. Saved for this repo: commands dotnet; full check "dotnet build && dotnet test"\.$/ })).toBeTruthy()
  await pane.unmount()
})

// A finished sprint opens no more PRs, so its board does not warn.
test('a finished sprint\'s board does not warn about the full check', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const state = { jobs: [] as Job[], calls: [] as string[][], sprints: [{ ...LIVE, check: false, finishedAt: '2026-10-05T13:00:00Z' }] }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await mountPane($)
  await settle(pane)
  await tap(pane, { key: 'open-board-s1' })
  expect(await look(pane, { type: 'Text', text: /No full check/ })).toBeFalsy()
  await pane.unmount()
})

// A This repo field saves on the settings as saved now, so another repo's newer value is kept.
test('Settings → This repo builds its save on the settings as saved now, not as first read', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const state: any = { jobs: [] as Job[], calls: [] as string[][], saved: { repoCommands: { other: ['npm'] } } }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await mountPane($)
  await tap(pane, { key: 'link-settings' })
  await tap(pane, { key: 'fold-settings:repo' })
  state.saved = { repoCommands: { other: ['npm'], third: ['go'] } }
  await type(pane, { key: 'repo-commands', text: 'dotnet' })
  expect(said(state, 'settings set --key repoCommands --value {"other":["npm"],"third":["go"],"repo":["dotnet"]}')).toBe(true)
  await pane.unmount()
})

// Values of the wrong kind in a hand-edited settings file never stop Settings drawing.
test('Settings draws with hand-edited per-repo values of the wrong kind', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const state: any = { jobs: [] as Job[], calls: [] as string[][], saved: { repoCommands: { repo: 'dotnet' }, repoCheck: { repo: 42 }, repoMergeMethod: { repo: 'Squash' } } }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await mountPane($)
  await tap(pane, { key: 'link-settings' })
  expect(await look(pane, { type: 'Button', text: /▸ This repo · squash merges$/ })).toBeTruthy()
  await tap(pane, { key: 'fold-settings:repo' })
  expect(await look(pane, { key: 'repo-commands' })).toBeTruthy()
  expect(await look(pane, { key: 'repo-check' })).toBeTruthy()
  await pane.unmount()
})

// ---- Sprint news only in the sprint's own chat ----
test('a board in another chat says how many updates wait for the sprint\'s own chat', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.id', () => ({ value: 'chat-1' }))
  const state = { jobs: [] as Job[], calls: [] as string[][], sprints: [{ ...LIVE, news: 2, chat: 'chat-9' }, { ...LIVE, id: 's7', name: 'Mine', news: 1, chat: 'chat-1' }] }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await mountPane($)
  await settle(pane)
  await tap(pane, { key: 'open-board-s1' })
  expect(await look(pane, { type: 'Text', text: /^2 updates waiting for this sprint's chat$/ })).toBeTruthy()
  await tap(pane, { key: 'back' })
  await tap(pane, { key: 'open-board-s7' })
  expect(await look(pane, { type: 'Text', text: /waiting for this sprint's chat/ })).toBeFalsy()
  await pane.unmount()
})

// News only another chat may take never sets this chat asking the inbox on every refresh.
test('news waiting for another chat\'s sprint never makes this chat ask the sprint inbox', async ($, on) => {
  on('turn.complete', () => ({ text: '' }))
  on('session.id', () => ({ value: 'chat-1' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const state = { jobs: [] as Job[], calls: [] as string[][], sprints: [{ ...SPRINT, news: 1, chat: 'chat-9' }], inbox: [] }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  await endTurn($)
  await endTurn($)
  expect(state.calls.some((c) => c[0] === 'status')).toBe(true)
  expect(state.calls.some((c) => c[0] === 'sprint' && c[1] === 'inbox')).toBe(false)
})

for (const chat of ['chat-1', null]) {
  test(`news for a sprint whose chat is ${chat ?? 'not set'} is asked for from chat-1`, async ($, on) => {
    on('turn.complete', () => ({ text: '' }))
    on('session.id', () => ({ value: 'chat-1' }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    const state = { jobs: [] as Job[], calls: [] as string[][], sprints: [{ ...SPRINT, news: 1, chat }, { ...SPRINT, id: 's9', news: 3, chat: 'chat-9' }], inbox: [] }
    on('process.run', (_$, e) => fakeEngine(state)(e.argv))
    await endTurn($)
    await endTurn($)
    expect(state.calls.some((c) => c[0] === 'sprint' && c[1] === 'inbox')).toBe(true)
  })
}

// "Take them here". A sprint whose chat is gone moves to this chat, so its news comes here.
test('Take them here moves a sprint whose news waits for another chat to this chat, and only another chat sees it', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.id', () => ({ value: 'chat-1' }))
  const state = { jobs: [] as Job[], calls: [] as string[][], sprints: [{ ...LIVE, news: 2, chat: 'chat-9' }, { ...LIVE, id: 's7', name: 'Mine', news: 1, chat: 'chat-1' }] }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await mountPane($)
  await settle(pane)
  await tap(pane, { key: 'open-board-s7' })
  expect(await look(pane, { key: 'link-take-news' })).toBeFalsy()
  await tap(pane, { key: 'back' })
  await tap(pane, { key: 'open-board-s1' })
  expect(await look(pane, { type: 'Button', text: /^Take them here \(if its chat is closed\)$/ })).toBeTruthy()
  await tap(pane, { key: 'link-take-news' })
  expect(said(state, 'sprint adopt --id s1 --session chat-1 --here')).toBe(true)
  const adopt = state.calls.findIndex((c) => c[0] === 'sprint' && c[1] === 'adopt')
  expect(state.calls.slice(adopt + 1).some((c) => c[0] === 'status')).toBe(true)
  await pane.unmount()
})

// Before this chat's id is known, the sprint's own chat must not flash "waiting for this sprint's chat".
test('a board says nothing about news waiting for another chat until this chat\'s id is known', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.id', () => { throw new Error('not yet') })
  const state = { jobs: [] as Job[], calls: [] as string[][], sprints: [{ ...LIVE, news: 2, chat: 'chat-9' }] }
  on('process.run', (_$, e) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await mountPane($)
  await settle(pane)
  await tap(pane, { key: 'open-board-s1' })
  expect(await look(pane, { type: 'Text', text: /^Oct week 2$/ })).toBeTruthy()
  expect(await look(pane, { type: 'Text', text: /waiting for this sprint's chat/ })).toBeFalsy()
  await pane.unmount()
})

// ---- Finished sprints in Done and Other chats, and other chats' sprints labelled ----
// A finished sprint stays on the list (never "No jobs in this chat yet" once both PRs merged). This chat's sit in the
// Done fold and other chats' in Other chats, as rows coloured done or failed, at most 5 a fold; a running sprint another
// chat started says so on its Working row, in a job row's words.
const endedTicket = (key: string, state: string, n: number) => ({
  ...LIVE.tickets[0], key, title: `Ticket ${key}`, state, task: 3, of: 3, phase: null, reason: null, findings: null,
  pr: state === 'stopped' ? null : { number: n, url: `https://github.com/o/r/pull/${n}` }, latest: null,
  tasks: [task(1, 'done'), task(2, 'done'), task(3, 'done')], canRetry: false, giveTo: null, canStop: false,
})
const finishedSprint = (id: string, chat: string | null, minute: number, states = ['merged', 'merged']) => ({
  ...LIVE, id, name: `Finished ${id}`, chat, finishedAt: new Date(Date.UTC(2026, 9, 5, 10, minute)).toISOString(),
  tickets: states.map((s, i) => endedTicket(`${id.toUpperCase()}-${i + 1}`, s, 20 + i)),
})
async function mountFinished($: any, on: any, state: any, surface: 'terminal' | 'desktop') {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.id', () => ({ value: 'me' }))
  on('process.run', (_$: any, e: any) => fakeEngine(state)(e.argv))
  await $.command.run({ command: 'podium', args: '' })
  const pane = await $.ui.mount({ plugin: 'podium', surface, component: 'Pane', props: { title: 'Podium', isFocused: true, bodyColumns: 100 }, requestId: 'podium' })
  await settle(pane)
  return pane
}
// The keys of the drawn buttons that open a sprint's board, in drawing order.
async function boardKeys(pane: any) {
  const keys: string[] = []
  const walk = (n: any) => {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) { n.forEach(walk); return }
    const k = String(n.props?.key ?? n.key ?? '')
    if (n.type === 'Button' && k.startsWith('open-board-')) keys.push(k)
    for (const c of n.children ?? []) walk(c)
  }
  walk(await drawnAll(pane))
  return keys
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`this chat's finished sprint is in the Done fold, coloured done or failed, and opens its board, on ${surface}`, async ($, on) => {
    const state = { jobs: [] as Job[], calls: [] as string[][], sprints: [finishedSprint('f2', 'me', 10, ['merged', 'stopped']), finishedSprint('f1', 'me', 30)] }
    const pane = await mountFinished($, on, state, surface)
    expect(await look(pane, { type: 'Button', text: /^▸ Done · 2$/ })).toBeTruthy()
    expect(await boardKeys(pane)).toEqual([])
    await tap(pane, { key: 'fold-list:done' })
    expect(await boardKeys(pane)).toEqual(['open-board-f1', 'open-board-f2'])
    expect(await look(pane, { type: 'Button', text: /Sprint · Finished f1/ })).toBeTruthy()
    expect(await look(pane, { type: 'Text', text: /^2 of 2 done · finished .+ ago$/ })).toBeTruthy()
    expect(await look(pane, { type: 'Text', text: /^1 of 2 done · 1 stopped · finished .+ ago$/ })).toBeTruthy()
    const tree = await drawnAll(pane)
    expect(edgeOf(tree, 'item-board-f1')).toBe(PALETTES.dark.done.edge)
    expect(edgeOf(tree, 'item-board-f2')).toBe(PALETTES.dark.failed.edge)
    // Nothing is working: the finished sprint is not a Working row.
    expect(await look(pane, { type: 'Text', text: /^Working/ })).toBeFalsy()
    await tap(pane, { key: 'open-board-f1' })
    expect(await look(pane, { key: 'open-ticket-F1-1' })).toBeTruthy()
    expect(await look(pane, { type: 'Text', text: /^Loading…$/ })).toBeFalsy()
    await pane.unmount()
  })

  test(`a chat whose only sprint finished does not say "No jobs in this chat yet", on ${surface}`, async ($, on) => {
    const state = { jobs: [] as Job[], calls: [] as string[][], sprints: [finishedSprint('f1', 'me', 30)] }
    const pane = await mountFinished($, on, state, surface)
    expect(await look(pane, { text: /No jobs in this chat yet/ })).toBeFalsy()
    expect(await look(pane, { type: 'Button', text: /^▸ Done · 1$/ })).toBeTruthy()
    await pane.unmount()
  })

  test(`another chat's finished sprint is in the Other chats fold, below the empty-state text (as other chats' jobs are), on ${surface}`, async ($, on) => {
    const state = { jobs: [] as Job[], calls: [] as string[][], sprints: [finishedSprint('g1', 'other', 20)] }
    const pane = await mountFinished($, on, state, surface)
    expect(await look(pane, { text: /No jobs in this chat yet/ })).toBeTruthy()
    expect(await look(pane, { key: 'fold-list:done' })).toBeFalsy()
    expect(await look(pane, { type: 'Button', text: /^▸ Other chats · 1$/ })).toBeTruthy()
    await tap(pane, { key: 'fold-list:others' })
    expect(await boardKeys(pane)).toEqual(['open-board-g1'])
    expect(edgeOf(await drawnAll(pane), 'item-board-g1')).toBe(PALETTES.dark.done.edge)
    await tap(pane, { key: 'open-board-g1' })
    expect(await look(pane, { key: 'open-ticket-G1-1' })).toBeTruthy()
    await pane.unmount()
  })

  test(`another chat's running sprint says "from another chat" on its Working row; this chat's does not, on ${surface}`, async ($, on) => {
    const state = { jobs: [] as Job[], calls: [] as string[][], sprints: [{ ...RUNNING_ONLY, id: 'r9', chat: 'other' }, { ...RUNNING_ONLY, id: 'r8', name: 'Mine running', chat: 'me' }] }
    const pane = await mountFinished($, on, state, surface)
    expect(await look(pane, { type: 'Text', text: /^Working · 2$/ })).toBeTruthy()
    // The status line for a running sprint, with the label after it.
    expect((await lookAll(pane, { type: 'Text', text: /^0 of 1 done · 1 of 3 running: ABC-11 · from another chat$/ })).length).toBe(1)
    expect((await lookAll(pane, { type: 'Text', text: /^0 of 1 done · 1 of 3 running: ABC-11$/ })).length).toBe(1)
    await pane.unmount()
  })

  test(`7 finished sprints show the newest 5 and an "older sprints" line, in each fold, on ${surface}`, async ($, on) => {
    const mine = [0, 1, 2, 3, 4, 5, 6].map((i) => finishedSprint(`m${i}`, 'me', i * 5))
    const theirs = [0, 1, 2, 3, 4, 5].map((i) => finishedSprint(`o${i}`, 'other', i * 5 + 1))
    const state = { jobs: [] as Job[], calls: [] as string[][], sprints: [...mine, ...theirs] }
    const pane = await mountFinished($, on, state, surface)
    expect(await look(pane, { type: 'Button', text: /^▸ Done · 5$/ })).toBeTruthy()
    expect(await look(pane, { type: 'Button', text: /^▸ Other chats · 5$/ })).toBeTruthy()
    await tap(pane, { key: 'fold-list:done' })
    expect(await boardKeys(pane)).toEqual(['open-board-m6', 'open-board-m5', 'open-board-m4', 'open-board-m3', 'open-board-m2'])
    expect(await look(pane, { type: 'Text', text: /^2 older sprints are not shown here; ask Claude for them\.$/ })).toBeTruthy()
    await tap(pane, { key: 'fold-list:done' })
    await tap(pane, { key: 'fold-list:others' })
    expect(await boardKeys(pane)).toEqual(['open-board-o5', 'open-board-o4', 'open-board-o3', 'open-board-o2', 'open-board-o1'])
    expect(await look(pane, { type: 'Text', text: /^1 older sprint is not shown here; ask Claude for it\.$/ })).toBeTruthy()
    await pane.unmount()
  })

  // A sprint is archived seconds after it finishes (its news delivered); `status --here` still lists the newest
  // finished ones, archived, and the list keeps them in Done, with no Pause or Resume on their boards.
  test(`a finished sprint archived after its news was delivered still shows in Done and opens a board with no Pause, on ${surface}`, async ($, on) => {
    // a2 and a3 were archived with no finishedAt recorded (archiveEnded can archive before a tick records it): still finished.
    const state = { jobs: [] as Job[], calls: [] as string[][], sprints: [
      { ...finishedSprint('a1', 'me', 30), archived: true, news: 0 },
      { ...finishedSprint('a2', 'me', 20), archived: true, finishedAt: null },
      { ...finishedSprint('a3', 'me', 10), archived: true, finishedAt: null, paused: true },
    ] }
    const pane = await mountFinished($, on, state, surface)
    expect(await look(pane, { text: /No jobs in this chat yet/ })).toBeFalsy()
    expect(await look(pane, { type: 'Text', text: /^Working/ })).toBeFalsy()
    expect(await look(pane, { type: 'Button', text: /^▸ Done · 3$/ })).toBeTruthy()
    await tap(pane, { key: 'fold-list:done' })
    expect(await boardKeys(pane)).toEqual(['open-board-a1', 'open-board-a3', 'open-board-a2'])
    expect(edgeOf(await drawnAll(pane), 'item-board-a1')).toBe(PALETTES.dark.done.edge)
    for (const id of ['a1', 'a2', 'a3']) {
      await tap(pane, { key: `open-board-${id}` })
      expect(await look(pane, { key: `open-ticket-${id.toUpperCase()}-1` })).toBeTruthy()
      expect(await look(pane, { key: 'board-pause' })).toBeFalsy()
      expect(await look(pane, { key: 'board-resume' })).toBeFalsy()
      await tap(pane, { key: 'back' })
    }
    await pane.unmount()
  })

  // Take them here is never offered on a finished sprint listed though archived, even with news counted.
  test(`another chat's finished archived sprint offers no Take them here, on ${surface}`, async ($, on) => {
    const state = { jobs: [] as Job[], calls: [] as string[][], sprints: [{ ...finishedSprint('g2', 'other', 20), archived: true, news: 2 }] }
    const pane = await mountFinished($, on, state, surface)
    await tap(pane, { key: 'fold-list:others' })
    await tap(pane, { key: 'open-board-g2' })
    expect(await look(pane, { key: 'open-ticket-G2-1' })).toBeTruthy()
    expect(await look(pane, { key: 'link-take-news' })).toBeFalsy()
    expect(await look(pane, { key: 'board-pause' })).toBeFalsy()
    await pane.unmount()
  })

  // The list as `podium status --here --session me` really answers (engine/sprint.js sprintSummary fields, ids
  // newest first, no `ended` or `tone`): this chat's newest 6 and other chats' newest 6 archived, and exact `olderFinished`.
  test(`the engine's real window of finished sprints: 5 a fold and exact "older sprints" lines, and the pane sends its chat, on ${surface}`, async ($, on) => {
    const engineTicket = (key: string, n: number) => ({
      key, title: `Ticket ${key}`, state: 'merged', task: 2, of: 2, phase: null, agent: 'codex', reason: null, findings: null,
      pr: { number: n, url: `https://github.com/o/r/pull/${n}` }, reviews: 2, latest: `${key}-a2`,
      tasks: [{ n: 1, title: 'Task 1', agent: 'codex', reviewer: 'claude', status: 'done', canAssign: false }, { n: 2, title: 'Task 2', agent: 'codex', reviewer: 'claude', status: 'done', canAssign: false }],
      canRetry: false, giveTo: null, canStop: false, plan: 'docs/plan.md', writer: null, reviewer: null, canAssignPlan: false,
      after: [], waitingOn: [], proposed: null, canApprove: false, canOneTask: false, canRevise: false,
    })
    const summary = (id: string, chat: string, day: number) => ({
      id, name: `Sprint ${id}`, draft: false, discarded: false, paused: false, finishedAt: new Date(Date.UTC(2026, 9, day, 12)).toISOString(),
      autoMerge: true, maxParallel: 3, archived: true, chat, news: 0, tickets: [engineTicket(`${id.toUpperCase()}-1`, day)],
    })
    // Created ids and finish days in no common order, as the engine returns them (sorted by id, newest first).
    const sprints = [
      ...[1, 2, 3, 4, 5, 6].map((i) => summary(`20261001${String(i).padStart(2, '0')}-me`, 'me', 20 - i * 2)),
      ...[1, 2, 3, 4, 5, 6].map((i) => summary(`20261003${String(i).padStart(2, '0')}-th`, 'other', 2 + i)),
    ].sort((a, b) => b.id.localeCompare(a.id))
    const state = { jobs: [] as Job[], calls: [] as string[][], sprints, olderFinished: { mine: 3, others: 1 } }
    const pane = await mountFinished($, on, state, surface)
    expect(state.calls.some((c) => c[0] === 'status' && c.includes('--here') && c[c.indexOf('--session') + 1] === 'me')).toBe(true)
    expect(await look(pane, { text: /No jobs in this chat yet/ })).toBeFalsy()
    expect(await look(pane, { type: 'Button', text: /^▸ Done · 5$/ })).toBeTruthy()
    await tap(pane, { key: 'fold-list:done' })
    // This chat's, newest finished first (day 18, 16, … 8), not by id.
    expect(await boardKeys(pane)).toEqual([1, 2, 3, 4, 5].map((i) => `open-board-20261001${String(i).padStart(2, '0')}-me`))
    expect(await look(pane, { type: 'Text', text: /^4 older sprints are not shown here; ask Claude for them\.$/ })).toBeTruthy()
    await tap(pane, { key: 'fold-list:done' })
    await tap(pane, { key: 'fold-list:others' })
    expect(await boardKeys(pane)).toEqual([6, 5, 4, 3, 2].map((i) => `open-board-20261003${String(i).padStart(2, '0')}-th`))
    expect(await look(pane, { type: 'Text', text: /^2 older sprints are not shown here; ask Claude for them\.$/ })).toBeTruthy()
    await pane.unmount()
  })
}

// A board opened from a finished sprint's row is drawn from the row until the board syncs; the row
// keeps `archived`, so nothing on it treats the sprint as live (no Pause, Resume, or Take them here).
test('on desktop, a finished archived sprint\'s board drawn from its row before Podium answers offers no live action', async ($, on) => {
  const state = { jobs: [] as Job[], calls: [] as string[][], sprints: [{ ...finishedSprint('g3', 'other', 20), archived: true, news: 2, finishedAt: null, paused: true }] }
  const pane = await mountFinished($, on, state, 'desktop')
  await tap(pane, { key: 'fold-list:others' })
  await pane.press({ key: 'open-board-g3' })
  // A navigation press: the Client draws the board at once, from the row it holds.
  expect(await pane.find({ type: 'Text', text: /^Loading…$/, in: APP })).toBeTruthy()
  for (const key of ['link-take-news', 'board-pause', 'board-resume']) expect(await pane.find({ key, in: APP }).catch(() => undefined)).toBeFalsy()
  await settle(pane)
  expect(await look(pane, { key: 'open-ticket-G3-1' })).toBeTruthy()
  for (const key of ['link-take-news', 'board-pause', 'board-resume']) expect(await look(pane, { key })).toBeFalsy()
  await pane.unmount()
})

// The same from a sprint step's own screen (Steps and diff). Its Back leads to the
// ticket, so refresh names the step's sprint too, and Back finds the ticket still listed.
for (const surface of ['terminal', 'desktop'] as const) {
  test(`a sprint step's screen keeps its sprint listed when it archives behind six newer finished ones, on ${surface}`, async ($, on) => {
    const old = finishedSprint('x1', 'me', 1)
    const open = { ...old, tickets: [{ ...old.tickets[0], latest: 'xs1' }, { ...old.tickets[1], state: 'pr-open' }] }
    const newer = [2, 3, 4, 5, 6, 7].map((i) => ({ ...finishedSprint(`n${i}`, 'me', i * 5), archived: true }))
    const step = job({ id: 'xs1', title: 'X1-1 task 3: Task 3', status: 'merged', delivered: true, sprint: { id: 'x1', ticket: 'X1-1', task: 3, role: 'author' } })
    const state: any = { jobs: [step], calls: [] as string[][], sprints: [open, ...newer], olderFinished: { mine: 0, others: 0 } }
    const pane = await mountFinished($, on, state, surface)
    await tap(pane, { key: 'fold-list:done' })
    await tap(pane, { key: 'open-board-x1' })
    await tap(pane, { key: 'open-ticket-X1-1' })
    await tap(pane, { key: 'open-steps-X1-1' })
    state.sprints = newer
    state.named = { x1: { ...open, tickets: [open.tickets[0], { ...open.tickets[1], state: 'merged' }], archived: true } }
    state.calls.length = 0
    await $.command.run({ command: 'podium', args: 'status' })
    await settle(pane)
    expect(state.calls.some((c: string[]) => c[0] === 'status' && c[c.indexOf('--sprint') + 1] === 'x1')).toBe(true)
    await tap(pane, { key: 'back' })
    expect(await look(pane, { text: /no longer listed/ })).toBeFalsy()
    expect(await look(pane, { key: 'ticket-tile' })).toBeTruthy()
    await pane.unmount()
  })
}

// A refresh asked for while the list was open answers after the board and ticket
// opened, without the sprint they show (it archived behind six newer ones). The open screen's sprint keeps its last view
// (keepShown), so the ticket's Back never says "no longer listed". This kit test also passes without keepShown (a later
// refresh restores the sprint before it can look), so it guards the end-to-end outcome only; keepShown's own logic is
// pinned in mod-client.test.js.
test('a refresh that answers after a board opened keeps that board\'s sprint listed', async ($, on) => {
  const old = finishedSprint('x1', 'me', 1)
  const open = { ...old, tickets: [old.tickets[0], { ...old.tickets[1], state: 'pr-open' }] }
  const newer = [2, 3, 4, 5, 6, 7].map((i) => ({ ...finishedSprint(`n${i}`, 'me', i * 5), archived: true }))
  const state: any = { jobs: [] as Job[], calls: [] as string[][], sprints: [open, ...newer], olderFinished: { mine: 0, others: 0 } }
  let hold: null | Promise<void> = null
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.id', () => ({ value: 'me' }))
  on('process.run', async (_$: any, e: any) => {
    if (hold && e.argv.includes('status')) await hold
    return fakeEngine(state)(e.argv)
  })
  await $.command.run({ command: 'podium', args: '' })
  const pane = await $.ui.mount({ plugin: 'podium', surface: 'terminal', component: 'Pane', props: { title: 'Podium', isFocused: true, bodyColumns: 100 }, requestId: 'podium' })
  await settle(pane)
  // A refresh starts from the list (no sprint named) and is held; the sprint archives meanwhile.
  let release!: () => void
  hold = new Promise<void>((r) => { release = r })
  state.sprints = newer
  // As the engine does: a sprint named with --sprint comes back even when archived behind newer ones.
  state.named = { x1: { ...open, archived: true } }
  const pending = $.command.run({ command: 'podium', args: 'status' })
  await tap(pane, { key: 'fold-list:done' })
  await tap(pane, { key: 'open-board-x1' })
  await tap(pane, { key: 'open-ticket-X1-1' })
  release()
  hold = null
  await pending
  // Right as the late answer lands, before any refresh names the sprint again.
  expect(await look(pane, { text: /no longer listed/ })).toBeFalsy()
  await settle(pane)
  await tap(pane, { key: 'back' })
  expect(await look(pane, { text: /no longer listed/ })).toBeFalsy()
  expect(await look(pane, { key: 'open-ticket-X1-1' })).toBeTruthy()
  await pane.unmount()
})

// A sprint the refresh named and the engine still left out is really gone (a draft
// discarded from the chat while its board is open): its board is not kept.
test('a board whose sprint the engine no longer returns, even when named, is not kept', async ($, on) => {
  const draft = { ...finishedSprint('d1', 'me', 1), draft: true, finishedAt: null, tickets: [{ ...finishedSprint('d1', 'me', 1).tickets[0], state: 'pending' }] }
  const state: any = { jobs: [] as Job[], calls: [] as string[][], sprints: [draft] }
  const pane = await mountFinished($, on, state, 'terminal')
  await tap(pane, { key: 'open-board-d1' })
  expect(await look(pane, { key: 'open-ticket-D1-1' })).toBeTruthy()
  // Discarded from the chat: the engine lists it no more, named or not.
  state.sprints = []
  await $.command.run({ command: 'podium', args: 'status' })
  await settle(pane)
  expect(state.calls.some((c: string[]) => c[0] === 'status' && c[c.indexOf('--sprint') + 1] === 'd1')).toBe(true)
  expect(await look(pane, { key: 'open-ticket-D1-1' })).toBeFalsy()
  await pane.unmount()
})

// An older sprint's last PR merges while six newer finished sprints exist; it archives, falls outside
// the engine's newest 6, and its open board said "That sprint is no longer listed." Refresh names the open board's (or
// ticket's) sprint (`--sprint`), and the engine returns it beside the newest.
for (const surface of ['terminal', 'desktop'] as const) {
  for (const screen of ['board', 'ticket'] as const) {
    test(`an open ${screen} stays drawn after the refresh that archives its sprint behind six newer finished ones, on ${surface}`, async ($, on) => {
      // x1 is still open (its last PR open: Working), and it finished shipping before the six newer ones finished.
      const old = finishedSprint('x1', 'me', 1)
      const open = { ...old, tickets: [old.tickets[0], { ...old.tickets[1], state: 'pr-open' }] }
      const newer = [2, 3, 4, 5, 6, 7].map((i) => ({ ...finishedSprint(`n${i}`, 'me', i * 5), archived: true }))
      const state: any = { jobs: [] as Job[], calls: [] as string[][], sprints: [open, ...newer], olderFinished: { mine: 0, others: 0 } }
      const pane = await mountFinished($, on, state, surface)
      await tap(pane, { key: 'fold-list:done' })
      expect(await look(pane, { type: 'Text', text: /^1 older sprint is not shown here; ask Claude for it\.$/ })).toBeTruthy()
      await tap(pane, { key: 'open-board-x1' })
      if (screen === 'ticket') await tap(pane, { key: 'open-ticket-X1-1' })
      // Its news is delivered and it archives: the engine's newest 6 leave it out unless the pane names it.
      state.sprints = newer
      state.named = { x1: { ...old, archived: true } }
      state.calls.length = 0
      await $.command.run({ command: 'podium', args: 'status' })
      await settle(pane)
      expect(state.calls.some((c: string[]) => c[0] === 'status' && c[c.indexOf('--sprint') + 1] === 'x1' && c.includes('--session'))).toBe(true)
      expect(await look(pane, { text: /no longer listed/ })).toBeFalsy()
      expect(await look(pane, { text: /^Loading…$/ })).toBeFalsy()
      expect(await look(pane, { key: screen === 'board' ? 'open-ticket-X1-1' : 'ticket-tile' })).toBeTruthy()
      // Back on the list it is still counted once: 5 rows and the same "2 older sprints" line (n2 and x1).
      await tap(pane, { key: 'back' })
      if (screen === 'ticket') await tap(pane, { key: 'back' })
      expect(await boardKeys(pane)).toEqual(['open-board-n7', 'open-board-n6', 'open-board-n5', 'open-board-n4', 'open-board-n3'])
      expect(await look(pane, { type: 'Text', text: /^2 older sprints are not shown here; ask Claude for them\.$/ })).toBeTruthy()
      await pane.unmount()
    })
  }
}
