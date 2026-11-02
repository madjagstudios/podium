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

test('the This repo fold names the repo\'s plans folder when one is set', () => {
  assert.equal(repoSummary({ repoPlanDir: { repo: 'docs/custom/plans' } }, 'repo'), 'plans in docs/custom/plans');
  assert.equal(repoSummary({ repoCommands: { repo: ['dotnet'] }, repoCheck: { repo: 'dotnet test' }, repoPlanDir: { repo: 'docs/x' } }, 'repo'), 'dotnet · full check set · plans in docs/x');
  assert.equal(repoSummary({ repoPlanDir: { repo: 'docs/x/' } }, 'repo'), 'plans in docs/x');
  assert.equal(repoSummary({ repoPlanDir: { other: 'docs/x' } }, 'repo'), 'nothing set');
  assert.equal(repoSummary({ repoPlanDir: { repo: 42 } }, 'repo'), 'nothing set');
  assert.equal(repoSummary({ repoPlanDir: { repo: '' } }, 'repo'), 'nothing set');
  assert.equal(repoSummary({ repoPlanDir: { repo: '   ' } }, 'repo'), 'nothing set');
  assert.equal(repoSummary({ repoPlanDir: 'docs/x' }, 'repo'), 'nothing set');
});

test('a draft\'s proposed plans folder: a short fold heading and exact words', () => {
  assert.equal(proposedSummary({ planDir: 'docs/custom/plans' }), 'plans folder');
  assert.equal(proposedSummary({ commands: ['dotnet'], check: 'npm test', planDir: 'docs/x' }), 'dotnet · full check · plans folder');
  assert.equal(proposedSummary({ planDir: '' }), 'default plans folder');
  assert.equal(repoValuesText({ planDir: 'docs/custom/plans' }), 'plans folder "docs/custom/plans"');
  assert.equal(repoValuesText({ commands: ['dotnet'], planDir: 'docs/x' }), 'commands dotnet; plans folder "docs/x"');
  assert.equal(repoValuesText({ planDir: '' }), 'default plans folder');
  assert.equal(startedNotice({ planDir: 'docs/x' }), 'Started. Saved for this repo: plans folder "docs/x".');
});

test('keeping plans in PRs: in the This repo fold only when truly on, a draft\'s proposal and Start\'s sentence', () => {
  assert.equal(repoSummary({ repoKeepPlan: { repo: true } }, 'repo'), 'plans kept in PRs');
  assert.equal(repoSummary({ repoKeepPlan: { repo: 'true' } }, 'repo'), 'nothing set');
  assert.equal(repoSummary({ repoKeepPlan: { repo: false } }, 'repo'), 'nothing set');
  assert.equal(repoSummary({ repoKeepPlan: { other: true } }, 'repo'), 'nothing set');
  assert.equal(repoSummary({ repoPlanDir: { repo: 'docs/x' }, repoKeepPlan: { repo: true } }, 'repo'), 'plans in docs/x · plans kept in PRs');
  assert.equal(proposedSummary({ keepPlan: true }), 'plans in PRs');
  assert.equal(proposedSummary({ keepPlan: false }), 'plans left out of PRs');
  assert.equal(proposedSummary({ planDir: 'docs/x', keepPlan: true }), 'plans folder · plans in PRs');
  assert.equal(repoValuesText({ keepPlan: true }), 'plans kept in PRs');
  assert.equal(repoValuesText({ keepPlan: false }), 'plans left out of PRs');
  assert.equal(startedNotice({ keepPlan: true }), 'Started. Saved for this repo: plans kept in PRs.');
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
  // A started sprint names the commit its copies start from, before what Start saved.
  const s = { base: 'main', startedFrom: { commit: '1ecac46aaaabbbbccccdddd', remote: 'origin', checked: true } };
  assert.equal(startedNotice({}, s), 'Started. Copies start from main at 1ecac46 (checked against origin/main at Start).');
  assert.equal(startedNotice({ check: 'npm test' }, s), 'Started. Copies start from main at 1ecac46 (checked against origin/main at Start). Saved for this repo: full check "npm test".');
  assert.equal(startedNotice({}, { base: 'main' }), 'Started.');
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

test('the repo\'s task test: in the This repo fold, a draft\'s proposal and Start\'s sentence', () => {
  assert.equal(repoSummary({ repoTaskTest: { repo: 'npm test' } }, 'repo'), 'task test set');
  assert.equal(repoSummary({ repoTaskTest: { repo: 7 } }, 'repo'), 'nothing set');
  assert.equal(proposedSummary({ check: 'npm run all', taskTest: 'npm test' }), 'full check · task test');
  assert.equal(proposedSummary({ taskTest: '' }), 'no task test');
  assert.equal(repoValuesText({ taskTest: 'npm test' }), 'task test "npm test"');
  assert.equal(startedNotice({ taskTest: '' }), 'Started. Saved for this repo: no task test.');
});
