// What Settings → This repo and the board say about the repo's settings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { repoSummary, NO_CHECK_LINE, proposedSummary, repoValuesText, startedNotice } from '../mod/view.js';
import { sprintCard } from '../mod/client.js';

test('the This repo fold says what is set for the repo this chat is in', () => {
  assert.equal(repoSummary({}, 'repo'), 'nothing set');
  assert.equal(repoSummary({ repoCommands: { repo: ['dotnet'] }, repoCheck: { repo: 'dotnet test' } }, 'repo'), 'dotnet · full check set');
  assert.equal(repoSummary({ repoCommands: { repo: ['dotnet', 'npm'] }, repoSquash: { repo: false }, repoMergeMethod: { repo: 'squash' } }, 'repo'), 'dotnet npm · commits kept · squash merges');
  assert.equal(repoSummary({ repoCommands: { other: ['dotnet'] } }, 'repo'), 'nothing set');
  assert.equal(repoSummary({ repoCommands: { repo: ['dotnet'] } }, null), 'nothing set');
  assert.equal(NO_CHECK_LINE, 'No full check for this repo: PRs open without one');
});

test('a hand-edited settings file with values of the wrong kind still gives the This repo heading', () => {
  assert.equal(repoSummary({ repoCommands: { repo: 'dotnet' } }, 'repo'), 'nothing set');
  assert.equal(repoSummary({ repoCommands: { repo: { dotnet: true } }, repoCheck: { repo: 42 } }, 'repo'), 'nothing set');
  assert.equal(repoSummary({ repoCommands: { repo: ['dotnet', 7] }, repoCheck: { repo: ['x'] } }, 'repo'), 'dotnet');
  assert.equal(repoSummary({ repoMergeMethod: { repo: 'Squash' } }, 'repo'), 'squash merges');
  assert.equal(repoSummary({ repoMergeMethod: { repo: { m: 1 } } }, 'repo'), 'nothing set');
  assert.equal(repoSummary({ repoCommands: 'dotnet' }, 'repo'), 'nothing set');
});

test('a draft\'s proposed commands and check: a short fold heading and an exact sentence', () => {
  assert.equal(proposedSummary({ commands: ['dotnet'], check: 'dotnet build && dotnet test' }), 'dotnet · full check');
  assert.equal(proposedSummary({ check: 'npm test' }), 'full check');
  assert.equal(proposedSummary({ commands: [] }), 'no commands');
  assert.equal(proposedSummary({ check: '' }), 'no full check');
  assert.equal(proposedSummary(null), '');
  assert.equal(repoValuesText({ commands: ['dotnet', 'npm'], check: 'dotnet test' }), 'commands dotnet, npm; full check "dotnet test"');
  assert.equal(repoValuesText({}), '');
  assert.equal(repoValuesText(undefined), '');
  assert.equal(startedNotice({ check: 'npm test' }), 'Started. Saved for this repo: full check "npm test".');
  assert.equal(startedNotice({}), 'Started.');
  assert.equal(startedNotice(undefined), 'Started.');
});

test('a sprint card carries a draft\'s proposal, and leaves it out when there is none', () => {
  const s = { id: 's1', name: 'Oct', draft: true, discarded: false, paused: false, finishedAt: null, autoMerge: false, maxParallel: 3, news: 0, tickets: [] };
  assert.deepEqual(sprintCard({ ...s, proposed: { commands: ['dotnet'], check: 'dotnet test' } }).proposed, { commands: ['dotnet'], check: 'dotnet test' });
  assert.equal('proposed' in sprintCard({ ...s, proposed: null }), false);
  assert.equal('proposed' in sprintCard(s), false);
});

test('a sprint card keeps whether its repo has a full check, and leaves it out when unknown', () => {
  const s = { id: 's1', name: 'Oct', draft: false, discarded: false, paused: false, finishedAt: null, autoMerge: false, maxParallel: 3, news: 0, tickets: [] };
  assert.equal(sprintCard({ ...s, check: false }).check, false);
  assert.equal('check' in sprintCard(s), false);
});
