// A sprint PR's text: the plan's own summary, and the check a public repo's PR text passes before it opens.
import test from 'node:test';
import assert from 'node:assert/strict';
import { planSummary, prLeaks, cleanPrText, PR_SUMMARY_HEADING, TRACKER_PHRASES } from '../engine/pr-text.js';

const AGENTS = ['codex', 'Codex', 'claude', 'Claude', 'fa'];

test('a plan\'s PR summary is the text under its heading, on one line', () => {
  assert.equal(PR_SUMMARY_HEADING, '## PR summary');
  const plan = '# Plan\n\nApproach.\n\n### Task 1: A\nDo A.\n\n## PR summary\nPeople can sign in\r\nwith their   email.\n\n## Done\nx\n';
  assert.equal(planSummary(plan), 'People can sign in with their email.');
  assert.equal(planSummary('# Plan\n\n## pr SUMMARY\n  Short.  \n'), 'Short.');
  assert.equal(planSummary('# Plan\n\n### Task 1: A\n'), '');
  assert.equal(planSummary(null), '');
  const long = planSummary(`## PR summary\n${'word '.repeat(400)}`);
  assert.equal(long.length, 1000);
  assert.ok(long.endsWith('…'));
});

test('another project\'s ticket key is a leak; the ticket\'s own project and standard names are not', () => {
  assert.deepEqual(prLeaks('See XYZ-7 and AT-132.', { key: 'AT-131' }), [{ kind: 'key', found: 'XYZ-7' }]);
  assert.deepEqual(prLeaks('Reads UTF-8, SHA-256, ISO-8601 and RFC-3339.', { key: 'AT-131' }), []);
  assert.deepEqual(prLeaks('at-7 is lower case', { key: 'AT-131' }), []);
});

test('tracker phrasing, agent names, attributions and private terms are leaks', () => {
  assert.deepEqual(prLeaks('As the related MCP-tool Ticket says, and MCP-12.', { key: 'AT-1' }).map((x) => x.kind), ['key', 'tracker']);
  assert.deepEqual(prLeaks('Built from the implementation\n brief.', {}), [{ kind: 'tracker', found: 'implementation\n brief' }]);
  assert.deepEqual(prLeaks('codex: wrote the parser', { agents: AGENTS }), [{ kind: 'agent', found: 'codex' }]);
  assert.deepEqual(prLeaks('Co-Authored-By: someone', {}), [{ kind: 'agent', found: 'Co-Authored-By' }]);
  assert.deepEqual(prLeaks('Generated with a tool \u{1F916}', {}).map((x) => x.found), ['Generated with', '\u{1F916}']);
  assert.deepEqual(prLeaks('Works like Nightjar does.', { terms: ['nightjar', ' '] }), [{ kind: 'term', found: 'Nightjar' }]);
  // Whole words only, and agent names shorter than three characters are skipped.
  assert.deepEqual(prLeaks('Codexes and claudette, a fast fan.', { agents: AGENTS }), []);
  assert.ok(TRACKER_PHRASES.includes('implementation brief'));
});

test('a phrase is matched as plain text, never as a pattern', () => {
  assert.deepEqual(prLeaks('a+b and (x)', { terms: ['a+b', '(x)'] }).map((x) => x.found), ['a+b', '(x)']);
  assert.deepEqual(prLeaks('aaab', { terms: ['a+b'] }), []);
});

test('cleaning drops each line with a leak and reduces a leaking title to the key', () => {
  const body = 'People can sign in.\n\nChanges:\n- Port the codex parser\n- Add the form\n- Follow XYZ-7\n\nTested: `npm test` passed.';
  const out = cleanPrText({ key: 'AT-131', title: 'Login form', body }, { agents: AGENTS, terms: [] });
  assert.deepEqual(out, {
    subject: 'AT-131: Login form',
    body: 'People can sign in.\n\nChanges:\n- Add the form\n\nTested: `npm test` passed.',
    left: ['codex', 'XYZ-7'],
  });
  const titled = cleanPrText({ key: 'AT-131', title: 'Port Nightjar\'s login', body: 'Changes:\n- Add the form' }, { terms: ['Nightjar'] });
  assert.deepEqual(titled, { subject: 'AT-131', body: 'Changes:\n- Add the form', left: ['Nightjar'] });
});

test('text with no leak comes back as it was', () => {
  const body = 'Changes:\n- Add a.txt\n\nTested: each task ran its own tests before review.';
  assert.deepEqual(cleanPrText({ key: 'ABC-11', title: 'Login form', body }, { agents: AGENTS }), { subject: 'ABC-11: Login form', body, left: [] });
});
