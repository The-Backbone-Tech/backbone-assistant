# Oracle: results (core and behaviour)

- **Target:** `legacy` at `948c1c23` (branch `claude/p04-core-oracle-2d71c1`), base `3e9f9c3b`.
- **Run:** 2026-10-23T15:13:07.752Z; Node v22.23.3; embedded PostgreSQL 18 (embedded-postgres 18.4.0-beta.17) through `backbone-oss:packages/db/src/testing.ts`.
- **Command:** `pnpm exec vitest run --config oracle/vitest.config.ts`, then `node oracle/report.ts`.
- **Made by:** Claude Opus 5.5 (claude-opus-5-5) integrating, with Opus 5.5 subagents; session reasoning effort low (15/100) throughout
- **Totals:** 410 passed, 0 failed, of 410 cases (expected failures count as passed).

## Pass count per promise

| Promise | Oracle cases | Passed | Failed | Legacy cases | Ported | Narrowed | Adversary | Gap | Deferred | Black-box share |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| isolation | 44 | 44 | 0 | 50 | 20 | 8 | 16 | 0 | 6 | 100.0% |
| mandates | 36 | 36 | 0 | 37 | 29 | 5 | 2 | 1 | 0 | 97.3% |
| effects | 48 | 48 | 0 | 50 | 36 | 10 | 2 | 2 | 0 | 96.0% |
| ledger | 18 | 18 | 0 | 17 | 9 | 4 | 4 | 0 | 0 | 100.0% |
| promotion | 14 | 14 | 0 | 14 | 12 | 2 | 0 | 0 | 0 | 100.0% |
| rule-of-two | 45 | 45 | 0 | 45 | 39 | 2 | 3 | 1 | 0 | 97.8% |
| **all six** | 205 | 205 | 0 | 213 | 145 | 31 | 27 | 4 | 6 | 98.1% |

Black-box share = (ported + narrowed + adversary) / (legacy cases − deferred). Deferred cases are black-boxable but exercise a surface outside the six promises; counted over every legacy case the share is 95.3%. Through public crossings and views alone, without the adversary port: 85.0%. Cases that could not be made black-box: 4 of 207 (1.9%).

Outside the promises: 205 of 205 passed (coverage.test.ts, imports.test.ts, smoke.test.ts, lessons/failing-first.test.ts, lessons/register.test.ts, behaviour/journey/agent-write.test.ts, behaviour/journey/brief.test.ts, behaviour/journey/coverage.test.ts, behaviour/journey/lessons.test.ts, behaviour/journey/save-kill.test.ts, behaviour/journey/stop.test.ts, behaviour/lifecycle/coverage.test.ts, behaviour/lifecycle/failing-first.test.ts, behaviour/lifecycle/guard.test.ts, behaviour/lifecycle/ledger.test.ts, behaviour/lifecycle/lessons.test.ts, behaviour/lifecycle/portable.test.ts, behaviour/lifecycle/recovery.test.ts, behaviour/scenes/agent-dojo.test.ts, behaviour/scenes/another-agent.test.ts, behaviour/scenes/approval-fatigue.test.ts, behaviour/scenes/approval-load.test.ts, behaviour/scenes/boundary.test.ts, behaviour/scenes/channels.test.ts, behaviour/scenes/cross-person.test.ts, behaviour/scenes/exfiltration.test.ts, behaviour/scenes/forged-approval.test.ts, behaviour/scenes/imported.test.ts, behaviour/scenes/inventory.test.ts, behaviour/scenes/knowledge-poisoning.test.ts, behaviour/scenes/lessons.test.ts, behaviour/scenes/mandate.test.ts, behaviour/scenes/multilingual.test.ts, behaviour/scenes/persistence.test.ts, behaviour/scenes/publication.test.ts, behaviour/scenes/secrets.test.ts, behaviour/scenes/self-elevation.test.ts, behaviour/scenes/skills.test.ts, behaviour/scenes/smuggling.test.ts, behaviour/scenes/url-fetch.test.ts).

## How each case reached the target

Of 205 promise cases: 202 call published crossings, 173 read views, 199 use at least one governed table write (no named crossing, SG-CORE-02), 28 use the adversary port, 200 use the operator port (every fixture creates its workspaces through it, SG-CORE-01).

## Spec gaps

| Id | Promise | Kind | Cases | What is missing | What the successor contract would need |
| --- | --- | --- | ---: | --- | --- |
| SG-CORE-01 | isolation | private-function | 0 | Every fixture needs more than one workspace; the service creates only an installation’s first (gov.create_workspace), so the adapter’s operator port calls gov._create_workspace on the administrator connection. | A named operator crossing for creating a workspace (with its authority stated), that a successor adapter can call without a superuser. |
| SG-CORE-02 | isolation | unnamed-crossing | 0 | Creating a task, queueing a run, writing a run step, recording a source, proposing a knowledge candidate, posting a message, writing memory and documents are table writes decided by row-level security, not named crossings (binding kind governed-write in results/usage). | Named crossings for these acts in the successor contracts (work-ledger, knowledge-memory, work-material), so the oracle binds a name instead of a table. |
| SG-ISO-02 | isolation | no-surface | 0 | The legacy catalogue cases pin exact lists (the ~550 published gov functions, the 143 tenant tables, the three role names) as a reviewed-change ratchet; those lists are the legacy schema itself. | The successor keeps its own pinned lists as a structural test of its own repository; the oracle checks only the target-neutral rule (no internal function executable, every store walled). |
| SG-ISO-03 | isolation | migration-history | 0 | “The door the service used to mark its own run is gone” (gov.taint_run does not exist) asserts the absence of a retired legacy function. | Nothing: the target-neutral promise (no session marks a run) is ported; the retired name is legacy history. |
| SG-MAN-01 | mandates | administrative | 1 | “Nobody answers a policy question”: the legacy case inserts a decision with checker_kind policy on the administrator connection, because no published crossing in the core opens one. | Either a crossing that opens a policy-settled question (so the oracle can try to answer it), or a statement in the mandates-decisions contract that policy questions never exist as answerable rows. |
| SG-EFF-01 | effects | migration-history | 0 | The shape of the proposal crossing in the catalogue: one overload, owned by the governance role, SECURITY DEFINER with a fixed search_path, delegating to a private repeat-guard function, with named lineage triggers and private trigger-function ACLs. | Nothing black-box: the successor states "the effect record is reachable only through the gateway" as its own structural test; the oracle keeps the behavioural half (the service cannot write an effect row). |
| SG-EFF-02 | effects | administrative | 1 | Several unresolved records of the same exact change (pending custody beside an older UNKNOWN, or two UNKNOWNs) exist only as historical rows the administrator seeds; the gateway itself never lets the second one in. | A named crossing that imports or restores historical effect records, or a contract statement that such states are unreachable (then the deterministic earliest-match rule is the successor's migration test). |
| SG-EFF-03 | effects | no-surface | 0 | That a waiting proposer or dispatcher is actually blocked on the partition lock (pg_stat_activity wait event, FOR KEY SHARE NOWAIT probe) while another transaction is open. | An adapter signal that a held or in-flight call is waiting on another session (for example `hold` reporting "blocked"), or a lock-wait view. |
| SG-EFF-04 | effects | no-surface | 1 | A fresh connected change proposed at REPEATABLE READ is refused while its original key still replays; the oracle cannot choose the transaction isolation level of a call. | An adapter verb to open a session at a stated isolation level, or a contract that isolation is adapter-internal (then the case is the successor's own). |
| SG-LED-01 | ledger | administrative | 2 | The ledger’s word digests are keyed with a per-workspace key only the installer reads (ops.fingerprint_keys); a case cannot recompute the digest of known words to find it in the record. | A published way to test-verify a digest without revealing the key (e.g. a crossing that answers whether given words match a ledger entry’s digest, for an authorised principal), or a contract stating the keyed-digest scheme and a test-key fixture. |
| SG-LED-02 | ledger | no-surface | 1 | The cross-workspace run queue has no view; whether a cancelled run’s queue entry is gone is visible only to the administrator. | An operator-level view of queue membership (or depth per workspace) so “leaves the queue” is observable apart from “is never claimed”. |
| SG-PRO-01 | promotion | private-function | 0 | The legacy case shows the service cannot call the private promotion helper gov._promote; the oracle cannot name a private function. | Nothing beyond the published contract: promotion inside the approving answer is the only door, and the direct table write is already refused. A successor states its private helpers are unexecutable by the service role in its own catalog check. |
| SG-PRO-02 | promotion | administrative | 0 | An active principal without a membership row is reachable only by deleting the membership with the administrator; every public removal deprovisions the principal too. | Either a public crossing that ends membership while the principal stays active (if that state is meant to exist), or a contract that it cannot exist, in which case the half of the case is retired. |
| SG-R2-01 | rule-of-two | administrative | 1 | Carrying earlier runs’ marks into a new run stays cheap in a task with twenty thousand earlier runs: the legacy case bulk-writes the runs as the administrator with the run triggers disabled, then reads query plans. | A seeding port (or bulk fixture crossing) for many finished runs in one task, and a stated latency budget for queueing a run there; which index serves the carry is the implementation’s own. |

“Cases” counts legacy cases whose status is `gap` with that id; a gap with 0 is referenced by narrowed cases or by every fixture.

## Deferred cases

- `isolation.test.ts > the tenant wall > delegation progress exposes metadata while frozen inputs, routes and mandates remain closed`: Column-level grants of sub-agent delegation batches; delegation progress is not one of the six core surfaces. Black-boxable with a 'delegation' view family.
- `isolation.test.ts > the tenant wall > commitment crossings cannot reach another workspace’s commitments or tasks`: Commitment crossings (gov.confirm_commitment, close_commitment, record_commitment) are not a core surface; the same not_found shape as the ported crossing case.
- `isolation.test.ts > the tenant wall > routine crossings cannot reach another workspace’s routines or memory proposals`: Routine crossings (pause, resume, retire, run now, memory proposals) are not a core surface.
- `isolation.test.ts > the tenant wall > skill crossings cannot reach another workspace’s skills, versions or questions`: Skill crossings belong to the skills promise, which is outside P-04's six; the skills oracle takes it.
- `isolation.test.ts > the tenant wall > vertical crossings cannot reach another workspace’s installations, suggestions or exports`: Vertical (extension) crossings are not a core surface.
- `catalog.test.ts > the schema’s guarantees hold for every object, including future ones > in an app’s session the service writes only an app’s own tables; every other table it may write refuses it`: App (A2A/MCP client) sessions writing only an app's own tables: the apps surface is not one of the six core promises.

## Behaviour oracle

| Area | Cases | Passed | Failed | Known legacy deviations (expected failures) |
| --- | ---: | ---: | ---: | ---: |
| journey | 40 | 40 | 0 | 1 |
| lifecycle | 27 | 27 | 0 | 2 |
| scenes/agent-dojo | 8 | 8 | 0 | 0 |
| scenes/another-agent | 6 | 6 | 0 | 0 |
| scenes/approval-fatigue | 2 | 2 | 0 | 0 |
| scenes/approval-load | 11 | 11 | 0 | 0 |
| scenes/boundary | 5 | 5 | 0 | 0 |
| scenes/channels | 7 | 7 | 0 | 0 |
| scenes/cross-person | 5 | 5 | 0 | 0 |
| scenes/exfiltration | 8 | 8 | 0 | 0 |
| scenes/forged-approval | 3 | 3 | 0 | 1 |
| scenes/imported | 2 | 2 | 0 | 0 |
| scenes/inventory | 1 | 1 | 0 | 0 |
| scenes/knowledge-poisoning | 5 | 5 | 0 | 0 |
| scenes/lessons | 14 | 14 | 0 | 0 |
| scenes/mandate | 3 | 3 | 0 | 0 |
| scenes/multilingual | 4 | 4 | 0 | 0 |
| scenes/persistence | 7 | 7 | 0 | 0 |
| scenes/publication | 3 | 3 | 0 | 0 |
| scenes/secrets | 3 | 3 | 0 | 0 |
| scenes/self-elevation | 2 | 2 | 0 | 0 |
| scenes/skills | 4 | 4 | 0 | 0 |
| scenes/smuggling | 6 | 6 | 0 | 0 |
| scenes/url-fetch | 3 | 3 | 0 | 0 |
| **all** | 179 | 179 | 0 | 4 |

Known legacy deviations, run as expected failures:
- `behaviour/journey/agent-write.test.ts > [O1][S8] A2: the service dies during the agent’s write > [S8] killed once the write has begun: after the restart the outcome reads unknown or settled, never still in progress (known legacy deviation)`
- `behaviour/lifecycle/lessons.test.ts > the lifecycle lessons, against the target > L17 [V5] a test run that names no Home never resolves, creates or migrates the default profile (known legacy deviation)`
- `behaviour/lifecycle/portable.test.ts > export, then import into an empty instance > [O4] an imported workspace’s routines do not fire on the new instance until a person resumes them (known legacy deviation)`
- `behaviour/scenes/forged-approval.test.ts > attack scenarios: forged approval > [S15 S6 S8] FA3 The checker is a model, and the injection speaks to it (known legacy gap)`

Of 153 behaviour cases with recorded usage: 115 act through the service's API, 133 start, stop or run a process, 28 call a crossing, 74 use a governed table write, 114 are judged with a read-only observer, 1 move time, 48 use the operator port, 5 the adversary port.

### Behaviour spec gaps

| Id | Area | Kind | What is missing | What the successor contract would need |
| --- | --- | --- | --- | --- |
| SG-SC-B-01 | scenes | no-surface | Three scenario runs (PS2, LD1, AP1) use a read-only observer to drive a later step — a document’s id, a note’s version, the open send question an app is told of — not only to judge a goal. | Named product reads for these (a person’s own document list, a document’s version, their open questions), so a scenario needs no observer to act. |
| SG-SC-B-02 | scenes | no-surface | A scenario cannot record an observation of its own: the port’s direct-attempt log is written only by `attempt`, so SK2’s blocking findings and AP1’s answerable count are not kept (no assertion depends on them). | A port method for a scenario to note what it saw, carried into the result. |
| SG-LIF-01 | lifecycle | no-surface | No command creates an instance short of serving: `backbone start` makes the Home, its cluster and its master-key binding only while starting the whole service (with a model route). The adapter provisions a Home with the command line’s own first-run functions in process (loadOrCreateConfig, startCluster, bindVerifiedMasterKey). | A command that creates a Home’s instance and stops (`backbone init`, or `start --no-serve`). |
| SG-LIF-02 | lifecycle | administrative | No command opens a stopped Home for work or reading short of serving it. Held work is made, and its states read after a restore, through the service role’s crossings on the Home’s database, which the adapter starts in process as verify-ledger and export start it. A workspace is created through the operator (SG-CORE-01). | The service’s HTTP API over a started instance with dispatch held (the journey area), or a maintenance start that serves the API and dispatches nothing. |
| SG-LIF-03 | lifecycle | no-surface | S10/S21 ask that a restore or import extend the last externally anchored head. The only anchor is the sha256 the operator keeps: an older valid backup or export, given its own digest, restores without notice, and nothing records or checks the last anchored head. | An anchor the restore checks (a head the operator passes, or an anchor registry), and a refusal or quarantine when the restored history does not extend it. |
| SG-LIF-04 | lifecycle | no-surface | An installation’s identity has no public surface (legacy keeps it in the Home’s task-material installation file). Lesson 13 is stated through its consequences: no second first-run setup, no second import or restore into the same instance, one imported entry. | An installation identity the operator can read (for example from `backbone status`), stable across restarts and new after a restore into another Home. |
| SG-LIF-05 | lifecycle | migration-history | Lesson 5 (an upgrade drains work in flight, parking it unknown) needs two builds of one target and work in flight between them; the oracle has one build, and the legacy upgrade on this machine is the migration step inside start. | Two published builds (a release and the next), or an upgrade command whose drain can be observed with pending schema changes. |
| SG-LIF-06 | lifecycle | no-surface | Lesson 6 (recovery sorts first, never sends, checks compatibility last): a refused restore publishes no Home, so its order is not observable beyond "a refused restore creates and sends nothing" (the adverse cases). The ordering belongs to the service start after a crash, which the journey area drives. | A recovery report, or the journey area’s restart with an effect in flight. |
| SG-LIF-07 | lifecycle | no-surface | The legacy command line recognises no development or test run: the adapter marks every run with NODE_ENV=test, which the target ignores. | A named way for a run to say it is a development or test run (an environment variable or a build flag), which the command line honours. |
| SG-J01-01 | journey | no-surface | A message attaches XLSX originals only (CreateTask.inputFiles); a text note cannot be attached to a message. | An attachment crossing for any file kind, keeping its original bytes, named in the message it came with. |
| SG-J01-02 | journey | no-surface | Earlier versions’ words have no API (DocumentView.versions is metadata only); the adapter reads app.document_versions as the observer to judge “v1 kept” and “applied at most once”. | A person-readable version history with each version’s words (or hash) and author. |
| SG-J01-03 | journey | no-surface | Legacy has no side chat, so neither its read-only tools (phase 6) nor its refused effect (A3) can be asked of it. | A side-chat crossing bound to a thread with a read-only tool grant, whose attempted effect is refused with a named reason. |
| SG-J01-04 | journey | no-surface | Documents carry a representation (text, office, original), not a class of original, working or accepted, and nothing marks intermediates as hidden. | A file class on every stored file, and a listing that hides intermediates. |
| SG-J01-05 | journey | no-surface | The repository task (scratch repo, Uncommitted diff, nothing committed without the person) needs a local working root and repository tooling the journey port does not reach yet. | A journey port verb for a scratch repository bound to the thread, and its uncommitted diff. |
| SG-J01-06 | journey | no-surface | Killing the service at a point inside an agent’s write uses the legacy test hook BACKBONE_FAILPOINT (effect.proposed, effect.claimed, dispatch.begun, effect.observed); Stop timings cannot reach the instant between proposal and dispatch, which only the held write (J-L8) reaches. | A named crash-injection contract for the service process (or a kill harness that pauses at each point of the effect gateway). |

## Lessons register

Each core lesson case passes on the correct stub, fails on an assertion with its flaw switched on, and runs against the target.

| Lesson | Case | Correct stub | Flawed stub | Target |
| --- | --- | --- | --- | --- |
| 7 | L7a [S8] a new key for the same connector change does not slip past duplicate detection while the first attempt is unknown | passes | fails (L7-key-only-dedupe) | holds |
| 7 | L7b [S8] a new key for the same external change does not slip past duplicate detection while the first attempt is unknown | passes | fails (L7-key-only-dedupe) | deviates: The legacy gateway blocks an exact copy of an unknown change only for connector (mcp.*) changes above class 1; the same crm:update_deal under a new key is allowed and claimable while the first attempt is unknown. |
| 8 | L8a [S5] permission revoked while a send waits is re-read just before sending: nothing goes out | passes | fails (L8-no-recheck-before-send) | holds |
| 8 | L8b [S5] permission that expired while a send waited is re-read just before sending: nothing goes out | passes | fails (L8-no-recheck-before-send) | holds |
| 9 | L9 [S8] every unknown outcome is listed with the person who answers for it, its evidence and a deadline | passes | fails (L9-ownerless-unknown) | deviates: The legacy schema lists unknown effects and keeps the observation hash, but names no person responsible (any dispatcher or admin may settle) and sets no deadline. |
| 10 | L10 [S1] every store, including ones added later, has the tenant wall | passes | fails (L10-unwalled-store) | holds |

| Lesson | Enforced in | Where |
| ---: | --- | --- |
| 1 | repository rule | One definition per database function: a CI check in the successor. |
| 2 | repository rule | No text-patched function bodies; every migration runs on a fresh database in CI. |
| 3 | repository rule | Frozen migrations: a checksum test. |
| 4 | repository rule | Same as lesson 1. |
| 5 | behaviour oracle | No case yet: an upgrade with work in flight needs two builds of the target (SG-LIF-05, behaviour/lifecycle/lessons.ts). |
| 6 | behaviour oracle | J-L6 (behaviour/journey): recovery after a kill mid-write never resends; the order itself is not observable through a refused restore (SG-LIF-06). |
| 7 | core oracle | L7a (connector change) holds on legacy; L7b (any external change) is a known legacy deviation; J-L7 (a killed write’s exact copy is never applied twice) holds. |
| 8 | core oracle | L8a (revoked after claim), L8b (expired after claim); effects/recovery and the lock-wait cases; J-L8 (a Stop while a write is held is honoured before sending). |
| 9 | core oracle | L9: listed with resolver, evidence and deadline; a known legacy deviation (no resolver, no deadline). |
| 10 | core oracle | L10 and isolation/catalog (every store walled, the inventory catches an unwalled one). The export-classification half belongs to the portability oracle. |
| 11 | behaviour oracle | behaviour/scenes: all 75 legacy attack scenarios restated and judged from effects; the rule-of-two cases in core are the database half. |
| 12 | repository rule | Explicit security-relevant order in PL/pgSQL: a review checklist item, not observable through a crossing. |
| 13 | behaviour oracle | L13a (import twice) and L13b (restore twice) in behaviour/lifecycle; erasure across every store is still the portability oracle’s (forgotten memory stays forgotten is in isolation/catalog). |
| 14 | oracle convention | behaviour/scenes/lessons.test.ts (the scene judge catches harm that is not a leak; a leak-only judge misses it) and J-L14 (a Save is judged by stored versions, not reported state). |
| 15 | oracle convention | core/imports.test.ts: cases import no legacy package, driver or adapter binding. |
| 16 | repository rule | One full gate; branch protection. |
| 17 | behaviour oracle | L17 in behaviour/lifecycle: a known legacy deviation (no test-run guard; with no BACKBONE_HOME the CLI resolves and migrates $HOME/.backbone/default). |
| 18 | repository rule | No vendor version strings in core paths: a pattern ban. |
| 19 | repository rule | ADRs record decisions; docs never claim what is not built. |
| 20 | repository rule | Evidence outside the repository; size limits; small daily commits. |
| 21 | repository rule | One integrator owns the core; commit trailers name the agent. |
| 22 | repository rule | One real job before scope widens; debt limits start at zero. |

