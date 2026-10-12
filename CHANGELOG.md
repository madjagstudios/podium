# Changelog

Each section is what Podium shows under "What's new" after an update.

## 0.4.0

- A new sprint opens as a draft on a board in the pane. There you can change who writes and reviews each task, the order of the tickets, Merge when green and how many tickets run at once, and then press Start or ask Claude to start it.
- Open a ticket from the sprint board to see its tasks and why it stopped. From there you can retry it, give it to another agent, inspect its steps and diff, or stop it. Pause and resume a sprint from its card.
- A sprint Podium can't read shows as a card saying so, instead of disappearing.
- A sprint ticket needs no plan: its writer plans it first, Claude sums the plan up, and the board shows its tasks with Approve and Ask for changes. A plan with no tasks can run as one task.
- A ticket can wait for others in its sprint: it starts once they are merged, from the code as merged on GitHub, and says what it waits for.
- A clearer pane. Every screen leads with one line saying where things stand and one main button, and the detail sits in folds. Rows and screen heads are coloured by state again.
- Finished sprints stay listed: yours under Done, other chats' under Other chats. A sprint started in another chat says so.
- Per-repo settings: the commands Claude may run in its copy (for example `dotnet`), a full check to run before each PR, whether a ticket's PR is squashed to one commit, and the merge method. Sprint drafts can propose commands and a full check; Start saves those settings.
- Writers end with the result of their tests, and a ticket whose tests didn't pass stops before review. Reviewers see the writer's report.
- A sprint's PR is one clean `KEY: title` commit, its description is the ticket's text and what changed, and it merges the way the repo merges.
- Each notice arrives once, in the chat that started the work. A sprint's news goes to its own chat, and **Take them here** moves it to another one if that chat is gone.
- The board says how many tickets are running and which are waiting for a free slot.

## 0.3.0

- Sprints (first part): Claude starts a sprint of planned tickets; agents work them task by task with a reviewer agent between tasks, and each ticket ends as a PR you merge.
- The pane shows each sprint as one card; ask Claude to pause, resume, retry or stop.

## 0.2.0

- Open PR turns ready work into a pull request; Podium watches its checks and can merge it when they pass.
- Review with… has another agent review a PR read-only; post its review to the PR in one press.
- When CI fails or reviewers comment, send it back to the agent with the details filled in, then Push to PR.
- Instructions for every agent: set once in Settings, added to every job's prompt.
- The desktop pane responds on the first click, never loses a press, and updates by itself: times move and finished jobs appear without a click.
- Clearer pane: every action is an outlined button, fields have boxes, and repeated steps collapse into one row.

## 0.1.0

- Hand work to Codex, Muse, Gemini, other Claude models or any agent CLI, and follow it in one pane.
- Edits happen in a separate copy: review the changes, then keep or throw them away.
- Ask for changes: continue finished work in the same copy, with any agent.
- Each chat shows its own work; Done tidies itself, and Clear empties it.
- A welcome check on first run, and Settings → Remove Podium's data.
