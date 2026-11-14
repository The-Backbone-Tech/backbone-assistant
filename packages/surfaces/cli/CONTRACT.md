# Command line contract

**Layer:** L3. **Status:** built, experimental.


Audit export has its own read boundary: [audit-export contract](../../../docs/contracts/audit-export.md).
It attaches to the app or daemon's read API beside running work, and never takes the CLI holder
lock or initializes a Host when standalone. A stopped embedded database is copied outside the
source data folder. Offline `audit verify` requires no data folder. It proves internal file consistency, not
source authenticity. Content requires an idle plaintext-key data folder opened by the command and explicit `--include-content`;
it adds Core receipt statements, raw receipt and retained payload digests, and the three unkeyed argument/proposal/intent digests. Raw commitments allow guesses of other omitted values. Default receipt anchors and private payload digests are keyed; published piece-file digests remain plain on registration facts. Every API
line refuses content. Export and verification stream with bounded memory; --limit resumes a
backlog by scanned sequence, and headers distinguish direct person identity from same-user callers. File delivery uses exclusive create outside the data folder.

## Purpose

A person's or a script's way to the same `api` the thread app calls, with what is known about each outcome in the exit code.

## Owns

- The bin `backbone`: its commands, flags, words and exit codes.
- `<home>/cli`: the lock this command line takes on a data folder and `holder.json`, naming the process that holds it. The OS-held lock inode persists; holder.json is removed when the command ends.

## Provides

The commands and exit codes in [README.md](README.md). Exit codes and `--json` shapes are the interface; text output is for people and may change.

## Consumes

- `ApiMethods` (`@backbone-next/platform`), through `Host.call` or a running app's api line (`attachApi`): no other way into the platform's state.
- For the full-screen chat's side pane, reads only: `files.list`, `material.read` and `changes.get` with a document version, and `threads.get` for the versions a turn's writes made. The pane holds no state of the platform's and changes nothing.
- For doctor only, `homeKeyProvider` from `@backbone-next/platform/system-keys` reads the recorded provider metadata; it neither asks the system store nor unwraps a key.
- From the platform's composition, what any surface needs to open a standalone data folder in its own process: `createHost`, `hostClosed`, `withHomeLock`, `chooseKeys`, `doorSocket`.

`Host.connectTool` and `Host.signCapability` are not called: they stay with the process that shows the person the permission.

## Rules

1. **Only a thing known to have gone through is exit 0.** The daemon service is the exception for key refusal: it logs a clean stop and exits 0 to prevent launchd retrying an unlock request; this never means the daemon started. A turn counts as done only if its status is `done` and every effect is `DONE`.
2. **unknown outcome prints as unknown outcome and exits 4.** That covers an effect, a receipt whose outcome is `UNKNOWN`, a changing call that threw, a turn still running when the command stopped waiting, and a stop that never settled. `threads show` and `now` exit 4 while they show one.
3. **Nothing is sent twice.** A call that throws is not retried. Each `send` has a fresh client key.
4. **One process holds a data folder.** See below. A refused command has done nothing and exits 5. Attaching to a running app holds nothing: any number of commands may share its line.
5. **Reading creates no data folder or key-provider records.** Only `projects create` makes a data folder; any other command on a missing data folder is refused. Before standalone reads or doctor can open a Host, the data folder must have its kernel stamp, Core identity and database (embedded PG_VERSION or external database configuration). An interrupted first run is refused with the same-home projects create command; Host is never asked to finish it from a read. A legacy pre-vault data folder instead requires explicit plaintext migration, and data without a vault or legacy keys needs the original keys or a backup export restored into a separate data folder.
6. **No secrets.** The command line takes no key, prints none, and `models` shows only whether one is set. It selects the system store for a fresh data folder, preserves plaintext data folders and opens a vault only through its recorded provider; read-only commands never publish provider records.
7. **The running app comes first.** If the data folder's api line answers, the command goes through it and opens nothing here. With none, an Electron safeStorage data folder is refused as the app not running, and one whose vault cannot be read or names anything else, or which holds data and no vault, is refused too, before anything is opened; system-store data folders, plaintext data folders and an explicitly creating command's fresh data folder may open in this process; nothing silently falls back or converts.

While the daemon is not running, status retains its existing fields and may add `lastRefusal: { kind, at }`,
read from the bounded tail of the existing daemon log. Only known kinds and UTC
timestamps are exposed; raw log text and key-store reads are excluded. It is
history; a running daemon omits the field and never reads the refusal log. Neither status nor these
diagnostics initializes a data folder or creates a new diagnostic state file.

## A running app: attached

The app serves a named part of the `api` on the data folder's api line. [ADR 0002](../../../docs/adr/0002-api-line.md) has the decision: who may do what, and what it does not stop. Here that means:

- `projects create` uses the app or daemon’s explicitly enabled local project request. It creates a folder or Git project without starting model work or asking in the app, using a fresh client key and the existing durable creation intent. A refusal and an unknown outcome keep their normal text and exit codes; a lost answer is never retried. Company sign-in configurations refuse it with guidance to create the project in the signed-in app. Each serving app or daemon composition must supply a budget or the line refuses to serve. That budget is shared by all its connections and replacement lines, limiting validated requests to 10 per rolling minute and 100 until that owner restarts; an excess request is refused immediately, never queued. Other local hosts keep it closed. Standalone creation also uses the durable intent and a fresh client key; its output, selection and folder/Git contents stay the same, with directories now named `<slug>-<full project id>` instead of using the first eight id characters. Git setup has a twenty-second timeout per invocation.
- `projects list`, `threads list`, `threads show`, `now`, `files`, `models`, `doctor` and `stop` work at once, beside a running turn. A read cannot start a model call: it reaches the live host's reads and recovers nothing.
- Each `send`, `queue`, `goal set`, `goal run` and `schedule add` (and `goal`, which is a send if it needs a chat, then a set and a run) works once the person clicks Allow for that one call in the app, having been shown all of it; no click stands. The dialog shows the write resolved as it will run, and exactly that runs: a goal run's shows its budget (with its checks, up to twice that in model turns), the chat's goal and the settings it is pinned to; a schedule's shows the words for when, how the app read them and the first run. If any of it moved while the question was up, it is `REFUSED (NOT_AVAILABLE)` and nothing was done. Words are at most 1,000 characters with nothing hidden in them, and the model, ids and `--when` are one plain line, or it is `REFUSED (INVALID)`. It says on stderr that it is waiting. A No, or no answer, is `REFUSED`, exit 1, and nothing was done; a No closes them all until the app reopens.
- `threads archive` is off the line: `REFUSED`, exit 1, and nothing was done. So is `export`: use Settings › Backup. `restore` goes only into a new, empty data folder, which the app does not hold.
- A turn running there is live, and not one a kill left, so `threads show` says it is still running in the app. It is not settled, so it exits 4, as rule 2 says.
- If the line ends mid-call, a change is `UNKNOWN`, exit 4, and it is not sent again. An app that holds the socket and does not answer is `BUSY`, exit 5.

- The chat's pane over the line: `files.list`, `material.read` and `changes.get` are carried as reads (ADR 0002, 5 November); `changes.get` only as a document version's own diff (`last-turn` with a version), never a git scope.

## A standalone data folder: one process per data folder

The decision, from the code as of this contract:

- `createHost` refuses a data folder another host holds, before any recovery, with `HomeOwned`: on start a host treats a stored `running` turn as one a kill interrupted and observes a write mid-dispatch as unknown outcome, so a second host beside a live one would do this to work still going. Opening resumes nothing: `resumeInterrupted` is its own step, and `readOnly` opens with no recovery at all and refuses every change.
- `backbone-mcp host` serves the api line with reads and Stop only, and the default daemon with reads and explicit local project creation (ADR 0002). A command attaches without opening another Host. Neither headless line starts model work for a command. A host that serves no api line leaves nothing to attach to: the door's socket carries four gateway calls and "no control call" (`doors/protocol.ts`, `composition/doors.ts`).

A daemon explicitly started with `--share` opts its private same-user line into
`identity.get`, `identity.invite`, `identity.share` and `identity.remove` for the
terminal team commands. Invitations on this line allow only member or guest;
admin invitations remain in the app. The ordinary daemon/app allowlists do not
change. The private handshake optionally includes `serverPid`; shared daemon
status requires it to match the stored PID, so a reused live PID cannot establish
ownership. macOS status preserves installed, running, pid and lastRefusal fields
and adds shared address/fingerprint when ownership is confirmed.

The commands that only read (`projects list`, `threads list`, `threads show`, `now`, `files`) open read-only, so a read never starts a model call and a turn a kill left reads as it was left. The commands that change the data folder resume interrupted turns first.

So this surface refuses, before `createHost` runs:

1. It takes `withHomeLock` on `<home>/cli` with no wait, for the life of the command. That key is apart from the data folder's own, so the host's locking is unchanged. A held lock is `BUSY`, naming the holder from `holder.json`.
2. Under the lock, if something answers on the data folder's door socket and serves no api line, another host holds the data folder: `BUSY`.
3. `send` serves the data folder's doors while it runs, so `backbone-mcp host` started meanwhile is refused too.

`stop` from a second process cannot call `turns.stop` on its own host, because only the process carrying a turn can abort it. It sends SIGINT to the `send` named in `holder.json`, after a live check of that pid, when the thread matches; it then waits for the send to end and reads the thread. A person's Ctrl-C takes the same path.

## Acceptance

`pnpm --dir packages/surfaces/cli test`: `test/commands.test.ts` for each receipt and status against a stand-in `api`, and `test/cli.test.ts` for the real bin on a real core, with a held data folder, a stop from a second process, a send killed mid-write, a door host on the data folder, a missing data folder and a data folder with no keys, and `test/app-line.test.ts` for the bin attached to a host, with a No, a method off the line, the host killed mid-send, the app closed, and `queue`, `goal set`, `goal run` and `schedule add` allowed and refused; `test/daemon.test.ts` for the daemon’s line creating folder and Git projects while refusing model-work writes and Stop. `test/line-projects.test.ts` checks confirmed, refused, unknown and lost creation answers without retries. `test/screen.test.ts` and `test/panes.test.ts` for the full-screen chat on a stand-in terminal: the pane beside the transcript from 100 columns and over it below, Esc and PgUp/PgDn, the files pane, a scripted turn's write named at its version and its diff on Ctrl-O, a read refused as the app's line refuses it, the real host's v1-to-v2 diff, and piped input unchanged. `packages/surfaces/app/e2e/cli.electron.spec.ts` runs it against the built app on a data folder the Keychain path keeps. `docs/how-to/use-the-cli.md` runs in `pnpm check`.

## Headless turn stream

`exec` runs exactly one ordinary `send` through the same admission, authority,
attachment, interruption and exit-code paths. It adds no platform method or API-line
permission. Existing `send --json` output is unchanged. `exec --json` emits the
[JSONL event schema](src/exec-events.schema.json); an unobserved terminal event is
never success. The [README](README.md#headless-execution) defines schema validation,
polled item semantics, unknown usage and terminal outcomes. Schema validation runs
before data folder opening and never fetches a remote schema. Validation cannot undo work
already performed, and does not retry it.

`test/exec.test.ts` proves the event schema and schema-checked answer, refusal,
unknown outcome, invalid output, lost send and interruption with a stand-in API.
`scripts/cli-install.test.mjs` installs the packed runtime into a clean prefix and
runs a schema-checked job against a loopback model, then checks doctor.

## Change procedure

A new command is a call to an existing `api` method. A change to an exit code or a `--json` shape changes this contract. Anything needing a new `api` method, or a method on the api line, is the platform's to add first, with another-family review.

## Task solution selection

`solutions options` compares current machine routes under `--needs`, `--network`,
`--spend` and optional `--structured`. Each option reports current use, concrete
setup, or an API entitlement prerequisite that discovery has not established. Client sign-in is classified as a subscription,
API-key billing or unknown; unknown billing requires metered permission.
Saved local models precede saved keys, which precede ambient endpoints. Saving an own or gateway key clears an older local choice for ordinary chats as well as selection; selecting a local model later makes it preferred again. Native selection refuses a different named turn model before confirmation, so the shown dispatch model stays bound. Codex sign-in billing is freshly checked rather than cached across requests. Discovered servers, including historical local selections being continued, remain setup-only until explicitly selected; known non-chat model families are refused. Configured keyless loopback endpoints remain usable under local, no-spend limits,
including custom ports; this classification comes from the effective route.
Routes that need setup are compared and explained, but only a usable route can win.
`--evidence` is a public Arena topic or exact record; it never receives the private
task text. Set BACKBONE_ARENA to an Arena checkout; the existing `npm run ask`
query runs with npm offline and update checks disabled. It supplies dated evidence, separately from machine feasibility and task fit.
Expired evidence needs revalidation and cannot rank routes as current evidence.

`solutions run <text>` uses the same constraints and ordinary project/thread,
permission and effort options. It waits for completion and prints the recorded
selection and dispatch route in JSON. Run defaults to no spend. The native question names the computed route, spend class and billing warning; endpoint/credential-handle or model changes before admission are refused. No eligible route or a required engine
setup starts no turn and exits 1. An attached run requires the app's per-call
confirmation of the complete task and limits; a headless line refuses it.
`solutions verify <turn> --thread <thread> --deliverable <name>` checks the
turn's exact written version and reports later edits. Exit 0 means its custody
and basic format checks passed; an incomplete verification exits 7. It does not
claim factual correctness. Ordinary failed, stopped and UNKNOWN turn exits hold.

The CLI selection package test exercises a real Host and loopback model through
the real CLI binary attached to a stand-in app confirmation. It does not qualify the installed CLI or desktop app.

## Bundled notices

`notices` and `notices --json` read the installed build's licence resources without
opening a data folder. Missing resources fail with exit 1. JSON uses schema 1 and
an entries array containing identity, declared licence, text format, digest and
complete text. [Bundled notices](../../../docs/contracts/bundled-notices.md) owns
the shared build-resource contract.
