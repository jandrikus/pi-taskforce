# pi-taskforce - full writeup

Everything settled about the single Pi extension that carries TODO lists, subagents and asking the user, stated one point at a time.
Rationale is given only where the point is not self-explaining or where a reader could implement the opposite.

## 0. How to read this document

Every bullet below starts with a marker saying what kind of statement it is.

- **(rule)** - enforced by the extension. The call is refused and whoever made it is told why.
- **(mechanic)** - the extension does it itself, unasked.
- **(expectation)** - behaviour the prompts ask of an agent. Nothing checks it.
- **(context)** - background, scope or an assumption, not a behaviour.

Every **(rule)** owes a refusal message.
An **(expectation)** is never phrased to the model as a rule.
Rationale sub-bullets carry no marker and assert nothing on their own.

### Words this document fixes

- **The harness** is this extension's code, in whichever pi process happens to be running it.
  Every agent runs its own pi process, and every one of them has the extension loaded.
- **Fork** means `fork: true` on a subagent (§7): the child starts from a copy of its parent's conversation.
  Pi's own `/fork` of a session is called branching a session, and this extension does nothing special for it.
- **A TODO list** is one Markdown file in the project's TODO directory (§4).

## 1. Purpose

- (context) The extension helps a pi agent keep track of long work, hand parts of it to subagents, and ask for a decision it cannot make itself.
- (context) Its first version managed tasks in a database, with reminders, injected task views and a question routing scheme that kept the root agent busy.
  It was dropped because all of that pushed into the conversation.
- (context) This version gets out of the way.
  Nothing it does starts a turn except a subagent's report or question (§10, §13), and nothing reminds an agent of anything.
- (expectation) An agent decides for itself when work deserves a TODO list, and when it is worth delegating.

## 2. One extension

- (context) TODO lists, subagents and asking the user are one package, `pi-taskforce`.
- (context) One package on both sides of a spawn means a parent and its child register the same tools, so a forked child's system prompt matches its parent's and the provider's prompt cache survives the fork (§7).
- (context) The three parts do not depend on each other's data.
  A subagent has no association with a TODO list, and a question carries no task context.

## 3. Settings

- (mechanic) Settings live in `~/.pi/config/pi-taskforce/settings.json`, overridden field by field by `<project>/.pi/pi-taskforce.json`.
- (rule) The project file is read only in a trusted project, as §6 defines it.
- (context) The list below is exhaustive: the extension reads no other setting.

```json
{
  "todos": { "enabled": true, "widget": true, "dir": "" },
  "subagents": { "enabled": true, "maxDepth": 3, "maxRunning": 8, "silenceTimeoutMs": 600000, "panelKey": 1, "agentDirs": [], "sharedExtensions": [], "sharedTools": [] },
  "ask": { "enabled": true, "notify": true }
}
```

- (mechanic) `todos.enabled` switches the TODO prompt block, the watcher and the widget.
- (mechanic) `todos.widget` is whether the widget is shown at session start.
- (mechanic) `todos.dir` replaces the base directory of §4. Empty means the default. A leading `~` means the user's home.
- (mechanic) `subagents.enabled` switches `delegate` and the child tools.
- (mechanic) `subagents.maxDepth` limits nesting, the root counting as one, so the default is the root plus two levels of children.
- (mechanic) `subagents.maxRunning` is how many children one agent may have running at once, from 1 to 64. A child follows its root's value.
- (mechanic) `subagents.silenceTimeoutMs` is how long a child may send nothing mid-run before it is stopped as stuck. It is floored at ten seconds.
- (mechanic) `subagents.panelKey` is the number key that opens the subagent panel with Alt.
- (mechanic) `subagents.agentDirs` lists more folders of agent definitions (§6). Entries must be absolute or start with `~/`; others are dropped.
- (rule) `subagents.agentDirs` is read from the global file only. A project file that sets it is ignored for that key.
  - Rationale: a definition can load an extension into a child, so which folders hold definitions is the user's choice.
- (mechanic) `subagents.sharedExtensions` names required extension files by absolute or `~/` paths; `subagents.sharedTools` names their baseline tools. Both are global-only and apply to fresh, forked, and resumed children.
- (mechanic) `ask.enabled` switches the `ask` tool.
- (mechanic) `ask.notify` rings the terminal bell and posts a desktop notification (OSC 777) when a question shows in the terminal.
- (mechanic) A switched-off feature registers no tools and adds no prompt text.
  The settings are read once, at load, so a change applies from the next session.
- (mechanic) Nothing blocks a session because a feature is off.
  A call from memory to a tool that is not registered is answered by pi as an unknown tool.
- (mechanic) A settings file that does not parse leaves the defaults in place.
- (mechanic) Keys that earlier versions read, such as `storage`, `tasks` or `ask.replyReminders`, are ignored.
- (mechanic) A child follows the switches of the session that spawned it, passed through its environment (§8).

## 4. TODO lists: the convention

- (mechanic) Each session has one TODO directory: `<base>/<project>/<session>/`.
  - Rationale: a list belongs to the session that keeps it. A new session starts clean, and a resumed one finds its own lists.
- (mechanic) `<base>` defaults to `todos` inside pi's agent directory, which is `~/.pi/agent/todos` unless `PI_CODING_AGENT_DIR` moves it.
  - Rationale: a user who syncs `~/.pi` between machines gets the lists on every machine.
- (mechanic) `<project>` is the project's path encoded the way pi names its session folders: the leading separator dropped, every `/`, `\` and `:` replaced by `-`, wrapped in `--`.
  - Rationale: a list and the sessions that worked on it sit under the same name, so they are easy to match by eye.
- (mechanic) `<session>` is the session's transcript file name without `.jsonl`, `<timestamp>_<id>`, as pi names it. A session that is not saved to disk uses its id.
  - Rationale: the layout mirrors pi's session storage, so no metadata in the file is needed to tie a list to its session.
- (mechanic) `/new` starts a session with no lists.
- (mechanic) `/new-keep` starts a new session with a copy of the current session's open lists. Finished lists are not copied.
- (mechanic) `/fork` and `/clone` copy the open lists of the session they came from.
  - Rationale: they copy the conversation, and that conversation was working on those lists.
- (mechanic) A copy keeps the file's name and change time, and is independent of the original afterwards. A name the new session already has is not overwritten.
- (expectation) A TODO list is one Markdown file per piece of work, named `YYYY-MM-DD-<slug>.md`.
- (expectation) It starts with a `# ` title, holds one `- [ ]` item per step, and items are ticked `- [x]` when done.
- (expectation) Notes go in plain text under the item they belong to.
- (expectation) New work gets a new file. A finished list stays where it is, as the record of that work.
- (expectation) When picking up earlier work in the same session, the agent lists the directory and continues the matching file rather than starting a second one.
- (expectation) The agent edits the file with its ordinary file tools. The user may edit it as well, so the agent reads it again before changing it.
- (expectation) Only the root agent keeps TODO lists.
  A subagent reports back in its last message (§10), and a forked child is told the lists in its copied conversation are its parent's (§8).
  - Rationale: two agents editing one Markdown file overwrite each other's changes.
- (context) There are no task tools, no task ids, no statuses beyond the checkbox and no store.
  The file is the whole state, and anything that can write a file can change it.

## 5. TODO lists: what the extension does

- (mechanic) The root agent's system prompt carries one TODO block: the directory, the naming, the checkbox format, and the expectations of §4.
- (mechanic) The block does not list the files or their contents.
  - Rationale: the block stays byte-identical for the life of the session, which keeps the provider's prompt cache. The agent lists the directory when it needs to.
- (mechanic) The extension never sends the agent a message about its TODO lists: not at session start, not on resume, not after a compaction, not at the end of a turn.
  - Rationale: the list is on disk, so an agent that needs it reads it. Injected copies were the main source of the intrusion this version removes.
- (mechanic) A watcher on the session's TODO directory re-reads it whenever any file in it changes, however it changed: the agent's `edit` or `write`, a `bash` command, the user's editor, or a sync.
  - Rationale: hooking the agent's file tools would miss every other writer.
- (mechanic) Changes are coalesced over a short debounce, so a burst of writes is read once.
- (mechanic) The watcher reads `*.md` files only, and skips hidden files, so a sync tool's temporary files are ignored until they are renamed into place.
- (mechanic) The directory is created when the session starts, so there is something to watch.
- (mechanic) A file is read as a title, the count of items, the count of ticked items, and the first unticked item.
- (mechanic) An item is a list line, bulleted or numbered, starting with `[ ]`, `[x]` or `[X]`. Lines inside fenced code blocks are not items.
- (mechanic) The title is the first `# ` heading, or the file name without its extension when there is none.
- (mechanic) A list is open while it has an unticked item.
- (mechanic) Only a root process watches. A child has no widget and keeps no list.
- (mechanic) The widget above the input shows the open lists, most recently changed first: title, ticked and total, and the first unticked item.
- (mechanic) It shows at most three lists, and counts the rest.
- (mechanic) It disappears when no list is open.
- (mechanic) The widget only reads. It never sends the agent anything.
- (mechanic) `Ctrl+Shift+T` hides the widget and brings it back, for this session only.
- (mechanic) `/todos` prints every list in the session's directory, open ones first, with its counts and its path, to the terminal only.
- (context) A sync conflict copy, such as `name.sync-conflict-<stamp>.md`, is a Markdown file and shows as one more list. That is the user's cue to merge it.

## 6. Agent definitions

- (context) An agent type is one YAML file, and the file is the whole definition.
- (mechanic) Definitions are read from the folders in `subagents.agentDirs` (§3), `~/.pi/agents` and `<project>/.pi/agents`, at every session start. A missing folder is ignored.
  - Rationale: agent files shared with other tools load without a copy in `~/.pi`.
- (mechanic) A later directory wins over an earlier one for the same `name`, as a whole file: project over `~/.pi`, `~/.pi` over `agentDirs`, and a later `agentDirs` entry over an earlier one.
- (rule) `<project>/.pi/agents` is read only in a trusted project: started with `--approve`, with a saved trust decision for the folder or one above it, or with `defaultProjectTrust: "always"`. `--no-approve` and a saved "do not trust" turn it off.
  - Rationale: a definition can load an extension into a child, so it is code. pi does not know these files, and a folder with none of the files pi knows counts as trusted without a prompt, so pi's own decision is not enough.
- (mechanic) The command line is read with pi's own argument parser, so `--approve` after `--`, or as another flag's value, is not a flag here either.
- (mechanic) The decision is made when the extension loads, before pi asks about trust, so a "this session only" decision is not seen.
- (mechanic) When project files are skipped, the root warns once at session start, naming them and how to allow them.
- (mechanic) A child follows the root's decision, passed through its environment (§8).
- (rule) In an untrusted project, an `extensions` entry that names a file relative to the project, or a bare name in `<project>/.pi/extensions`, does not resolve. An absolute path, a `~/` path and the user's own extension folders always do.
- (mechanic) Only `.yml` and `.yaml` files are read, and a symlink that resolves to a file is read like a file.
  - Rationale: agent files are routinely symlinked in from a dotfiles repository.
- (mechanic) A file that does not parse is skipped and listed in the subagent panel with its reason. The other agents load.
- (mechanic) `enabled: false` switches an agent off, so a project can disable a global one.
- (mechanic) A built-in `general` type exists without YAML, and YAML can override or disable it.
- (rule) `name` must be letters, digits, `-` and `_`, starting with a letter or a digit.
- (rule) `label` is required.
- (rule) A file naming a prompt field this document does not define is refused, and the refusal names the field to use instead.
  - Rationale: silently ignoring a prompt field strips an agent of its instructions.

The fields:

- (mechanic) `promptSnippet` is the one-line type description shown in `delegate`.
- (mechanic) `promptGuidelines` are that agent's own rules.
- (mechanic) `taskTemplate` is instruction text with a `{goal}` placeholder. Without the placeholder, the goal is appended.
- (rule) A template or `parameters` block that still uses placeholders other than `{goal}` is refused for delegation with migration instructions.
- (mechanic) `tools` is the allowlist of pi's own tools. Empty or absent means unrestricted.
- (mechanic) `model` pins the child's model as an exact `provider/id`. Empty runs on the parent's current model.
- (rule) A pinned model is never matched fuzzily. It is checked at session start against pi's model list and its credentials; one that fails is named in a warning, and that type runs on the parent's model and settings until it is fixed.
  - Rationale: a near miss must not quietly land on another provider, such as a router the user did not choose.
- (mechanic) An empty `thinking` runs at the parent's current thinking level.
- (mechanic) `extensions` lists extra extensions to load in the child, by path or by a name in an extension folder. `pi-taskforce` and the global shared extensions are always loaded; fresh children discover no other extensions (§8).
- (mechanic) `identity` replaces pi's opening identity paragraph and leaves the rest of the prompt intact.
- (mechanic) `appendSystemPrompt` is layered on top of the child's prompt.
- (mechanic) `includeParentAppendSystemPrompt` forwards the parent's appended prompt, default true.
- (mechanic) `piDocs` keeps pi's documentation block in the child's prompt, default false.
  - Rationale: most agents never touch pi itself, and the block costs tokens in every child.
- (mechanic) `fork`, `background` and `thinking` are the defaults for the three controls of §7.
- (mechanic) `subagents` lists the types this agent may spawn. Absent means all of them, and `subagents: none` means none.
  - Rationale: an empty list is not used for this, because `tools: []` already means unrestricted.
- (mechanic) `silenceTimeoutMs` and `timeoutMs` override the watchdogs for that agent. `timeoutMs` defaults to 0, no wall-clock limit.

## 7. Spawning a subagent

- (mechanic) One tool, `delegate({ type, goal, background, fork, thinking })`, starts every type.
- (mechanic) Only `goal` is required, and `type` defaults to `general`.
- (mechanic) Omitted controls use the type's defaults.
- (mechanic) `background: false` blocks and returns the child's report as that call's result.
- (mechanic) `background: true` returns at once, and the report arrives later as a message (§10).
- (mechanic) `fork: true` starts the child from a copy of the parent's conversation.
  It copies the conversation and nothing else: the child has no children of its own.
- (mechanic) `thinking` is one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.
- (rule) A spawn past the depth limit is refused, with the caller's depth, the child's and the maximum.
- (rule) A spawn of a type the caller's `subagents` field does not allow is refused, naming the allowed types.
- (mechanic) An agent that may spawn nothing, or that sits at the maximum depth, is not given `delegate` at all, unless it is a forked child (§8).
- (rule) A spawn while the caller already has `subagents.maxRunning` children running is refused, with the count, and the caller is told to wait for a report or close one. Restarting a child by messaging it counts the same way.
  - Rationale: depth bounds the tree's height, not its width, and a model in a loop can start processes and spend money faster than any watchdog notices.
- (mechanic) The child's record is written before its process starts (§9).
- (mechanic) A spawn's result gives the child's uuid and the tools that address it.
- (mechanic) A background spawn's result says the report arrives as a message, that the parent may keep working or end its turn, and that there is no need to poll.
- (mechanic) A foreground child that asks a question hands the turn back at that moment: the call returns the question, and the child carries on in the background.
  - Rationale: answering needs a turn, and a turn cannot start while the call is still open.
- (mechanic) When the user interrupts the parent during a foreground spawn, the child carries on in the background.

## 8. How a subagent process runs

- (context) A subagent is a real `pi` process in RPC mode, started by its parent's process and driven over its standard input and output.
- (mechanic) The task is sent as a prompt once the child is up, never as a command-line argument.
- (mechanic) The parent reads the whole run off the event stream: tool calls, streamed text, turns, usage, retries and compactions.
- (mechanic) The child learns who it is through its environment: its uuid, its parent's, its type, its depth, the maximum, the feature switches, whether it was forked, whether every spawn above it was forked, which types it may spawn, and whether the project is trusted (§6).
- (mechanic) The child inherits the parent's whole environment, credentials included, and runs with the same permissions. It is not a sandbox.
- (mechanic) Every `PI_TASKFORCE_*` variable is removed from that environment before the child's own are set, so nothing the parent was told about itself, such as being forked or its inherited prompt, passes to a child.
- (mechanic) A child never gets a tool its parent was denied. The parent's own `--tools`, `--no-tools`, `--no-builtin-tools` and `--exclude-tools` pass to every child: a non-forked child's allowlist is the intersection of the parent's and the agent's.
- (mechanic) A non-forked child starts with extension discovery off, and the harness loads `pi-taskforce` plus the agent's `extensions`.
- (mechanic) Every launch mode also loads `sharedExtensions`, with canonical-path deduplication against explicit extension flags. Missing required files refuse the launch.
- (mechanic) `sharedTools` supplements role allowlists but never parent restrictions. Conflicting parent restrictions refuse the launch; unavailable baseline tools shut down the child before its task runs.
- (mechanic) Once the parent prompt is built, its eligible skill file paths are passed explicitly with automatic skill discovery disabled. This applies to forks and resumes too, preserves filtered and extension-contributed skills, and does not activate explicit-only skills. Before prompt construction, normal Pi skill discovery applies.
- (mechanic) Its instructions travel as an appended system prompt file, and `identity` is applied inside the child.
- (mechanic) When an agent declares a `tools` allowlist, the extension's own tools are added back to it.
  - Rationale: pi's tool filter covers extension tools too, and leaving them out strips the child of `ask` and `delegate`.
- (mechanic) A forked child starts from the parent's session file with no prompt flags, and with the extension flags the parent's own process was started with.
  - Rationale: any flag that changes the system prompt or the tool roster costs the provider's prompt cache, which is what a fork exists to keep.
- (mechanic) A forked child gets the parent's tool flags as they are, so its roster matches. The agent's own `tools`, intersected with any allowlist the parent itself enforces, travels in the environment, and the child blocks every other tool call with a message naming the allowed tools.
  - Rationale: a `--tools` flag of its own would change the fork's prompt, and a read-only agent must stay read-only when forked.
- (mechanic) A forked child's system prompt is its parent's, verbatim, including the TODO block.
- (mechanic) Its leading user message carries the agent's instructions, says the conversation above is a copy of its parent's, gives its depth and the maximum, its allowed tools, that its final message is its report, and then the task.
- (mechanic) That message also says the TODO lists in the conversation are its parent's, and not to edit them.
- (mechanic) When the parent had children at the moment of the fork, that message says they are the parent's and are not to be addressed.
- (mechanic) At the maximum depth, that message says the child cannot spawn, whatever its prompt says.
- (mechanic) A child writes its transcript into `subagents/<parent session>/` beside its parent's session file, one folder per parent session, and the parent records the path the moment the child reports it.
  - Rationale: pi's session list does not recurse, so subagent transcripts stay out of it, and a recorded path is what lets a child be restarted later.
- (mechanic) pi's own retry of transient provider errors is switched on in the child.
- (mechanic) A child that settles with no background children of its own shuts its process down. That exit is the normal end of its run.
- (mechanic) A child with background children stays up when it settles, and their reports wake it.
- (mechanic) An exit in the middle of a run is a failure. An exit after the child settled is a finish, unless its last model call failed.
- (mechanic) A stop is not a failure. The report says the run was stopped and why.
- (mechanic) A child that sends nothing for longer than its silence timeout is stopped and reported as failed.
- (mechanic) A child with a wall-clock limit is stopped when it is reached. Time spent waiting on an answer does not count.
- (mechanic) An open question freezes both watchdogs.
  - Rationale: a child waiting on an answer is silent on purpose.
- (mechanic) Stopping is cooperative first: abort, close the input so the child can flush its transcript, then signals.
- (mechanic) The parent reads the child's output defensively. A line that is not a JSON object with a string `type` is dropped, a line longer than 32 MiB stops the child, and a malformed event never throws into the parent. Only the tail of the streaming text and the last eight tool names are kept.
- (mechanic) A child's own session shutdown stops its children, so stopping a child stops everything below it.
- (mechanic) Any dialog a child extension opens, other than an ask, is declined.

## 9. Children a parent can address

- (mechanic) Every subagent has a uuid.
- (mechanic) A parent records each child it spawns as a custom entry in its own session: uuid, type, depth, whether it was forked, its transcript path, and whether its last run failed.
- (mechanic) A later entry for the same uuid updates the earlier one.
- (mechanic) At session start the parent reads those entries back, so its children are still addressable after pi restarts.
  - Rationale: the parent's session already outlives its process, and a parent only ever addresses its own children, so its own session is the place for them. No database is needed.
- (mechanic) The entries never enter the model's context.
- (mechanic) A child's status is running, compacting, idle or failed.
  Running, compacting and idle are read from the run. Only the failed flag is recorded.
  - Rationale: a stored "running" goes stale the moment the process dies.
- (mechanic) A child of a process that is gone is idle.
- (mechanic) `listSubagents` lists the caller's own children with uuid, type, status and context use.
  A child that can no longer run is listed with the reason: its transcript is gone, its type is gone from the catalog, or it sits past the depth limit.
- (mechanic) `messageSubagent` steers a running child, which reads the message at its next step.
- (mechanic) Messaging a child whose process is gone restarts it from its own transcript, launched exactly as the first time, and the message follows a note asking it to read back over its context.
- (rule) A transcript path is reopened only when it resolves, symlinks followed, to a `.jsonl` file inside this session's own `subagents/<parent session>/` folder, and that folder is not itself a symlink. Any other path counts as gone, including one in a sibling session's folder.
- (rule) A saved session whose subagent folder cannot be created, or is a symlink, refuses every spawn. pi would otherwise put the transcript in its default folder, where it could never be restarted from.
- (context) Tool limits are enforced by code in the child's own process. Every extension loaded there runs with the same rights and can undo them, so they hold against the model, not against an extension.
  - Rationale: the path comes from the session file, which is data anyone can edit or hand over, and it must not point a restarted child at another session's transcript.
- (mechanic) `closeSubagent` stops a child. It becomes idle and can be woken again by messaging it.
- (rule) The child tools refuse a uuid that is not one of the caller's own children, and point at `listSubagents`.
  - Rationale: reaching a grandchild directly would put two agents in charge of one child.
- (rule) `messageSubagent` refuses a child whose transcript is gone, whose type is gone, or which sits past the depth limit, and says why.
- (mechanic) `closeSubagent` is never refused for those reasons.
- (context) Branching a session with pi's `/fork` copies the child entries with the rest of the session, so both sessions address the same child transcripts. Messaging the same child from both is not guarded against.

## 10. Reports

- (mechanic) A subagent's result is its last assistant message that had text. There is no `submit` tool.
- (mechanic) The report the parent receives is one message: who it is from, how the run ended when that was anything but a normal finish, and the child's last message.
- (mechanic) A run that failed or was stopped still hands over what the child wrote last, under a line saying so.
- (mechanic) A failed run's report gives the reason, the context use, and the tail of the child's stderr.
- (mechanic) A run that wrote nothing says so, and tells the parent to ask the child or close it.
- (mechanic) A report longer than the cap is cut, and the cut says the child is idle, not gone, so the parent can ask for the rest.
- (mechanic) A background report is delivered as a follow-up: it waits for the parent's current run to finish and never cuts into it. When the parent is idle, it starts a turn.
  - Rationale: the previous version steered reports into the parent mid-run, which interrupted the user's conversation with the root.
- (mechanic) A child is never reminded of anything when it stops.
- (expectation) A child that stops with work undone says so in its last message.

## 11. Stopping

- (mechanic) `/subagents stop` and `Alt+S` stop every child of this session.
- (mechanic) The subagent panel stops one selected run, or all of them.
- (mechanic) A stopped child is idle and can be woken by messaging it.
- (mechanic) When pi itself is killed, every child is idle when the session resumes. Nothing restarts until the parent messages it.
- (expectation) A parent that no longer needs a child closes it.

## 12. Asking

- (mechanic) Asking is one tool, `ask`, available to every agent while the feature is on.
- (mechanic) A call carries an optional line of context and a list of questions, and the guidelines ask for everything in one call.
- (mechanic) A question has an id, a prompt, a type, options, a tab label, an optional default, and the flags `optional` and `allowOther`.
- (mechanic) The types are select, multiselect, text and confirm. An omitted type is select with options and text without.
- (mechanic) `allowOther` defaults on for the option types and offers a free-text row.
- (mechanic) A confirm question gets its Yes and No options from the harness.
- (rule) A call that cannot be rendered is refused with a message saying what to change: no questions, a missing or duplicate id, no prompt, an option without value or label, an option type without options, a text question with options, or a default naming no option.
- (mechanic) An ask ends answered, omitted, cancelled or unattended. Omitted is per question.
- (mechanic) Omitted and unattended read to the agent as permission to proceed on its own judgment and state its assumptions, never as an error.
  - Rationale: an agent told the call failed retries it.
- (mechanic) Cancelled means the user stopped the work, and the agent stops with it.
- (mechanic) Two asks never show at once; the second waits.
- (mechanic) In the terminal it is one overlay for the whole ask, with a tab per question and a review tab when there is more than one.
- (mechanic) A text question is a text field that takes keys as soon as it shows. On an option question that takes a typed answer, typing a letter starts that answer.
  - Rationale: a row the user had to open before typing lost the first keys, and read digits and letters as commands.
- (mechanic) Enter answers the question on screen. Space is the only toggle in a multiselect; digits 1 to 9 pick, or toggle, the numbered rows. Enter on a multiselect with nothing ticked picks the row under the cursor.
- (mechanic) Every question offers "Skip, let the agent decide". It has no number, so a digit never lands on it.
- (mechanic) Answering moves to the next unanswered question, then to review. From review, Enter on a question reopens it and Enter on Submit sends the ask. A question left unanswered is sent as skipped, and review says so.
- (mechanic) Ctrl+N writes a note on the question on screen.
- (mechanic) Esc clears a text field that has text. Otherwise the first Esc arms the cancel and says so, and a second Esc within two seconds cancels.
  - Rationale: cancelling stops the agent's work, and one stray key should not do that.
- (mechanic) Keys in the first 350 ms after the overlay shows are dropped.
  - Rationale: a question that pops up while the user types in the editor would otherwise take those keys as answers.
- (mechanic) The overlay shows how many asks wait behind it, and reports pi as blocked on a question to terminals that read OSC 7501.
- (mechanic) In an RPC session it is the host's dialogs, one question at a time, without notes. A confirm is a select of Yes, No and Skip, because a dismissed host confirm reads as No. A multiselect is a select of checkbox rows that toggle until Done.
- (mechanic) With nobody there, nothing is shown and the outcome is unattended.
- (mechanic) Cancelling the overlay, or dismissing any one dialog, cancels the whole ask.

## 13. Where a question goes

- (mechanic) A root agent's ask goes to the user.
- (mechanic) A subagent's ask goes to the agent that spawned it, as one dialog request on the channel pi gives a child for asking its host.
- (mechanic) The question is validated again when it arrives, with the same rules as §12. One from a uuid that is not the receiver's own child, or that fails validation, is answered as cancelled.
- (mechanic) Who asked, and whether the question goes to the user, are taken from the receiver's own record of the child, never from what the child sends about itself.
  - Rationale: anything that writes the child's output, such as an extension loaded into it, could otherwise claim to be the root or another agent.
- (mechanic) An agent every spawn above which used `fork: true` asks the user directly, passed up through its parents, and the overlay names the agent that asked.
- (mechanic) Only a forked child of an agent that itself asks the user directly may do so. A relayed question names its origin as the child reported it, followed by the chain of agents it came through, each added by the parent that vouches for it.
  - Rationale: a forked child runs inside a copy of the root's conversation, so its questions are that conversation's questions.
- (mechanic) Any other child's question is for its parent to handle.
  The parent can answer it with `answer_subagent`, ask the user itself with `ask`, or work until it knows.
- (mechanic) The parent is given the question with a reference, the question ids and options, and an example call built from the real ids.
  - Rationale: a placeholder id in an example gets copied as the answer.
- (mechanic) A question from a foreground child comes back as that `delegate` call's result.
- (mechanic) A question from a background child is delivered as a follow-up, like a report: it never cuts into a run, and starts a turn when the parent is idle.
- (rule) `answer_subagent` refuses a reference nothing is waiting on and lists what is waiting.
- (rule) It refuses a call with no answers, and one that leaves a required question unanswered.
- (mechanic) Only a multiselect answer is split on commas. In any other answer a comma is part of the text.
- (mechanic) Nothing reminds a parent of a question it has not answered, and nothing cancels the question on a budget.
  - Rationale: the reminders forced the root back to work when it had stopped to talk to the user.
- (mechanic) A root that stops with a child's question open leaves it waiting.
  The status line counts waiting questions, and the user can answer one from the subagent panel.
- (mechanic) A subagent that stops with its own child's question open answers it as unattended, so that child proceeds on its own judgment.
  - Rationale: nobody else can reach that question, and a child left waiting would hang with its watchdogs frozen.
- (mechanic) A question whose child run has ended is released. A question whose session is shutting down is answered as cancelled.
- (mechanic) Every exchange a parent handled is recorded in its session as an entry, with who asked, what, how it was answered and how long it waited. The entry never enters the model's context.

## 14. Surfaces

- (mechanic) The TODO widget of §5.
- (mechanic) While children run, a second widget shows each one: short uuid, what it is doing, duration, tool calls, context use, and its recent tools.
- (mechanic) It says what the child is actually doing: waiting for the model, running a tool, writing, compacting or asking a question.
  - Rationale: silence otherwise reads as stuck.
- (mechanic) The widget disappears when no child runs.
- (mechanic) The status line counts child questions waiting on the user.
- (mechanic) The subagent panel lists waiting questions, runs in flight, recently finished runs, the configured agent types, and agent files that failed to load.
- (mechanic) From the panel the user can stop the selected run, stop all of them, or answer the first waiting question.
- (mechanic) The extension posts no notifications at session start, except for a settings or agent problem the user has to fix.

## 15. What the agent reads

- (mechanic) The root agent's prompt carries the TODO block of §5 while TODO lists are on.
- (mechanic) An agent that may spawn carries a subagents block: what `delegate` does, when delegation pays and when to keep work in one loop, the three controls, and how to follow up, steer and close.
- (mechanic) A subagent's prompt ends with a block naming its parent's uuid and saying its final message is its report, the only part of its work the parent reads.
- (mechanic) An isolated agent at the maximum depth is told it does the work itself.
- (mechanic) The block most likely to differ between two runs of the same agent is appended last, to keep the longest identical prefix for the cache.
- (mechanic) A forked child carries its parent's appended blocks verbatim.
- (context) The texts read as a colleague's suggestions. Nothing in them tells an agent to stop, wait or account for itself.

## 16. Commands and keys

- (mechanic) `/todos` prints the project's lists (§5).
- (mechanic) `/subagents` opens the subagent panel, and `/subagents stop` stops every child.
- (mechanic) `Alt+<panelKey>` opens the panel, `Alt+S` stops every child, `Ctrl+Shift+T` toggles the TODO widget.

## 17. Assumptions

- (context) Two machines rarely edit the same TODO list before a sync finishes. When they do, the sync tool keeps both, and the user merges them.
- (context) Children running in parallel work on different files; the parent plans the work that way.
- (context) Child records from the database of earlier versions are not migrated. Those children cannot be messaged from a session that recorded them there.

## 18. The shape of the code

- (context) `todos/` holds the directory rule, the parser and the watcher of §4 and §5. The parser is pure.
- (context) `agents/` holds the definitions of §6, the child process and its watchdogs of §8, the supervisor, the child records of §9, and what a parent does with a child in §7 to §11.
- (context) `ask/` holds the question of §12, the route of §13, and the two surfaces that render it.
- (context) `tools/` is what the model may call, `prompts/` what it reads, `ui/` what the user sees.
- (context) `index.ts` is wiring and holds no rules of its own.
