// Calls the `podium` engine CLI through the mod's $.process.run.
// No Node imports: hooks modules run without Node, so `run` is injected.

export function engineArgv(root, args) {
  return ['node', `${root}/bin/podium.js`, ...args];
}

export async function callEngine(run, root, args, { stdin, timeoutMs = 120_000 } = {}) {
  let r;
  try {
    r = await run(engineArgv(root, args), { stdin, timeoutMs });
  } catch (e) {
    return { ok: false, error: { code: 'node-missing', message: `Podium couldn't start its engine. It needs Node.js 22 or newer on PATH. (${String(e?.message ?? e).slice(0, 200)})` } };
  }
  const lines = String(r.stdout ?? '').trim().split(/\r?\n/);
  try {
    const body = JSON.parse(lines[lines.length - 1]);
    return body && body.error ? { ok: false, error: body.error } : { ok: true, value: body };
  } catch {
    const detail = String(r.stderr ?? '').trim().slice(0, 300);
    return { ok: false, error: { code: 'engine-unreadable', message: `Podium's engine gave an unreadable answer (exit ${r.exitCode}).${detail ? ` ${detail}` : ''}` } };
  }
}
