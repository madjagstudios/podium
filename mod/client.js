// Pure helpers for the desktop Client pane. No Node imports: the Client runs in the app's view.
import { isOpenSprint, isFinishedSprint, finishedSprintTone, finishedSprints, isSprintMine, FINISHED_SPRINTS, shorten, laneOf, fitCode, CODE_LIMIT, organise, threads, sprintHeadline, sprintStatusLine, sprintRowTitle, sprintTone, SPRINT_ENDED, NEEDS_YOU_STATES } from './view.js';

const JOB_FIELDS = [
  'id', 'title', 'project', 'ticket', 'agent', 'model', 'permission', 'status', 'createdAt', 'startedAt', 'endedAt',
  'isLong', 'delivered', 'hasChanges', 'changes', 'outcome', 'outcomeSource', 'error', 'warning', 'committed', 'leftovers',
  'base', 'worktree', 'threadId', 'step', 'followUpOf', 'endStatus', 'resumeFrom', 'resumeFailed', 'origin',
  'pr', 'kind', 'reviewOf', 'posted', 'sprint',
];

// What the pane draws from a job; runner internals stay behind (Client props are size-bounded).
export function slimJob(job) {
  const out = {};
  for (const k of JOB_FIELDS) if (job[k] !== undefined) out[k] = job[k];
  return out;
}

// The listing from the engine, with each busy marker ({ id, busy: true }: the sprint could not be read just
// now) replaced by the previous view of that sprint, or dropped if there is none. Nothing else ever sees one.
export function keepBusy(prev, next) {
  const last = new Map((prev ?? []).filter((s) => s && !s.busy).map((s) => [s.id, s]));
  return (next ?? []).flatMap((s) => (s?.busy ? (last.has(s.id) ? [last.get(s.id)] : []) : [s]));
}

// The sprint the open screen shows (shownId), left out of an answer asked for before that screen opened, keeps its last
// view: an archived sprint behind newer finished ones is listed only when named, and
// the next refresh names it. Kept at the end; nothing else changes.
export function keepShown(prev, next, shownId) {
  if (!shownId || (next ?? []).some((s) => s?.id === shownId)) return next ?? [];
  const last = (prev ?? []).find((s) => s?.id === shownId && !s.busy);
  return last ? [...(next ?? []), last] : next ?? [];
}

const cut = (s, max) => (typeof s === 'string' && s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s);

// Sprint tickets waiting on the person, across every sprint (Your turn), whichever page of sprints the list shows:
// parked, or a plan waiting for an answer. Drafts never wait on anyone. At most TURN_TICKETS; `more` counts the rest.
export const TURN_TICKETS = 20;
export function turnTickets(list) {
  const out = [];
  for (const s of (list ?? []).filter(isOpenSprint)) {
    if (s.unreadable || s.draft) continue;
    for (const t of s.tickets ?? []) {
      if (!NEEDS_YOU_STATES.has(t.state)) continue;
      out.push({ sprint: s.id, sprintName: cut(String(s.name ?? s.id), 60), key: t.key, title: cut(String(t.title ?? ''), 80), state: t.state, reason: cut(String(t.reason ?? ''), 160) });
    }
  }
  return { tickets: out.slice(0, TURN_TICKETS), more: Math.max(0, out.length - TURN_TICKETS) };
}

const FINDINGS_LIMIT = 1200;
const TASK_TITLE_LIMIT = 80;

// A plan's tasks a row shows while it waits for the person; the rest are a "… and N more tasks" line.
export const PLAN_ROWS = 30;

// What the pane draws from a sprint: open sprints and finished ones (the Done and Other chats
// folds list them and their boards open), no other sprint whose tickets have all ended; review findings only on a parked
// ticket, whose open row shows them, cut short; short task titles; a waiting plan's first PLAN_ROWS task titles, cut short,
// and how many more (never the plan's text), only for the open board's open row (board: { sprint, open }), the one row that draws them.
export function slimSprints(list, board = null) {
  const isOpenRow = (s, t) => Boolean(board?.open) && board.sprint === s.id && board.open === t.key;
  return (list ?? []).filter((s) => isOpenSprint(s) || isFinishedSprint(s)).map((s) => ({
    ...s,
    tickets: s.tickets.map(({ findings, tasks, proposed, ...t }) => ({
      ...t,
      ...(t.state === 'parked' && findings ? { findings: findings.length > FINDINGS_LIMIT ? `${findings.slice(0, FINDINGS_LIMIT - 1)}…` : findings } : {}),
      ...(tasks ? { tasks: tasks.map((x) => ({ ...x, title: shorten(x.title, TASK_TITLE_LIMIT) })) } : {}),
      ...(Array.isArray(proposed) && isOpenRow(s, t) ? {
        proposed: proposed.slice(0, PLAN_ROWS).map((x) => ({ n: x.n, title: shorten(x.title, TASK_TITLE_LIMIT) })),
        ...(proposed.length > PLAN_ROWS ? { proposedMore: proposed.length - PLAN_ROWS } : {}),
      } : {}),
    })),
  }));
}

// ---- What the desktop Client is sent (its props count toward its tree's 100,000 characters) ----
// The engine refuses a Client whose props serialize past 100,000 characters (and drops a `{ props }` answer past it):
// the desktop pane goes blank for good. Sending every job in the project would blank it once the history is long.
export const PROPS_BUDGET = 80_000;
// File rows the detail draws (screens.tsx changeRows); the rest are a "… and N more files" line.
export const FILE_ROWS = 150;
// A row draws its path three times (row key, button key, label) in about 270 more characters of drawing; rows stop
// before ROW_CHARS, so long paths cannot outgrow a Client tree's 100,000 characters with the screen's code.
export const ROW_CHARS = 50_000;
export function fileRows(files) {
  let chars = 0;
  let n = 0;
  for (const f of (files ?? []).slice(0, FILE_ROWS)) {
    chars += 3 * JSON.stringify(String(f?.path ?? '')).length + 270;
    if (chars > ROW_CHARS) break;
    n += 1;
  }
  return n;
}

const sizeOf = (v) => JSON.stringify(v).length;
const isAtWork = (j) => laneOf(j) !== 'done';
// A job travels with its thread (a card counts its steps and shows its first title); a sprint step on its own.
const unitOf = (j) => (j.sprint ? `step:${j.id}` : `thread:${j.threadId ?? j.id}`);
const endOf = (j) => Date.parse(j.endedAt ?? j.createdAt) || 0;
// The detail as the screen draws it: the files it has rows for (fileRows; `more` counts the rest), only open files'
// patches, each cut as codeBlock cuts it (fitCode), so nothing the pane would not draw is sent.
function drawnDetail(d, max) {
  if (!d) return d;
  const out = { ...d };
  if (typeof d.output === 'string' && d.output.length > max) out.output = fitCode(d.output, { keep: 'end', max });
  if (!Array.isArray(d.changes?.files)) return out;
  const open = new Set(d.open ?? []);
  const files = d.changes.files.slice(0, fileRows(d.changes.files)).map((f) => ({
    ...f, patch: open.has(f.path) && typeof f.patch === 'string' && f.patch ? fitCode(f.patch, { keep: 'start', max }) : '',
  }));
  const more = (d.changes.more ?? 0) + d.changes.files.length - files.length;
  out.changes = { ...d.changes, files, ...(more > 0 ? { more } : {}) };
  return out;
}

// A job with its long text cut to `max` characters (the jobs Podium must keep, when even they are over the budget).
function shortJob(j, max) {
  const out = { ...j, title: cut(j.title, max) };
  if (j.error) out.error = cut(j.error, max);
  if (j.warning?.message) out.warning = { ...j.warning, message: cut(j.warning.message, max) };
  if (j.committed?.commits) out.committed = { ...j.committed, commits: j.committed.commits.slice(0, Math.max(1, Math.floor(max / 40))).map((c) => ({ ...c, subject: cut(c.subject, max) })) };
  if (j.pr?.attention) out.pr = { ...j.pr, attention: cut(j.pr.attention, max) };
  return out;
}

function shortLive(live, max) {
  return Object.fromEntries(Object.entries(live ?? {}).map(([id, l]) => [id, { ...l, activity: cut(l?.activity, max), lines: (l?.lines ?? []).slice(-10).map((x) => cut(x, max)) }]));
}

const CUTS = [2000, 1000, 500, 250, 120, 60, 30];

// A sprint as its list card draws it (a sprint is never left out): the headline's fields and a row per
// ticket (key, title, state, why it stopped, its PR) and what the ticket allows now, with titles and reasons cut to
// `max`. No tasks or review findings: only the open board draws those. `brief` tells the board so. A sprint already
// capped keeps what capRows gave it.
const REASON_CHARS = 160;
const unique = (list) => [...new Set(list)];
// A ticket's plan buttons' state, sent only when the summary has it (the page refuses a Client prop that is undefined).
const PLAN_FLAGS = ['canApprove', 'canRevise', 'canOneTask', 'canAssignPlan'];
// Fields the summary did not have are left out, not sent as undefined (the page refuses a Client prop that is undefined).
const defined = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
export function sprintCard(s, max = TASK_TITLE_LIMIT) {
  if (s.unreadable) return defined({ ...s, name: cut(s.name, max), unreadable: cut(s.unreadable, Math.max(max * 4, 120)), brief: true });
  return defined({
    id: s.id, name: cut(s.name, max), draft: s.draft, discarded: s.discarded, paused: s.paused, finishedAt: s.finishedAt,
    autoMerge: s.autoMerge, maxParallel: s.maxParallel, news: s.news, check: s.check, chat: s.chat, brief: true,
    // A draft's proposed commands and check: the board's This repo fold.
    ...(s.proposed ? { proposed: s.proposed } : {}),
    ...(typeof s.headline === 'string' ? { headline: s.headline } : {}), ...(typeof s.status === 'string' ? { status: s.status } : {}), ...(typeof s.tone === 'string' ? { tone: s.tone } : {}), ...(s.more > 0 ? { more: s.more } : {}),
    ...(s.ended === true ? { ended: true } : {}),
    // Listed though archived: every reduced form keeps it, so nothing treats the sprint as live.
    ...(s.archived === true ? { archived: true } : {}),
    tickets: (s.tickets ?? []).map((t) => defined({
      key: t.key, title: cut(t.title, max), state: t.state, task: t.task, of: t.of, phase: t.phase, agent: t.agent,
      reason: cut(t.reason, Math.min(REASON_CHARS, max * 2)), pr: t.pr ?? null, reviews: t.reviews, latest: t.latest,
      canRetry: t.canRetry, giveTo: t.giveTo, canStop: t.canStop, ...(t.pos !== undefined ? { pos: t.pos } : {}), ...(t.slot ? { slot: t.slot } : {}),
      // What its row reads (who plans it, what it waits for) and its buttons' state; the plan's tasks only on the open board.
      plan: cut(t.plan ?? null, 200), writer: t.writer ?? null, reviewer: t.reviewer ?? null, after: t.after ?? [], waitingOn: t.waitingOn ?? [],
      ...Object.fromEntries(PLAN_FLAGS.filter((k) => t[k] !== undefined).map((k) => [k, t[k] === true])),
      ...(s.draft && Array.isArray(t.tasks) ? { writers: unique(t.tasks.map((x) => x.agent)), reviewers: unique(t.tasks.map((x) => x.reviewer)) } : {}),
    })),
  });
}

// Every sprint as its card, but the one whose board is open (`keep`) whole.
const cards = (list, keep = null, max = TASK_TITLE_LIMIT) => (list ?? []).map((s) => (s?.id === keep && keep !== null ? s : sprintCard(s, max)));
const CARD_CUTS = [40, 20, 8];

// Rows a capped card keeps (15 drafts of 30 tickets can be over the budget even as cards): its pinned rows (the
// board's open row, the open step's ticket), then those parked or waiting for an answer, running and waiting ones, then the
// rest in order.
export const CARD_ROWS = 5;
const ROW_RANK = { parked: 0, 'plan-ready': 0, 'no-tasks': 0, running: 1, waiting: 2 };
const rowRank = (t) => ROW_RANK[t?.state] ?? (SPRINT_ENDED.has(t?.state) ? 4 : 3);

// A sprint (or its card) with at most `n` ticket rows, drawn in the sprint's order: a card sent with rows left out.
// The screens can't work out a sprint's state from the rows it keeps, so the card carries its own: `headline`, `status`
// and `tone` counted over every ticket, `ended` when it finished, `more` for the rows left out, and each row's place in
// the whole list (`pos`: Move up and Move down read it). The open board's sprint keeps its tasks this way.
export function capRows(s, n = CARD_ROWS, pins = []) {
  const tickets = s?.tickets ?? [];
  if (!s || s.unreadable || tickets.length <= n) return s;
  const pinned = new Set(pins);
  const order = tickets.map((t, i) => i).sort((i, j) => (pinned.has(tickets[j].key) - pinned.has(tickets[i].key)) || rowRank(tickets[i]) - rowRank(tickets[j]) || i - j);
  const keep = new Set(order.slice(0, Math.max(0, n)));
  const rows = tickets.flatMap((t, i) => (keep.has(i) ? [{ ...t, pos: t.pos ?? i }] : []));
  const ended = isFinishedSprint(s);
  return {
    ...s, headline: sprintHeadline(s), status: sprintStatusLine(s), tone: ended ? finishedSprintTone(s) : sprintTone(s), tickets: rows,
    more: (s.more ?? 0) + tickets.length - rows.length, ...(ended ? { ended: true } : {}),
  };
}

// A sprint as little as the pane draws it (the last resort): its name, headline and buttons' state, no rows.
function sprintIdentity(s, max = 40) {
  if (s?.unreadable) return { id: s.id, name: cut(s.name, max), unreadable: cut(s.unreadable, 120), brief: true, tickets: [] };
  return capRows(sprintCard(s, max), 0);
}

// The order sprints matter in, shared by fitModel (which sprints it keeps) and the list (which come first):
// `first` (the open board's) if given, then those with a ticket running, then those with one that needs you (parked, or a
// plan waiting for an answer), then drafts and the rest, newest first (a sprint's id starts with when it was made). Indexes into `list`.
export function sprintOrder(list, first = null) {
  const has = (s, state) => (s?.tickets ?? []).some((t) => t.state === state);
  const needsYou = (s) => (s?.tickets ?? []).some((t) => NEEDS_YOU_STATES.has(t.state));
  const rank = (s) => (first !== null && s?.id === first ? 0 : has(s, 'running') ? 1 : needsYou(s) ? 2 : 3);
  return (list ?? []).map((s, i) => i).sort((i, j) => rank(list[i]) - rank(list[j]) || String(list[j]?.id).localeCompare(String(list[i]?.id)) || i - j);
}

// As many of `shown` (the sprints of `list`, as sent) as fit beside `base`: the open board's sprint first, then those
// with a ticket running, then parked, then the rest, newest first (sprintOrder). Drawn in Podium's order; `hiddenSprints` counts the
// rest, and the list says so. Null when not even one fits.
function someSprints(base, shown, list, boardId, budget) {
  const order = sprintOrder(list, boardId);
  let used = sizeOf({ ...base, sprints: [], hiddenSprints: list.length });
  const keep = new Set();
  for (const i of order) {
    const c = sizeOf(shown[i]) + 1;
    if (used + c > budget) continue;
    used += c;
    keep.add(i);
  }
  if (!keep.size) return null;
  const out = { ...base, sprints: shown.filter((s, i) => keep.has(i)), hiddenSprints: list.length - keep.size };
  return sizeOf(out) <= budget ? out : null;
}

const PANE_FULL = 'Podium has more than this pane can hold; ask Claude about your jobs.';

// The model the desktop Client is sent, at most `budget` characters as JSON. A model that fits goes whole. Otherwise jobs
// are left out in the order of `tiers` (in fitted). If what must be kept is still too big, long text is cut shorter, then
// the jobs go, then the open board's rows are capped, then card titles are cut, then whole sprints are left out. Whatever
// is left out is counted (`hiddenJobs`, `hiddenAtWork`, `hiddenSprints`, `olderSprints`) so the list can say so, and
// anything still over the budget becomes the smallest model. The terminal draws the whole model.
export function fitModel(model, { budget = PROPS_BUDGET, now = Date.now() } = {}) {
  const paged = pagedSprints(model);
  const out = fitted(paged, budget, now);
  return sizeOf(out) <= budget ? out : smallest(paged, budget);
}

// The sprints the Client is sent (the list draws a page of sprints, so the budget is not spent on sprints it
// never draws, leaving out jobs at work): the list's page (listPage, the same pages the terminal draws), with the open
// board's sprint and the open step's sprint, and `sprintPaging`, which ones are on the page and where it is in the list.
// They go whole while the model fits; past the budget fitted sends the page's sprints as rows first (sprintAsRow).
// Finished sprints: the newest FINISHED_SPRINTS of each fold (this chat's Done, Other chats) go as rows
// (sprintAsRow), never whole, but the open board's or step's sprint stays whole; `olderSprints` counts, per fold, the
// finished sprints not sent, so the list can say so. It is sent only when some sprint has finished.
function pagedSprints(model) {
  const list = model.sprints ?? [];
  const at = listPage(list.filter(isOpenSprint), model.sprintPage, null, CARD_ROWS);
  const ids = at.sprints.map((s) => s.id);
  const keep = new Set(ids);
  const v = model.view ?? {};
  if ((v.screen === 'sprint' || v.screen === 'ticket') && v.id) keep.add(v.id);
  const step = v.screen === 'detail' && v.id ? (model.jobs ?? []).find((j) => j.id === v.id) : null;
  if (step?.sprint?.id) keep.add(step.sprint.id);
  const fin = finishedSprints(list, model.session ?? null);
  const asRows = new Set([...fin.mine.slice(0, FINISHED_SPRINTS), ...fin.others.slice(0, FINISHED_SPRINTS)].map((s) => s.id).filter((id) => !keep.has(id)));
  const sent = (s) => keep.has(s.id) || asRows.has(s.id);
  const { sprints: _, ...where } = at;
  return {
    ...model, sprints: list.filter((s) => sent(s)).map((s) => (asRows.has(s.id) ? sprintAsRow(s) : s)), sprintPaging: { ...where, ids, rows: CARD_ROWS },
    ...(fin.mine.length || fin.others.length ? { olderSprints: { mine: fin.mine.filter((s) => !sent(s)).length, others: fin.others.filter((s) => !sent(s)).length } } : {}),
  };
}

// A sprint as its list row draws it: its card with no ticket rows (`status`, `headline` and `more` counted over
// every ticket). Your turn comes from the model's `turn`, so the list needs nothing else.
const sprintAsRow = (s) => capRows(sprintCard(s), 0);

function fitted(model, budget, now) {
  const whole = { ...model, hiddenJobs: 0, hiddenAtWork: 0 };
  if (sizeOf(whole) <= budget) return whole;
  const all = model.jobs ?? [];
  const v = model.view ?? {};
  const boardId = v.screen === 'sprint' || v.screen === 'ticket' ? (v.id ?? null) : null;
  const open = v.screen === 'detail' && v.id ? all.find((j) => j.id === v.id) : null;
  const isBoard = (s) => boardId !== null && s?.id === boardId;
  const isStep = (s) => Boolean(open?.sprint) && s?.id === open.sprint.id;
  // Finished sprints' rows are a tier of their own, each a unit (`sprint:<id>`), this chat's first; every other path
  // leaves them out and counts them in `olderSprints`. The open board's or step's sprint is never one of them.
  const isDoneRow = (s) => !isBoard(s) && !isStep(s) && isFinishedSprint(s);
  const session = model.session ?? null;
  const fin = finishedSprints((model.sprints ?? []).filter(isDoneRow), session);
  const doneRows = new Map([...fin.mine, ...fin.others].map((s) => [`sprint:${s.id}`, sprintAsRow(s)]));
  const olderOf = (kept = new Set()) => {
    if (!doneRows.size) return model.olderSprints ? { olderSprints: model.olderSprints } : {};
    const left = [...doneRows].filter(([k]) => !kept.has(k)).map(([, s]) => s);
    const mine = left.filter((s) => isSprintMine(s, session)).length;
    const base = model.olderSprints ?? { mine: 0, others: 0 };
    return { olderSprints: { mine: base.mine + mine, others: base.others + left.length - mine } };
  };
  const list = (model.sprints ?? []).filter((s) => !isDoneRow(s));
  // A capped sprint keeps these rows first: the board's open row and the open step's ticket.
  const pins = (s) => [model.board?.sprint === s?.id ? model.board?.open : null, open?.sprint?.id === s?.id ? open.sprint.ticket : null].filter(Boolean);
  const capped = (max = TASK_TITLE_LIMIT) => list.map((s) => capRows(sprintCard(s, max), CARD_ROWS, pins(s)));
  // Every card whole; then each card capped. The open board's sprint is whole in both.
  const full = cards(list, boardId);
  const short = capped().map((s, i) => (isBoard(list[i]) ? list[i] : s));
  // First past the budget: the list's sprints as rows (the list draws a row each), the open board's whole and the
  // open step's as its capped card (its ticket pinned), so a page of rows leaves room for the jobs at work.
  const rows = list.map((s, i) => (isBoard(s) ? s : isStep(s) ? short[i] : sprintAsRow(s)));
  const units = new Map();
  for (const j of all) {
    const k = unitOf(j);
    if (!units.has(k)) units.set(k, []);
    units.get(k).push(j);
  }
  const must = new Set([...units].filter(([, js]) => js.some(isAtWork)).map(([k]) => k));
  if (open?.sprint) for (const j of all) { if (j.sprint?.id === open.sprint.id && j.sprint.ticket === open.sprint.ticket) must.add(unitOf(j)); }
  else if (open) must.add(unitOf(open));
  const asking = model.askFor?.threadId ? `thread:${model.askFor.threadId}` : null;
  if (asking && units.has(asking)) must.add(asking);
  // The lanes as the list draws them (threads() leaves sprint steps out; a thread's id is its unit's).
  const org = organise(threads(all), { session: model.session ?? null, now, clearedAt: model.cleared ?? null, showAll: Boolean(model.showAllDone) });
  const newest = (a, b) => Math.max(...units.get(b).map(endOf)) - Math.max(...units.get(a).map(endOf));
  const rest = [...units.keys()].filter((k) => !must.has(k));
  // After `must` (threads with a job still at work, waiting on the person or in review; the open screen's and the ask form's thread), while
  // they fit, in this order; each tier stops at its first unit that does not fit.
  const tiers = [
    rest.filter((k) => units.get(k).some((j) => j.sprint?.id === boardId)).sort(newest), // the open board's steps
    org.done.map((t) => `thread:${t.id}`), // this chat's Done lane, as the list shows it
    org.others.map((t) => `thread:${t.id}`), // other chats' finished work the list shows
    [...doneRows.keys()], // finished sprints as rows
    rest.filter((k) => k.startsWith('thread:')).sort(newest), // the rest, newest first
    rest.filter((k) => k.startsWith('step:')).sort(newest), // then other sprint steps
  ];
  const lanes = all.filter((j) => !j.sprint);
  const keeping = (keys, base, shorten = (j) => j) => {
    const keySet = new Set(keys);
    const kept = new Set(keys.flatMap((k) => units.get(k) ?? []));
    const hidden = lanes.filter((j) => !kept.has(j));
    const done = [...doneRows].filter(([k]) => keySet.has(k)).map(([, s]) => s);
    return {
      ...base, jobs: all.filter((j) => kept.has(j)).map(shorten), hiddenJobs: hidden.length, hiddenAtWork: hidden.filter(isAtWork).length,
      sprints: [...(base.sprints ?? []), ...done], ...olderOf(keySet),
    };
  };
  // Each job costs its JSON and a comma (a finished sprint's row too); the hidden counts are sized at their largest, so the
  // sum is an upper bound.
  const cost = (k) => (doneRows.has(k) ? sizeOf(doneRows.get(k)) + 1 : units.get(k).reduce((n, j) => n + sizeOf(j) + 1, 0));
  const fill = (lean) => {
    let total = sizeOf({ ...lean, jobs: [], hiddenJobs: lanes.length, hiddenAtWork: lanes.length, ...olderOf() }) + [...must].reduce((n, k) => n + cost(k), 0);
    if (total > budget) return null;
    const keys = new Set(must);
    for (const tier of tiers) {
      for (const k of tier) {
        if (keys.has(k)) continue;
        const c = cost(k);
        if (total + c > budget) break;
        total += c;
        keys.add(k);
      }
    }
    const out = keeping([...keys], lean);
    return sizeOf(out) <= budget ? out : null;
  };
  // Rows are nearly always the smallest; full and short are a safety net for a sprint whose row (its headline and status
  // line added) outweighs its card, e.g. one short ticket.
  for (const sprints of [rows, full, short]) {
    const out = fill({ ...model, detail: drawnDetail(model.detail, CODE_LIMIT), sprints });
    if (out) return out;
  }
  // What must stay is over the budget: cut its long text shorter and shorter.
  for (const max of CUTS) {
    const base = { ...model, sprints: rows, detail: drawnDetail(model.detail && { ...model.detail, summary: cut(model.detail.summary, max * 2) }, Math.max(200, max * 4)), live: shortLive(model.live, max) };
    const squeezed = keeping([...must], base, (j) => shortJob(j, max));
    if (sizeOf(squeezed) <= budget) return squeezed;
  }
  // Still over: no jobs; then the open board's rows capped too (with their tasks), then it as a capped card, then
  // shorter card titles; then fewer sprints; then the bare list (never no sprints while one fits).
  const bare = (sprints) => ({ ...model, jobs: [], detail: null, live: {}, hiddenJobs: lanes.length, hiddenAtWork: lanes.filter(isAtWork).length, sprints, ...olderOf() });
  const boardCapped = rows.map((s, i) => (isBoard(list[i]) ? capRows(s, CARD_ROWS, pins(s)) : s));
  for (const sprints of [rows, boardCapped, capped(), ...CARD_CUTS.map(capped)]) {
    const out = bare(sprints);
    if (sizeOf(out) <= budget) return out;
  }
  const least = capped(CARD_CUTS.at(-1));
  const few = someSprints(bare([]), least, list, boardId, budget);
  if (few) return few;
  const stripped = {
    ...bare(least), view: { screen: 'list', id: null }, notice: PANE_FULL,
    agents: [], settings: null, checks: null, whatsNew: null, removing: null, askFor: null, draftAdapter: null,
    draft: { ...model.draft, task: '' }, folds: [], acked: (model.acked ?? []).slice(-20), seen: (model.seen ?? []).slice(-20),
  };
  if (sizeOf(stripped) <= budget) return stripped;
  return someSprints({ ...stripped, sprints: [] }, least, list, null, budget) ?? stripped;
}

// The smallest model the pane draws (fitModel's final check): the list, no jobs, and each sprint's name, headline and
// buttons, as many as fit (`hiddenSprints` counts the rest). Every field the screens read is present. It keeps `turn`
// whole (TURN_TICKETS tickets at most, about 8.5 KB at their longest), so it fits any budget above about 1,000
// characters plus that.
function smallest(model, budget) {
  const lanes = (model.jobs ?? []).filter((j) => !j.sprint);
  const list = model.sprints ?? [];
  const draft = Object.fromEntries(Object.entries(model.draft ?? {}).map(([k, x]) => [k, k === 'task' ? '' : typeof x === 'string' ? cut(x, 200) : x]));
  const base = {
    view: { screen: 'list', id: null }, notice: PANE_FULL, jobs: [], live: {}, detail: null, agents: [], agentsLoaded: Boolean(model.agentsLoaded),
    settings: null, draft, draftAdapter: null, palette: model.palette === 'light' ? 'light' : 'dark', askFor: null,
    cleared: typeof model.cleared === 'string' ? cut(model.cleared, 40) : null, showAllDone: false, checks: null, whatsNew: null, removing: null,
    board: { sprint: null, open: null, confirm: null, picking: null }, session: typeof model.session === 'string' ? cut(model.session, 100) : null,
    acked: (model.acked ?? []).slice(-20), seen: (model.seen ?? []).slice(-20),
    folds: [], turn: model.turn ?? { tickets: [], more: 0 }, olderFinished: { mine: Number(model.olderFinished?.mine) || 0, others: Number(model.olderFinished?.others) || 0 },
    hiddenJobs: lanes.length, hiddenAtWork: lanes.filter(isAtWork).length,
    sprintPage: Number.isInteger(model.sprintPage) ? model.sprintPage : 0, sprintPaging: model.sprintPaging ?? null,
  };
  const shown = list.map((s) => sprintIdentity(s));
  const out = { ...base, sprints: shown };
  if (sizeOf(out) <= budget) return out;
  return someSprints({ ...base, sprints: [] }, shown, list, null, budget) ?? { ...base, sprints: [], hiddenSprints: list.length };
}

// ---- The list's sprint rows, a page at a time ----
// 60 saved drafts fit the model's budget, but 60 sprints drawn were past the desktop page's 2,000 elements and texts:
// the list drew the "couldn't draw" note, and its Back led to the same list. The list draws its sprint rows a page at
// a time (listPage, in sprintOrder), each page well inside the page's bounds, with the rest of the list beside it.
// A row draws the sprint's title and status line, each at most LIST_LINE_CHARS (the pane cuts a line on screen
// anyway). In the terminal a page's sprints keep at most LIST_ROWS tickets; on desktop fitModel sends them with none.
export const LIST_ROWS = 40;
export const LIST_LINE_CHARS = 240;
// What one page of sprint rows may take of the page's 2,000 elements and texts and 100,000 characters.
export const SPRINT_PAGE_NODES = 500;
export const SPRINT_PAGE_CHARS = 30_000;
// A sprint's row on the list (screens.tsx listScreen: row()), measured from the kit's drawing, with margin: its box,
// title button and status line; two nodes and about LINE_EXTRA characters around each text; its id in each key.
// (SPRINT_ROW_CHARS, not ROW_CHARS: that name is the file rows' bound above.) Its box is a tile (tiles.tsx tile:
// border, background and padding props), measured at 5 nodes and about 500 characters.
const SPRINT_ROW_NODES = 6;
const SPRINT_ROW_CHARS = 850;
const LINE_NODES = 2;
const LINE_EXTRA = 90;
const ID_USES = 6;

// What a sprint's row takes of the page, at most.
export function cardCost(s) {
  const lines = [sprintRowTitle(s), sprintStatusLine(s ?? { tickets: [] })].map((l) => cut(String(l), LIST_LINE_CHARS));
  return {
    nodes: SPRINT_ROW_NODES + LINE_NODES * lines.length,
    chars: SPRINT_ROW_CHARS + ID_USES * sizeOf(String(s?.id ?? '')) + lines.reduce((n, l) => n + sizeOf(l) + LINE_EXTRA, 0),
  };
}

// The list's sprints in sprintOrder, cut into pages that stay inside SPRINT_PAGE_NODES and SPRINT_PAGE_CHARS (a row
// alone always fits one), and the page `page` of them (the last if past it): its sprints (tickets capped at `rows`),
// which page it is of how many, and its first and last row's place in the whole list. On desktop fitModel has paged
// them already (`paging`, sprintPaging): the page is the sprints it names, in its order, each with at most the ticket
// rows fitModel sent (`paging.rows`, 0: rows only), so the list draws what fitModel measured.
export function listPage(list, page = 0, paging = null, rows = LIST_ROWS) {
  const all = list ?? [];
  if (paging && Array.isArray(paging.ids)) {
    const byId = new Map(all.map((s) => [s?.id, s]));
    const sprints = paging.ids.flatMap((id) => (byId.has(id) ? [capRows(byId.get(id), paging.rows ?? CARD_ROWS)] : []));
    return { sprints, page: paging.page ?? 0, pages: paging.pages ?? 1, from: paging.from ?? 1, to: paging.to ?? sprints.length, total: paging.total ?? sprints.length };
  }
  const pages = [];
  let cur = [];
  let nodes = 0;
  let chars = 0;
  for (const i of sprintOrder(all)) {
    const s = capRows(all[i], rows);
    const c = cardCost(s);
    if (cur.length && (nodes + c.nodes > SPRINT_PAGE_NODES || chars + c.chars > SPRINT_PAGE_CHARS)) {
      pages.push(cur);
      cur = [];
      nodes = 0;
      chars = 0;
    }
    cur.push(s);
    nodes += c.nodes;
    chars += c.chars;
  }
  if (cur.length) pages.push(cur);
  const at = Math.max(0, Math.min(Number.isInteger(page) ? page : 0, pages.length - 1));
  const before = pages.slice(0, at).reduce((n, p) => n + p.length, 0);
  const sprints = pages[at] ?? [];
  return { sprints, page: at, pages: pages.length, from: before + 1, to: before + sprints.length, total: all.length };
}

// The short list the Client draws when the whole list is past the page's bounds (else the "couldn't draw" note's
// Back would lead back to the same list, a loop). The header, Your turn and the list's page of sprint rows (each sprint sent as
// its card of at most CARD_ROWS tickets, short titles); no job rows (the list says some are not shown) and nothing that
// opens on the list (an ask form, the welcome card). It is always the list, so nothing leads from it back to a screen that failed.
export const LIST_TOO_LONG = 'This list is too long for this pane, so it shows only your sprints. Ask Claude about your jobs.';
export function safeList(model) {
  const lanes = (model.jobs ?? []).filter((j) => !j.sprint);
  const card = (s) => capRows(s?.brief || s?.unreadable ? s : sprintCard(s, CARD_CUTS[0]), CARD_ROWS);
  return {
    ...model, view: { screen: 'list', id: null }, notice: model.notice ? `${model.notice}\n${LIST_TOO_LONG}` : LIST_TOO_LONG,
    jobs: [], live: {}, detail: null, askFor: null, checks: null, whatsNew: null,
    hiddenJobs: (model.hiddenJobs ?? 0) + lanes.length, hiddenAtWork: (model.hiddenAtWork ?? 0) + lanes.filter(isAtWork).length,
    sprints: (model.sprints ?? []).map(card),
  };
}

// Presses the Client shows at once, before Podium answers.
export const NAV_ACTIONS = new Set(['showScreen', 'openDetail', 'openBoard', 'backToList', 'openAgent', 'fixOpen', 'openTicket']);

// The screen a navigation press shows at once (the Client's overlay) until Podium's model agrees.
export function overlayFor(name, args) {
  if (name === 'openDetail') return { screen: 'detail', id: String(args[0]) };
  if (name === 'fixOpen') return { screen: 'detail', id: String(args[1]) };
  if (name === 'openTicket') return args[1] ? { screen: 'ticket', id: String(args[0]), key: String(args[1]) } : { screen: 'sprint', id: String(args[0]) };
  if (name === 'openBoard') return { screen: 'sprint', id: String(args[0]) };
  if (name === 'openAgent') return { screen: 'agent', id: String(args[0]) };
  if (name === 'backToList') return { screen: 'list', id: null };
  return { screen: args[0], id: null };
}

// Presses that set a value: a newer one replaces an unsent older one, and none shows "Working…".
export const EDIT_ACTIONS = new Set(['editDraft', 'askEdit', 'editAdapter', 'askConfirm', 'openPicker', 'showSprints', 'editNote', 'confirmJob']);

// Presses that show no "Working…" but are never replaced by a newer one (two folds opened quickly both open).
export const QUIET_ACTIONS = new Set(['toggleFold']);

export function enqueue(outbox, msg) {
  const kept = EDIT_ACTIONS.has(msg.name) ? outbox.filter((m) => m.name !== msg.name) : outbox;
  return [...kept, msg];
}

// What the Client posts on this tick. The app keeps only the last post of a frame, and a
// busy or background window can run several ticks in one frame, so a press posted on its
// own could be silently replaced (a Push to PR that never ran). Instead every post carries
// all the presses Podium has not yet said it received (model.seen); Podium skips ids it
// has seen, so a replaced post loses nothing. Unchanged, the batch is sent again after
// RESEND ticks; with nothing waiting, a due sync goes.
export const RESEND = 8;
export function nextPost(outbox, s) {
  const key = outbox.map((m) => m.id).join(',');
  if (outbox.length && (key !== s.sentKey || s.sinceSend >= RESEND)) {
    return { post: { kind: 'acts', acts: outbox }, s: { syncDue: false, sentKey: key, sinceSend: 0 } };
  }
  if (!outbox.length && s.syncDue) return { post: { kind: 'sync' }, s: { syncDue: false, sentKey: '', sinceSend: 0 } };
  return { post: null, s: { ...s, sinceSend: s.sinceSend + 1 } };
}

// Drops the presses Podium has received.
export function unseen(outbox, seen) {
  const got = new Set(seen ?? []);
  return outbox.filter((m) => !got.has(m.id));
}

// ---- The desktop page's rules for a Client's tree ----
// The Client's runtime sends the page JSON of its tree (props copied plain, functions and undefined dropped, a
// Button, Input or Select as a handle with no children). The page throws the whole tree away (a blank pane, logged
// as "Client instance unmounted (render)") unless it fits these bounds and every element is one it draws. The bounds
// were measured against the Claude desktop app (2026-10). There is no Code, Link or Markdown on the page.
// The page itself allows 262,144 characters, but the Client runtime unmounts a tree past 100,000 (ClientElements), so the stricter bound.
const PAGE_CHARS = 100000;
const PAGE_NODES = 2000;
const PAGE_DEPTH = 32;
const PAGE_NESTING = 66;
const PAGE_TAGS = new Set(['Box', 'Text', 'div', 'span', 'b']);
const PRESSABLE = new Set(['Button', 'Input', 'Select']);
const KEY_CHARS = 256;
const VALUE_CHARS = 16384;
const SVG_CHARS = 131072;
const SVG_SIDE = 4096;

const count = (n) => n.toLocaleString('en-US');
const what = (v) => (v === null ? 'null' : Array.isArray(v) ? 'a list' : typeof v === 'object' ? 'an object' : `a ${typeof v}`);
class Refused extends Error {}
const refuse = (reason) => { throw new Refused(reason); };

// Props as the runtime copies them: null kept, a number that is not finite becomes null, functions and undefined drop.
function plainValue(v) {
  if (v === null) return null;
  const kind = typeof v;
  if (kind === 'string' || kind === 'boolean') return v;
  if (kind === 'number') return Number.isFinite(v) ? v : null;
  if (kind !== 'object') return undefined;
  if (Array.isArray(v)) return v.map((x) => { const y = plainValue(x); return y === undefined ? null : y; });
  const out = {};
  for (const k of Object.keys(v)) { const y = plainValue(v[k]); if (y !== undefined) out[k] = y; }
  return out;
}

// The tree the page receives (the runtime's exportTree). The runtime numbers each Button, Input and Select handle
// from a counter that grows for the pane's life (it redraws every second): counted here at its largest.
function sent(node) {
  if (typeof node === 'string') return node;
  if (typeof node !== 'object' || node === null || Array.isArray(node)) refuse(`a child that is neither text nor an element (${what(node)})`);
  if (typeof node.type !== 'string') refuse('an element without a type');
  const out = { type: node.type };
  if (node.props !== undefined) out.props = plainValue(node.props);
  if (PRESSABLE.has(node.type)) return { ...out, held: Number.MAX_SAFE_INTEGER };
  if (node.children !== undefined) {
    if (!Array.isArray(node.children)) refuse(`${node.type} children that are not a list`);
    out.children = node.children.map(sent);
  }
  return out;
}

// The page's bounds: every element and every text child counts; element depth; how deep any data nests.
function measure(tree) {
  let nodes = 0;
  let depth = 0;
  let nesting = 0;
  const stack = [{ value: tree, depth: 0, nesting: 0, isChild: true }];
  while (stack.length) {
    const e = stack.pop();
    const v = e.value;
    const isObject = typeof v === 'object' && v !== null;
    const isElement = isObject && 'type' in v;
    const d = isElement ? e.depth + 1 : e.depth;
    const n = isObject ? e.nesting + 1 : e.nesting;
    if (isElement || (e.isChild && typeof v === 'string')) nodes += 1;
    depth = Math.max(depth, d);
    nesting = Math.max(nesting, n);
    if (isObject) for (const x of Object.values(v)) stack.push({ value: x, depth: d, nesting: n, isChild: Array.isArray(v) });
  }
  return { nodes, depth, nesting };
}

function bounds(tree) {
  const { nodes, depth, nesting } = measure(tree);
  if (nodes > PAGE_NODES) refuse(`${count(nodes)} elements and texts, more than the desktop pane's ${count(PAGE_NODES)}`);
  if (depth > PAGE_DEPTH) refuse(`elements nested ${depth} deep, more than the desktop pane's ${PAGE_DEPTH}`);
  if (nesting > PAGE_NESTING) refuse(`data nested ${nesting} deep, more than the desktop pane's ${PAGE_NESTING}`);
}

const isText = (v) => typeof v === 'string';

// A Button, Input or Select needs a key of 1 to 256 characters; the rest of its text props are checked by name.
function keyed(type, props) {
  const an = /^[AEIOU]/.test(type) ? 'an' : 'a';
  if (!isText(props.key) || props.key.length < 1) refuse(`${an} ${type} with no key`);
  if (props.key.length > KEY_CHARS) refuse(`${an} ${type} key longer than ${KEY_CHARS} characters`);
  const name = `${an} ${type} ${props.key}`;
  const optionalText = (field, max = Infinity) => {
    if (props[field] === undefined) return;
    if (!isText(props[field])) refuse(`${name} whose ${field} is not text`);
    if (props[field].length > max) refuse(`${name} whose ${field} is longer than ${count(max)} characters`);
  };
  return { name, optionalText };
}

// The elements the page draws and their props.
function element(node) {
  if (isText(node)) return;
  const { type } = node;
  const props = node.props ?? {};
  if (typeof props !== 'object' || Array.isArray(props)) refuse(`a ${type} whose props are ${what(props)}`);
  if (PAGE_TAGS.has(type)) {
    for (const [k, v] of Object.entries(props)) {
      if (!['string', 'number', 'boolean'].includes(typeof v)) refuse(`a ${type} prop ${k} that is ${what(v)}`);
    }
    for (const c of node.children ?? []) element(c);
    return;
  }
  if (type === 'Svg') {
    if (!isText(props.source) || !props.source.length) refuse('an Svg with no source');
    if (props.source.length > SVG_CHARS) refuse(`an Svg source longer than ${count(SVG_CHARS)} characters`);
    if (!isText(props.alt) || !props.alt.trim()) refuse('an Svg with no alt text');
    for (const side of ['width', 'height']) {
      const v = props[side];
      if (typeof v !== 'number' || !(v > 0) || v > SVG_SIDE) refuse(`an Svg whose ${side} is not a number from 1 to ${count(SVG_SIDE)}`);
    }
    if (props.isInteractive !== undefined && typeof props.isInteractive !== 'boolean') refuse('an Svg whose isInteractive is not true or false');
    return;
  }
  if (type === 'Button') {
    const { name } = keyed(type, props);
    if (!isText(props.label)) refuse(`${name} with no label`);
    if (props.plain !== undefined && typeof props.plain !== 'boolean') refuse(`${name} whose plain is not true or false`);
    return;
  }
  if (type === 'Input') {
    const { optionalText } = keyed(type, props);
    for (const f of ['label', 'placeholder', 'submitLabel']) optionalText(f);
    optionalText('value', VALUE_CHARS);
    return;
  }
  if (type === 'Select') {
    const { name, optionalText } = keyed(type, props);
    if (!Array.isArray(props.options) || !props.options.length) refuse(`${name} with no options`);
    for (const o of props.options) {
      if (typeof o !== 'object' || o === null || !isText(o.value)) refuse(`${name} with an option that has no value`);
      if (o.value.length > VALUE_CHARS) refuse(`${name} with an option value longer than ${count(VALUE_CHARS)} characters`);
      if (o.label !== undefined && !isText(o.label)) refuse(`${name} with an option label that is not text`);
    }
    optionalText('label');
    optionalText('value', VALUE_CHARS);
    return;
  }
  refuse(`a ${type} element, which the desktop pane cannot draw`);
}

// null when the desktop page will draw this Client tree; otherwise why it would refuse it, a short phrase that
// reads after "The screen has". Takes the tree as the Client builds it or as the kit draws it.
export function pageProblem(tree) {
  try {
    const text = JSON.stringify(sent(tree));
    if (text.length > PAGE_CHARS) refuse(`a drawing of ${count(text.length)} characters, more than the desktop pane's ${count(PAGE_CHARS)}`);
    const page = JSON.parse(text);
    bounds(page);
    element(page);
    return null;
  } catch (err) {
    if (err instanceof Refused) return err.message;
    return `a drawing that could not be checked (${String(err?.message ?? err)})`;
  }
}

// How much of the page's bounds a Client tree (or a part of one) takes: elements and texts, and characters as sent.
export function pageSize(tree) {
  const page = JSON.parse(JSON.stringify(sent(tree)));
  return { nodes: measure(page).nodes, chars: JSON.stringify(page).length };
}

// How many words a drawing shows (the first view's "fewer words" check): every text, every Button's label, and
// an Input's label and placeholder (its value is the person's own words). A word is a run of characters with a letter or a
// digit in it, so "·", "›" and "▸" are not words.
export function wordsDrawn(tree) {
  let n = 0;
  const count = (s) => { n += String(s ?? '').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length; };
  const walk = (node) => {
    if (typeof node === 'string' || typeof node === 'number') { count(node); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object') return;
    const props = node.props ?? {};
    if (node.type === 'Button') count(props.label);
    if (node.type === 'Input') { count(props.label); count(props.placeholder); }
    for (const c of node.children ?? []) walk(c);
  };
  walk(tree);
  return n;
}

// What the "couldn't draw" note says first, in plain words; pageProblem's reason goes below it, dim.
const TOO_MUCH = /^(a drawing of [\d,]+ characters|[\d,]+ elements and texts|elements nested \d+ deep|data nested \d+ deep)/;
export function plainProblem(reason) {
  return TOO_MUCH.test(String(reason ?? ''))
    ? 'This screen has too much to show here. Close some open files, or ask Claude.'
    : 'Something on this screen can\'t be shown here.';
}

// Code drawn as lines of text for the desktop Client, which has no Code element. A diff colours its added and
// removed lines, dims its headers and keeps its start; other output keeps its end (the newest lines). At most
// `max` lines and `maxChars` characters of drawing (lineCost each), with a dim note for the rest; a line longer
// than LINE_CHARS is cut (the pane cuts it on screen anyway, but sends all of it). `used` is how many lines it
// drew, for the screen's budget (look.tsx).
export const CODE_LINES = 300;
export const LINE_CHARS = 400;
// A line's share of the drawing: its text as JSON and its Text element around it ({"type":"Text","props":{…}}).
export const lineCost = (text) => JSON.stringify(String(text)).length + 80;
export function codeLines(source, { format = 'source', max = CODE_LINES, maxChars = Infinity } = {}) {
  const all = String(source ?? '').split('\n');
  const isDiff = format === 'diff';
  const tone = (line) => {
    if (line.startsWith('… ')) return 'dim';
    if (!isDiff) return 'plain';
    if (/^(@@|diff |index |\+\+\+ |--- )/.test(line)) return 'head';
    if (line.startsWith('+')) return 'added';
    if (line.startsWith('-')) return 'removed';
    return 'plain';
  };
  const room = Math.max(0, max);
  const fit = (line) => (line === '' ? ' ' : line.length > LINE_CHARS ? `${line.slice(0, LINE_CHARS - 1)}…` : line);
  // Lines kept from the end that matters (a diff's start, output's end) while they fit both bounds.
  const order = isDiff ? all : [...all].reverse();
  const kept = [];
  let chars = 0;
  for (const line of order) {
    if (kept.length >= room) break;
    const text = fit(line);
    chars += lineCost(text);
    if (chars > maxChars) break;
    kept.push({ text, tone: tone(line) });
  }
  const used = kept.length;
  const lines = isDiff ? [...kept] : [...kept].reverse();
  const rest = all.length - used;
  if (rest > 0) {
    const note = { text: `… ${count(rest)} ${isDiff ? 'more' : 'earlier'} line${rest === 1 ? '' : 's'}`, tone: 'dim' };
    if (isDiff) lines.push(note); else lines.unshift(note);
  }
  return { used, lines };
}
