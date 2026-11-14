# effect-gateway contract (DRAFT 0)

**Owner:** integrator (core).

**Layer:** L0.

**Status:** have. Egress descriptors (A15) are thin. The undo ladder is not yet stated as one rule.

## Purpose

Every action outside Backbone's own state goes through one door. That door decides, dispatches, observes, reconciles and offers a way back sized to the action's finality.

That is the design goal. The code does not yet meet it everywhere: [Coverage per configuration](#coverage-per-configuration-5-november-2026) says which effects pass through the door today and which do not.

## Owns

- effects, effect classes and idempotency keys;
- approvals;
- taint and source marks;
- egress descriptors;
- unknown outcome records and their resolvers.

## Provides

- `gov.propose_effect`;
- decide (through PolicyDecision and mandates);
- claim;
- `gov.begin_dispatch`;
- observe;
- receipt;
- reconcile;
- undo or cancel, depending on class.

## Consumes

- mandates-decisions;
- work-ledger;
- the PolicyDecision port;
- secrets (handles resolved at dispatch only).

## Rules

- Classes only rise. An unknown target is treated as class 3 or higher.
- Rule of two: untrusted ∧ private ∧ external ⇒ the arbiter (R-GOV-R2-01, which waits on memo 08).
- An effect is idempotent, or queryable, or neither. "Neither" ⇒ unknown outcome until reconciled; it is never resent, and the exact copy is denied (M0152).
- Every unknown outcome has a resolver, its evidence and a deadline.
- Each GUI action from the HostAgent port is an effect with before and after receipts (R-HOST-02).

## Acceptance

- R-BASE-04, R-GOV-UNDO-01, R-GOV-R2-01 and R-HOST-02.
- Tests: the recovery suite and `backbone-oss:packages/evals` injection scenarios.
- **Adverse case:** the acknowledgement is lost after dispatch. The effect becomes unknown outcome, the gateway refuses a retry and shows the resolver.

## Exit test

Not replaceable. Module removal checks this piece for held unknown outcome of the module's classes.

## Change procedure

ADR plus a cross-model review, and mutation tests on the lifecycle (guardrail 15).

## Required by the oracle's legacy deviations (P-04)

- **L7b → R-EFF-DEDUP-01.** WHILE an earlier attempt at an external change is unknown outcome, a proposal of the **same change under a new key** SHALL be refused for **every** external effect, not only for `mcp.*` connector changes. "Same change" means the same meaning: target, operation, content and expected version.
  - **Legacy deviation:** `crm:update_deal` proposed again under a new key is allowed and claimable.
  - **Adverse case:** propose `crm:update_deal` and lose the acknowledgement, which makes it unknown outcome. Then propose the same change under a new key: it is refused, with a link to the original.
- **L9 → R-EFF-UNK-01.** Every unknown outcome SHALL carry a **named resolver** (a person or role), its **evidence** (the observation hash) and a **deadline**. When the deadline passes, the resolver is escalated.
  - **Legacy deviation:** any dispatcher or admin may settle it, and there is no deadline.
  - **Adverse case:** an unknown outcome past its deadline appears in the resolver's inbox and escalates. An unknown outcome created with no resolver is refused.

## Oracle spec gaps the successor must close (P-04)

- **SG-EFF-01.** "The effect record is reachable only through the gateway" is the successor's own structural test. The oracle keeps the behavioural half: the service cannot insert, update or delete an effect row.
- **SG-EFF-02.** Either provide a named crossing that imports or restores historical effect records, or state that several unresolved records of the same exact change cannot exist (the gateway never admits the second), in which case the deterministic earliest-match rule becomes the successor's migration test.
- **SG-EFF-03.** Provide an adapter signal that a held or in-flight call is waiting on another session (for example, `hold` reports "blocked"), or a lock-wait view.
- **SG-EFF-04.** Either provide an adapter verb to open a session at a stated isolation level, or state that isolation is adapter-internal.
- **SG-R2-01.** Provide a seeding port (or a bulk fixture crossing) for many finished runs in one task. Carrying earlier runs' taint marks into a new run must stay within a latency budget that the contract states.
- **Narrowed cases**, to make direct in the successor:
  - a session that carries both a principal and a run;
  - a gateway hash defined by the contract rather than as sha256 of jsonb text;
  - queue membership observed through `claim_next`, and the 30-second grace period waited out;
  - the ACL purpose asserted behaviourally instead of by catalog introspection;
  - the replayed copy staying denied after reconciliation;
  - the lock wait (SG-EFF-03).

Source: P-04 `oracle/RESULTS.md` on branch `claude/p04-core-oracle-2d71c1` at `15538047`, 23 Oct; cross-family review pending.

## Added 23 Oct (routines and stale dispatch)

- **Occurrence keys (R-ROUT-OCC-01).** A routine occurrence's effect uses `occurrence_key = hash(routine_id, scheduled_slot)` as its idempotency key. The gateway refuses a second claim of the same key, and forwards the key to destinations whose capability manifest (R-EFF-CAP-01) accepts one: Stripe `Idempotency-Key`, Slack `client_msg_id`, email `Message-ID`. Duplicates at destinations without idempotency are the recorded residual (R-ROUT-RESID-01).
- **Stale dispatch (R-EFF-STALE-01), recorded as correct.**
  - A dispatching effect whose lease is lost stays dispatching through a grace window, then returns as stale, with its claim, for inspection. It is never resent.
  - Legacy window: 30 s after `lease_expires_at` (`0054_verifier_model_infer.sql:562`).
  - The successor states its own window here.


## Successor status (S1-02, 24 Oct 2026)

- **L7b → R-EFF-DEDUP-01: closed.** While an earlier attempt is unknown outcome, the same change (task, beneficiary, operation, connection, arguments, expected version) under a new key is a denied receipt (`repeat_unknown_blocked`) linked to its original, for every external change above class 1. Connector changes are also blocked while the original is still in custody (`repeat_pending`).
- **L9 → R-EFF-UNK-01: closed.** An unknown outcome carries its resolver (the person the effect was for), its evidence (the observation hash) and a deadline 24 hours on; a CHECK refuses an unknown outcome without them. Past its deadline it is listed as overdue, and its resolver, the dispatcher or an owner or admin settles it; anyone else is refused.
- **R-EFF-STALE-01: the successor's window is 30 seconds** after the lost dispatch lease (`gov.claim_next_effect`).
- **Gateway hash.** SHA-256 of the canonical jsonb text of the arguments (`sec.args_hash`).
- **SG-EFF-01: closed** (the pinned lists show the service writes no store; the oracle's behavioural half passes).
- **SG-EFF-02: retired, 24 Oct 2026, by statement.** Several unresolved records of the same exact change cannot exist: the gateway admits none after the first, and a deferred lineage trigger refuses forged copies.
- **SG-EFF-03, SG-EFF-04: retired, 24 Oct 2026, by statement.** Lock waits and isolation levels are adapter-internal; every crossing that must see another's writes first takes its workspace's ledger head.
- **SG-R2-01: open.** No bulk seeding port or stated latency budget yet for carrying many earlier runs' marks.
- **R-ROUT-OCC-01: open.** Occurrence keys belong to the routines slice; the gateway already returns the same effect for a repeated key and refuses a reused key for different content.

## Added 25 Oct (silent dispatchers, pilot/mcp-door)

- **`gov.settle_lapsed_dispatch`.** The system principal settles a dispatch whose dispatcher went silent, by inspection, in one crossing under the effect's lock: only once the effect's own dispatch claim has lapsed (its lease plus the 30-second grace of R-EFF-STALE-01), never on a run's lease or status. It records succeeded if the inspection found it landed, unknown outcome otherwise (with resolver and deadline), or leaves a live dispatch alone.
- **Late observation.** `gov.observe_effect` under the claim such a sweep closed may settle that unknown outcome once, as succeeded or failed, recording who settled it (`settled_by`). It never resends. Otherwise unknown outcome leaves only through `gov.reconcile_effect`. Tests: `packages/core/test/sweep.test.ts`.

## Pieces (26 Oct 2026)

- **Act-time ceiling.** A run bound to a registered piece (`app.runs.piece_id`, set when it is queued, never changed) is denied an effect whose operation the piece's manifest does not declare (`outside_piece`), whose class is above its highest declared class (`above_piece_ceiling`), or whose piece was unregistered (`piece_unregistered`), whatever its mandate allows. Only a run of the recorded `'direct'` kind answers to its mandate alone; any other run without a standing piece is denied (`no_carrier`). Tested in `packages/core/test/pieces.test.ts`.
- **Removal.** `gov.unregister_piece` is refused while an effect of a run bound to the piece is `unknown` or `dispatching`.

## Coverage per configuration, 5 November 2026 (native account route updated 13 November)

Original observation from integration `ddd77b0`; the native account exception follows the [engine contract](harness.md#native-codex-account-tools-13-november-2026). Other rows retain their dated scope; paths are relative to `packages/`. "Gated" means held, released once, and unknown outcome never resent. "Contained" means limited by a sandbox, not decided by the door. The send-time withdrawal check (`stillAllowed`) stops a model request that would carry a withdrawn source. It is not the door.

| Effect | Pi | Codex (native, default environment `full`) | Person's MCP and plugin servers | Triage | Routines, goals, API line |
| --- | --- | --- | --- | --- | --- |
| Document writes | Gated (`platform/src/composition/harness-turn.ts` `gateway.write`) | Gated: staged drafts import through `writeIfVersion` | Not applicable | Gated (draft) | Gated: same turn path; API-line writes need the person's confirmation |
| Connector tool effects | Gated: held, released once (`platform/src/connectors/service.ts`) | Host connectors: same as Pi. Native MCP/apps/plugins in full use Codex's permissions, outside this gateway; hooks remain off | Gated | Label and move gated; no send capability | Same as the engine |
| Connector reads | Not gated: called directly, recorded afterwards | Same as Pi | A tool that wrongly claims to be read-only runs ungated unless its name is blocklisted | Mail reads gated | Same as the engine |
| Shell and processes | None offered | Contained: workspace-write sandbox on the stage, no command network. The filesystem is probed; network is set by configuration only | Not gated: server processes run unsandboxed with the person's rights, and the person's own servers start to list tools before enabling | Same as the engine | Same as the engine |
| Model requests | Withdrawal check on the first request of a turn only | Withdrawal check on `turn/start` only; not on steering or subagent traffic | Not applicable | No withdrawal check passed | Same as the engine |
| Web search | None | Not gated: live search through the provider | Server-dependent | Same as the engine | Same as the engine |

**Gaps to close or to accept explicitly**, each as a queue item in Backbone's Execution:
1. **Read-only turns.** Fixed on `claude/readonly-writes-20261105`. A reviewer child or judge turn writes nothing, whatever its engine offers: `performWrite` refuses before any effect is recorded, checkpoints are not imported, restart recovery cancels its undispatched writes instead of finishing them, and a connector tool that has become an action is refused rather than held. Nothing it was shown becomes the person's memory. It may still read: a connector read is recorded as a source document, as in every turn, because withdrawal and provenance depend on that record. Under Codex it keeps its sandboxed shell, web search and subagents, whose changes reach only the stage.
2. **The withdrawal check covers only the first model request.** It does not cover later requests in Pi's loop, Codex steering or subagents, and triage turns pass none.
3. **Connector reads and server processes are outside the door.** This is the documented position for reads. Starting a person's own server to list its tools is a process start before enabling; plugin servers already wait.
4. **Live web search under Codex `full` sends query text to the provider.** The environment allows it on purpose; the gap is that it is not stated as an outside effect.
5. **unknown outcome:** whether Codex's own process writes memories in its own data folder directory despite ephemeral threads, and whether command network isolation holds physically, since only the filesystem is probed.
