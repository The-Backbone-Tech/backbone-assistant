# How to use the MCP door

**For:** a person or an agent (Claude Code, Codex, Hermes, OpenClaw) that wants to try Backbone's MCP door and see a receipt. **Time:** about a minute.

**Before you start:**
- Node 22.18 or newer and pnpm 10, with the repository installed (`pnpm install`; see [install and open the app](install-and-open-the-app.md), steps 1 and 2).
- Local listening and shared memory must be allowed. The door itself holds no secret and opens no database: it relays to the one process that holds the data folder's keys, the app, or for a test data folder `backbone-mcp host`, which starts an embedded PostgreSQL on `127.0.0.1` inside the data folder and listens on the data folder's door socket. Sandboxed agents (for example Codex's workspace sandbox) block one or both: `listen EPERM` means listening is blocked, and `initdb failed … shmget … Operation not permitted` means shared memory is blocked. Run the door outside that sandbox.
- **Sandboxed agents:** if your sandbox blocks listening on localhost, the first step fails with `listen EPERM`. Run it with that permission (for Codex, a profile that allows local networking; for Claude Code, outside the sandbox or with local binding allowed). The script needs no network, account or key.

## Steps

Blocks marked `bash test` run in CI through `pnpm guides`, which `pnpm check` calls.

1. Run the example. It makes a temporary test data folder (its keys in plain text, `BACKBONE_KEYS=plaintext`), starts its host, permits a door, talks to it with the official MCP client, writes one file through `outbox.write`, reads the projects through the host's api line, revokes the door and shows the next call refused. It stops the host and removes the data folder and its database at the end, even when a step fails.

   ```bash test
   node packages/surfaces/mcp/examples/try-door.mjs
   ```

   You see, abbreviated (receipt id, negotiated protocol version and expiry date differ):

   ```text
   1. Host: Serving the doors of <home>; stop with Ctrl-C.
   2. Grant: Granted door "try-door": outbox.write up to class 3, until <date>.
   3. Connected over stdio (protocol <version>); tools: effect_status, list_goals, list_projects, list_receipts, list_schedules, list_threads, propose_effect, read_thread, recall_knowledge, search_memory, search_threads, solutions_options, solutions_run, solutions_verify.
   4. propose_effect outbox.write: receipt <uuid>, outcome DONE.
   5. The file landed: outbox/hello.txt holds "hello from try-door".
   6. effect_status by idempotency key: DONE, the same receipt.
   7. list_receipts: 1 receipt, outcome DONE.
   8. list_projects, read through the host's api line: 0 project(s).
   9. Revoked door "try-door" (1 mandate(s)).
   10. After revoke the same door is refused: NO_MANDATE, and nothing was written.
   OK: host, grant, receipt, file, status, read, revoke and refusal all behaved as documented.
   ```

   Exit code 0 means all of it held. Any mismatch prints `FAILED: …` and exits 1.

   The three solution-selection tools are listed too. `solutions_options` and `solutions_verify` read through the host. `solutions_run` needs the running app's confirmation of that task and its limits, so this headless example cannot start a selected turn. The outbox permission does not authorize it.

2. Use the door from your own client on a test data folder: keep its host running, permit a door yourself, then point the client at it. The configuration is in [the door's README](../../packages/surfaces/mcp/README.md#use-it-alone). For the app's own data folder, connect the tool from the app instead (Settings › Assistants using this app): its keys are in the Keychain, so these commands refuse it.

   ```bash
   export BACKBONE_HOME="$PWD/.backbone-home" BACKBONE_KEYS=plaintext
   node packages/surfaces/mcp/src/main.ts host &
   node packages/surfaces/mcp/src/main.ts grant --name my-agent --operations outbox.write --ceiling 3
   ```

**Observed (10 November 2026):** Codex CLI 0.165.0 listed 11 tools, made a write accepted with a `DONE` receipt, and the file appeared in the outbox. After revoke, its next write was refused with `NO_MANDATE`. Claude Code 2.1.321 was signed out, so its connection, tools, write and refusal were not observed.

## Telling the failures apart

Only `DONE` is a successful call. Read `isError`, then `structuredContent.reason` and `structuredContent.value.outcome`.

| You see | It means | What to do |
| --- | --- | --- |
| `listen EPERM` at `host` or at the permission | The sandbox forbids the database listening on `127.0.0.1`, or the host listening on the data folder's socket. A transport problem, not a refusal. | Allow local listening, or run outside the sandbox. |
| `MCP error … connection closed` during `server/discover` or `initialize` | The door process exited before it could answer. Its stderr names the cause (a missing `--home`, a wrong `--grant`, a Node older than 22.18). | Run `node packages/surfaces/mcp/src/main.ts serve --home <home> --grant <name>` by hand and read the message. |
| `isError: true`, `reason: NOT_AVAILABLE` and `not running` | Nothing holds the data folder's keys right now: the app is closed (or, for a test data folder, `host` is not running). Nothing was sent. | Open the app (or start `host`), then call again; the door connects by itself. |
| A read tool's text starts `UNAVAILABLE`, with `reason: NOT_AVAILABLE` | The read could not reach the app (closed, an app whose api line does not carry that read, or a line that ended). Nothing was read: it does not mean the workspace is empty. | Open the app (or start `host`), then read again. |
| `outcome: UNKNOWN` with `reason: NOT_AVAILABLE` | The app stopped while the call was in flight; whether it happened is not known. | Once the app runs again, read `effect_status` with the same key; never propose it under a new key. |
| `held in the Keychain by the app` from `grant`, `revoke` or `host` | The data folder is the app's own: its keys are in the Keychain and only the app opens it. Nothing was permitted or revoked. | Connect or disconnect the tool in the app (Settings › Assistants using this app). |
| A `grant` that exits non-zero | The permission failed, so there is no door. A name can be permitted once: giving permission to it again is refused. | Use a new `--name`. A revoked name stays used, so its receipts keep pointing at the mandate that acted; to reconnect after a revoke, permit a new name. |
| `isError: true` and `reason: NO_MANDATE` | The door is up and the core refused: the permission was never made, was revoked, has expired, or `--grant` names another door. Nothing was sent. | If you did not revoke it, permit it under a new name using step 2. The refusal names `backbone-mcp grant`, which the installed app ships; in a checkout use `node packages/surfaces/mcp/src/main.ts grant` with step 2’s options. |
| `outcome: AWAITING_DECISION` | The effect is above the permission's ceiling. A person decides it in the app; it was not sent. | Decide it in the app, or ask for a lower class. |
| `outcome: UNKNOWN` (an error) | The door cannot tell whether the effect happened, for example it was killed mid-way. It is never resent. | Read `effect_status`, check the outbox yourself, and settle it; a retry with the same key stays `UNKNOWN`. |
| `outcome: REFUSED`, `FAILED` or `CANCELLED` | The core said no, the effect failed, or a revoke cancelled it. | Read the `reason` it returns. |
| `outcome: REFUSED` with `reason: outside_piece` or `above_piece_ceiling` | The door's own manifest does not declare that operation, or the class is above the one it declares (3). The permission cannot widen what the door declares. | Use an operation the door declares. |
| The door exits with `not the content its manifest declares`, `not a registered piece` or `granted for another version` | The door's files the host checks changed since it was permitted (edited, tampered, or upgraded). It does not open. | Review the change; for a new version, permit a new name with it. |

## What you now have

A door you saw work, with a receipt, a file in the outbox, a read, and a revoke that stops effects under its permission. A separately app-approved `solutions_run` is outside that permission. Reads also remain available: any program of your user can read the data folder's files anyway, so to stop a tool reading, remove its entry.

## What next

- The door's tools, tests and limits: [packages/surfaces/mcp/README.md](../../packages/surfaces/mcp/README.md).
- The example's source: `packages/surfaces/mcp/examples/try-door.mjs`.

## Protocol evidence, and why not the official conformance suite yet

The official suite (`@modelcontextprotocol/conformance`, checked 26 Oct 2026: `latest` 0.1.16, and 0.2.0-alpha.12 for the 2026-07-28 spec) tests servers over HTTP only; stdio support is an open upstream request (issue 258). The door ships over stdio, and most of the suite's server scenarios need fixture tools, resources and prompts the door deliberately does not have. A test-only HTTP front would measure a transport we do not ship, so it is not built. The door's protocol evidence today: the official MCP SDK client over stdio in `packages/surfaces/mcp/test/door.test.ts` (2026-07-28 and the 2025 handshake), and a live run in Codex CLI 0.162.1. Revisit when the suite runs stdio servers.
