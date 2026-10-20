// Handing finished work to Claude. Pure: the mod passes its $ calls in as closures.

// The details go in first, as a row the person doesn't see but Claude reads, then the one-line
// headline. If the hidden row cannot be added (append throws, or the host has no such call), the
// details ride in the visible message instead (headline, blank line, details). Claude gets the report
// and the person sees more than they would, which beats a finished job that never arrives.
// True only when the message went in, so the caller marks delivered only then (a failed submit
// leaves the work to be tried again).
// A row or prompt a hook refused or dropped on purpose still counts as handled: a `deny` from append is a
// plugin saying no to the row, so the details are not forced into the chat.
// With `arrived` (an `arrivals()` registry's expect), the message also counts as in once a turn starts holding the
// headline, which opens the message either way: see arrivals.
export async function handOver({ append, submit, headline, details, arrived }) {
  let hidden = true;
  try {
    await append();
  } catch {
    hidden = false;
  }
  const watch = arrived ? arrived(headline) : null;
  try {
    const sent = submit(hidden ? headline : `${headline}\n\n${details}`);
    await (watch ? Promise.race([sent, watch.seen]) : sent);
  } catch {
    return false;
  } finally {
    watch?.cancel();
  }
  return true;
}

// Prompts that waited behind a busy turn can enter together: the host starts one turn holding every waiting text, one
// per line, and settles only the last one's submit (the others never settle). So a hand-over waiting on its submit
// also ends once a turn starts whose text holds its headline (turnStarted, from the mod's turn.start hook): the
// message is in then, never before. Identical headlines (three reviews of one PR) are counted, oldest first, so a turn
// holding one confirms one.
export function arrivals() {
  const waiting = [];
  const drop = (entry) => {
    const i = waiting.indexOf(entry);
    if (i >= 0) waiting.splice(i, 1);
  };
  return {
    expect(headline) {
      const entry = { headline };
      entry.seen = new Promise((resolve) => { entry.settle = resolve; });
      waiting.push(entry);
      return { seen: entry.seen, cancel: () => drop(entry) };
    },
    turnStarted(text) {
      const left = new Map();
      for (const entry of [...waiting]) {
        if (!left.has(entry.headline)) left.set(entry.headline, occurrences(String(text ?? ''), entry.headline));
        const n = left.get(entry.headline);
        if (n < 1) continue;
        left.set(entry.headline, n - 1);
        drop(entry);
        entry.settle(true);
      }
    },
  };
}

function occurrences(text, part) {
  if (!part) return 0;
  let n = 0;
  for (let i = text.indexOf(part); i !== -1; i = text.indexOf(part, i + part.length)) n += 1;
  return n;
}

// One pass of sprint news: claim, hand over, then mark delivered, as for jobs. The mod keeps three things across
// passes: `announced`, ids handed over but not yet marked (marked first next time, never announced twice); `inFlight`,
// ids being sent now (a later pass skips them; a failed send clears them); and `busy` ({ on }), so only one pass runs at a
// time. mark(ids) answers { failed }, or null when the call failed. With `sleep` and `refresh(ids)`, the claims are renewed
// while the send waits (keepFresh), so a send that outlasts the 2-minute claim never lets another pass, in this mod or a
// reloaded one, take the news and say it again.
export async function sprintNewsPass({ busy = { on: false }, ...deps }) {
  if (busy.on) return;
  busy.on = true;
  try {
    await newsPass(deps);
  } finally {
    busy.on = false;
  }
}

async function newsPass({ announced, inFlight, hasNews, claim, tellClaude, send, toast, mark, sleep, refresh }) {
  const confirm = async (ids) => {
    if (!ids.length) return;
    const r = await mark(ids);
    if (!r) return;
    const failed = new Set(r.failed ?? []);
    for (const id of ids) if (!failed.has(id)) announced.delete(id);
  };
  await confirm([...announced]);
  if (!(await hasNews())) return;
  const list = await claim();
  const again = list.filter((m) => announced.has(m.id));
  const fresh = list.filter((m) => !announced.has(m.id) && !inFlight.has(m.id));
  await confirm(again.map((m) => m.id));
  if (!fresh.length) return;
  for (const m of fresh) inFlight.add(m.id);
  try {
    if (await tellClaude()) {
      const ids = fresh.map((m) => m.id);
      const sent = sleep && refresh ? await keepFresh(() => send(fresh), { sleep, refresh: () => refresh(ids) }) : await send(fresh);
      if (!sent) return; // nothing went in: the claim expires and it is tried again
    } else {
      toast(fresh); // Claude isn't told: the person still sees it, as finished jobs do
    }
    for (const m of fresh) announced.add(m.id);
  } finally {
    for (const m of fresh) inFlight.delete(m.id);
  }
  await confirm(fresh.map((m) => m.id));
}

// While `work` runs, `refresh` is called after each `sleep`, for as long as `work` runs (the delivery lock goes stale
// after a minute, and a submit can wait behind a busy turn far longer; no cap, since a capped heartbeat would let the lock
// go stale under a submit waiting over an hour). A refresh that fails (throws or rejects) is let go and the next beat tries
// again: one bad renewal never ends the heartbeat. Only a `sleep` that fails ends it (there is no safe way left to wait).
// Answers what `work` answers. A refresh still in flight when `work` ends is awaited (not the sleep after it), so it can't
// touch the lock once the caller goes on to release it.
export async function keepFresh(work, { sleep, refresh }) {
  let done = false;
  let pending = null;
  const beat = (async () => {
    for (;;) {
      await sleep();
      if (done) return;
      pending = Promise.resolve().then(refresh);
      try { await pending; } catch { /* a failed renewal: the next beat tries again */ }
    }
  })();
  beat.catch(() => {});
  try {
    return await work();
  } finally {
    done = true;
    await Promise.resolve(pending).catch(() => {});
  }
}
