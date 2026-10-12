# Podium

Podium is a mod for Claude Code. It lets Claude hand work to the other coding agents on your machine (Codex, Muse, Gemini, other Claude models, or any agent with a command line) and shows all of it in one pane inside Claude Code.

I built it because I was using several agents at once and losing track of them. I'd have one reviewing a branch in one terminal and another writing tests in a second, and I was copying results back into Claude by hand. With Podium I ask Claude in plain words, the agents run in the background, and the results come back to the chat when they finish.

## What it looks like

> **You:** have Codex review this branch, read only, and have Claude Sonnet add tests for the payout code

Claude starts two jobs. The pane lists them under **Working**, with a line saying what each agent is doing right now. You can keep talking to Claude while they run, and jobs keep going if you close the app.

When a job finishes, a short note lands in the chat and Claude sums up the result. A job that changed files moves to **Your turn**, where you open it, read the diff, and press **Keep changes** or **Throw away**.

## Install

You need Claude Code (desktop app or terminal), Node.js 22 or newer, git 2.28 or newer, and at least one other agent CLI, such as `codex`, `muse`, `gemini` or `claude`.

1. In Claude Code, run `/plugin marketplace add madjagstudios/plugins`.
2. Run `/plugin install podium@madjagstudios`.
3. Restart Claude Code and run `/podium`. A welcome card checks your setup and offers a small test job.

Updates arrive with Claude Code's plugin updates. To remove Podium, use **Settings → Remove Podium's data…**, then run `/plugin uninstall podium`.

## Your files stay yours

- An agent that may edit works in **a separate copy of your repo**, with its own sandbox switched on. Nothing touches your folder until you keep the changes.
- The copy starts from your last commit. Uncommitted work is invisible to the agent unless you tick **Include my uncommitted changes**.
- Reviews and questions run **read only**, in place.
- Every job shows its permission: Read only, Edit in a separate copy (the default), Agent's own settings, or Full access. The last two are opt-in, one job at a time.
- If the agent commits on a branch itself, those commits are the result, and Podium removes its copy.

## Pull requests

Ready work becomes a PR with **Open a PR instead**. Podium watches its checks, can merge it when they pass, and lets any agent review the PR or fix what failed.

## Sprints

For bigger work, ask Claude to plan a sprint across several tickets. Claude proposes which agent writes and which reviews each task, and the draft opens as a board in the pane, where you can change any of it before pressing **Start sprint**.

From there:

- Each ticket is worked task by task in its own copy, and a second agent reviews every task.
- A ticket without a plan is planned first, and you approve the plan.
- Writers report whether their tests passed. A ticket whose tests didn't pass stops and asks you, instead of going to review.
- Before a PR opens, Podium can run your repo's full check (for example `dotnet build && dotnet test`).
- Each ticket ends as one PR with a single `KEY: title` commit and a plain description.
- A ticket can wait for another ticket to merge first.

Per repo, **Settings → This repo** sets:

- which commands Claude may run in its copy;
- the full check;
- whether PRs are squashed to one commit;
- how they merge.

## Using it day to day

- Ask Claude in plain words, press **+ New job** in the pane, or run `/podium run <agent> <task>`.
- To change finished work, press **Ask for changes…** on its screen. The next step runs in the same copy, with whichever agent you pick.
- **Agents** in the pane shows what's installed, sets each agent's default permission, and adds any other command-line agent without editing files.
- **Settings → Instructions for every agent** is added to the start of every job's prompt, for example "Follow AGENTS.md".
- `/podium status` lists jobs, and `/podium cancel <id>` stops one.

## Developing

Point Claude Code at a checkout by adding `"env": { "CLAUDE_CODE_PLUGIN_DIRS": "/absolute/path/to/podium" }` to `~/.claude/settings.json`, then restart. A dev folder overrides an installed copy.

Tests:

- `npm test` runs the engine and logic tests.
- `claude plugin test .` runs the pane tests.
- `claude plugin validate .` checks the mod.

Podium has no dependencies.

## Credits

Podium's adapter approach was informed by [hex/claude-council](https://github.com/hex/claude-council), and its job commands by [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc).

Podium is built with AI coding agents, many of its own jobs included, and reviewed by me.

## License

MIT. See [LICENSE](LICENSE).
