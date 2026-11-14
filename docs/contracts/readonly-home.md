# Read-only data folders

Owner: platform composition, with H1 owning admission and Core owning schema verification.
Status: implemented by F7 on the C8 head 6e3f37c4, 10 November 2026.
The dated dbbfdd6 inventory below records the behavior before this change.

## Behavior

A read-only Host, CLI read or doctor creates and changes nothing in the data folder outside
the PostgreSQL physical-runtime exception below. It never turns a folder into a data folder.
An incomplete data folder is refused before construction, ownership, vault opening or Core
opening. The refusal names missing relative artifacts and gives the writable command
`backbone projects create "My project"` with the same --home. No secret or unrelated
path belongs in that message. Completion is structural; it does not attest a schema,
decrypt a vault or permit a write. Writable initialization remains responsible for repair.

Starting or recovering PostgreSQL can change physical data and global pages (WAL recovery,
hint bits, checkpoints, autovacuum) as well as the pid, WAL and control files. NEVER promise
byte identity of `base/` from a live server.

Everything outside the explicit physical-runtime paths is compared by relative name,
entry type, mode, size and SHA-256 (or link target). Independently compare logical data,
catalogue definitions, roles and installed history before and after. A physical exception
never permits schema, role, history or personal-data changes. Refused incomplete data folders
have no exception: no server starts. Strict byte identity through a snapshot reader is a
possible later unit for general reads, outside F7. Standalone audit export already
uses its separately owned snapshot path.

Read-only database opening must bypass password cleanup/migration, keeper writes,
directory creation, initdb, ALTER ROLE and every owned installer. Verify the exact current
history and catalogue profile with read-only verifiers before exposing any service;
behind, unknown or tampered history is a refusal. A pending step says:
"This data folder needs a writable open to upgrade." Core opening must also bypass claiming,
identity creation, mandate renewal and identity saving. Never await a Core open, close or
crossing while holding a data folder lock. Writable exclusion and kernel stamps stay unchanged.

## Baseline inventory

The original inventory was captured before the fix. This command now reports the
current refusals and opens, using fake keys and disposable native clusters only:

```sh
node scripts/no-leftovers.mjs node scripts/with-test-cluster.mjs node packages/platform/test/readonly-home-inventory.ts
```

The probe inspects the entire data folder before and after a whole read-only Host. It calls
projects.list, threads.list, threads.get, work.now, backup.inspect, connectors.list and
audit.export, then closes the Host and waits for Core close. It also invokes the real
doctor and projects list entries on separate vault-only plaintext data folders. Protected
Host cases use MemoryKeyStore through systemKeys; no real store is contacted.
The [path inventory](readonly-home-paths.json) enumerates every observed changed or
created path for each case (a dot names the root directory, whose size is also compared);
numeric PostgreSQL relation names are observations of this
baseline, never an allowlist. The original probe is diagnostic; the current regression controls are named below.

| Starting state | Non-PostgreSQL mutations observed |
| --- | --- |
| Vault only | root lock; kernel stamp; Core identity; vault password entry; memory and thread folders; pg folder, identity lock and port metadata |
| Vault and kernel stamp | As above except the already present root lock and stamp |
| Passwords committed, before initdb | Core identity; overwritten vault passwords and port metadata; pg identity lock; memory and thread folders |
| Cluster initialized, before Core identity | Core identity; pg identity lock; memory and thread folders |
| Complete data folder | No non-PostgreSQL mutation of plaintext data folders in these fixtures |
| Complete data folder without memory and threads folders | memory, memory/daily, memory/projects, memory/topics and threads recreated |
| Complete data folder on the frozen pre-guard baseline | Pending guard, link and enforcement steps installed; PostgreSQL catalogue and installed history change |
| Real doctor / projects list, vault only | Both exit 0; same writes as Host, plus cli folder and cli lock |

For every protected Host case, reopening with a new systemKeys instance also creates
keys/system-protected, with zero new store items. This is an additional forbidden write,
including on a complete data folder; a structural readiness guard alone cannot fix it.
That baseline had no non-mutating Vault open and no signature-ledger installer hook.
The current C8-based implementation has both; it also verifies the closure and hardening steps.

Write sites, with line numbers at dbbfdd6:

| Writes | Owning code |
| --- | --- |
| threads directory | packages/platform/src/composition/host.ts:109 |
| memory and its three subdirectories | packages/platform/src/memory/store.ts:56 |
| owner folder and permissions; root lock acquisition | packages/platform/src/composition/home-owner.ts:84, 118 |
| CLI holder folder, lock and transient holder record | packages/surfaces/cli/src/session.ts:141, 148; packages/kernel/src/home-lock.ts:132 |
| kernel.json and root lock acquisition | packages/platform/src/composition/home-kernel.ts:35, 40 |
| vault entries and keys directory permissions | packages/platform/src/keys/vault.ts:130–132, 210 |
| keys/system-protected | packages/platform/src/system-keys/provider.ts:45 |
| pg directory, cluster.json, transient pw, initdb tree | packages/core/src/db/personal.ts:175, 185–191 |
| pw cleanup and legacy secrets migration | packages/core/src/db/personal.ts:125–130 |
| physical runtime, pid removal and postgres startup | packages/core/src/db/personal.ts:209–219 |
| role reconciliation | packages/core/src/db/personal.ts:248–252 |
| guard, link and enforcement installers | packages/core/src/db/personal.ts:262–264 |
| Core workspace, agent, identity file and pg lock | packages/platform/src/composition/core.ts:191–203 |
| mandate renewal and identity save | packages/platform/src/composition/core.ts:207, 212–213 |

Persistent lock files are made by the native lock API, never planted or removed by the
probe. Recursive removal happens only after removeDataHome has drained the disposable
data folder. Kernel stamping and password/cluster setup are called before any read-only probe;
no Core open or crossing is awaited under a lock.

## Physical-runtime comparison boundary

Observed complete-home physical changes lie under these explicit subtrees of pg/data:
base (relation pages and cache), global (shared pages, control and cache), pg_wal (WAL),
pg_xact (transaction status), pg_subtrans (subtransaction status), and pg_stat
(server statistics). Starting/stopping also
permits the exact pg/data/postmaster.pid and pg/data/postmaster.opts paths. Recovery
also changes the size of the pg/data directory entry when a stale PID disappears;
only that directory size is exempt, never its mode or its individually inventoried
children. These are
the initial comparison boundary, subject to native recovery controls; no blanket pg
exception is valid. In particular pg/cluster.json, pg/external.json, pg/data/PG_VERSION,
postgresql.conf, postgresql.auto.conf, pg_hba.conf and pg_ident.conf remain pinned.
Logical queries must detect a migration even when its files lie inside these subtrees.
The C1 recovery control additionally observed pg_subtrans/0000 changing after a
real server crash while the independent logical-state comparison stayed equal.
PostgreSQL's [physical layout](https://www.postgresql.org/docs/18/storage-file-layout.html)
identifies this directory as subtransaction status. This narrowly named physical
exception does not permit changes to configuration, schema, roles, history or
personal records; similarly named neighboring paths remain pinned.
Git reads disable optional index locking/refresh through GIT_OPTIONAL_LOCKS=0;
explicit writable repository setup still uses Git's required add/commit locks.

## Completion and admission

The side-effect-free requireCompleteHome function in
[home-complete.ts](../../packages/platform/src/composition/home-complete.ts) runs
before Host construction, key selection or a CLI holder write. It requires regular,
nonempty kernel.json, core.json and keys/vault.json files, plus native PG_VERSION
and cluster.json (or the existing external.json test substitute). It requires the
persistent native root lock file and the existing threads and memory folders,
including daily/projects/topics. Empty root lock files are valid. Reader startup
never takes keys/pg locks or publishes an in-home socket, so it does not require
those artifacts from older installed data folders. Missing, unusable or linked artifacts produce HomeIncomplete with relative
missing names and a shell-quoted writable command for the same data folder.

A read-only Host holds an owner socket outside the data folder in a private runtime
folder under the OS account's data folder directory. The account directory is resolved from
the OS user record, independent of client HOME/TMPDIR values, and must be owned by
the user and not writable by another account. Short writable-owner paths remain in
the data folder's run folder; long writable-owner paths use the private runtime folder.
The runtime folder must be outside the data folder and fit the Unix socket path limit;
otherwise opening refuses without creating an in-home fallback. Every probe checks
the parent with the private-folder rule and requires a real, user-owned private socket:
0700 immediately after bind under umask 077, then 0600 at readiness. The bind changes
the process mask only synchronously and restores it even when binding throws. Both
private modes are probeable, so a simultaneous probe sees a live owner and a process
killed before readiness leaves a recoverable stale socket, not a permanent refusal.
Foreign, linked or public metadata refuses with its path before connecting; it is
never reported as a live owner. No owner probe consults the squattable temp namespace.
Both reader and writer probe both owner endpoints under the same
short native admission lock, so a reader still excludes a writer and another reader.
No Core operation is awaited in that lock scope. Read-only ownership starts no
workspace sweep. CLI reads publish no holder file and create no CLI lock directory;
a daemon-held doctor uses the owner's existing API line.

Core reads retain the existing identity without claiming or renewing mandates.
They use a read-only vault instance: no legacy master migration, wrapping-key
rotation, key creation or provider marker publication. C8's policy checks remain
active and read-only; required telemetry is not initialized by a read-only Host.
Personal mode requires existing cluster/password/port metadata, verifies exact
current history and all current profile verifiers, and never calls an installer or
ALTER ROLE. A missing history-view on a released old owned database is diagnosed
using an unlocked SELECT of the owning history, not a service view that did not yet
exist. Unknown or tampered history/profile is refused. Read-only admission recognizes
the frozen bootstrap and the two released bootstrap receipts used by the upgrade
controls; a checksum-shaped unknown bootstrap is refused too. Writable installers
retain their existing historical-baseline rule. Application and operator
sessions, including dedicated service connections, default to read-only transactions.
The guarded write-capable Core crossings refuse on a read-only link before connection
acquisition. Indirect writes through read(), including claim(), rely on the database
read-only backstop; N5 below names the remaining application-guard follow-up.
An existing server must authenticate
and report this data folder's canonical data directory. An unauthenticated live PID is
preserved and refused with pg/data/postmaster.pid named in the remedy; a reader closes
only a server it started itself. A PID probe returning EPERM or ESRCH leaves stale-file
adjudication to PostgreSQL, as PostgreSQL does itself, for writable and read-only opens.
Read-only journal replay updates its in-memory view but never retires workspace scratch,
including before ownership is acquired. A later writable replay performs that cleanup.

Plain-file backup export reads Core receipts before acquiring the data folder file lock;
it never waits for a Core crossing inside that lock. Its selected destination must
remain outside the data folder, as the backup contract already requires. Standalone audit
snapshot export also uses non-mutating vault opening and recognizes reader ownership.

## Proving controls

[Fixture controls](../../packages/platform/test/home-complete.test.ts) verify the
completion function without any path exception, including finished native and
external-test data folders. [Native Host controls](../../packages/platform/test/readonly-home.test.ts)
exercise interrupted first runs, both key kinds, complete populated data folders, new and
reused servers, crash recovery, unknown/tampered histories and role profiles, failed
open cleanup, wrong-server authentication, reused PIDs, key rotation and policy reads.
The [state comparator](../../packages/platform/test/readonly-home-state.ts) lists the
physical paths and reasons explicitly and hashes every non-exempt entry. Separate
queries pin every logical table, schema definitions, roles/settings and history.
[Adverse controls](../../packages/platform/test/readonly-home-boundary.test.ts) prove
that metadata/configuration neighbors, modes, new/deleted entries and changed logical
personal data cannot hide under the physical exception.

[Real CLI controls](../../packages/surfaces/cli/test/readonly-home.test.ts) exercise
projects list and doctor on interrupted data folders, app-style complete data folders without a
CLI directory, and data folders held by a real disposable daemon, using plaintext and the
fake system store. Existing audit, admission, policy and telemetry controls remain
in force. Writable first runs still finish interrupted data folders; a writable open
installs the released pending steps and preserves all earlier ledger receipts while
appending only the permission and material boundary receipts owned by those steps.

Read-only preparation is applied and
archived. General snapshot reading for strict whole-home byte identity remains
outside this unit; the live-server physical exception above is a stated limit.

## Security review follow-ups

The review of 925f2379 accepted the unit with M1/M2 fixes; this round also addresses
L1/L2. [PID controls](../../packages/platform/test/readonly-pid-review.test.ts),
[owner controls](../../packages/platform/test/readonly-owner-security.test.ts),
[scratch controls](../../packages/platform/test/readonly-thread-workspace.test.ts) and
[connection controls](../../packages/platform/test/core-readonly-connections.test.ts)
pin the four corrections. The following remain named follow-ups, not guarantees added
by this round:

- L3 — Broaden logical pinning to other databases, large objects, materialized-view
  contents, aggregate/window functions and the remaining ownership/shared-dependency,
  default-ACL, description, extension and event-trigger catalogue attributes. Broaden
  the SQL spy to all write and row-lock forms, or use schema dumps plus database hashes.
- L4 — Distinguish unfinished first runs from older installed layouts requiring a
  writable open or stopped-client lock upgrade. The current create-project remedy can
  create an unwanted project when only projection folders or lock layout need repair.
- L5 — Guard the second legacy-master check in Vault.open with the captured read-only
  mode. A legacy file appearing after preflight currently fails safely at put, with
  less useful guidance; it does not migrate through the read-only vault.
- L6 — Bound backup-export consistency between its pre-lock receipt read and locked
  file snapshot. A writable concurrent crossing can commit between them. Document
  that bound in the backup owner or compare receipts again and refuse/retry on change;
  never await Core while holding the data folder lock.
- L7 — A read-only unwrap that needs no rewrap can populate the in-process key cache.
  A later writable open using the same keys object can therefore defer optional
  system-protected marker publication until a later process. Skip that cache entry
  or document the optional marker's weaker publication timing.

The delta review accepted a85fdc59 with no HIGH findings. N1 is addressed by
[socket creation controls](../../packages/platform/test/owner-bind-private.test.ts):
they inspect the socket before its ready callback and kill real disposable owners
immediately after bind, proving privacy and recovery for both opening modes. The
following LOW findings remain named follow-ups:

- N2 — Short-path writable owners still depend on the OS account directory because
  they also compute the reader endpoint. Consider omitting that endpoint only when
  its account directory is unusable and therefore no reader can start there.
- N3 — Long-path writable owner locations differ from pre-review clients. Stop all
  old clients before upgrading and opening such a data folder: old and new versions do not
  discover each other's owner socket. The data folder write lock remains, but does not make
  the two owner-discovery protocols compatible. A later upgrade unit can bridge them.
- N4 — Add an actionable stopped-server recovery step for a stale same-user PID in
  pg/data/postmaster.pid. Confirming the real data folder server is stopped and retrying
  alone cannot recover that file; any removal instruction must require that proof.
- N5 — Gate claim() at the application boundary too. reclaimRun currently reaches
  gov.claim_run through read(); the database read-only setting safely refuses it,
  rather than the earlier application refusal used by the guarded write crossings.
