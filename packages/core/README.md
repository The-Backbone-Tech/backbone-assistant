# Core (L0)

The system of record and its rules, as PostgreSQL 18 with forced row-level security: workspaces and principals, mandates and decisions, tasks and runs, one effect gateway with receipts, a hash-chained ledger, documents, knowledge and memory.
Every other piece reaches it only through its `gov.*` crossings (SQL functions) as the service role; it depends on the kernel package for cluster, durable-file and lock primitives, and `src/kernel` is a TypeScript twin of its mandate and effect rules for property tests.

## Schema evolution and traced reads

Start at the [schema source map](schema/README.md) and its generated [current definition index](schema/current.json). The frozen bootstrap remains executable history; a current definition may live in an explicit version. The bootstrap and its four released installers retain their original bytes. Later schema steps have closed manifests and statically imported release data; runtime installation never discovers SQL from a developer folder. [ADR 0003](../../docs/adr/0003-source-evolution.md) owns this distinction and historical receipt admission.

The material closure foundation records immutable candidate input evidence and receiving-run knowledge reads. Exact installation history selects a complete catalogue profile for all three material statuses, including unchanged historical coverage. A verified profile does **not** activate material-backed knowledge, decisions or output. The new typed recall admits only positively demonstrated native personal-message roots; unsupported producers and incomplete run lineage remain unknown outcome. The old two-column recall ABI and its structural source allowlist stay unchanged.

The Core client export `recallThroughBoundedTransport` calls the separately named typed crossing and keeps its six-column rows private until an actual COMMIT acknowledgement. Its adapter must own a dedicated client, bounded connection/query/lock timeouts, a checked parameter-logging policy and client closure on every outcome. It must propagate Stop without a historical-acknowledgement override. The helper captures inputs before transport setup, verifies the actual complete profile, refuses uncertain COMMIT without replay, and checks Stop again after asynchronous cleanup. A durable read identity records that read; it certifies neither complete receiving-run context nor permission for later use. Product consumers still need their own final admission before material activation.

## Use it alone

You need this repository installed (`pnpm install`). No app, platform, key or network: the core runs in an embedded PostgreSQL 18 on `127.0.0.1`.

Fastest check: `node packages/core/examples/try-core.mjs` creates a workspace, issues a mandate, claims a run, proposes one effect through the gateway, dispatches it as the system principal, reads its receipt, revokes the mandate and shows the next proposal refused, then stops the database and removes everything. Its expected output and a table of refusals are in [use the core alone](../../docs/how-to/use-the-core-alone.md), which CI runs.

### Where your script lives

Package names resolve only from inside the package. A script at the repository root, or anywhere else, fails with `ERR_MODULE_NOT_FOUND` on `import … from '@backbone/core/db'`. Either put the script in `packages/core/` (for example a file named my-script.mjs there; it runs from any working directory) or resolve the import by path from anywhere:

```js
const { enter, openPersonalDatabase } = await import(createRequire('/path/to/checkout/packages/core/package.json').resolve('@backbone/core/db')); // import { createRequire } from 'node:module'
```

### Keep everything inside one directory

`openPersonalDatabase({ dir, passwords })` keeps the whole cluster and its port in `dir`; nothing else is written. Its passwords are kept only by `passwords`, a keeper you pass (`read()` and `write(p)`, both async; the platform's seals them in the data folder's vault): without one no cluster is made, and PostgreSQL is given only their SCRAM verifiers. A `dir` made before keepers holds them in `secrets.json`; the first open moves them to the keeper, writes `cluster.json` durably (synced, with its folder) before it removes that file, and syncs the removal. A `pw` an interrupted `initdb` of an earlier version left (the superuser's password in the clear) is removed at every open. Both writers are `writeDurable` and `removeDurable` (`src/db/durable.ts`), a private copy of the platform's `src/files/durable.ts` that goes with the core at S9. The example makes its `dir` with `mkdtempSync(join(tmpdir(), 'backbone-try-core-'))`, and `tmpdir()` follows `TMPDIR`, so a run you point there stays inside the directory you chose and removes its own folder when it ends:

```bash
mkdir -p .scratch && TMPDIR="$PWD/.scratch" node packages/core/examples/try-core.mjs
```

Do this in a sandbox that only lets you write inside the checkout, to find a leftover with one `ls`, or to throw a run away with `rm -r .scratch`. `node scripts/no-leftovers.mjs <command>` does the same with a fresh `TMPDIR` and fails if a `backbone-*` folder or a database is left behind.

### The API recipe

Each call is a SQL statement inside `enter(client, actor)` (`import { buildBaseline, enter, openPersonalDatabase, reasonOf, serviceClient } from '@backbone/core/db'`). Permissions are from `packages/core/src/db/` and `packages/core/schema/`.

1. `const db = await openPersonalDatabase({ dir, baselineSql: buildBaseline().sql, passwords })` returns `{ appUrl, operatorUrl, stop() }`. `dir` is created on first use and reused later with the same keeper; call `db.stop()` at the end. The example's keeper holds the passwords in memory only.
2. `operator = new pg.Client({ connectionString: db.operatorUrl })`, then `SELECT * FROM operator.create_workspace(name, kind, owner_name, owner_email)` returns one row `{ workspace_id, owner_id, system_id }`.
3. `service = await serviceClient(db.appUrl)`. For each call, `await enter(service, actor)` (it runs `BEGIN`), `await service.query(sql, params)`, then `COMMIT`, or `ROLLBACK` when it throws. `actor` is `{ workspace, principal }`, `{ workspace }` for a worker, or `{ workspace, run: { id, secret } }` for a claimed run. A refusal is an error; `reasonOf(error)` names it.
4. As the person (`principal: owner_id`):
   - `gov.create_agent(name text, role text 'worker'|'verifier')` returns the agent id.
   - `gov.issue_mandate(subject uuid, parent uuid|NULL, projects jsonb, connections jsonb, tools jsonb, operations jsonb, ceiling smallint, max_tokens, max_cost_micros, max_duration_ms, max_effects, expires_at timestamptz, carrier text, intent jsonb DEFAULT '{}', piece uuid DEFAULT NULL)` returns the mandate id (the four limits may be `NULL`). A root mandate states what carries its work: `'piece'` with a registered piece, whose declaration then bounds that work, or `'direct'` (the person's own direct work, or code the installation trusts as itself, such as the platform's stub or a script like the example). A missing or inconsistent kind is refused (`invalid`); it is never inferred from a missing piece. A delegated one (`carrier` `NULL`) keeps its parent's kind and piece, and its runs take them too.
   - `gov.create_task(requested_by uuid, on_behalf_of uuid, title, goal, visibility)` returns the task id.
   - `gov.queue_run(task uuid, agent uuid, mandate uuid, routine uuid DEFAULT NULL, piece uuid DEFAULT NULL)` returns the run id. A run carried by a piece is bound to its registration here, for good (its mandate's piece when it has one).
   - `gov.register_piece(manifest jsonb)` (an owner or admin only; never a run, an agent or the system) records a module's or surface's id, version, sha256 digest and declared capabilities, and returns the registration id; `gov.unregister_piece(registration uuid)` ends one, refused (`unsettled`) while an effect it carried is `UNKNOWN` or still being sent.
5. As a worker (`{ workspace }` only): `SELECT fence, secret FROM gov.claim_run(run uuid, worker text, lease_ms int, carrier text, piece uuid DEFAULT NULL)`, with `carrier` `'direct'` here. The worker states what it runs; a run carried by anything else is refused (`other_piece`): a piece's worker never claims a direct run, nor a direct worker a piece's. `gov.claim_next_run(worker, lease_ms, carrier, piece)` selects only those runs before it locks any.
6. As the run (`{ workspace, run: { id, secret } }`): `gov.propose_effect(run, fence bigint, step int|NULL, tool, operation, connection|NULL, project|NULL, class_hint|NULL, external_hint|NULL, args jsonb, description, expected_version|NULL, idempotency_key)` returns the effect id. Reusing a key with the same change returns the same id.
7. As the system principal (`principal: system_id`): `gov.claim_effect(effect, lease_ms)` returns a claim, `gov.begin_dispatch(effect, claim)` returns `true`, you perform the effect, then `gov.observe_effect(effect, claim, 'succeeded'|…, external_ref|NULL, observation_hash|NULL, note|NULL)` returns the status.
8. Read the receipt as the run (or the person): `SELECT id, idempotency_key, operation, status, args_hash, observation_hash FROM app.effects WHERE id = $1`. `status` is one of `proposed`, `awaiting_checker`, `allowed`, `denied`, `claimed`, `dispatching`, `succeeded`, `failed`, `unknown` or `cancelled`; `observation_hash` is the hash you passed to `observe_effect`. The ledger rows behind it are in `app.ledger`.
9. As the person: `gov.revoke_mandate(mandate)` returns how many mandates ended; the run's next `propose_effect` is refused (`not_in_run`).

The same calls, who acts and what each does:

| Who acts | Crossing | What it does |
| --- | --- | --- |
| the installation's operator | `operator.create_workspace` | a workspace, its owner and its system principal |
| the person | `gov.create_agent`, `gov.issue_mandate` | a worker and its mandate: operations, tools, class ceiling, expiry |
| the person | `gov.create_task`, `gov.queue_run` | the work and a run under that mandate |
| a worker | `gov.claim_run` | the run's fence and secret; only the claimed run proposes |
| the run | `gov.propose_effect` | the gateway classifies, checks the mandate and the run's piece, and records the effect (`allowed`, `denied` or `awaiting_checker`) |
| the system principal | `gov.claim_effect`, `gov.begin_dispatch`, `gov.observe_effect` | the dispatch and what came of it; an outcome nobody can tell is `unknown` |
| the run or the person | `SELECT … FROM app.effects WHERE id = $1` | read the receipt: status, idempotency key, operation, args hash, observation hash |
| the person or an admin | `gov.register_piece`, `gov.unregister_piece` | a piece's declared capabilities, enforced on every run bound to it; a new version or digest is a new registration |
| the person | `gov.revoke_mandate` | the mandate and its delegation tree end; runs stop, undispatched effects are cancelled |

`openPersonalDatabase` (personal mode: one cluster in a folder, created on first use) and `serviceClient` (refuses a superuser or a role that bypasses row-level security) are the client side. `startTestPostgres` from `@backbone/core/testing` gives tests a PostgreSQL: inside a run that started a shared cluster (vitest's `globalSetup`, or `scripts/with-test-cluster.mjs`) a database cloned from that cluster's template, otherwise a throwaway cluster of its own. A folder holding `external.json` (`{ appUrl, operatorUrl }`) makes `openPersonalDatabase` use a database in a cluster someone else runs and start nothing; `prepareDataHome(home)` from the same module writes one, so a run needs one cluster instead of one per data folder.

The platform sends identity credentials as bind parameters, never inside SQL statement text. Local clusters set `log_parameter_max_length` and `log_parameter_max_length_on_error` to zero, including for existing local roles; they also disable parameter logging for `auto_explain`. The platform checks each connection before sending credentials and refuses an unsafe posture. An externally managed database must set these values to zero for its effective roles, disable `auto_explain` plan logging and `debug_print_plan`, set `auto_explain.log_parameter_max_length` to zero when loaded, and keep `pgaudit.log_parameter` off when present. Plans can embed bound values even when parameter logging is disabled. The external owner applies that policy; Backbone does not alter its server. This controls these PostgreSQL logging paths, not arbitrary server errors, extensions, proxies or logging of application data.

What is tested, and where:
- `packages/core/test/catalog.test.ts`: one file per object; no role is a superuser or bypasses row-level security; exactly the pinned stores, each with forced row-level security and the workspace wall; the service executes exactly the pinned crossings and writes no store directly.
- `packages/core/test/kernel.test.ts`: the kernel twin, with property tests (fast-check): a child mandate is the request intersected with its parent; classes decide the route and the rule of two; the effect lifecycle only moves forward.
- `packages/core/test/recall.test.ts`: knowledge recall honours each statement's validity window.
- `packages/core/test/pieces.test.ts`: a piece is registered by an owner or admin, never by its own run, agent or the system principal, and never under a git reference; an operation it did not declare (`outside_piece`) or a class above its highest declared one (`above_piece_ceiling`) is refused although the mandate allows it; a run and a mandate keep their piece; unregistering is refused while one of its effects is `UNKNOWN`; a wider upgrade widens no live run or mandate; and a worker claims only runs bound to the piece it runs.
- `packages/core/test/sweep.test.ts`: a dispatch whose dispatcher went silent becomes `UNKNOWN` only once its own claim has lapsed, and a late observation settles it once.
- `packages/core/test/testing.test.ts`: the test support itself: one shared cluster per run, a database of its own for each file and each prepared data folder (under the same name too), and a prepared data folder that starts no server.
- `oracle/` (the promise tests, `pnpm oracle`): isolation, mandates, effects, ledger, promotion, rule of two, lessons and the journeys through a black-box adapter. The 9 November 2026 run passed all 271 implemented cases: the versioned summary is `oracle/results/successor.json` (explicitly excepted from `oracle/.gitignore`), with the execution log retained at `evidence/material-withdrawal-20261109/unit2-oracle-final.log`. Attack scenes and CLI lifecycle remain unimplemented adapter families, so `pnpm oracle` still exits 1 and does not claim full-platform conformance. The adapter now supplies message evidence for generic promotion fixtures and an explicit plaintext vault for disposable headless journeys. Re-arming a crash point stops its previous service before starting another Host. Amendment A-3 keeps a shared task’s write held, matching the already qualified Core audience check; no assertion was weakened or skipped.
- `packages/core/examples/try-core.mjs`, run by `pnpm guides`: the recipe above, end to end.

## Knowledge source checks and upgrades

Knowledge source checks currently use a conservative temporary rule: only message and web evidence is eligible for promotion and agent recall. File, document, MCP and uncertain provenance is held, including knowledge accepted before this guard. Run reads are bounded by the immutable ledger sequence at proposal time; later reads do not rewrite a proposal's lineage. Run-less agent proposals are ineligible. Person records and rejection remain available; a held candidate, decision or verification receipt is never deleted.

`openPersonalDatabase` returns `materialGuard` independently of the data folder's availability. Owned data folders install `material-source-guard-v1` atomically under the same target-database advisory lock as fresh installation. Compiled catalogue fingerprints recognize the reviewed legacy definition family and the guarded family; a whole-baseline checksum alone gives no permission. The frozen step is extracted from the shipped baseline, takes bounded table locks, and commits its definitions and checksum together without rewriting tenant rows. A busy, unknown, mixed or changed installation pauses promotion and recall while other work opens. Every open rechecks function bodies, caller and input-freeze triggers, enabled states, policies, views, indexes, owners and privileges. External databases receive no DDL: their service role must be able to inspect the same definitions and the narrow read-only `app.material_guard_history` view.

The supported legacy control is frozen from `f9cf2c9` in the platform upgrade fixture. Qualification uses disposable data folders, including pending approvals, verifier queues, legacy insert bodies, concurrent ledger ordering, post-DDL SQL failure and termination of the installer backend. The 9 November 2026 catalogue-only survey used private copies of six stopped real data folders: two match the complete legacy function and object profile, one current-lineage data folder has an older `gov.record_source` and stays paused until general Core migrations, and three pre-pivot data folders are outside this Core family. No original database was started or changed. This qualifies the guard's specific definition family, not general application compatibility with every older schema. Older installed function bodies containing CRLF also pause rather than being silently rewritten.

On a busy data folder, policy DDL needs strong table locks; the episodes index is built in the same transaction, not concurrently. A lock timeout (2 seconds), a deadlock or an index build exceeding the 30-second statement limit rolls back the entire step. Three bounded attempts can finish paused; the next open retries. No zero-downtime or unbounded-size upgrade is claimed.

For an external database, the DBA procedure is:

1. Keep the installation's normal recovery copy and use the matching shipped baseline and package. Inspect the catalogue first; an unknown family requires its own reviewed migration, never edited pins or a fabricated history row.
2. From the DBA's controlled installer connection, call `upgradeMaterialGuard(adminClient, shippedBaselineSql)`. The connection must pass the installer check (currently superuser). The function owns the advisory lock, frozen SQL, table locks, checks and history transaction. Do not apply selected function bodies or permission execution to PUBLIC. The service role receives only the reviewed helper privileges and SELECT on `app.material_guard_history`.
3. Check the returned status, reconnect as the service role and call `verifyMaterialGuard(appClient)`. Reopen the Host so its cached status is verified again. A missing view, changed definition or unknown history stays paused; the reason is written once to the Host's diagnostic stderr. History can reject an installation and never replaces installed-definition verification.

Run SQL views additionally retain their audience and trust restrictions; recall remains the existing crossing for accepted workspace knowledge and marks untrusted words. Eligibility is shared, not a promise that those consumers expose identical row sets. The verifier queue now also drops an orphaned decision if one exists: its former FOUND check was overwritten by session-setting work; ordinary rows retain their ordering and held promotion rows stay unchanged. Cross-run ancestry and the public set-returning policy helper's cost remain outside this temporary guard's lineage and recall cost proof.

This guard does not deliver the permanent store-to-Core withdrawal protocol, and it must not be removed merely because an outbox receipt exists. Fresh registration after restoration and decision-time rechecks still belong to that protocol. No runtime promotion caller is present today; a new proposer or direct knowledge reader must be included in the capability audit before it is enabled.

The additive material journal is a separate capability, `materialLink`. Its system-only crossings
`gov.withdraw_material_source` and `gov.record_material_source_read` retain withdrawal events and
typed preparation receipts in three governor-only, append-only stores. Withdrawal does not need a
prior episode. Exact retries return the original receipt; a different payload under the same key
is a conflict. A restored source uses a new generation only after Core has the complete prior
withdrawal prefix. Both journal crossings require READ COMMITTED isolation, including exact
replays; other isolation levels pause without recording. Old episodes, receipts and tombstones remain. An incomplete historical prefix
pauses registration; no counter, migration or acknowledgement fabricates its missing events.

The trusted recorder supplies project/material identity, immutable version, original-byte hash,
transformation, episode text and adapter-prepared text. Core hashes the latter two separately. It
does not prove the original filesystem bytes, actual restoration, delivery to a model or current
permission to use the material. A preparation retry after withdrawal is refused even if its first
transaction committed: refusal is not proof that no receipt exists. Material identities bind to
one project in the workspace; a conflicting project is a terminal conflict, never an invitation
to retry or silently rebind it. The Host must make those states visible when composing delivery.

`upgradeMaterialLink` installs the journal under the same target-database lock, after the source
guard's recorded prerequisite. It creates each object as its owning role and commits DDL and
history together. `verifyMaterialLink` uses catalogue reads only; external owners apply upgrades
explicitly and reconnect their consumers. Function owners, definitions and privileges, table
walls, constraints, defaults, triggers, indexes and role posture are pinned. Unknown or partial
installations pause this capability. History follows the compiled dependency order; a rollback
binary that does not recognize a later receipt pauses rather than guessing compatibility.
This profile targets PostgreSQL 18 with the installation's dedicated roles. It includes role
memberships touching those roles; a managed database with different administrator memberships
needs its own reviewed profile. Older PostgreSQL catalogues are not qualified. Installer and
verifier status alone never prevent a fresh baseline creating its objects: unqualified development
baselines must be used only in disposable data folders until their source and catalogue pins are frozen.

Typed file and MCP producers compose the journal with a separately pinned insertion-enforcement
step. Its deferred ALWAYS trigger refuses new raw MCP episodes and reserved `material:` file episodes
without their own atomic live binding. The check runs at validation: normally COMMIT, or earlier
under explicit immediate constraint validation. Historical unbound episodes remain unknown.
The Host verifies the original bytes and selected preparation, retains connector responses before
registration and keeps uncertain observations withheld for an explicit person decision. These
mechanisms are described in the [connector contract](../../docs/contracts/connectors.md).

The complete withdrawal protocol still needs fresh decision, recall and final-use closure. The
temporary message/web promotion and recall allowlist stays. Neither insertion enforcement nor a
historical receipt permits activating material promotion, recall or repository use.

Not built: an export command, a skills store and sealed secrets (the platform's credential store stands in). `schema/baseline.json` still owns the per-object baseline; the source guard, additive material journal and insertion enforcement are separately pinned upgrades.

## What it replicates, from whom, when

- PostgreSQL with forced row-level security as the system of record (decided by the distribution's radar, `backbone-way:radar/plat-data-store.json`, evidence dated 23 Oct 2026: PostgreSQL 18.6 tagged 11 Aug 2026; the embedded build used here, `embedded-postgres` 18.4.0-beta.17, published 5 Jun 2026).
- Idempotency keys as payment APIs use them (Stripe's `Idempotency-Key`): the same key always names the same effect. A September 2026 study (arXiv 2609.29095, 24 Sep 2026) found required keys on every write cut duplicate effects from 28% to 4% (`backbone-way:radar/plat-durable-execution.json`).
- A per-workspace hash-chained ledger whose receipts can convert to whichever IETF receipt draft is adopted; `draft-marques-asqav-compliance-receipts-08` (31 Aug 2026) is the field reference (`backbone-way:radar/plat-receipts-ledger.json`, evidence dated 25 Oct 2026).
- The fixed floor in database roles and policies rather than in a reviewer model (`backbone-way:radar/cap-12-structural-trust.json`, 25 Oct 2026).

## Why

The guarantees that must hold whatever model, engine or app is in front (authority only narrows, every outside action passes one gateway and gets a receipt, an `UNKNOWN` is never resent) live in structure: roles, row-level security, crossings and constraints, proven by tests. A sentence in a prompt cannot enforce them. Keeping them in one small, strict piece lets everything around it change.

## Swap it

Another core may replace this one if it passes the promise tests: write an adapter in `oracle/adapters/` (the `Target` port in `oracle/target.ts`) and run `pnpm oracle`. The platform reaches the core only through its crossings (`packages/platform/src/composition/core.ts`), so that file and the adapter are what a replacement touches. The data can move to any PostgreSQL host that keeps the same schema and roles.

## Remove it

It is not removable: every other piece stands on it. To leave, stop the pieces that use it, settle any `UNKNOWN` effects, then keep or delete its cluster (a data folder's `pg` folder, or your own PostgreSQL database). Nothing outside it holds its rows.

## Manifest

<!-- generated from backbone.module.json by scripts/module-readme.mjs; do not edit -->
| Field | Value |
| --- | --- |
| id | `io.github.albertoangulo/core` (core) |
| version, licence | 0.0.0, Apache-2.0 |
| publisher | Backbone maintainers, namespace `io.github.albertoangulo` (github, pending) |
| stability | experimental |
| provides | gov crossings (SQL functions on PostgreSQL 18) 0.x, kernel twin (TypeScript model of mandates and effects) 0.x |
| consumes | none |
| capabilities | planes: personal, team, company; effect classes: none; operations: none; network: none; secrets: none |
| data | owns: workspaces, principals and sign-in (schemas app, auth), mandates, decisions, tasks, runs and their steps, effects and their receipts, the hash-chained ledger, documents and their versions, knowledge, memory, routines, channel threads, queues and installation state (schema ops), piece registrations: each module's or surface's declared capabilities and digest; migrations: 2; export: not built: an export of the ledger as JSONL and the data as a SQL dump is planned |
| depends on | @backbone-next/kernel workspace, embedded-postgres 18.4.0-beta.17 (MIT), pg 8.23.0 (MIT), pg-connection-string 2.14.1 |
| conformance | bronze: `packages/core/test/catalog.test.ts`, `packages/core/test/kernel.test.ts`, `packages/core/test/pieces.test.ts`, `packages/core/test/recall.test.ts`, `packages/core/test/sweep.test.ts`, `packages/core/test/testing.test.ts`, `oracle/runner.mjs` |
| exemption | promise tests on every change: pnpm check runs the core's own tests; the promise tests run apart (pnpm oracle), and scenes and lifecycle are not implemented for this core |
| exemption | export: no export command yet; the data lives in one PostgreSQL cluster |
| exemption | secrets: the core keeps its own database passwords beside the cluster (an owner-only file) and run secrets; it hands no secret value to another piece or a model |
| exemption | skills and sealed secrets: listed as core responsibilities, not built in this schema yet; the platform's credential store stands in for sealed secrets |
| removal | not removable: every other piece stands on it; it is replaced whole by a core that passes the promise tests, once its UNKNOWN effects are settled; refused while one of its effects is UNKNOWN |
<!-- end of generated block -->
