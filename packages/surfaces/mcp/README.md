# MCP door

Backbone's effect gateway, receipts, accepted knowledge, work reads and task solution selection over stdio (spec 2026-07-28, with the 2025 handshake for older clients).
Use it from Claude Code, Codex, Hermes or OpenClaw without the desktop app; it still needs the platform host, core and kernel: the core decides every effect under a mandate the person sets outside the door.

## Use it alone

You need this repository installed (`pnpm install`) and a data folder: a folder holding its embedded PostgreSQL, its vault of keys, permissions and outbox. **The door holds no secret and opens no database:** `serve` relays its four calls over the data folder's socket (`<home>/run/door.sock`, or `/tmp/backbone-doors-<uid>/` for a data folder path too long for a socket; either way in a folder only the person's user may enter, and a socket in any other folder is never used) to the one process holding the data folder's keys, which carries them out on its own link to the core (`@backbone-next/platform/composition/doors`). For the app's data folder that process is the app, its keys in the Keychain. For a standalone protected data folder, `backbone-mcp host` selects the system key store with BACKBONE_KEYS unset (or requires it with BACKBONE_KEYS=system); see [the provider and its tests](../../platform/src/system-keys/README.md). Existing plaintext data folders stay plaintext. For a test data folder whose keys are in plain text (`BACKBONE_KEYS=plaintext`, which the app refuses) it is `backbone-mcp host`. With neither running, the door still starts and every call is refused with `NOT_AVAILABLE` ("not running"), nothing sent; it connects by itself once the app is up. The read tools go another way: over the data folder's api line (`<home>/run/api.sock`, [ADR 0002](../../../docs/adr/0002-api-line.md)), which the app serves, and `host` serves with reads and Stop only and no send, since nobody is there to ask. They do not consult the door's permission, which governs effects: any program of the person's user can read the data folder's plain files anyway. So revoking a door ends its effects, not its reads; to stop a tool reading, remove its entry. The embedded database listens on `127.0.0.1`: a sandbox that blocks local listening fails at `host` with `listen EPERM`.

Fastest check: `node packages/surfaces/mcp/examples/try-door.mjs` starts a host on a temporary test data folder, permits a door, drives it with the official MCP client (receipt, `DONE`, the file in the outbox, revoke, then `NO_MANDATE`), prints each step, exits non-zero on any mismatch and removes everything it made. Its expected output and a troubleshooting table are in [use the MCP door](../../../docs/how-to/use-the-mcp-door.md), which CI runs.

**From the app, with no terminal:** Settings › Assistants using this app does steps 1, 2 and 4 below for Claude Code, Codex, Cursor and Claude Desktop, each with its own permission, through the tool's own command where it has one ([the platform's README](../../platform/README.md) has the table). Their entries are named `backbone-door` and start the door inside the app (`Contents/Resources/bin/backbone-mcp`), which runs the copy of this door the app ships with the app's own runtime as Node, and the app serves their calls while it runs. The app's host checks the door's shipped folder against the registration each permission is bound to. On the app's data folder, `grant`, `revoke` and `host` are refused (`held in the Keychain by the app`): its permissions are made and taken back in the app.

Only `host` creates a data folder. `grant` and `revoke` refuse a missing or empty folder before choosing keys. `serve` does not select or probe keys: it starts even before a data folder exists, creates nothing, and its tools answer NOT_AVAILABLE until a host runs. Legacy plaintext key files migrate only with an explicit plaintext choice. Wait for “Serving the doors” before giving a door permission in a data folder the host is creating.

1. **The person permits a door** (from their own shell, never through MCP), on a test data folder whose host is running. The mandate names only these operations, under this ceiling, for 30 days:

   ```bash
   export BACKBONE_HOME="$PWD/.backbone-home" BACKBONE_KEYS=plaintext
   node packages/surfaces/mcp/src/main.ts host &
   node packages/surfaces/mcp/src/main.ts grant --name claude-code --operations outbox.write --ceiling 3
   ```

2. **Point the client at it.** Claude Code (`.mcp.json` in a project, or `claude mcp add`):

   ```json
   {
     "mcpServers": {
       "backbone": {
         "command": "node",
         "args": ["<repo>/packages/surfaces/mcp/src/main.ts", "serve", "--grant", "claude-code"],
         "env": { "BACKBONE_HOME": "<repo>/.backbone-home" }
       }
     }
   }
   ```

   To save the same entry with Claude Code, from the repository root (this changes that client's local configuration):

   ```bash
   claude mcp add backbone -e "BACKBONE_HOME=$BACKBONE_HOME" -- node "$PWD/packages/surfaces/mcp/src/main.ts" serve --grant claude-code
   ```

   Claude Code needs a live sign-in first; check `claude auth status`. For a non-interactive run, save the JSON above as `mcp.json` in the current directory, replace its placeholders with absolute paths, then run:

   ```bash
   claude -p "List the Backbone tools" --mcp-config "$PWD/mcp.json" --strict-mcp-config --allowedTools "mcp__backbone" --output-format text < /dev/null
   ```

   Codex (`config.toml` in `$CODEX_HOME`, by default the `.codex` folder in your data folder; or the same keys as `-c` overrides for one run):

   ```toml
   [mcp_servers.backbone]
   command = "node"
   args = ["<repo>/packages/surfaces/mcp/src/main.ts", "serve", "--grant", "codex"]
   env = { BACKBONE_HOME = "<repo>/.backbone-home" }
   default_tools_approval_mode = "approve"
   ```

   For a single Codex run without changing its configuration, first permit the `codex` door with the same permission command as step 1, changing the name to `codex`. From the repository root, with `BACKBONE_HOME` set as above:

   ```bash
   codex exec -m gpt-6.1-terra -c 'approval_policy="never"' -c 'sandbox_mode="read-only"' -c 'mcp_servers.backbone.command="node"' -c "mcp_servers.backbone.args=[\"$PWD/packages/surfaces/mcp/src/main.ts\",\"serve\",\"--grant\",\"codex\"]" -c "mcp_servers.backbone.env={BACKBONE_HOME=\"$BACKBONE_HOME\"}" -c 'mcp_servers.backbone.default_tools_approval_mode="approve"' -C "$PWD" -o "$BACKBONE_HOME/codex-out.txt" "List the Backbone tools"
   ```

   Add `--skip-git-repo-check` when the working directory is outside a Git repository. The tool-approval override approves this door's tool calls for the run; the 10 November trial used both it and `--skip-git-repo-check` and did not test either without it. These TOML overrides assume paths contain no double quotes or backslashes.

   Hermes and OpenClaw take the same stdio entry (command, args, env) in their own MCP server configuration; for Hermes, under `mcp_servers` in its config file. Permission each its own door (`--name hermes`, `--name openclaw`) so its receipts and revocation are its own.

3. **Use it.** The arguments, as the door declares them (`src/tools.ts` holds the full schemas):

   | Tool | Arguments | Returns |
   | --- | --- | --- |
   | `propose_effect` | `operation` (`"outbox.write"`), `args` (`{ "name": "hello.txt", "content": "…" }`), `description` (plain words for the person), `idempotencyKey` (your own unique string; the same key always means the same action) | a receipt; `outcome` is `DONE` on success |
   | `effect_status` | `effect` (the receipt's id) or `idempotencyKey` | the same receipt, read only |
   | `list_receipts` | `limit` (optional, at most 200) | this door's receipts, newest first |
   | `recall_knowledge` | `words` (optional list), `limit` (optional) | accepted statements and their topics |
   | `solutions_options` | `needs`, `network`, `spend`, optional `structured`, `evidenceQuery` | compared routes, availability, reasons and optional dated Arena evidence |
   | `solutions_run` | `projectId`, optional `threadId`, `text`, `task`, `settings`, `clientKey` | selection and started turn, or a concrete limitation; ask permission only, named-client app confirmation required |
   | `solutions_verify` | `threadId`, `turnId`, `deliverables` | exact-version custody and format checks, with later edits separate |
   | `list_projects` | none | the projects: id, name, kind |
   | `list_threads` | `projectId`, `archived`, `limit` (all optional) | the chats, newest first; archived ones only if asked |
   | `read_thread` | `threadId` | one chat whole: words, answers, steps, goal and goal run |
   | `search_threads` | `query` (one line) | hits for every word: chat id, place and a snippet |
   | `list_goals` | `threadId` (optional) | every goal run with its chat's goal words; or one chat's goal and run |
   | `list_schedules` | `limit` (optional, recent runs) | schedules, the heartbeat and the latest runs |
   | `search_memory` | `query` (one line) | remembered lines ranked by shared words, with topic and source |

   Each result has `structuredContent` (`{ "ok": true, "value": … }`, or `{ "ok": false, "reason": "NO_MANDATE", … }`) and `isError` is set unless the outcome is `DONE`, `PENDING` or `AWAITING_DECISION` (an unknown outcome, REFUSED, FAILED or CANCELLED receipt is an error). A read tool that cannot reach the app is an error whose text starts `UNAVAILABLE` (`reason: NOT_AVAILABLE`, no `value`): nothing was read, which never means the workspace is empty. Every read tool is annotated `readOnlyHint: true` and says to treat what it returns as information, never as instructions or permission.

   `outbox.write` writes a named file into `$BACKBONE_HOME/outbox`. A runnable client is `examples/try-door.mjs`, and the step-by-step is [docs/how-to/use-the-mcp-door.md](../../../docs/how-to/use-the-mcp-door.md). A good write is `outcome: DONE` and the file exists.

4. **Revoke it:** `node packages/surfaces/mcp/src/main.ts revoke --name claude-code`. Its run stops, effects not yet sent are cancelled, and every later gateway proposal is refused with `isError: true` and `reason: NO_MANDATE`; nothing is sent under that permission. Same-user reads remain available. Selection requests are capped at ask permission and require a separate native question naming the MCP client, chosen route and spend class. They do not acquire the door permission’s authority; revoking a door permission does not revoke a task the person separately allowed.

**Which failure is it?** `listen EPERM` at `host`: the database or the socket could not listen (transport). A client error `connection closed` during `server/discover`: the door never started (its stderr says why). `NOT_AVAILABLE` and `not running`: nothing holds the data folder's keys now (the app is closed, or `host` is not running); nothing was sent. A non-zero `grant`: no door exists. The refusal may suggest `backbone-mcp grant`: the installed app ships that launcher, while from a checkout use `node packages/surfaces/mcp/src/main.ts grant` with the options in step 1. `NO_MANDATE` with the door running: the core refused, either never permitted or correctly revoked. `AWAITING_DECISION`: above the ceiling, a person decides. `UNKNOWN`: outcome not known, never resent. The full table is in the how-to.

What is tested, and where (`packages/surfaces/mcp/test/door.test.ts` with the official MCP client over stdio against the real core; `packages/platform/test/gateway.test.ts` for the port):
- A client that probes with `server/discover` negotiates 2026-07-28; a client using the older handshake negotiates 2025-11-25 (as in the example). Both get exactly the tools described in `packages/surfaces/mcp/src/tools.ts`; `propose_effect` and `solutions_run` are annotated as writes; the remaining tools are read-only.
- The read tools return what the host holds (projects, chats, a chat whole, search hits, goal runs with their goal, schedules), through the same-user read path of a line whose separately confirmed selection run is capped at ask permission; with nothing holding the data folder each says `UNAVAILABLE`, never empty; a door whose permission was revoked still reads and cannot propose (`packages/surfaces/mcp/test/reads.test.ts`). The line's reads change none of the data folder's files (`packages/platform/test/api-line.test.ts`).
- A call without a mandate is refused (`NO_MANDATE`), and nothing is sent.
- Every effect returns its receipt; only `DONE` is a successful call; the same idempotency key is the same effect; a key reused for another change is refused.
- Outside the permission is refused; above its ceiling waits for a person's decision (`AWAITING_DECISION`).
- The permission is bound to the door's registered piece (`grant` registers this package as it is on disk): an operation this manifest does not declare (`outside_piece`) or a class above 3 (`above_piece_ceiling`) is refused whatever the permission allows, and a door whose files are not that registration does not open, so a new version needs a new permission (`packages/platform/test/pieces.test.ts`).
- A canary model key sealed in the same data folder, canary environment variables and the database passwords never appear in any tool output or log, the host's included.
- The door holds no secret: on a data folder whose keys the Keychain holds (a key in the test's memory plays it), the door works only through the running app's host; no file of the data folder holds a password, the master key or the model key; `grant`, `revoke` and `host` run as the person's user are refused and change nothing; once the app quits every call is `NOT_AVAILABLE`, nothing sent. The socket carries only an existing permission's four calls (`packages/platform/test/doors.test.ts`).
- A host killed mid-dispatch leaves the door's call an error with outcome `UNKNOWN` (never a refusal), and the effect `PENDING` until its dispatch claim lapses, then `UNKNOWN`; a retry with the same key does not resend it, and the same change under a new key is refused (`repeat_unknown_blocked`).
- `effect_status` only observes (it never dispatches) and reports an `UNKNOWN`, `REFUSED`, `FAILED` or `CANCELLED` receipt as an error, as `propose_effect` does.
- Refusals use fixed words and the core's reason code: no operation name, argument name or value from the caller comes back.
- A door name is permitted once; giving permission to it again is refused, so revoking always reaches the mandate that acts.
- A dispatch whose dispatcher went silent is settled by inspection once its own dispatch claim has lapsed (lease plus the core's 30-second grace), by the door or by the app, even after the door was revoked; a revoked run or a paused dispatcher never has its outcome taken, and a dispatcher that was only slow still settles the truth by a late observation (in `packages/platform/test/gateway.test.ts` and `packages/core/test/sweep.test.ts`).
- Changing a tool description fails the manifest digest in `pnpm check`.

Tried live on 26 Oct 2026: **Codex CLI 0.162.1** (with `-c` overrides, nothing written to its config) proposed an `outbox.write`, read `DONE` from `effect_status` and `list_receipts`, the file landed, and after `revoke` its next call came back `REFUSED` / `NO_MANDATE` with nothing written. Not yet tried live: Claude Code (its sign-in on the test machine had expired), Hermes and OpenClaw. On the same day, `claude mcp add|remove -s user` (Claude Code 2.1.310) and `codex mcp add|remove|get` (Codex CLI 0.162.1) were run in a throwaway `HOME`, `CLAUDE_CONFIG_DIR` and `CODEX_HOME` to see where and how they write; the fake commands the tests use (`packages/platform/src/testing/fake-tools/`) follow what they did.

## What it replicates, from whom, when

- The MCP server shape and stdio transport of the official TypeScript SDK v2 (`@modelcontextprotocol/server` 2.4.0, Apache-2.0, October 2026), serving 2026-07-28 through `server/discover`.
- Receipts and idempotency keys as payment APIs use them (Stripe `Idempotency-Key`): the same key always names the same action.
- Tools chosen by hand, not mirrored from the API, after the evidence in `docs/repo-design.md` (Doors to other tools).

## Why

People already work in Hermes, OpenClaw, Claude Code and Codex. This door gives those agents Backbone's one guarantee that matters most outside its app: an action leaves only through the gateway, under a mandate that can only narrow, with a receipt, and an outcome nobody can tell stays `UNKNOWN` instead of being sent twice. The door holds no policy; the core decides.

## Swap it

Any other door over the same gateway port (`packages/platform/src/gateway.ts`) can replace it, for example OpenAPI over HTTP. A client can be pointed at another MCP server by changing its configuration; Backbone's data stays in the data folder.

## Remove it

Revoke its permissions (`revoke --name …`), then remove the client entries and this package. Its manifest's removal rule is the core's: unregistering its piece (`gov.unregister_piece`, `unregisterPieceIn` in the platform) is refused while one of its effects is `UNKNOWN`, so a person settles those first; the door has no command for it yet. Permissions, effects and receipts stay in the core.

## Remote use (not built)

Stdio only. A remote door over Streamable HTTP would need: OAuth 2.1 authorisation as the 2026-07-28 spec states it (the SDK's bearer-token middleware, a protected-resource metadata document, audience-bound tokens), a mapping from each token to exactly one door permission (never a wider one), TLS, per-permission rate limits, and the database no longer shared with a person's app. Until then, a remote client reaches it only through a stdio bridge the person runs.

## Notes

- `search_memory` reads remembered lines without changing the memory files; `recall_knowledge` reads the core's accepted knowledge, which is another thing.

- One door process per permission at a time: a second one waits for the first one's run lease, then refuses its calls (not covered by a test yet).
- The door opens no database and holds no secret; the process serving its calls (the app, or `host`) holds the data folder's keys and its link to the core.
- Not on Windows yet: `serve` and `host` exit with "not supported on Windows yet" until the pipe has a per-user name, an access list for the current user only and a check of the server (tested on a simulated Windows in `test/door.test.ts`).

## Manifest

<!-- generated from backbone.module.json by scripts/module-readme.mjs; do not edit -->
| Field | Value |
| --- | --- |
| id | `io.github.albertoangulo/mcp` (surface) |
| version, licence | 0.0.0, Apache-2.0 |
| publisher | Backbone maintainers, namespace `io.github.albertoangulo` (github, pending) |
| stability | experimental |
| provides | MCP door (spec 2026-07-28, stdio) 0.x |
| consumes | Gateway 0.x |
| capabilities | planes: personal; effect classes: 3; operations: outbox.write; network: none; secrets: none |
| data | owns: none; migrations: 0; export: nothing durable: grants, effects and receipts belong to the core and the data home |
| depends on | @backbone-next/platform workspace, @modelcontextprotocol/server 2.4.0 (Apache-2.0), zod 4.6.7 (MIT) |
| conformance | bronze: `packages/surfaces/mcp/test/door.test.ts`, `packages/platform/test/gateway.test.ts`, `packages/surfaces/mcp/test/key-admission.test.ts` |
| exemption | remote transport: stdio only; HTTP with authorisation is not built (see README) |
| exemption | real clients: automated conformance uses the official MCP client, not live external AI clients; a separate Codex CLI trial is recorded for 26 October 2026 in README.md, while Claude Code, Hermes and OpenClaw remain untried live |
| removal | revoke its grants first; held UNKNOWNs stay with the core's gateway and their resolvers; refused while one of its effects is UNKNOWN |
<!-- end of generated block -->

## Select a route for a task

Call `solutions_options` with capabilities, network permission and spend category,
then `solutions_run` with those task limits and a stable clientKey. The running
app fixes the choice before asking and shows the chosen route, dispatch model, spend class, billing warning and task limits. A different named native model is refused before asking; select that model in Settings first. The question identifies the caller as an MCP client, then shows its claimed name (at most 60 characters), or says that no name was supplied. Only ask permission is accepted; a headless host cannot approve it. This cap binds the MCP tool call only. A client that can also run shell commands as the person can invoke the CLI or API line directly under their existing rules.
Use `read_thread` to inspect completion and the dispatch route in the turn's
selection, then `solutions_verify` to check named deliverables. A run returning
no started turn is an error with its setup or feasibility limitation. A lost run
has an unknown outcome and is never automatically resent. Client subscriptions and configured keys
do not establish unlimited quota or a separate API entitlement.

An optional evidenceQuery is a public topic or exact Arena record, not private
task text. BACKBONE_ARENA names its checkout. The platform calls the maintained
`npm run ask` query with npm offline and update checks disabled, preserves current dated comparison records and withholds expired decision text, marking it as needing revalidation. It never treats a catalogue pick as machine permission
or task fit, and leaves model routing inside the chosen engine.

The selection package test uses an official stdio MCP client, a real disposable
Host, a stand-in app confirmation and a scripted loopback model. This proves the
surface protocol and local execution path, not an installed app or live provider.
