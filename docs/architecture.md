# Guarantees and trust limits

The [source map](map.md) owns pieces and dependency direction. This page owns the
invariant IDs used by contracts and conformance jobs, and the trust boundary.
Source read on 10 November 2026; the pointers below identify code or contracts,
not a claim that their suites were rerun on this head. A design requirement is
not a delivered guarantee. Older architecture tables mixed prior repositories
and proposed modules; those tables are superseded by the source map.

## 3. Invariants

The invariant statements retain their identifiers. Current evidence and gaps replace
old-repository line numbers so a reader can find their owner in this checkout.

| ID | Invariant | Current owner or limit |
| --- | --- | --- |
| I-1 | No context, no rows. Every table has forced RLS and a restrictive workspace wall. | [Identity contract](contracts/identity-tenancy.md); `packages/core/test/catalog.test.ts` |
| I-2 | The service refuses superuser and BYPASSRLS roles. | [Core connection checks](../packages/core/README.md); `packages/platform/src/composition/core.ts` |
| I-3 | Authority only narrows: child = request ∩ parent. | `packages/core/test/kernel.test.ts`, `packages/core/test/pieces.test.ts` |
| I-4 | Maker ≠ checker, across the whole delegation tree. | [Mandates and decisions](contracts/mandates-decisions.md) |
| I-5 | Effects pass one gateway, and their classes only rise. | [Effect gateway](contracts/effect-gateway.md) |
| I-6 | An unknown outcome is never success and is never resent. | [Effect gateway](contracts/effect-gateway.md); interrupted-effect tests in `packages/platform/test/` |
| I-7 | Taint marks only rise; untrusted ∧ private ∧ external ⇒ arbiter. | [Effect gateway](contracts/effect-gateway.md); no general egress sandbox claimed |
| I-8 | The ledger is append-only and hash-chained, and stores references, never words. | [Work ledger](contracts/work-ledger.md); [audit export](contracts/audit-export.md) |
| I-9 | Accepted knowledge changes only through promotion. A row a principal may not see is not returned at all; it is never masked. | [Knowledge and memory](contracts/knowledge-memory.md) |
| I-10 | Models see secret handles, never values. | [Secrets](contracts/secrets.md); [key provider](../packages/platform/src/system-keys/README.md) |
| I-11 | Skills and read content never give authority. | [Skills](contracts/skills.md); [runtime agent guidance](for-agents.md) |
| I-12 | Automatic change never widens authority. | Design requirement; no general self-change proof |
| I-13 | Surfaces cannot write core state. | `scripts/structure.mjs`; platform API entry points |
| I-14 | A child thread's mandate and mode are at most its parent's; reviewers are read-only. | [Thread orchestration](contracts/thread-orchestration.md); no general reviewer-isolation claim |
| I-15 | Configuration resolves once per session from ordered layers: platform, distribution, organisation, workspace, project, user, session. Any layer may tighten. Only designated layers may loosen, and each loosening writes a permission record. The resolved view names the layer that supplied each key. | Design requirement; full layered resolver not built |
| I-16 | Enforcers do not share the agent's failure domain. The door, egress proxy, database, reviewer and ledger run under separate identities and processes. Executors run in Backbone's sandbox behind the egress proxy. | Partial: separate MCP relay; trusted in-process pieces and same-user database access remain (below) |
| I-17 | Budgets are charged to every ancestor in one transaction, and are held before the effect (two-phase hold). | Design requirement; lab SQL is not proof of the ordinary app path |
| I-18 | An approval binds an exact content hash and is given in-app with a passkey. | Partial: connector permissions have exact definitions; [permission contract](contracts/standing-signature-ledger.md). No universal passkey approval claim |
| I-19 | Models are pinned per action. | [Engine contract](contracts/harness.md); no runtime best-route selection claim |

## Pieces in the host's process: the trust boundary

- **A piece that runs in the host's process is trusted, pinned code.** Today that is `harness-pi` inside the app's or a test's host. The load-time check (`packages/platform/src/composition/pieces.ts`, `snapshot.ts`) detects tampering at rest: changed files, a forged manifest, an upgrade nobody registered and permitted, a link or an unchecked file in the import graph, a `data:` or network import. It does not contain a hostile piece at runtime: code in the same process can undo any check made there (`createRequire` from an outside path, `chmod`, its own hooks). It is defence in depth, not a sandbox.
- **The authority guarantees live in the core** and hold whatever the loader does, for work that reaches the core through a run's own session: the gateway refuses an effect outside the mandate intersected with the run's registered declaration, checked in the database.
- **They do not bound an in-process piece today.** Such a piece can reach credentials far wider than its run's:
  - the host's live connection pool, which acts as the service role and states any principal of the workspace (the person, the system principal) through session settings;
  - the vault the host opened: personal mode's database passwords, including the superuser's, which bypasses row-level security and every crossing, and the master key of the sealed model credentials. On disk they are sealed in `<data home>/keys/vault.json` under a data key the Keychain's key wraps for the app (`packages/platform/src/keys/vault.ts`); in the host's memory they are in the clear;
  - `<data home>/core.json` (the person's, system's and worker's ids).

  An in-process piece can therefore act as the person or as the database superuser, so a mandate and a declaration constrain it only while it is honest.
- **An untrusted piece must run out of process:** in its own process under an OS sandbox (the work-planes lab's design adopts Anthropic's `sandbox-runtime`; Node's permission model is not a boundary), with no access to the data folder, talking to the host over its port and acting only through a run's session, as the MCP door already runs as its own process. The lab owns that sandbox and its egress door (`work-planes-lab:docs/SECURITY.md`, step 4); Backbone adopts it through its ports and builds no second design.
- **The same bound holds for the AI tools a person connects.** Their entries start the door inside the app bundle, which macOS code signing and App Management protect from other apps once the app is signed, and they are connected only on the person's click in the main process. The door holds no secret and opens no database: it relays its four gateway calls over the data folder's socket, in a folder only the person's user may enter, to the running app, the one process holding the data folder's keys, which carries them out on its own link (lab S18; `packages/platform/src/composition/doors.ts`). The socket carries only an existing permission's calls, never a permission, a revoke or another control. With the app closed, every call is refused as not running and nothing is sent.
- **The command line reaches a real data folder through the app, on a line of its own.** It holds no key. The api line carries reads and stop for any process of the person's user, and each send, queued message, goal set or run and schedule only after the person's click for it in the main process (ADR 0002, `packages/platform/src/composition/api-line.ts`). The personal app and daemon also explicitly enable bounded creation of an empty local project and attachment of an original without a click; company sign-in requires both in the signed-in app. Other methods are refused before the host hears of them.
- **What a tool running unsandboxed as the same user (Claude Code, Codex, a script) can still reach.** Not a password, the master key or a model key in a file of the data folder: the vault is wrapped by the Keychain through Electron's `safeStorage`, PostgreSQL holds only SCRAM verifiers, and an existing data folder moves its plaintext files into the vault once (tested in `packages/platform/test/keys.test.ts`, `packages/platform/test/doors.test.ts` and `packages/surfaces/mcp/test/door.test.ts`). It can still:
  - rewrite its entry, or the app's files while the app is unsigned;
  - work on the cluster's own files, which belong to the person: read every row at rest, or stop the server and open the files with PostgreSQL in single-user mode, which asks for no password. Only a separate identity for the database, or the tool's sandbox, closes that;
  - while the RunAsNode fuse stays on (the door's launcher runs on the app's own runtime as Node), run code the Keychain takes for the app and so unwrap the vault; until the app is signed with hardened runtime, attach to it as well;
  - find the old plaintext files in copies made before the migration (backups, snapshots).

  The next steps, in order: sign and notarise the app with hardened runtime; move the door to its own runtime; then turn the RunAsNode, NODE_OPTIONS and inspect fuses off (`packages/platform/README.md`, "Secrets at rest"). The rest waits for the lab's sandbox.
- **Until then, no third-party piece.** The host loads only the built-in pieces named in `PIECES` (`packages/platform/src/composition/pieces.ts`), fixed in code and never taken from a manifest, so a piece that is not built in is refused before it is registered or imported. Widening that list to a piece Backbone did not ship waits for the out-of-process sandbox.


The integrated [offline thread workspace](contracts/workspace.md) has a separate
macOS execution boundary and lifetime. It does not sandbox the Host or turn a
native engine's wider environment into that workspace. Its qualification and
limits are owned by [the workspace guide](how-to/use-a-thread-workspace.md).
[ADR 0003](adr/0003-source-evolution.md) owns immutable Core bootstrap and explicit
schema versions; material-closure installation does not activate material use.

## Replacing a piece

Read its contract and removal rule first. Pending or unknown effects must keep
their history; absence of a removal guard is a gap, not permission to erase it.
[Manifest registration](repo-design.md#manifests) binds code and declared capability.
A digest check is not runtime confinement. Contracts and tests must establish a
replacement's behaviour; another brand name does not change these obligations.
