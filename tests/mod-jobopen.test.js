import test from 'node:test';
import assert from 'node:assert/strict';
import { jobOpenNext, askOf, withQuestion, openCount } from '../mod/jobopen.js';

const FORM = { threadId: 'n1', agent: 'codex', task: '' };
const PRESSES = [
  { type: 'ask', form: FORM },
  { type: 'askEdit', patch: { task: 'make the heading bigger' } },
  { type: 'confirm', id: 'n1', what: 'discard' },
  { type: 'repair', id: 'n1', on: true },
  { type: 'askClose' },
  { type: 'confirm', id: 'n1', what: null },
  { type: 'repair', id: 'n1', on: false },
  { type: 'screenOpened' },
];

// Every order of `items` (each press applied whole, as one update applies it: an interleaving of overlapping presses is
// some order of whole transitions).
function* orders(items) {
  if (items.length <= 1) { yield items; return; }
  for (let i = 0; i < items.length; i++) {
    for (const rest of orders([...items.slice(0, i), ...items.slice(i + 1)])) yield [items[i], ...rest];
  }
}

test('in every order of overlapping presses, at most one of the form, the ender\'s question and Repair\'s is open', () => {
  let checked = 0;
  for (const order of orders(PRESSES.slice(0, 6))) {
    let cur = null;
    for (const press of order) {
      cur = jobOpenNext(cur, press);
      assert.ok(openCount(cur) <= 1, JSON.stringify({ order, cur }));
      const d = withQuestion({ id: 'n1' }, cur);
      const shown = [askOf(cur), d.confirm, d.confirmRepair].filter(Boolean).length;
      assert.ok(shown <= 1, `the screen shows at most one: ${JSON.stringify(cur)}`);
      checked += 1;
    }
  }
  assert.ok(checked > 1000);
});

test('the last opener wins: the form, then Throw away, leaves only the question; then Repair, only Repair', () => {
  let cur = jobOpenNext(null, { type: 'ask', form: FORM });
  cur = jobOpenNext(cur, { type: 'askEdit', patch: { task: 'x' } });
  assert.deepEqual(cur, { ask: { ...FORM, task: 'x' } });
  cur = jobOpenNext(cur, { type: 'confirm', id: 'n1', what: 'discard' });
  assert.deepEqual(cur, { confirm: 'discard', id: 'n1' });
  assert.equal(askOf(cur), null);
  // An edit or a close of a form that is no longer open changes nothing.
  assert.deepEqual(jobOpenNext(cur, { type: 'askEdit', patch: { task: 'y' } }), cur);
  assert.deepEqual(jobOpenNext(cur, { type: 'askClose' }), cur);
  cur = jobOpenNext(cur, { type: 'repair', id: 'n1', on: true });
  assert.deepEqual(cur, { repair: 'n1' });
  // Closing a question that is not the open one changes nothing; closing the open one closes it.
  assert.deepEqual(jobOpenNext(cur, { type: 'confirm', id: 'n1', what: null }), cur);
  assert.equal(jobOpenNext(cur, { type: 'repair', id: 'n1', on: false }), null);
  // Another job's Cancel leaves this one's question.
  assert.deepEqual(jobOpenNext({ confirm: 'cancel', id: 'r1' }, { type: 'confirm', id: 'n1', what: null }), { confirm: 'cancel', id: 'r1' });
});

test('a question shows only on its own job, and opening a job\'s screen closes questions but keeps the form', () => {
  assert.deepEqual(withQuestion({ id: 'n1', summary: 's' }, { confirm: 'discard', id: 'n1' }), { id: 'n1', summary: 's', confirm: 'discard', confirmRepair: false });
  assert.deepEqual(withQuestion({ id: 'd1' }, { confirm: 'discard', id: 'n1' }), { id: 'd1', confirm: null, confirmRepair: false });
  assert.equal(withQuestion(null, { repair: 'n1' }), null);
  assert.equal(jobOpenNext({ repair: 'n1' }, { type: 'screenOpened' }), null);
  assert.deepEqual(jobOpenNext({ ask: FORM }, { type: 'screenOpened' }), { ask: FORM });
});
