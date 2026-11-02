import fs from 'node:fs';
import { dataDir, projectKey, projectHere } from './paths.js';
import { PodiumError } from './errors.js';
import { listAgents } from './discover.js';
import { preflight, dispatch } from './dispatch.js';
import { status, result, saveSummary } from './status.js';
import { changes } from './changes.js';
import { cancel } from './cancel.js';
import { keep, discard } from './review.js';
import { markDelivered, setOutcome } from './outcome.js';
import { claimDelivery, releaseDelivery, refreshDelivery } from './delivery.js';
import { repairMuseSandbox } from './repair.js';
import { prune } from './retention.js';
import { loadSettings, setSetting, repoSettings } from './settings.js';
import { getAdapter, saveAdapter } from './adapters/registry.js';
import { doctor, markWelcomed, versionInfo, markSeen } from './doctor.js';
import { removalPlan, uninstall } from './uninstall.js';
import { openPr, pushPr, refreshPr, mergePr, setAutoMerge, watchAgain, postReview, fixPrompt, browsePr, flushSprintNews } from './pr.js';
import { ensureWatch } from './pr-watch.js';
import { suggestAdapter, testAdapter } from './adapters/admin.js';
import { draftSprint, startSprint, discardSprint, sprintSummaries, sprintSummary, PANE_FINISHED, setPaused, retryTicket, addNote, acceptTests, reviewWithEvidence, stopTicket, syncTicket, answerCommits, assignTask, moveTicket, removeTicket, assignTicket, setAfter, setSprintOptions, claimMessages, markMessages, refreshMessages, archiveEnded, approvePlan, revisePlan, draftNotes, baseNotes, adoptSprint } from './sprint.js';
import { repoCiNotes } from './ci-steps.js';
import { ensureSprints } from './sprint-run.js';

const COMMANDS = 'agents, preflight, dispatch, status, result, cancel, keep, discard, claim, release, deliver, outcome, summary, changes, prune, settings, adapter, repair, doctor, welcome, version, uninstall, here, pr, sprint, data-dir';

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const positional = [];
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith('--')) {
      const next = rest[i + 1];
      if (next === undefined || next.startsWith('--')) opts[arg.slice(2)] = true;
      else { opts[arg.slice(2)] = next; i++; }
    } else {
      positional.push(arg);
    }
  }
  return { command, positional, opts };
}

async function readAll(stream) {
  let text = '';
  stream.setEncoding?.('utf8');
  for await (const chunk of stream) text += chunk;
  return text;
}

// After a change that succeeded, make sure a runner is working. If it cannot be started the change still
// happened, so the command still says so; the pane asks for a runner again about once a minute.
function keepRunning(root, spawn) {
  try { ensureSprints(root, { spawn }); } catch { /* the change stands; the next ensure starts the runner */ }
}

export async function main(argv, { stdout = process.stdout, stdin = process.stdin, env = process.env, cwd = process.cwd(), spawn } = {}) {
  const root = dataDir(env);
  const { command, positional, opts } = parseArgs(argv);
  const need = (key) => {
    if (opts[key] === undefined || opts[key] === true) throw new PodiumError('missing-option', `Missing --${key}.`);
    return opts[key];
  };
  const prompt = async () => {
    if (opts['prompt-file']) return fs.readFileSync(opts['prompt-file'], 'utf8');
    if (opts.prompt === '-') return readAll(stdin);
    return need('prompt');
  };
  try {
    let out;
    switch (command) {
      case 'agents': out = await listAgents(root); break;
      case 'preflight': out = await preflight(root, { agent: need('agent'), permission: opts.permission, model: opts.model, cwd: opts.cwd ?? cwd }); break;
      case 'dispatch': out = await dispatch(root, { agent: need('agent'), permission: opts.permission, model: opts.model ?? null, ticket: opts.ticket ?? null, cwd: opts.cwd ?? cwd, prompt: await prompt(), includeUncommitted: opts['include-uncommitted'] === true, base: opts.base ?? null, session: opts.session ?? null, followUp: opts['follow-up'] ?? null, review: opts.pr ?? null, env }); break;
      case 'status': {
        const project = opts.here === true ? projectHere(opts.cwd ?? cwd) : opts.project;
        out = { jobs: status(root, { project, ticket: opts.ticket, id: opts.id }) };
        // The pane draws sprints from the same call.
        if (opts.here === true) {
          // PR news a sprint couldn't take when its PR ended goes to it now, before it is read.
          await flushSprintNews(root, { project }).catch(() => 0);
          // The newest finished sprints stay listed after they are archived, this chat's (`--session`) and
          // other chats' for Done and Other chats; `olderFinished` ({ mine, others }) counts the ones beyond them exactly.
          const counts = {};
          const session = typeof opts.session === 'string' ? opts.session : null;
          // The open board's or ticket's sprint: listed even when it archived behind newer finished ones.
          const sprint = typeof opts.sprint === 'string' ? opts.sprint : null;
          out.sprints = sprintSummaries(root, { project, finished: PANE_FINISHED, session, sprint, counts });
          out.olderFinished = counts.olderFinished ?? { mine: 0, others: 0 };
          await archiveEnded(root, out.sprints);
        }
        break;
      }
      case 'result': out = result(root, need('id'), { full: opts.full === true }); break;
      case 'changes': out = await changes(root, need('id'), { full: opts.full === true }); break;
      case 'cancel': out = { job: await cancel(root, need('id')) }; break;
      case 'keep': out = { job: await keep(root, need('id')) }; break;
      case 'discard': out = { job: await discard(root, need('id')) }; break;
      // --refresh: the holder keeps its lock fresh while its submit waits.
      case 'claim': out = opts.refresh === true ? refreshDelivery(root, need('id'), need('session')) : claimDelivery(root, need('id'), need('session')); break;
      case 'release': out = releaseDelivery(root, need('id')); break;
      case 'deliver': out = { job: markDelivered(root, need('id')) }; break;
      case 'outcome': out = { job: setOutcome(root, need('id'), need('value'), opts.source ?? 'user') }; break;
      case 'summary': out = { job: saveSummary(root, need('id'), opts.text === '-' ? await readAll(stdin) : need('text')) }; break;
      case 'prune': out = prune(root); break;
      case 'settings':
        out = positional[0] === 'set' ? setSetting(root, need('key'), JSON.parse(need('value'))) : loadSettings(root);
        break;
      case 'adapter': {
        const sub = positional[0];
        if (sub === 'suggest') out = await suggestAdapter(need('command'));
        else if (sub === 'save') out = { adapter: saveAdapter(root, JSON.parse(opts.json === '-' ? await readAll(stdin) : fs.readFileSync(need('file'), 'utf8'))) };
        else if (sub === 'test') out = await testAdapter(getAdapter(root, need('name')), { permission: opts.permission ?? 'read-only' });
        else throw new PodiumError('unknown-command', 'Use: podium adapter suggest | save | test');
        break;
      }
      case 'repair':
        if (need('what') !== 'muse-sandbox') throw new PodiumError('unknown-repair', 'Podium can only repair "muse-sandbox".');
        out = await repairMuseSandbox();
        break;
      case 'doctor': out = await doctor(root); break;
      case 'welcome': out = opts.done === true ? markWelcomed(root) : { welcomed: fs.existsSync(`${root}/welcome.json`) }; break;
      case 'version': out = opts.seen === true ? markSeen(root) : versionInfo(root); break;
      case 'uninstall': out = opts.yes === true ? await uninstall(root) : removalPlan(root); break;
      case 'here': out = { project: projectKey(opts.cwd ?? cwd) }; break;
      case 'pr': {
        const sub = positional[0];
        if (sub === 'open') out = { job: await openPr(root, need('id'), { env, watch: true }) };
        else if (sub === 'push') out = { job: await pushPr(root, need('id')) };
        else if (sub === 'refresh') out = { job: await refreshPr(root, need('id'), { env }) };
        else if (sub === 'merge') out = { job: await mergePr(root, need('id'), { env }) };
        else if (sub === 'auto') out = { job: await setAutoMerge(root, need('id'), need('on') === 'true') };
        else if (sub === 'watch') out = ensureWatch(root);
        else if (sub === 'post') out = { job: await postReview(root, need('id'), { env }) };
        else if (sub === 'fix') out = await fixPrompt(root, need('id'), need('kind'), { env });
        else if (sub === 'watch-again') { out = { job: await watchAgain(root, need('id')) }; ensureWatch(root); }
        else if (sub === 'browse') out = await browsePr(root, need('id'), { env });
        else throw new PodiumError('unknown-command', 'Use: podium pr open | push | refresh | merge | auto | fix | post | watch | browse');
        // A merge may let a sprint ticket waiting for this one ("after") start, and a close parks it: wake its runner now,
        // not at the pane's next minute check (a closed PR drops out of the watcher's checks, so nothing else would).
        if ((sub === 'refresh' || sub === 'merge') && ['merged', 'closed'].includes(out.job?.status)) keepRunning(root, spawn);
        break;
      }
      case 'sprint': {
        const sub = positional[0];
        const one = (s) => ({ sprint: sprintSummary(root, s) });
        if (sub === 'draft') {
          // A new sprint is always a draft: nothing runs until Start.
          const input = JSON.parse(await readAll(stdin));
          const made = await draftSprint(root, input, { cwd: opts.cwd ?? cwd, session: opts.session ?? null });
          const settings = loadSettings(root);
          // The check that will apply: the draft's proposal when it makes one (an empty one removes the
          // check, so there is nothing to cover), else the repo's saved check.
          const proposedCheck = made.proposed?.check;
          const check = proposedCheck !== undefined ? (proposedCheck || null) : repoSettings(settings, made.project).check;
          const ci = await repoCiNotes(made.repo, settings, made.project, { env, check }).catch(() => []);
          // What the draft proposed for the repo: saved only when the person presses Start.
          out = { ...one(made), notes: [...draftNotes(made, settings), ...(await baseNotes(made).catch(() => [])), ...ci], proposed: made.proposed ?? {} };
        } else if (sub === 'start') {
          const started = await startSprint(root, need('id'));
          // What Start saved for the repo from the draft's proposal, so the reply can say so.
          out = { ...one(started), applied: started.applied ?? {} };
          keepRunning(root, spawn);
        } else if (sub === 'discard') {
          out = one(await discardSprint(root, need('id')));
        } else if (sub === 'status') {
          const project = opts.here === true ? projectHere(opts.cwd ?? cwd) : undefined;
          // One sprint asked for by id is shown even when archived.
          out = { sprints: sprintSummaries(root, { project, includeArchived: Boolean(opts.id), id: opts.id === undefined ? null : need('id') }) };
          await archiveEnded(root, out.sprints);
        } else if (sub === 'pause' || sub === 'resume') {
          out = one(await setPaused(root, need('id'), sub === 'pause'));
          if (sub === 'resume') keepRunning(root, spawn);
        } else if (sub === 'retry') {
          // A note for the ticket's agents comes on stdin (--note -), as a plan's notes do.
          const note = opts.note === undefined ? null : opts.note === '-' ? await readAll(stdin) : need('note');
          const s = await retryTicket(root, need('id'), need('ticket'), { agent: opts.agent ?? null, note });
          const t = s.tickets.find((x) => x.key === String(opts.ticket).toUpperCase());
          // Whether the retry carried a note, so the caller can tell the person rather than assume it.
          const added = String(note ?? '').trim() ? t.notes.at(-1) : null;
          out = { ...one(s), retried: { key: t.key, note: added ? { n: added.n, chars: added.text.length } : null } };
          keepRunning(root, spawn);
        } else if (sub === 'evidence') {
          // Review again with evidence: the person's words, on stdin.
          const text = opts.text === '-' ? await readAll(stdin) : need('text');
          out = one(await reviewWithEvidence(root, need('id'), need('ticket'), text));
          keepRunning(root, spawn);
        } else if (sub === 'accept') {
          // Accept and continue: the person's reason, on stdin.
          const text = opts.text === '-' ? await readAll(stdin) : need('text');
          out = one(await acceptTests(root, need('id'), need('ticket'), text));
          keepRunning(root, spawn);
        } else if (sub === 'note') {
          const text = opts.text === '-' ? await readAll(stdin) : need('text');
          const s = await addNote(root, need('id'), need('ticket'), text);
          const t = s.tickets.find((x) => x.key === String(opts.ticket).toUpperCase());
          // A step running now doesn't see it: the reply says it applies from the next one. A step being started (dispatching,
          // saved before its job; a runner that died there leaves it) may be running already, so it counts too.
          out = { ...one(s), noted: { key: t.key, n: t.notes.at(-1).n, running: t.state === 'running' || Boolean(t.dispatching) } };
        } else if (sub === 'sync') {
          // The base as the remote has it now, merged into the ticket's copy.
          const r = await syncTicket(root, need('id'), need('ticket'));
          out = { ...one(r.sprint), commits: r.commits, saved: r.saved ?? null };
          keepRunning(root, spawn);
        } else if (sub === 'commits') {
          // The answer about commits in a ticket's copy that Podium didn't make: --answer keep or drop.
          const answer = need('answer');
          if (!['keep', 'drop'].includes(answer)) throw new PodiumError('bad-value', 'Answer keep or drop.');
          const r = await answerCommits(root, need('id'), need('ticket'), { keep: answer === 'keep' });
          out = { ...one(r.sprint), dropped: r.dropped, saved: r.saved ?? null };
          keepRunning(root, spawn);
        } else if (sub === 'stop') {
          out = one(await stopTicket(root, need('id'), need('ticket')));
          // A ticket waiting for the stopped one ("after") parks on the runner's next tick.
          keepRunning(root, spawn);
        } else if (sub === 'assign') {
          const who = { agent: opts.agent ?? null, reviewer: opts.reviewer ?? null };
          // Without --task: every task of a draft ticket (the draft board's "for every task").
          out = one(opts.task === undefined
            ? await assignTicket(root, need('id'), need('ticket'), who)
            : await assignTask(root, need('id'), need('ticket'), Number(need('task')), who));
        } else if (sub === 'move') {
          out = one(await moveTicket(root, need('id'), need('ticket'), need('to')));
        } else if (sub === 'remove') {
          out = one(await removeTicket(root, need('id'), need('ticket')));
        } else if (sub === 'options') {
          const on = (v) => (v === undefined ? undefined : v === true || v === 'true' || v === 'on');
          // need() refuses a bare --at-once or --extra-rounds, which would otherwise read as 1.
          const value = (name) => (opts[name] === undefined ? undefined : need(name));
          out = one(await setSprintOptions(root, need('id'), { mergeWhenGreen: on(opts['merge-when-green']), atOnce: value('at-once'), extraRounds: value('extra-rounds') }));
        } else if (sub === 'after') {
          // A draft ticket's "after": --keys A,B (or none), --add KEY, --drop KEY.
          const keys = opts.keys === undefined ? null : need('keys') === 'none' ? [] : String(opts.keys).split(',').map((k) => k.trim()).filter(Boolean);
          out = one(await setAfter(root, need('id'), need('ticket'), {
            keys, add: opts.add === undefined ? null : need('add'), drop: opts.drop === undefined ? null : need('drop'),
          }));
        } else if (sub === 'approve' || sub === 'one-task') {
          // A plan waiting for the person: its tasks, or the whole plan as one task. --acknowledge: the person agreed to the
          // production commands it runs.
          out = one(await approvePlan(root, need('id'), need('ticket'), { whole: sub === 'one-task', acknowledge: opts.acknowledge === true }));
          keepRunning(root, spawn);
        } else if (sub === 'revise') {
          const text = opts.text === '-' ? await readAll(stdin) : need('text');
          out = one(await revisePlan(root, need('id'), need('ticket'), text));
          keepRunning(root, spawn);
        } else if (sub === 'ensure') out = ensureSprints(root, { spawn });
        else if (sub === 'inbox') out = await claimMessages(root, need('session'), { project: opts.here === true ? projectHere(opts.cwd ?? cwd) : undefined, instance: opts.instance === undefined ? null : need('instance') });
        else if (sub === 'delivered') out = await markMessages(root, String(need('ids')).split(','));
        // A chat still sending claimed news renews its claims.
        else if (sub === 'refresh') out = refreshMessages(root, need('session'), String(need('ids')).split(','), { instance: opts.instance === undefined ? null : need('instance') });
        // "Take them here": the sprint's news goes to this chat from now on.
        // Only a sprint of the repo it is run in (always checked, whether or not --here was passed).
        else if (sub === 'adopt') out = one(await adoptSprint(root, need('id'), need('session'), { project: projectHere(opts.cwd ?? cwd) }));
        else throw new PodiumError('unknown-command', 'Use: podium sprint draft | start | discard | status | pause | resume | retry | note | accept | evidence | sync | commits | stop | assign | move | remove | options | after | approve | one-task | revise | ensure | inbox | delivered | refresh | adopt');
        break;
      }
      case 'data-dir': out = { dataDir: root }; break;
      default: throw new PodiumError('unknown-command', `Unknown command "${command ?? ''}". Commands: ${COMMANDS}.`);
    }
    stdout.write(JSON.stringify(out) + '\n');
    return 0;
  } catch (e) {
    // Full Git output is for engine diagnostics; keep the CLI's existing concise error shape.
    const error = e instanceof PodiumError
      ? { code: e.code, message: e.message, details: e.code === 'git-failed' ? null : e.details ?? null }
      : { code: 'internal', message: e.message, details: null };
    stdout.write(JSON.stringify({ error }) + '\n');
    return 1;
  }
}
