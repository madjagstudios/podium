export const USAGE = 'Usage: /podium · /podium run <agent> <task> · /podium status · /podium cancel <job id>';

export function parseCommand(args) {
  const text = String(args ?? '').trim();
  if (!text) return { kind: 'open' };
  const [word, ...rest] = text.split(/\s+/);
  if (word === 'status') return { kind: 'status' };
  if (word === 'cancel') return rest[0] ? { kind: 'cancel', id: rest[0] } : { kind: 'usage', message: 'Usage: /podium cancel <job id>' };
  if (word === 'run') {
    const [agent, ...task] = rest;
    return agent && task.length ? { kind: 'run', agent, task: task.join(' ') } : { kind: 'usage', message: 'Usage: /podium run <agent> <task>' };
  }
  return { kind: 'usage', message: USAGE };
}
