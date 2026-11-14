# Kernel (L0, v0.8)

The v0.8 kernel's SQL, byte for byte from the kernel lab (`work-planes-lab:`, `prototype/packages/db/migrations-v08/`) at the commit `sql/pin.json` names. The provisioner installs it. The embedded PostgreSQL 18 primitives every cluster in this repository starts from live here too.

At the pinned commit `e0357a1e`, the SQL was independently accepted with conditions on 2 November 2026. The evidence is in the lab at `prototype/packages/db/spec/evidence/acceptance-e0357a1e/`. The conditions are host obligations: the door classifies effects correctly, the cap is checked immediately before sending, the destination is fenced, and no pool sets `query_timeout` unless it discards timed-out connections. Whoever drives the kernel carries them.

| File | What it is |
| --- | --- |
| `sql/*.sql`, `sql/pin.json` | The pinned SQL and its sha256 per file. `kernelSql()` recomputes the digests on every load and refuses other bytes. |
| `src/provision.ts` | `provisionKernel(adminUrl)` applies the SQL to an empty database and makes three logins: `backbone_app`, a door login holding `planes_observer`, and an identity login holding `planes_identity`. The passwords are made there and returned only inside the URLs. |
| `src/testing.ts` | `startKernelCluster()` is a disposable cluster with the kernel installed, for tests. |
| `src/cluster.ts`, `src/cluster-guard.mjs` | Where the PostgreSQL binaries are, a free port, waiting until a server is ready, and a guard that stops a server whose owner died. |
| `src/durable.ts` | `writeDurable` and `removeDurable`: a file takes its name only once its bytes are on disk, and a removal holds after a crash. |
| `src/home-lock.ts` | Pure local-write admission and a private descriptor holding one persistent lock inode; shared by initialization and Platform's scoped data folder and vault locks. |

Roles belong to a cluster, and both this kernel and the older core name a `backbone_app`, so a cluster holds one or the other, never both.

## Local storage primitive

The `@backbone-next/kernel/home-lock` leaf has no Core or Platform dependency. `assertHomeWriteAdmission(home, ...ownedDirectories)` checks the main JavaScript thread, local filesystem profile, legacy lock shape and pinned Node-API backend before initialization. It creates nothing and proves neither ownership nor source eligibility. Callers include actual keys, PG and socket locations rather than assuming the data folder's filesystem covers a submount. External database inspection does not initialize owned storage.

`acquireHomeFileLock(home, waitMs, onIntegrityLoss?)` returns an idempotent release function. The descriptor remains private until release: BSD flock on macOS, Linux OFD locking with the same backend in every writer. A regular owner-only, single-link `.lock` inode remains after release. Never unlink, rotate or restore it. Opening and closing an unrelated descriptor does not cancel ownership. There is no lease, PID takeover or heartbeat. An optional, scoped observer reports inode or private-metadata changes once; notification never releases the descriptor or changes a confirmed effect into an unknown outcome. Platform refuses subsequent admissions for that canonical path key until process restart. Native realpath does not unify firmlink or bind-mount spellings; those spellings have separate refusal keys, even when they name the same directory. Removing a live home (including misuse of removeDataHome), sync/restore replacement or other same-user inode tampering can still create a second lock domain: notification does not fence an already-running callback or a foreign recreated inode. This is outside the cooperative stable-inode contract. Release checks dev/ino before closing so a reused number for another file is retained. Any failed release identity read also reports loss and retains the descriptor until process exit. This is defensive checking, not isolation from arbitrary code in the same process.

Platform owns queuing, reentry, cancellation and callback draining; cancellation cannot release another callback. A started cross-process acquisition still drains to success/timeout before cancellation returns. Worker threads must ask their main thread to perform the operation. The binding is `fs-native-extensions` 1.5.3 (Apache-2.0), Node-API 9, loaded lazily by its exact package-local payload path, without an installer or payload fallback. Ordinary Node package resolution still applies to the package itself; this is not protection against same-user or administrator replacement of installed native code. The Kernel uses the pinned package's same whole-file exclusive native call and EAGAIN busy mapping. Packaging carries its selected native payload and production package closure for both Electron main and installed MCP. Missing or unloadable payloads refuse writable initialization. Linux requires the named experimental opt-in and stays unqualified. See [storage and upgrades](../../docs/how-to/install-and-open-the-app.md#storage-and-upgrades) for qualification limits and the stopped-client legacy transition.

## Moving the pin

1. Accept the new commit independently first.
2. Copy its three files with `git -C <lab> show <commit>:prototype/packages/db/migrations-v08/<name>.sql`.
3. Write the commit and the new digests into `sql/pin.json`.
4. Run this package's tests and the platform's `test:sql-v08:sql`.

## Tests

- `test/sql.test.ts`: the vendored bytes are the pin's, and one changed byte is refused.
- `test/provision.test.ts`: on a real cluster, each login holds exactly its role, the application role reaches no table directly, and the kernel's functions are installed.

<!-- generated from backbone.module.json by scripts/module-readme.mjs; do not edit -->
| Field | Value |
| --- | --- |
| id | `io.github.albertoangulo/kernel` (core) |
| version, licence | 0.0.0, Apache-2.0 |
| publisher | Backbone maintainers, namespace `io.github.albertoangulo` (github, pending) |
| stability | experimental |
| provides | v0.8 gov crossings (SQL functions on PostgreSQL 18), pinned and digest-checked 0.x, embedded PostgreSQL 18 cluster primitives and durable file writes 0.x, local data-home write admission and descriptor-owned file exclusion 0.x |
| consumes | none |
| capabilities | planes: personal, team, company; effect classes: none; operations: none; network: none; secrets: none |
| data | owns: planes, contracts, runs, crossings, verdicts, receipts and effect attempts of the v0.8 kernel (schemas app, gov, sec, ops); migrations: 1; export: not built: the audit export (gov.dump_crossing_rows) is the only read of the whole record so far |
| depends on | embedded-postgres 18.4.0-beta.17 (MIT), pg 8.23.0 (MIT), fs-native-extensions 1.5.3 (Apache-2.0) |
| conformance | bronze: `packages/kernel/test/sql.test.ts`, `packages/kernel/test/provision.test.ts`, `packages/kernel/test/home-lock.test.ts` |
| exemption | promise tests on every change: the kernel's acceptance runs in the kernel lab (parity, effects, crossing, mutation) at the pinned commit; this package refuses any other bytes |
| exemption | export: no export command yet |
| exemption | secrets: the provisioner makes the logins' passwords and returns them only inside URLs; it keeps none |
| removal | not removable while a data home runs on it: replaced whole by a newer pinned kernel once its UNKNOWN attempts are settled; refused while one of its effects is UNKNOWN |
<!-- end of generated block -->
