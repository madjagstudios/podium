// What a job's screen has open: the ask form (Ask for changes, Send fix, Answer comments, Review with…), the ender's
// question (Throw away, Stop) or Repair's question. Pure: register.tsx keeps the value in one atom and moves it only
// through `jobOpenNext` inside one update, so the three are exclusive however presses overlap.
//
// The value: null, { ask: <form> }, { confirm: 'discard' | 'cancel', id }, or { repair: id }.

// The next value after `action`:
//   { type: 'ask', form }            opens the ask form (closing any question)
//   { type: 'askEdit', patch }       changes the open form (nothing else open: no change)
//   { type: 'askClose' }             closes the form (Cancel, or sent); a question stays
//   { type: 'confirm', id, what }    opens the ender's question; what null closes that job's question
//   { type: 'repair', id, on }       opens Repair's question; on false closes that job's
//   { type: 'questionClose', id }    closes that job's question, whichever it is
//   { type: 'screenOpened' }         a job's screen was (re)opened: any question closes; the form stays
export function jobOpenNext(cur, action) {
  const now = cur ?? null;
  switch (action?.type) {
    case 'ask': return action.form ? { ask: action.form } : now;
    case 'askEdit': return now?.ask ? { ask: { ...now.ask, ...action.patch } } : now;
    case 'askClose': return now?.ask ? null : now;
    case 'confirm':
      if (action.what) return { confirm: action.what, id: action.id };
      return now?.confirm && now.id === action.id ? null : now;
    case 'repair':
      if (action.on) return { repair: action.id };
      return now?.repair === action.id ? null : now;
    case 'questionClose':
      return (now?.confirm && now.id === action.id) || now?.repair === action.id ? null : now;
    case 'screenOpened':
      return now?.confirm || now?.repair ? null : now;
    default: return now;
  }
}

// What the screens read: the ask form, and the job's own question folded into its detail.
export const askOf = (open) => open?.ask ?? null;
export function withQuestion(detail, open) {
  if (!detail) return detail;
  const confirm = open?.confirm && open.id === detail.id ? open.confirm : null;
  const confirmRepair = open?.repair === detail.id;
  return { ...detail, confirm, confirmRepair };
}

// How many things are open at once (for tests): never more than one.
export const openCount = (open) => (open ? ['ask', 'confirm', 'repair'].filter((k) => open[k]).length : 0);
