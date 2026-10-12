import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { standingText, withInstructions } from '../engine/instructions.js';
import { setSetting } from '../engine/settings.js';
import { saveAdapter } from '../engine/adapters/registry.js';
import { dispatch } from '../engine/dispatch.js';
import { readJob } from '../engine/store.js';
import { projectKey } from '../engine/paths.js';
import { tempRoot, tempRepo, fakeAdapter, waitFor } from './helpers.js';

test('standing text joins global and per-repo instructions', () => {
  assert.equal(standingText({ instructions: '', repoInstructions: {} }, 'p'), '');
  assert.equal(standingText({ instructions: 'Global.', repoInstructions: { p: 'Repo.' } }, 'p'), 'Global.\n\nRepo.');
  assert.equal(standingText({ instructions: 'Global.', repoInstructions: { q: 'Other.' } }, 'p'), 'Global.');
  assert.equal(withInstructions('Do it.', ''), 'Do it.');
  assert.match(withInstructions('Do it.', 'Follow AGENTS.md.'), /^Standing instructions from the user:\nFollow AGENTS\.md\.\n\n---\n\nDo it\.$/);
});

test('every job prompt starts with the standing instructions; the title stays the task', async () => {
  const root = tempRoot();
  saveAdapter(root, fakeAdapter('ok'));
  const repo = tempRepo();
  setSetting(root, 'instructions', 'Follow AGENTS.md.');
  setSetting(root, 'repoInstructions', { [projectKey(repo)]: 'Use the studio skills.' });
  const res = await dispatch(root, { agent: 'fake', permission: 'read-only', cwd: repo, prompt: 'Say hi' });
  await waitFor(() => ['done', 'failed'].includes(readJob(res.dir).status));
  const prompt = fs.readFileSync(path.join(res.dir, 'prompt.md'), 'utf8');
  assert.match(prompt, /Follow AGENTS\.md\.\n\nUse the studio skills\.[\s\S]*---\n\nSay hi$/);
  assert.equal(readJob(res.dir).title, 'Say hi');
});

test('a follow-up brief starts with the standing instructions too', async () => {
  const root = tempRoot();
  saveAdapter(root, fakeAdapter('edit'));
  const repo = tempRepo();
  const first = await dispatch(root, { agent: 'fake', permission: 'edit-worktree', cwd: repo, prompt: 'First' });
  const done = await waitFor(() => { const j = readJob(first.dir); return ['needs-review', 'done', 'failed'].includes(j.status) && j; });
  setSetting(root, 'instructions', 'Follow AGENTS.md.');
  const next = await dispatch(root, { agent: 'fake', cwd: repo, prompt: 'Second', followUp: done.id });
  assert.match(fs.readFileSync(path.join(next.dir, 'prompt-brief.md'), 'utf8'), /^Standing instructions from the user:\nFollow AGENTS\.md\./);
  await waitFor(() => ['needs-review', 'done', 'failed'].includes(readJob(next.dir).status));
});
