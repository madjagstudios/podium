import test from 'node:test';
import assert from 'node:assert/strict';
import { agentLimit, resetTimeOf, LIMIT_LINES } from '../engine/limits.js';

const NOW = Date.UTC(2026, 9, 26, 3, 50);
const HOUR = 3_600_000;

test('usage limits are spotted, with the line that said so', () => {
  for (const s of [
    "You've hit your session limit · resets 3am (America/Chicago)",
    'You have hit your usage limit.',
    'Claude AI usage limit reached|1761897600',
    '5-hour limit reached ∙ resets 3am',
    "You've hit your weekly limit · resets Nov 5, 3am (America/Chicago)",
    'quota exceeded',
    'You exceeded your current quota',
    'out of credits',
  ]) {
    const got = agentLimit([s], NOW);
    assert.equal(got?.kind, 'usage', s);
    assert.equal(got.line, s);
  }
  assert.equal(agentLimit(["You've hit your weekly limit · resets Nov 5, 3am (America/Chicago)"], NOW).resetAt, null);
  assert.equal(agentLimit(["You've hit your session limit · resets 3am (America/Chicago)"], NOW).resetAt, Date.UTC(2026, 9, 26, 8, 0));
});

test('a busy service is spotted, with no reset time', () => {
  for (const s of [
    'Selected model is at capacity. Please try a different model.',
    'API Error: 529 Overloaded',
    'Rate limit reached',
    'Error: rate limited',
    'HTTP 429 Too Many Requests',
    'status: 429',
  ]) assert.deepEqual(agentLimit([s], NOW), { kind: 'busy', line: s, resetAt: null }, s);
});

test('other errors and empty output are not limits', () => {
  for (const s of ['boom', 'at foo.js:429:5', 'Add rate limiting to the API', 'Fake exited with code 3.', 'the limit was reached by the loop']) {
    assert.equal(agentLimit([s], NOW), null, s);
  }
  assert.equal(agentLimit([], NOW), null);
  assert.equal(agentLimit([''], NOW), null);
  assert.equal(agentLimit([undefined], NOW), null);
});

test('only the end of each text is read', () => {
  const other = Array.from({ length: 50 }, (_, i) => `working on step ${i}`);
  assert.equal(agentLimit([['You have hit your usage limit.', ...other].join('\n')], NOW), null);
  assert.equal(agentLimit([[...other.slice(1), 'You have hit your usage limit.'].join('\r\n')], NOW)?.kind, 'usage');
  assert.ok(LIMIT_LINES < 50);
  assert.equal(agentLimit(['all fine\n', 'Selected model is at capacity.'], NOW)?.kind, 'busy');
});

test('a line is cut to 200 characters', () => {
  const long = `You have hit your usage limit. ${'x'.repeat(300)}`;
  assert.equal(agentLimit([long], NOW).line.length, 200);
});

test('a usage limit wins over a busy line', () => {
  const got = agentLimit(['HTTP 429 Too Many Requests\nYou have hit your usage limit.'], NOW);
  assert.equal(got.kind, 'usage');
  assert.equal(got.line, 'You have hit your usage limit.');
});

test('resetTimeOf reads "resets <time> (<zone>)" as the next such wall time', () => {
  assert.equal(resetTimeOf('resets 3am (America/Chicago)', NOW), Date.UTC(2026, 9, 26, 8, 0));
  assert.equal(resetTimeOf('resets 3:30pm (UTC)', NOW), Date.UTC(2026, 9, 26, 15, 30));
  assert.equal(resetTimeOf('resets 3 am (UTC)', NOW), Date.UTC(2026, 9, 27, 3, 0));
  assert.equal(resetTimeOf('resets 15:00 (UTC)', NOW), Date.UTC(2026, 9, 26, 15, 0));
  assert.equal(resetTimeOf('resets 12am (UTC)', NOW), Date.UTC(2026, 9, 27, 0, 0));
  const unknown = resetTimeOf('resets 3am (Not/AZone)', NOW);
  assert.ok(unknown >= NOW - 60_000 && unknown <= NOW + 24 * HOUR, String(unknown));
  assert.equal(resetTimeOf('resets Nov 5, 3am', NOW), null);
});

test('resetTimeOf reads a trailing Unix time within 8 days', () => {
  const at = NOW + 5 * HOUR;
  assert.equal(resetTimeOf(`Claude AI usage limit reached|${at / 1000}`, NOW), at);
  assert.equal(resetTimeOf(`Claude AI usage limit reached|${(NOW - HOUR) / 1000}`, NOW), null);
  assert.equal(resetTimeOf(`Claude AI usage limit reached|${(NOW + 9 * 24 * HOUR) / 1000}`, NOW), null);
});

test('resetTimeOf reads "try again in" spans', () => {
  assert.equal(resetTimeOf('try again in 2 hours 13 minutes', NOW), NOW + 133 * 60_000);
  assert.equal(resetTimeOf('try again in 4 days 2 hours', NOW), NOW + (4 * 24 + 2) * HOUR);
  assert.equal(resetTimeOf('Try again in 45m', NOW), NOW + 45 * 60_000);
  assert.equal(resetTimeOf('You have hit your usage limit.', NOW), null);
});
