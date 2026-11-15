# How to do a first job from the terminal

**For:** a person using a standalone CLI data folder. **Before starting:** install the [CLI](install-the-cli.md), or install this checkout with `pnpm install --frozen-lockfile --offline`. From the repository root, define the command below; an installed CLI already provides `backbone`.

```bash
backbone() { node packages/surfaces/cli/src/main.ts "$@"; }
```

## A real engine and your first document

The following commands use a disposable data folder, never your default data folder. Plaintext is for this test: the folder contains its own unencrypted vault key, so protect it. Set `SOURCE` to your CSV's actual path.

```bash
export BACKBONE_HOME="$(mktemp -d)/home" BACKBONE_KEYS=plaintext
unset BACKBONE_HARNESS BACKBONE_CODEX_MODEL BACKBONE_MODEL_ENDPOINT BACKBONE_MODEL_ID
SOURCE="$PWD/sales.csv"
backbone projects create "Sales review"
backbone engine codex
backbone model codex --model gpt-6.1-sol
backbone engine
backbone models
backbone files attach "$SOURCE"
backbone files
backbone send "Read sales.csv. Which region had the highest revenue, and what was its total? Compute the totals and show your method." --permission full
```

Codex needs the installed supported Codex client, already signed in through its own client. No subscription credential is imported into this data folder. This experimental adapter requires Full permission because Codex executes commands and edits in a restricted temporary workspace rather than proposing each command to the Host. Full authorizes that native execution; canonical document imports still pass through the Host's effect gateway and expected-version checks. Do not choose Full unless you want that behavior. A missing or incompatible client gives its own refusal.

A send prints its thread id, work steps, write receipts and answer. Before work details are recorded, the Host removes known credential values and token-shaped text: Bearer/Basic authorization values, key/token/secret/authorization headers (including x-api-key), KEY/TOKEN/SECRET/PASSWORD assignments (except `key=lambda x: ...`, the sort keyword argument, which is shown as written), common provider key prefixes, and long high-entropy strings containing lowercase letters, uppercase letters and digits. The entropy rule preserves paths and lowercase hexadecimal hashes; known credential values and explicit credential forms are still removed. Recorded commands are not byte-for-byte replay scripts. Copy the id into `THREAD`; follow-ups keep the same conversation. Staged commands say what ran and its exit status when the client reports them. “Completed in staging” describes the temporary copy; a separate `DONE write-working-copy` receipt establishes a canonical document import. Read the record, then ask for a document:

```bash
THREAD=<thread-id-printed-by-send>
backbone threads show "$THREAD"
backbone send "Write a one-page summary as summary.md. Include the regional totals, the winning region and total, and the calculation method." --thread "$THREAD" --permission full
backbone files
backbone files read summary.md --version 1
backbone files save summary.md --base-version 1
backbone files
backbone doctor
```

`files save` accepts the version you inspected and creates a new version by the person. To edit before accepting, copy the text out, edit that local file with your editor, then save it through the same command:

```bash
backbone files read summary.md --version 2 > /tmp/summary-edit.md
# Edit /tmp/summary-edit.md with your editor, then:
backbone files save summary.md --from /tmp/summary-edit.md --base-version 2
```

Use the actual version shown by `files`; a stale base is refused. Originals stay unchanged. Documents are managed in the data folder, with versions, and are not automatically written into the project folder. `files` and the app Files tab also show tracked Git files and files copied into folder projects as **unregistered: not given to the engine; attach to use it**. They stay out of Review. Copying a file into the folder does not attach it. Use `files attach`, or attach while sending:

```bash
backbone send "Read this file and describe its columns." --thread "$THREAD" --attach "$SOURCE" --permission full
```

Each `--attach` goes through `material.attach`, just as the app does, and keeps an original. CLI attachments must be regular files of at most 25 MiB; a symlink is accepted only when its target is a regular file. The CLI checks the file type and size before reading it. Reattaching the same name may create a renamed original. `files read` and `files save` accept either a name or a material id, within the selected project. With several projects, pass `--project <name-or-id>`.

After a person saves v2, an engine with permission to write may revise it directly to v3 through the gateway, provided it read the current version. Full does not require another person approval for that internal write. It is a new working version by the agent, **not accepted**; `files` shows that the person last saved v2. v2 stays readable. If the person saves while the engine works, the expected-version check prevents overwriting that save; the engine's draft can be kept beside it. Accept the new version explicitly after reading it.

To stop, press Ctrl-C in the sending terminal. Or, in another terminal with the same data folder, run:

```bash
backbone stop "$THREAD"
```

The stop command reports the final state, and the sending process exits 3 for a known stop. A write with an unknown outcome exits 4 and is never blindly resent. A standalone data folder admits one product process at a time; Stop reaches the process already sending.

## Switch to a local model in the same thread

Pi needs an OpenAI-compatible endpoint on loopback and the exact model id the server serves. Start that server separately, load a model, then choose its route. For example, with Ollama serving `qwen3.5:4b`:

```bash
backbone engine pi
backbone model local --runtime ollama --endpoint http://127.0.0.1:11434/v1 --model qwen3.5:4b
backbone models
backbone send "Read sales.csv. Which region had the highest revenue, and what was its total? Show your method." --thread "$THREAD"
backbone threads show "$THREAD"
backbone doctor
```

For Ollama, LM Studio, llama.cpp and vLLM, an address with no path gets `/v1` added, because those servers answer there; the command prints "Using ..." when it does this. It then asks the server for its model list: it says the model is listed, or that the server does not list it, or that the check could not be made (a server that is off is still saved). `--runtime other` saves the address exactly as given.

This changes the data folder setting for the next process. Each turn records its engine; the thread and its registered material stay. To switch back:

```bash
backbone engine codex
backbone model codex --model gpt-6.1-sol
backbone send "Check the previous answer against sales.csv." --thread "$THREAD" --permission full
```

Give a local model enough context for the instructions, tools, history, file and answer; a server default of 4,096 tokens may be too small. Pi currently reads text (including CSV and supported workbook cell text) and writes documents. It has **no code or SQLite computation tool today**: arithmetic generated by a small model must be checked independently. Codex can inspect staged source copies and run installed command line tools to calculate; availability and successful execution are shown in the work record. ACP uses an explicitly configured installed agent and its own capabilities and sign-in; scratch files are not automatically imported. See [the ACP guide](use-the-acp-harness-alone.md). None of these statements establishes answer accuracy: inspect the method and receipts.

A `length` finish reason or a stream ending without a normal stop produces an unfinished answer, keeps the partial text, explains the likely context/output limit or connection problem, and exits 7 (`UNFINISHED`). It never says the job is done. Authentication, provider and other failures print `FAILED` with their reason and exit 6; a person-requested Stop remains exit 3. Increase the server's limits or shorten the task before asking again.

## Settings and hosted keys

`engine` stores the same `harness` setting the app uses in the data folder's `settings.json`; `model` uses `settings.model.put` and the same `model-route.json` as Settings. There is no separate CLI configuration. An already running app or daemon must restart to pick up an engine change.

`BACKBONE_HARNESS` selects an engine; `BACKBONE_CODEX_MODEL` overrides the stored Codex model. Pi resolves the person's saved local model first, then a stored own key and gateway, then an explicitly enabled Keychain route, then the keyless loopback route named by `BACKBONE_MODEL_ENDPOINT` and `BACKBONE_MODEL_ID`. Test app launches and launches with a named data folder disable Keychain route discovery. An ambient endpoint cannot replace a saved local choice or API key. An empty endpoint value counts as unset. An invalid stored local setting or a nonempty non-loopback endpoint refuses instead of selecting another route. Read `models` for the effective route before sending. Saving an own or gateway key clears an older saved local choice, including for ordinary chats; selecting a local model later makes it preferred again. A keyless loopback label describes the connection, not independent proof that the server cannot proxy a paid provider.

For a hosted API or gateway key, add it in the app's **Settings → AI and models** for that data folder. The product seals it under a credential handle in the data folder's `credentials` folder using the data folder's vault master key; settings contain the handle, never the key value. `models`, `engine` and `doctor` never echo a key. There is no CLI key argument or key prompt: do not put secrets in argv, shell history or conversation text. This guide's real runs need no hosted API key.

The running app’s API line carries reads, `files attach`, Stop and project creation (create projects and attach files in the signed-in app when company sign-in is configured), and asks in the app before each send, queue, goal or schedule. It does not carry engine/model changes, send attachments or document Saves; use the app for those. The background service also carries `files attach` without stopping it, with the same 25 MiB file limit as the standalone command. A CLI-managed standalone data folder supports the full sequence above. An app-kept data folder can require the app open to read its keys. See [the CLI contract](../../packages/surfaces/cli/CONTRACT.md).

## A runnable practice job without a model

These `bash test` steps run in CI. The stub calls no model; this exercises the same command, attachment and Save paths, without an account.

```bash test
export BACKBONE_HOME="$(mktemp -d)/home" BACKBONE_KEYS=plaintext BACKBONE_HARNESS=stub
trap 'rm -rf "$(dirname "$BACKBONE_HOME")"' EXIT
backbone() { node packages/surfaces/cli/src/main.ts "$@"; }
printf 'region,revenue\nNorth,42\nSouth,7\n' > "$(dirname "$BACKBONE_HOME")/sales.csv"
backbone projects create "Sales review"
backbone engine stub
backbone engine
backbone files attach "$(dirname "$BACKBONE_HOME")/sales.csv"
backbone send "Write a summary document from sales.csv" --attach "$(dirname "$BACKBONE_HOME")/sales.csv"
backbone threads list
backbone files
backbone files read brief.md --version 1
backbone files save brief.md --base-version 1
backbone files read brief.md --version 2 > "$(dirname "$BACKBONE_HOME")/edit.md"
printf '\nPerson checked this.\n' >> "$(dirname "$BACKBONE_HOME")/edit.md"
backbone files save brief.md --from "$(dirname "$BACKBONE_HOME")/edit.md" --base-version 2
backbone files
backbone models
status=0
backbone files save brief.md --base-version 1 || status=$?
test "$status" -eq 1
```

`backbone chat` offers an interactive session; `/help` lists its commands, `/files`, `/open brief.md v1` and `/diff brief.md` show work, and Ctrl-C stops the turn. The full command and flag list is in the [CLI README](../../packages/surfaces/cli/README.md).

## Exit codes

| Exit | Meaning |
| --- | --- |
| 0 | The requested operation completed with known outcomes. A model answer still needs human judgement. |
| 1 | Refused: read the reason and any partial write receipts. |
| 2 | Invalid command or arguments. |
| 3 | Stopped by the person: read the explanation and any completed write receipts. |
| 6 | FAILED: authentication, provider, tool or other failure; read the reason. |
| 7 | UNFINISHED: the answer was cut off (length, missing or broken stream); read any partial answer. |
| 4 | unknown outcome: inspect `threads show` and settle unresolved writes; never resend blindly. |
| 5 | BUSY: another process holds the data folder; wait or stop its send. |

Reads recover nothing and never call a model. On a later writable open, interrupted work may recover before the new command; it says so. `threads show` and `now` keep exiting 4 while showing an unresolved write. A goal exits 3 while blocked, paused or out of budget. No data folder yet: create a project first. A key/vault refusal includes the recovery action; keep damaged data folders intact and use [backup and restore](../../packages/surfaces/cli/README.md) to recover into a fresh data folder.

Read commands and doctor leave personal data, schema, keys, metadata and folders in
an existing data folder unchanged. An incomplete first run is refused with the missing
artifacts and a writable completion command for the same data folder. Starting the data folder's
PostgreSQL server can change its physical runtime pages and files; the
[read-only data folder contract](../contracts/readonly-home.md) defines that exception.
Doctor uses the existing API line when a daemon holds the data folder.

## Consume a headless turn

Use `backbone exec "Summarize the project" --json --output-schema answer.schema.json`
for JSONL lifecycle events and a schema-checked final answer. See the
[headless output contract](../../packages/surfaces/cli/README.md#headless-execution).
The existing `send --json` remains a single Turn object. Wait for `turn.completed`
and exit 0 before consuming its `structured_output`; failure never retries work.

```bash test
node packages/surfaces/cli/src/main.ts exec --help | grep -q -- '--output-schema'
```

## Choose a route for a task

Compare the routes found in this data folder and on the machine before running work:

```bash
backbone solutions options --needs model,files --network false --spend none
backbone solutions run "Write an editable brief" --network false --spend none
backbone solutions verify <turn-id> --thread <thread-id> --deliverable brief.md
```

Options report availability and concrete setup, hard exclusions and reasons for
the choice. Select the required engine first with `backbone engine pi` or
`backbone engine codex` if the run identifies an engine dependency. Running uses
the same platform selection as the app, records its actual destination, and keeps
ordinary Stop and unknown outcome handling. An attached run requires the app's native
confirmation; a headless daemon cannot confirm it. JSON output includes the
comparison and the turn's pinned and observed routes.

For external evidence, set BACKBONE_ARENA to a local Arena checkout and pass
`--evidence agent-harness` to options. This public topic goes through Arena's
existing `npm run ask` query; private task text is never supplied to it. A dated
pick is separate from local feasibility. Expired or undated decisions need
revalidation and cannot become current recommendations. Verification checks the
turn's exact version and receipt, even after a human save; factual accuracy still
needs the task's substantive check. An incomplete verification exits 7.

Selection run defaults to `--spend none`; pass an explicit spend ceiling for a paid route. The app confirms the chosen route and spend class before dispatch, and refuses a moved choice. Scanned servers are setup suggestions, not approved destinations; select a chat model in Settings first.
