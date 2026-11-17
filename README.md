# pi-taskforce

A [pi](https://pi.dev) extension for TODO lists, subagents, and user questions.

Agents write TODO lists as plain Markdown files with their normal file tools.
There are no task tools or database.
The `delegate` tool starts subagents as separate `pi` processes.
Each subagent sends its questions to its parent agent.
The parent answers the question or asks the user.

Background reports and questions do not interrupt the current run.
They arrive after the run and start a new turn only when the agent is idle.
The extension does not remind agents about TODO lists or unanswered questions.

## Install

```bash
pi install git:github.com/jandrikus/pi-taskforce
```

Use `@` to pin a tag or commit, for example `pi install git:github.com/jandrikus/pi-taskforce@v0.1.0`.
The extension is available through Git only, not npm.
For local development, use `pi install ./` or `pi -e ./extensions/index.ts`.

pi clones the repository and installs the dependencies from `package.json`.
It uses the package manager selected by its `npmCommand` setting.
npm, pnpm, and bun are supported.
The extension does not depend on how you installed pi or which runtime starts it.
Every subagent automatically loads pi-taskforce.
You do not need to add it to the subagent's extension list.

## TODO lists

Each session stores its TODO lists in `~/.pi/agent/todos/<project>/<session>/`.
This path follows pi's session storage layout:

- `<project>` is the encoded project path, such as `--home-u-dev-x--`.
- `<session>` is the transcript file name without `.jsonl`, such as `2026-11-08T18-03-03-307Z_01a1bc53-…`.

The transcript at `~/.pi/agent/sessions/<project>/<session>.jsonl` and its TODO directory use the same project and session names.
Set `PI_CODING_AGENT_DIR` or `todos.dir` to change the base location.

`/new` starts a session without TODO lists.
`/resume` restores access to the selected session's lists.
`/new-keep` starts a new session with a copy of the current session's open lists.
`/fork` and `/clone` also copy open lists because they copy the conversation that used them.
Each copy is independent.
Changes in one session do not change the other session's files.

Use one file for each piece of work.
Name it `YYYY-MM-DD-<slug>.md`:

```markdown
# Rewrite the parser

- [x] Read the existing loader
- [ ] Sketch the grammar
  Note under the item it belongs to.
- [ ] Wire it up
```

The root agent's system prompt includes the TODO directory and these file conventions.
This prompt block does not list individual files.
It stays unchanged during the session to preserve prompt caching.
Completed lists remain in the directory as a record of the work.
When an agent resumes earlier work, it lists the directory and continues the matching file.

A directory watcher reads the lists again after any change.
It detects changes from the agent's `edit` tool, a `bash` command, your editor, or a file sync tool.
It skips hidden files, including hidden temporary files from sync tools.
A `.sync-conflict-*.md` copy appears as another list, so you can identify and merge the conflict.

The widget above the input shows up to three open lists.
It shows the most recently changed list first and uses the format `title done/total · next item`.
The widget is read-only and disappears when there are no open lists.

Subagents do not keep TODO lists.
They report their results in their last message.

## Subagents

Use `delegate` to start any type of subagent:

```ts
delegate({
  type: "scout",
  goal: "Find the authentication entry points. Don't change files.",
})
```

Only `goal` is required.
If you omit `type`, the tool selects `general`.
This type has a built-in definition that you can override or disable with YAML.

### Agent definitions

Each agent type has one YAML file in `~/.pi/agents` or `<project>/.pi/agents`.
Project definitions override user definitions with the same name.
To share agent files with other tools, add their directories to `subagents.agentDirs`.
These directories load before `~/.pi/agents`.
A definition in `~/.pi/agents` therefore overrides a shared definition with the same name.

The extension reads project definitions and `<project>/.pi/pi-taskforce.json` only when you explicitly trust the project through one of these methods:

- Start pi with `--approve`.
- Save a trust decision with `/trust` for the project directory or an ancestor directory.
- Set `defaultProjectTrust: "always"`.

A project definition can load executable extension code into a child process.
The trust requirement prevents a cloned repository from loading that code without approval.
The extension cannot detect a "this session only" trust decision because it loads before pi asks for that decision.
If the extension skips project files, a warning identifies them.

```yaml
name: scout                       # type identifier: letters, digits, - and _
label: Scout                      # required
promptSnippet: Map an unfamiliar part of the codebase and report what is where
promptGuidelines:
  - Use scout before touching code you have not read, not to answer questions you can answer yourself.
taskTemplate: |
  {goal}
  Report what is where, and say what you did not look at.
tools: [read, grep, find, ls]     # pi's own tools; empty or absent means unrestricted
model: ""                         # exact provider/id; empty runs on the parent's current model
subagents: none                   # or a list of types; absent means all of them
fork: false                       # per-agent defaults for the three controls
background: true
thinking: medium                  # empty runs at the parent's current level
silenceTimeoutMs: 600000
timeoutMs: 0                      # 0 means no wall-clock limit
extensions: []                    # extra extensions for the child; pi-taskforce is always loaded
identity: ""                      # replaces pi's opening identity paragraph
appendSystemPrompt: ""
includeParentAppendSystemPrompt: true
piDocs: false
```

### Models and prompts

Set `model` to an exact `provider/id` from `pi --list-models`.
The extension does not use approximate matching.
At session start, it checks each pinned model against pi's model list and available credentials.
If a check fails, a warning and the subagent panel identify the model.
That agent type uses the parent's model until you fix the configuration.

A child without a valid pinned model uses the parent's current model at launch, including its provider.
A child without a `thinking` setting uses the parent's current thinking level.

The delegate result and every report state the child's launch model and thinking level, for example `on deepseek/deepseek-flash at thinking level low`.
A child that starts with a fresh context also receives this information in its first prompt.
Neither agent needs to inspect the environment to identify the model or detect a fallback.
A forked child inherits the parent's prompt and model, so its first prompt does not include this additional line.

`taskTemplate` supports only the `{goal}` placeholder.
If the template does not contain `{goal}`, the extension appends the goal after the template.

### Launch controls

`delegate` has three optional controls.
Each uses the agent type's default value unless the call overrides it:

- `background: false` waits for the child and returns its report as the tool result.
  `background: true` returns immediately and delivers the report later as a follow-up message.
- `fork: true` starts the child with a copy of the parent's conversation and the same prompt to preserve the provider's cache.
- `thinking` sets the child's thinking level.

If a foreground child asks a question, the tool call returns control to the parent.
The child continues in the background.
Interrupting the foreground call has the same effect.

### Extensions, tools, and skills

The parent controls each child `pi` process through RPC.
A child with a fresh context starts with pi's extension discovery disabled.
It loads pi-taskforce and the agent type's `extensions`.
A forked child inherits the parent's extension flags.

Both launch modes also load `subagents.sharedExtensions`, including when a child resumes.
The extension resolves shared paths to their canonical form and removes duplicates already present in explicit extension arguments.
pi also removes duplicate discovered resources.
If a required shared extension is missing, the launch fails instead of continuing without it.

`subagents.sharedTools` adds baseline tools to each agent type's tool allowlist.
This also applies to tool restrictions in forked children.
The parent's restrictions take precedence.
The extension refuses a launch if the required tools conflict with those restrictions.

At startup, the child checks that all required tools are active.
If any are unavailable, it shuts down and reports the problem.
This check verifies tool availability, not the health of remote services that the tools use.

After the parent constructs its prompt, it passes its eligible skill files to both launch modes.
This includes skills supplied by extensions.
The child keeps the parent's skill filtering without loading unrelated parent extensions into a fresh context.
Skills remain available on demand, and explicit-only skills still require explicit use.
Before the parent constructs a prompt, normal pi skill discovery applies.

### Permissions and results

A child inherits the parent's environment, including API keys, and runs with the same permissions.
**A child is not a sandbox.**
Use an agent type's `tools` setting to restrict which tools it can call.
A child never receives a tool that its parent was denied.
A forked child also keeps its agent type's tool restrictions, which the extension checks on each call.

These checks run inside the child's pi process.
Other extensions in that process have the same permissions and can disable the checks.
Load only extensions you trust.

If a run fails, the parent's report includes the end of the child's stderr output.
Anything the child prints there can therefore reach the parent's model.
The child's result is its last assistant message.
A failed or stopped run still returns that last message.

Each agent can run up to `subagents.maxRunning` children at the same time.
The default limit is 8.
The extension refuses additional launches until a child finishes or is closed.

### Managing children

The parent uses `listSubagents`, `messageSubagent`, and `closeSubagent` to manage its own children.
Messaging a child whose process has exited restarts it from its transcript.
The transcript must be in the session's own `subagents/<session>/` directory.
Closing a child stops that child and all its descendants.

The parent records each child as a custom entry in its own session.
These records let the parent address its children after a restart.
The records do not enter the model's context.

## Asking

Use `ask` to group select, multiselect, text, and confirm questions in one call.
In a terminal, the tool displays one overlay with a tab for each question and a review tab before submission.
In an RPC session, it uses the host's dialogs to display one question at a time.

| Key | Action in the overlay |
|---|---|
| `Enter` | Pick the option under the cursor, toggle in a multiselect, record a text answer, or in a single question run the `Send answer` row; in review, reopen a question or submit |
| `1`-`9` | Select an option; in a multiselect, toggle it |
| `Space` | Toggle the option under the cursor in a multiselect |
| any letter | Start a typed answer if the question accepts one |
| `Tab` / `Shift+Tab` | Move to the next or previous question |
| `Alt+Left` / `Alt+Right` | Back / Next, also while a text field holds the keys |
| `Alt+1`-`Alt+9` | Jump straight to that question |
| `Ctrl+Enter` | Submit the whole ask explicitly, on one question or several |
| `Ctrl+N` | Add a note to the current question |
| `Alt+H` | Put the ask away to read and scroll the transcript; nothing is submitted or cancelled |
| `Esc` | Clear the text being typed; otherwise press twice to cancel the whole ask |

Picking an option never submits, not even in a single-question ask: press
`Ctrl+Enter`, or `Enter` on its `Send answer` row, to send.
`Alt+Q` (or `/questions`) brings a put-away ask back with every answer and its
position, and the status line says how many questions are put away.
Moving between questions never submits or cancels anything.
Notes are part of the draft even while the note is still being typed, and the
submitted answers are read from every question's current field: an earlier
question's unconfirmed text cannot be dropped, and an edited answer cannot be
replaced by a stale one.
Text questions accept typing immediately.
Every question includes "Skip, let the agent decide".
The overlay ignores keys pressed during the first 350 ms after it opens.
This prevents typing intended for the editor from answering a question that has just appeared.

The question, the draft of what has been answered, the submission and a final
done marker are written to the session as custom entries that never enter the
model's context directly. The answer itself is a custom message that the context
hook projects as the original call's tool result.
The question is written when it is queued, before the overlay appears, so a
question waiting behind another one survives a kill too.
Typing reaches the session within one second of the first unsaved change;
continuous typing cannot postpone that deadline.
Hiding, moving to another question, and shutdown write the current draft at once.
A graceful close therefore loses nothing, while an abrupt kill can lose at most
the last second of typing.

If pi stops with a question unanswered, the next process that opens the same
branch offers it again from `/questions` or `Alt+Q`, with its draft and position.
The phone receives it through the same ask widget and the same `ask:open` bridge.
A child's own question is journalled in the child's session and re-sent through
the extension UI protocol when the child is restarted, so the parent sees a new
request and the answer is written where that child's model reads it. The child's
first model run waits for that answer instead of running past the unanswered
call.

An answer is not new user input. It is written as a custom message carrying the
original `ask` tool call id, and a context hook projects it as that call's tool
result, adjacent to the assistant message that asked. A real result already on
the branch wins; only this extension's own suspended placeholder is replaced.
A cancellation is a real result too. If compaction removed the call, the answer
stays as ordinary context rather than being dropped or guessed at.

The order is durable, and it is what makes recovery safe:

1. the answers are written once to the journal (`pi-taskforce-ask-submit`);
2. the write attempt is journalled (`pi-taskforce-ask-send-attempt`);
3. the canonical answer is sent (`triggerTurn: false`, so it interrupts nothing);
4. the canonical answer is observed on this branch;
5. the question is marked done;
6. optionally, one wake message starts a turn (`triggerTurn: true`);
7. before the provider runs, the request boundary verifies that the projected request carries the original call's result.

The first submission fixes the payload. A later, different answer is refused
before anything is written; an identical one may retry only when no write attempt
exists. Each attempt carries a process identity kept on `globalThis`, which
survives `/reload` but changes in a new process. A same-process attempt that has
not become visible is guarded: it is not sent again, and the user is told to wait
or restart. A genuinely new process may apply the same saved payload once,
because the old process can no longer deliver it. No retry timer is used.

Pi may defer a message sent while a turn is streaming. It is provisional, not
accepted. Until the canonical answer is actually on the branch, the journal
remains replayable and the question is not marked done; the phone sees saved, not
accepted. A restart replays the submit journal even if an earlier process wrote a
done marker before the deferred message landed.

A recovered child does not rely on the `before_agent_start` gate to see a queued
write. The context boundary runs after Pi flushes that queue and before the
provider: when the original call is still in the request, the request must carry
a matching non-suspended result for it, or the request is aborted with
`ctx.abort()`. A real result, an explicit cancellation projected as that result,
and a call compacted out of the request (where the answer remains ordinary
context) all pass. An append that fails while Pi flushes the queue cannot reach
the provider; in stock Pi 1.5.2 that failure can leave the run active until its
silence watchdog instead of ending it immediately.

The automatic wake is at most once per process and canonical answer. Its attempt
is journalled before the send; a same-process attempt is not assumed dead just
because the session reads idle. Visibility is recorded per actual request: several
answers carried by one request share a request id, and another answer's marker is
not a new request. A successful assistant response consumes the answer only when
that request carried the answer and the response followed it. Consumption is
monotonic: once a successful response consumed the answer, a later unrelated turn
cannot take that back. An error or abort after the answer is a settled failed
attempt: automatic recovery does not retry it, because that would loop on the
error or override the user's abort. `/questions continue` is the explicit retry,
and it may retry in the same process once the failure response is durable. A
response after a request that did not carry the answer is not this answer's
response, so the attempt remains unknown and guarded. A canonical cancellation
continues exactly like an answer. After a genuinely new process, an old wake
attempt may be repeated once if the answer was not consumed. An old wake record
without a process identity is adopted as this process's guard and needs one full
restart; it is never sent in the same process. A repeated `/questions continue`
after a request has started is a no-op, except for the explicit retry after a
definitive error or abort.

Normal product order writes `pi-taskforce-ask-done` before the wake request, so a
restart cannot rely on the question still being offerable. The startup inventory
therefore looks at completed canonical answers separately from pending questions:
if the answer is still on the branch and its call has no real result, one safe
continuation is attempted per new process. DONE is answer bookkeeping for the
question UI, never permission to skip the request boundary. If the completed
answer cannot continue automatically, the terminal says so instead of silently
hiding it.

The canonical answer may be queued while a turn runs; the automatic wake waits for a turn boundary.
Recovery never adds a user message. Leaving the branch
with `/tree` takes a recovered question back and refuses its old callback;
returning to the branch offers it again. The phone gets a status, not an error,
after an accepted answer, and a question with a canonical answer is never offered
twice. A fork copies the parent's entries, but restores only questions from its
own session.

An older journal written before answers carried a call id cannot be linked to
its call. It is never guessed at and never becomes new user input. `/questions`
still opens it with its draft so it can be edited and copied; sending saves the
answers as a draft and puts their text in the editor, but sends nothing to the
model.

To try the overlay, hiding, recovery and the continuation turn locally, run
`scripts/ask-smoke.sh` from this repository.
It starts an isolated pi with only `tests/fixtures/ask-smoke.ts`, no tools and a
local synthetic provider; sending starts one zero-cost turn with no network. The
terminal explains its commands.
The workspace is reused between runs, so a restart opens the same session and
`/recover-show` goes through the real broker restore; `-c` removes it.
The script seeds one real user message first: pi does not write a session that
has no conversation, and without it the journal entries would never reach the
file. After quitting, `bun scripts/ask-smoke-check.ts <workspace>` reads the
journal back from the session file and lists the recoverable questions.

When `ask.notify` is enabled, a question rings the terminal bell.
It also sends a desktop notification through OSC 777 to terminals that support it, such as Ghostty.

The root agent sends its questions to the user.
A subagent sends its question to its parent as a message after the parent's current run.
The parent can answer with `answer_subagent`, ask the user with `ask`, or continue investigating until it can answer.
The child remains paused until it receives an answer.
Its silence timeout does not advance while it waits.
The status line shows the number of pending questions.
You can answer them from the subagent panel.

A subagent asks the user directly if every launch between the root and that subagent used `fork: true`.
The overlay identifies the subagent.
This identity comes from the parent's child record, not from the child's own claim.

Omitted and unattended answers instruct the agent to continue with its own judgment and state its assumptions.

## Commands and keys

| Command or key | Action |
|---|---|
| `/todos` | Print this session's TODO lists to the terminal only |
| `/new-keep` | Start a new session with a copy of this session's open TODO lists |
| `/subagents` | Open the subagent panel |
| `/subagents stop` | Stop every subagent |
| `Ctrl+Shift+T` | Hide or show the TODO widget |
| `Alt+1` | Open the subagent panel |
| `Alt+S` | Stop every subagent |

## Settings

Global settings are stored in `~/.pi/config/pi-taskforce/settings.json`.
Set `PI_TASKFORCE_CONFIG` to an absolute or `~/` path to use one explicit settings file instead of the global one, for example a scoped profile that must not inherit the host's `agentDirs`, `sharedExtensions` or `sharedTools`.
The selected file is inherited by every child, so a delegated child reads the same settings as its root.
An explicit file that is missing, malformed or contains an unknown setting fails with its path and the setting named; it never falls back to the global file.
In a trusted project, `<project>/.pi/pi-taskforce.json` overrides individual settings, except those marked as global-only below.
The following list contains all supported settings.

```json
{
  "todos": { "enabled": true, "widget": true, "dir": "" },
  "subagents": { "enabled": true, "maxDepth": 3, "maxRunning": 8, "silenceTimeoutMs": 600000, "panelKey": 1, "agentDirs": [], "sharedExtensions": [], "sharedTools": [] },
  "ask": { "enabled": true, "notify": true }
}
```

- `todos.dir` changes the base directory.
  An empty value uses `~/.pi/agent/todos`.
- `subagents.agentDirs` lists additional directories of agent definitions as absolute or `~/` paths.
  This setting is global-only.
- `subagents.sharedExtensions` lists extension files required by every child as absolute or `~/` paths.
  This setting is global-only.
  Projects and agent profiles cannot remove these extensions.
  Configure shared memory and search integrations here instead of repeating them in each profile.
- `subagents.sharedTools` lists tools that every child requires from those integrations, for example `recall`, `search`, and `fetch`.
  This setting is global-only.
  Shared integrations still depend on their own host configuration and environment settings.
  Make sure these settings enable the integration.
  An extension without tools, such as a compaction hook, needs a separate check to verify that it works.
- `subagents.maxDepth` counts the root as level one.
  The default permits the root and two levels of children.
- `subagents.maxRunning` limits the number of children that one agent can run at the same time.
  Values range from 1 to 64.
- `subagents.silenceTimeoutMs` limits how long a child can remain silent during a run before the extension stops it as unresponsive.
- `ask.notify` enables the bell and desktop notification when a question appears.
- A disabled feature registers no tools and adds no prompt text from the next session onward.

The extension ignores keys from earlier versions, such as `storage`, `tasks`, and `ask.replyReminders`.

## Development

```bash
bun install
bun run typecheck
bun run test
```

```
todos/     the directory rule, the parser and the watcher
agents/    definitions, the child processes, and what a parent does with them
ask/       the question, where it goes, and the two surfaces that show it
tools/     what the model can call
prompts/   what the model reads
ui/        what the user sees
```

`idea-writeup.md` defines the contract for the implementation.
