import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { atLeast, changelogSection, doctor, markWelcomed, versionInfo, markSeen } from '../engine/doctor.js';
import { setSetting } from '../engine/settings.js';
import { tempRoot } from './helpers.js';

function fakePlugin(version, changelog = null) {
  const dir = tempRoot();
  fs.mkdirSync(path.join(dir, '.claude-plugin'));
  fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'podium', version }));
  if (changelog) fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), changelog);
  return dir;
}

test('atLeast compares dotted versions', () => {
  assert.equal(atLeast('22.3.0', '22'), true);
  assert.equal(atLeast('20.11.1', '22'), false);
  assert.equal(atLeast('2.45.1', '2.28'), true);
  assert.equal(atLeast('2.27.9', '2.28'), false);
});

test('changelogSection finds a version heading and stops at the next', () => {
  const text = '# Changelog\n\n## 0.2.0 — 2026-11-01\n\n- Follow-ups\n- Sprints\n\n## 0.1.0\n\n- First release\n';
  assert.equal(changelogSection(text, '0.2.0'), '- Follow-ups\n- Sprints');
  assert.equal(changelogSection(text, '0.1.0'), '- First release');
  assert.equal(changelogSection(text, '0.3.0'), null);
});

test('doctor reports node, git, settings and the welcome record', async () => {
  const root = tempRoot();
  const report = await doctor(root);
  assert.equal(report.node.ok, true);
  assert.equal(report.git.ok, true);
  assert.equal(typeof report.gh.installed, 'boolean');
  assert.equal(report.tellClaude, true);
  assert.equal(report.welcomed, false);
  setSetting(root, 'tellClaudeWhenDone', false);
  markWelcomed(root);
  const again = await doctor(root);
  assert.equal(again.tellClaude, false);
  assert.equal(again.welcomed, true);
});

test('versionInfo notices a new version once one has been seen before', () => {
  const root = tempRoot();
  const v1 = fakePlugin('0.1.0');
  assert.deepEqual(versionInfo(root, v1), { version: '0.1.0', previous: null, notes: null });
  markSeen(root, v1);
  const v2 = fakePlugin('0.2.0', '## 0.2.0\n\n- Sprints\n');
  assert.deepEqual(versionInfo(root, v2), { version: '0.2.0', previous: '0.1.0', notes: '- Sprints' });
  markSeen(root, v2);
  assert.equal(versionInfo(root, v2).previous, '0.2.0');
});
