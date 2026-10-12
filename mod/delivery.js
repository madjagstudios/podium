// Handing finished work to Claude. Pure: the mod passes its $ calls in as closures.

// The details go in first, as a row the person doesn't see but Claude reads, then the one-line
// headline. If the hidden row cannot be added (append throws, or the host has no such call), the
// details ride in the visible message instead (headline, blank line, details). Claude gets the report
// and the person sees more than they would, which beats a finished job that never arrives.
// True only when the message went in, so the caller marks delivered only then (a failed submit
// leaves the work to be tried again).
// A row or prompt a hook refused or dropped on purpose still counts as handled: a `deny` from append is a
// plugin saying no to the row, so the details are not forced into the chat.
export async function handOver({ append, submit, headline, details }) {
  let hidden = true;
  try {
    await append();
  } catch {
    hidden = false;
  }
  try {
    await submit(hidden ? headline : `${headline}\n\n${details}`);
  } catch {
    return false;
  }
  return true;
}

// One pass of sprint news: claim, hand over, then mark delivered, as for jobs. The mod keeps three things across
// passes: `announced`, ids handed over but not yet marked (marked first next time, never announced twice); `inFlight`,
// ids being sent now (a send can outlast the 2-minute claim, so a later pass skips them; a failed send clears them);
// and `busy` ({ on }), so only one pass runs at a time. mark(ids) answers { failed }, or null when the call failed.
export async function sprintNewsPass({ busy = { on: false }, ...deps }) {
  if (busy.on) return;
  busy.on = true;
  try {
    await newsPass(deps);
  } finally {
    busy.on = false;
  }
}

async function newsPass({ announced, inFlight, hasNews, claim, tellClaude, send, toast, mark }) {
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
      if (!(await send(fresh))) return; // nothing went in: the claim expires and it is tried again
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
