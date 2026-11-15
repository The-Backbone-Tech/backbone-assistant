# Command line

The `backbone` bin: projects, threads, turns and what matters now, from a terminal or a script, on the same platform `api` the thread app calls. It holds no policy: the platform decides, and each answer is its receipt or projection as it is.

## Use it alone

A local npm tarball can be installed without a checkout; it is not published. See [install the CLI](../../../docs/how-to/install-the-cli.md). For development, install this repository (`pnpm install`) and use a data folder. Run it as `node packages/surfaces/cli/src/main.ts`; [use the CLI](../../../docs/how-to/use-the-cli.md) has a run you can copy, which CI runs.

| Command | Platform call |
| --- | --- |
| `backbone chat [--thread <thread>] [--project <project>]` | an interactive session: each line is a `send` in the current thread, and slash commands run the commands below; see [The chat](#the-chat) |
| `backbone exec <text> [--json] [--output-schema <file>]` | one `turns.send`, followed through `threads.get`; the same thread, project, attachment and turn settings as `send` |
| `backbone projects list` | `projects.list` |
| `backbone projects create <name> [--kind folder\|git]` | `projects.create`; the one command that makes a data folder |
| `backbone projects rename <id> <name>` | `projects.update` |
| `backbone projects archive <id>` | `projects.update`; hides the project and its chats |
| `backbone projects restore <id>` | `projects.update`; brings the project back |
| `backbone threads list [--all]` | `threads.list`; `--all` includes archived threads and projects |
| `backbone threads show <thread>` | `threads.get` |
| `backbone threads archive <thread>` | `threads.update` |
| `backbone send <text> [--thread <thread>] [--project <project>] [--attach <path>]... [--model <id>] [--effort 1-5] [--permission ask\|auto-review\|full] [--plan]` | `turns.send`, then follows `threads.get` |
| `backbone goal <text> [--thread <thread>] [--project <project>] [--budget 1-50]` | as the app's `/goal`: without a thread, `turns.send` starts a chat with the words; then `goals.set` and `goals.run`, and it follows the run, printing each check. Exit 0 when met, 3 when it waits for you. `send "/goal <text>"` is the same |
| `backbone goal set <text> --thread <thread>` | `goals.set` on the version `threads.get` shows; it starts no work |
| `backbone goal run <thread> [--budget 1-50]` | `goals.run`, then follows the run as `goal` does |
| `backbone goal pause <thread>`, `backbone goal resume <thread>` | `goals.pause`, `goals.resume` |
| `backbone queue <text> --thread <thread> [--model <id>] [--effort 1-5] [--permission ...] [--plan]` | `queue.add`: sent when the thread's turn in hand ends, or now if none runs |
| `backbone schedule add <text> --when <words> [--thread <thread>] [--project <project>] [--model <id>] [--effort 1-5] [--permission ...] [--plan]` | `schedules.create`: `--when` is "every day at 9:00", a cron line or one moment; pause or delete it in the app |
| `backbone stop [<thread>]` | `turns.stop` |
| `backbone now [--project <project>]` | `work.now` |
| `backbone files [--project <project>]` | `files.list` |
| `backbone engine [pi\|codex\|acp\|stub]` | `settings.model.get` / `settings.engine.put`: show the effective engine or store the next Host's engine in the shared data folder settings |
| `backbone model codex --model <id>`, `backbone model local --endpoint <url> --model <id> [--runtime <name>]` | `settings.model.put`, the app's same route; no credential argument |
| `backbone files attach <path>` | `material.attach`: preserve an original, available to project turns; `send --attach <path>` does the same before sending |
| `backbone files read <name-or-id> [--version <n>]` | `material.list` / `material.read`: read a managed text version |
| `backbone files save <name-or-id> --base-version <n> [--from <edited-file>]` | `material.save`: accept the inspected version, or save edited text as a person version; stale bases refuse |
| `backbone models` | `models.list`, `settings.model.get`: which route is active, never a key |
| `backbone doctor` | Node, the data folder, its recorded key provider, who holds it, the engine, the route and permissions: `connector-signature-ledger-v1` is ok when verified; missing/not verified and could-not-be-inspected are separate warnings that keep the exit code unchanged and explain per-call permissions and who installs the step |
| `backbone export <folder>` | `backup.export`: your work in plain files (projects with every version, chats and receipts as history, memory, skills) into a new folder; no credential, database row or authority |
| `backbone audit export [<file>\|-] --since <instant> --until <instant> [--after <event id>] [--limit <source rows>] [--include-content] [--scratch-root <directory>]` | `audit.export`: committed Core audit JSONL, through the live API line or a standalone read; [guide](../../../docs/how-to/export-the-audit-record.md) |
| `backbone audit verify <file> [--previous <file>]` | Offline integrity and optional source-cursor join; opens no data folder |
| `backbone restore <folder> [--dry-run]` | `importHome` into a new, empty data folder, through its api as you would add the work yourself. A dry run changes nothing; a data folder that holds work is refused and left as it is |

Every command except offline `audit verify` needs `--home <data home>` (or `BACKBONE_HOME`). `--json` puts one JSON value on stdout except `exec`, which streams JSONL events; a successful audit export to stdout emits the complete JSONL stream. A failed write exits non-zero and identifies partial output. With one project, `--project` may be left out; it takes an id or a name.

The exit code says what is known:

| Exit | Word | Means |
| --- | --- | --- |
| 0 | | It is known to have gone through. |
| 1 | `REFUSED (<reason>)` | The platform said no; nothing was done. A turn may have been refused partway: its receipt says what landed. |
| 2 | | The command line itself is wrong. |
| 3 | `STOPPED` | The person stopped the turn; known writes stay recorded. |
| 6 | `FAILED` | Authentication, provider or another failure; its reason is shown. |
| 7 | `UNFINISHED` | A cut-off answer (length, missing or broken stream); partial text and reason are kept. |
| 4 | `UNKNOWN` | Whether something happened is not known. It is never sent again; a person settles it. `threads show` and `now` exit 4 for as long as they show one. |
| 5 | `BUSY` | Another process holds this data folder, and nothing was done. |

**With the app running,** a command goes through the app's api line and opens nothing itself: reads and `stop` work at once, beside a running turn, and each `send`, `goal`, `goal set`, `goal run`, `queue` and `schedule add` waits until you click Allow for it in the app, which shows all of it: its words, its thread or project, and for a goal run or a schedule its budget or its times. A No closes them until the app reopens. `projects create` creates a new folder or Git project through the personal app without starting model work, limited to 10 requests per minute and 100 until restart. With company sign-in, create the project in the signed-in app. `projects rename`, `projects archive` and `projects restore` also work through that personal line, sharing the creation limit. `threads archive` is refused there: use the app. [ADR 0002](../../../docs/adr/0002-api-line.md) has who may do what.

**With the app closed,** the app's own data folder is refused in plain words, and no host starts: only the app reads its keys.

**A standalone data folder** uses the system key store on first creation with no key-choice variable, where usable. Existing plaintext data folders remain plaintext, and explicit `BACKBONE_KEYS=plaintext` is the headless/test choice with plain-text keys. The command opens these data folders itself, one process at a time. A second command while a `send` runs is refused with exit 5, naming the holder. While `backbone-mcp host` holds a test data folder, commands attach to its api line as they do to the app's: reads and `stop` work, and nothing that changes the data folder is carried. The default daemon’s line carries reads and local project creation; it starts no model work for a command. With explicit `--share`, its private same-user line also carries the terminal team controls; invitations there allow members and guests only ([team guide](../../../docs/how-to/share-with-a-team.md)). `backbone stop` is the exception: it signals the `send` holding the data folder, as Ctrl-C would, and reads what came of it. [CONTRACT.md](CONTRACT.md) has the reasons.

## Headless execution

Run `backbone exec "Summarize the project" --json --output-schema answer.schema.json`
with the intended data folder. The schema file is JSON Schema draft-07, validated with
Ajv before opening the data folder. Only references within the supplied schema are supported.
The schema is included in the prompt sent to the selected engine. The CLI asks for
a JSON answer and validates it after the turn. This is
checked output, not a provider-native constrained generation guarantee. An invalid
schema exits 2 before work starts; an answer that fails the schema exits 6. No turn
or effect is retried to repair an answer.

The [event schema](src/exec-events.schema.json) describes one JSON object per stdout
line. Lifecycle names follow Codex exec: `thread.started`, `turn.started`,
`item.started`, `item.updated`, `item.completed`, then exactly one terminal
`turn.completed` or `turn.failed`. Diagnostic text goes to stderr. `backbone_step`
items project the platform's polled work record; they are not raw engine tool events
or token deltas. `backbone_effect` items retain DONE, REFUSED or unknown outcome; completion
of a reporting item does not establish that an effect succeeded. An `agent_message`
may contain a partial or schema-invalid answer: consume `structured_output` only
from a successful terminal event and check the process exit code. Reported token
usage uses `input_tokens` and `output_tokens`; absent usage and unavailable cached
counts are null. A process killed before its terminal event has an unknown outcome.

Without `--json`, exec prints the answer and diagnostic text. It runs one turn;
`/goal` prompts are refused so automation cannot start a goal loop accidentally.
The existing `send --json` still returns its single Turn object.

## Backup, export and restore

Export and restore work on a data folder this command can hold: a test or headless data folder, with the app closed. With the app running, `export` is refused (use Settings › Backup); `restore` goes only into a new data folder, and Settings › Backup › Restore from a backup runs the same operation from the app, with a preview first. A restore exits 0 only when it finished, and 1, changing nothing, on a conflict; its `--json` is the plan.

## The chat

`backbone chat` at a terminal is full screen: a header with the thread and the settings the next message goes with, the transcript, and your line at the bottom. `/help` lists its commands. Piped input gets none of the screen: plain lines, as a script expects, and the pane's commands print their text instead.

A side pane shows the work beside the conversation, as the diff views of Claude Code and Codex CLI do:

| In the chat | Shows | Platform call |
| --- | --- | --- |
| a turn that writes | `wrote brief.md v2` in the transcript: each document the turn's writes made, at that version | `threads.get` |
| Ctrl-O, or `/diff` | the diff of what the last turn wrote, each version against the one before | `changes.get` with the version |
| `/diff <name> [vN]` | that document's change at a version (the latest by default) | `changes.get` with the version |
| `/files` | the project's files | `files.list` |
| `/open <name> [vN]` | a document's text at a version (the current by default) | `material.read` |
| Esc, or `/close` | closes the pane | |

From 100 columns the pane takes about half the width beside the transcript; on a narrower terminal it covers the transcript until Esc, and output that arrives meanwhile is kept. PgUp and PgDn scroll it. The pane only reads, through calls the platform already serves to any surface. With the app running, its line carries `files.list`, `material.read` and `changes.get` too, so the pane works the same there.

**The engine** is the app's, `harness-pi`. With no model route a `send` is refused and no model is called. `BACKBONE_HARNESS=stub` uses the stub, which calls no model and is labelled as such.

## What it replicates, from whom, when

- Exit codes that separate "refused" from "unknown", after the MCP door's rule in this repository that only `DONE` is a successful call.
- `--json` on one value per command, as `gh` does with `--json`, so scripts read a projection and not a table.

## Why

The app, headless execution and outside clients are meant to reach the same mechanisms. A script or a person in a terminal gets the same receipts as the app, with the outcome in the exit code, where a shell can act on it.

## Swap it

Any surface over the same `api`: the thread app, or the MCP door for agents.

## Remove it

Delete the package and the how-to. It holds nothing durable: `<home>/cli` holds its lock while it runs.

## Notes

The package suite runs at most two test files at once. PostgreSQL-heavy fixture
setup otherwise competes with the audit pipe case's deliberate 30-second stall.
The tests retain their existing deadlines and concurrent-client scenarios.

- Opening a data folder runs the platform's recovery, as opening the app does. A turn a kill interrupted resumes in whichever command opens the data folder next, and on a real route that can call a model; the command waits up to 30 seconds for it, then shows it as running, and it resumes again next time. `stop` does not wait.
- A killed process's lock goes stale in about 5 seconds; until then the data folder reads as `BUSY`.
- A `send` prints work steps as they appear and the answer when the turn ends; the `api` gives no partial text.
- `backbone send` attaches files with `--attach <path>` through `material.attach`, and `model` sets a Codex or local route. Hosted keys are entered in app Settings; a key argument would land in shell history.
- If the lock is lost while a `send` runs (the machine slept past its staleness), nothing tells the `send`.
- A process that opens a host with no doors (the app's browser bridge, a headless example) is not seen by the check for another host. The app refuses a plain-text data folder, so the app itself never meets this.

## Messaging channels

`channels connect slack`, `channels connect telegram`, `channels connect discord` or `channels connect teams` reads two lines from standard input and seals them in the data folder's credential store. Slack and Telegram take a bot token and verification secret; Discord takes a bot token and registration JSON; Teams takes an app client secret and registration JSON. The [channel setup](../channels/README.md#discord-and-microsoft-teams) names those JSON fields. Use `--project` to select the project, the ordinary model/permission options for channel turns, and optionally `--port` for the loopback webhook listener. Restart the daemon after connecting. `channels bind` prints a one-use code valid for ten minutes; send it to the bot from the account to bind. `channels unbind` ends all channel bindings and pending codes while the daemon keeps running. See the [channel README](../channels/README.md) for the real-bot setup, which has not been tried.

The daemon composes the channel service with its own Host and a twenty-second delivery deadline. Channel startup failures are reported while schedules and goals continue. The API line carries reads and local project creation, and refuses model-work writes; channels use the Host object directly. Channel configuration and receipts live with the channel package, while bot credentials are sealed by the platform.

## Manifest

<!-- generated from backbone.module.json by scripts/module-readme.mjs; do not edit -->
| Field | Value |
| --- | --- |
| id | `io.github.albertoangulo/cli` (surface) |
| version, licence | 0.0.0, Apache-2.0 |
| publisher | Backbone maintainers, namespace `io.github.albertoangulo` (github, pending) |
| stability | experimental |
| provides | Command line (the backbone bin) 0.x |
| consumes | api (projection in, command out, receipt back) 0.x, Direct messaging channels over the shared Host 0.x |
| capabilities | planes: personal; effect classes: 2, 3; operations: workspace.write_document, channels.reply; network: model-route, slack-api, telegram-api, discord-api, teams-api; secrets: surrogate |
| data | owns: <home>/cli: this command line's lock and the record of who holds it, gone when it ends; migrations: 0; export: nothing durable of its own: work, versions and receipts belong to the platform's data home and the core |
| depends on | @backbone-next/platform workspace, @backbone-next/channels workspace, ajv 8.20.0 |
| conformance | bronze: `packages/surfaces/cli/test/commands.test.ts`, `packages/surfaces/cli/test/cli.test.ts`, `packages/surfaces/cli/test/app-line.test.ts`, `packages/surfaces/cli/test/channels.test.ts`, `packages/surfaces/cli/test/daemon-channel-failure.test.ts`, `packages/surfaces/cli/test/channel-breadth.test.ts` |
| exemption | suite in pnpm check: its tests run per package and in CI after pnpm check; pnpm check runs its guide, on a real home |
| removal | delete the package; it holds nothing durable, and held UNKNOWNs stay with the core's gateway; refused while one of its effects is UNKNOWN |
<!-- end of generated block -->

Standalone audit export accepts --scratch-root for a short, operator-owned mode-0700 disk folder.
The default is the per-user audit parent under /tmp; full socket paths over 100 bytes refuse.
The ACP automatic read exclusion covers only the default parent, not overrides elsewhere.

For the real-engine sequence, requirements, environment overrides and data-file limits, follow [the first-job guide](../../../docs/how-to/use-the-cli.md). `files` lists registered material and shows other folder/tracked Git paths as unregistered (not given to the engine; attach to use it), and shows the current version author and acceptance. A later agent revision of a person-saved document is working and not accepted. Engine/model changes, attachments and Saves are commands for a standalone data folder; the running app line does not carry them. Hosted keys are entered in app Settings, sealed in the data folder credentials store, and never echoed by the CLI.
