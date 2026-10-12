import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, USAGE } from '../mod/commands.js';

test('/podium forms', () => {
  assert.deepEqual(parseCommand(''), { kind: 'open' });
  assert.deepEqual(parseCommand('  status '), { kind: 'status' });
  assert.deepEqual(parseCommand('cancel 2026-abc'), { kind: 'cancel', id: '2026-abc' });
  assert.deepEqual(parseCommand('run codex review   the branch'), { kind: 'run', agent: 'codex', task: 'review the branch' });
  assert.deepEqual(parseCommand('run codex'), { kind: 'usage', message: 'Usage: /podium run <agent> <task>' });
  assert.deepEqual(parseCommand('cancel'), { kind: 'usage', message: 'Usage: /podium cancel <job id>' });
  assert.deepEqual(parseCommand('dance'), { kind: 'usage', message: USAGE });
});
