// The desktop pane. The app paints a Client on its own frame clock, so this draws
// at once; Podium's own redraws of a Pane are not painted until the next click.
// Every press is posted to Podium (ui.message); its answer, and a sync each second,
// bring the next model as props. A screen switch shows at once from a local overlay.
import { drawPane, drawFailed, isListView, HANDLER_NAMES } from '../screens'
import type { PaneModel } from '../screens'
import { enqueue, nextPost, unseen, NAV_ACTIONS, EDIT_ACTIONS, overlayFor, pageProblem, plainProblem, safeList, QUIET_ACTIONS } from '../../mod/client.js'
import { PALETTES } from '../theme'
import { clientLook } from './look'

type Msg = { kind: 'act'; id: string; name: string; args: unknown[] }
// typed: the notes last typed for a plan here (editNote), with the board's question they were typed under.
type Typed = { sprint: string; confirm: string | null; text: string }
type Outbox = { outbox: Msg[]; seq: number; overlay: PaneModel['view'] | null; pending: string[]; tick: number; typed: Typed | null }
type Local = { box: Outbox; n: number }

export default function PodiumApp(model: PaneModel, surface: any) {
  let created: Outbox | null = null
  if (surface.state === undefined) {
    // First call: start the timers. State is set from a timer, never while drawing.
    const box: Outbox = { outbox: [], seq: 0, overlay: null, pending: [], tick: 0, typed: null }
    created = box
    // One poster: every post carries all presses Podium has not yet received (nextPost).
    let sent = { syncDue: false, sentKey: '', sinceSend: 0 }
    surface.every(60, () => {
      if (surface.state === undefined) surface.setState({ box, n: 0 })
      const r = nextPost(box.outbox, sent)
      sent = r.s
      if (r.post) surface.post(r.post)
    })
    // Once a second: a sync is due, and a redraw so elapsed times move.
    surface.every(1000, () => {
      sent = { ...sent, syncDue: true }
      box.tick += 1
      surface.setState({ box, n: ((surface.state as Local | undefined)?.n ?? 0) + 1 })
    })
  }
  const local = surface.state as Local | undefined
  const box = local?.box ?? created
  const acked = new Set(model.acked ?? [])
  if (box) {
    box.pending = box.pending.filter((id) => !acked.has(id))
    box.outbox = unseen(box.outbox, model.seen)
    if (box.overlay && model.view.screen === box.overlay.screen && model.view.id === box.overlay.id && (model.view.key ?? null) === (box.overlay.key ?? null)) box.overlay = null
  }
  const send = (name: string, args: unknown[]) => {
    if (!box) return
    // A plan's Send carries the notes as they are now, and the last words typed here may not be in this model's
    // board yet: Send takes them when they were typed under its own question. Anything else that moves the board drops them.
    if (name === 'editNote') box.typed = { sprint: String(args[0]), confirm: model.board?.confirm ?? null, text: String(args[1] ?? '') }
    else if (name === 'revisePlan') {
      const t = box.typed
      if (t && t.sprint === args[0] && t.confirm === `revise:${args[1]}`) args = [args[0], args[1], t.text]
      box.typed = null
    } else if (NAV_ACTIONS.has(name) || ['askConfirm', 'openPicker'].includes(name)) box.typed = null
    box.seq += 1
    const id = `${Date.now()}-${box.seq}`
    if (NAV_ACTIONS.has(name)) box.overlay = overlayFor(name, args) as PaneModel['view']
    box.outbox = enqueue(box.outbox, { kind: 'act', id, name, args })
    if (!NAV_ACTIONS.has(name) && !EDIT_ACTIONS.has(name) && !QUIET_ACTIONS.has(name)) box.pending.push(id)
    // Called from a press, not while drawing: safe to set state here.
    surface.setState({ box, n: (local?.n ?? 0) + 1 })
  }
  const go: Record<string, (...args: unknown[]) => void> = {}
  for (const name of HANDLER_NAMES) go[name] = (...args: unknown[]) => send(name, args)
  const shown: PaneModel = box?.overlay ? { ...model, view: box.overlay, notice: null } : model
  const { Box, Text } = surface.elements
  const p = PALETTES[model.palette]
  const ui = clientLook(surface.elements, p, surface.columns)
  const now = Date.now()
  const draw = (m: PaneModel) => (
    <Box flexDirection="column">
      {box && box.pending.length ? <Text key="working" color={p.dim}>Working…</Text> : null}
      {drawPane(clientLook(surface.elements, p, surface.columns), m, go as any, now)}
    </Box>
  )
  const tree = draw(shown)
  // The page throws away a whole tree it cannot draw (a blank pane that reopens blank), so never hand it one:
  // say why instead, with Back to the list.
  const problem = pageProblem(tree)
  if (!problem) return tree
  // The list is where Back leads, so it never shows the note (its Back would lead to the same list, a loop): past the
  // page's bounds it draws the short list (safeList: the header and a page of sprint rows, no job rows), and if
  // even that can't be drawn, the note with no Back.
  const isList = isListView(shown.view)
  if (isList) {
    const short = draw(safeList(shown) as PaneModel)
    if (!pageProblem(short)) return short
  }
  return <Box flexDirection="column">{drawFailed(ui, shown, go as any, plainProblem(problem), `The screen has ${problem}.`, !isList)}</Box>
}
