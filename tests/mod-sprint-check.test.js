// What the board, a ticket's screen, the tool and Steps say about the full check.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sprintRow, sprintHeadline, sprintStatusLine, ticketState, ticketStatusLine, sprintStepLine, doingText } from '../mod/view.js';

const check = { key: 'ABC-11', title: 'Login form', state: 'running', task: 2, of: 2, phase: 'check', agent: 'codex', reason: null, pr: null, reviews: 2 };
const fixing = { ...check, phase: 'check-fix' };
const sprintOf = (t) => ({ id: 's1', name: 'Oct', paused: false, finishedAt: null, autoMerge: false, maxParallel: 3, news: 0, tickets: [t] });

test('a ticket at its full check says so on the board, its screen and in the tool', () => {
  assert.equal(ticketState(check), 'running the full check');
  assert.equal(ticketState(fixing), 'Codex fixing what the full check found');
  assert.equal(ticketStatusLine(check), 'Running the full check before the PR');
  assert.equal(ticketStatusLine(fixing), 'Codex is fixing what the full check found');
  assert.equal(sprintRow(check), 'Full check before the PR · running');
  assert.equal(sprintRow(fixing), 'Fixing what the full check found · Codex working');
  assert.equal(doingText(check), 'full check on ABC-11');
  assert.equal(doingText(fixing), 'Codex fixing ABC-11 for its full check');
  assert.equal(sprintHeadline(sprintOf(check)), 'Sprint · Oct · 0 of 1 tickets done · 1 of 3 running: full check on ABC-11');
  assert.equal(sprintStatusLine(sprintOf(check)), '0 of 1 done · 1 of 3 running: ABC-11');
  assert.equal(sprintStatusLine(sprintOf(fixing)), '0 of 1 done · 1 of 3 running: ABC-11');
});

test('Steps and diff names a full check fix, and it does not turn the last review into a fail', () => {
  const at = (m) => `2026-10-10T10:0${m}:00Z`;
  const review = { id: 'r2', agent: 'claude', title: 'Review ABC-11 task 2: B', status: 'done', createdAt: at(1), endedAt: at(2), sprint: { id: 's1', ticket: 'ABC-11', task: 2, role: 'reviewer' } };
  const fix = { id: 'c1', agent: 'codex', title: 'ABC-11: fix what the full check found', status: 'done', createdAt: at(3), endedAt: at(4), sprint: { id: 's1', ticket: 'ABC-11', task: 2, role: 'author' } };
  const steps = [fix, review];
  assert.match(sprintStepLine(fix, steps, Date.parse(at(5))), /^Codex fixed what the full check found · /);
  const reviewed = sprintStepLine(review, steps, Date.parse(at(5)));
  assert.match(reviewed, /^Claude reviewed task 2/);
  assert.doesNotMatch(reviewed, /failed/);
});
