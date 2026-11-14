# Audit export contract

Owner: platform composition and CLI. Schema: `backbone.audit.v1`.
The [JSON Schema](../../schemas/audit-export.schema.json) describes one line;
[the operator guide](../how-to/export-the-audit-record.md) shows delivery and resumption.

The audit export is a read of the Core's committed record, not another ledger. It emits one event
for every selected row of `app.ledger`, including rows whose kind is not yet understood. It does
not infer a history from current effect status, chat files, connector settings or telemetry.
The [work ledger](work-ledger.md) and [effect gateway](effect-gateway.md) remain authoritative.

## Events and sources

Every event has schema, type (`event`), homeId, id, sequence (a decimal string), kind (the ledger entry
name), at (RFC 3339 UTC), actorId, subjectId, data, receipt, omitted and previousHash.
The receipt identifies the original ledger sequence and keyed representations of its entry hash and previous entry hash by default. Content opt-in exposes the raw Core hashes. An
optional effect object names its immutable Core effect id, runId, taskId, mandateId,
proposerId, beneficiaryId, connectionId, undoOf, repeatOf and class. An optional run object
names id, taskId, mandateId and engineId (the piece registration UUID, null for direct work).
These joins obey the person's Core row visibility; unavailable details stay absent.

All rows below come from `app.ledger`. The source column identifies the recording crossing
under `packages/core/schema/gov/`; supporting rows never supply a second event or current status.
The data column is an allowlist, restricted further to UUIDs, numbers, booleans, digests and
known enums. Free strings, including operation names and connection slugs, are never copied.

| Kind | Recording crossing | Data retained when present |
| --- | --- | --- |
| workspace.created | _create_workspace | kind, owner, system |
| workspace.window_set, workspace.verifier_allowance_set | set_delay_window, set_verifier_allowance | ms, tokens |
| person.added, person.account_bound, person.role_changed | add_person / accept_invitation, bind_account, change_role | role, invited_by, from, to |
| agent.created | create_agent | role, owner |
| mandate.issued, mandate.revoked | issue_mandate, revoke_mandate | parent, subject, on_behalf_of, carrier, intent_hash; root |
| piece.registered, piece.unregistered | register_piece, unregister_piece | digest (piece label and version omitted) |
| task.created, task.changed, task.shared | create_task, rewrite_task, share_task | visibility, for; status, title/goal digests |
| run.queued | queue_run | task, agent, mandate, carrier |
| run.claimed, run.parked | _claim, park_run | fence (worker label omitted) |
| run.finished, run.stopped, run.usage | finish_run, _stop_run, record_usage | outcome, fence; status, known reason class; tokens, cost_micros |
| effect.proposed | propose_effect / propose_undo | route, reason class, run, repeat_of, class, undo_of, args_hash, tool_hash, description digest |
| decision.asked | _open_decision | subject_kind, subject, reason class, checker_kind, checker, proposal_hash |
| decision.answered | _settle_decision | verdict, subject, note digest |
| decision.escalated | escalate_decision | note digest |
| effect.dispatched | begin_dispatch | class, undo_of, args_hash, tool_hash, dispatcher |
| effect.observed | observe_effect / settle_lapsed_dispatch | class, undo_of, args_hash, tool_hash, outcome, dispatcher, resolver, late, swept, note digest |
| effect.reconciled, effect.cancelled | reconcile_effect, _cancel_effect | outcome, settled_by, note digest, args_hash; reason digest |
| connection.registered, connection.checked, connection.marked, connection.signed_in | register_connection, record_connection_tools, mark_connection, sign_in_connection | scope; status, tools, error digest; sensitive; scopes digest |
| operations.classified | classify_operations | lowers (nested operation names omitted) |
| document.created, document.revised, document.written, document.marked, document.reviewed | create_document, revise_document, write_document_by_effect, mark_document, review_document | task, version, effect, sensitive, untrusted, imported |
| message.posted | post_message / answer_in_conversation | task, role, run, kept |
| source.recorded | record_source / read_document / record_server_answer | kind, trust, run, task, document, version, ref/content/tool digests (connection label omitted) |
| material.imported | import_material | person, source UUID when available |
| material.read_registered | record_material_source_read | episode, read_key, project/material digests, version, generation, kind, original_sha256, transformation, episode_sha256, prepared_sha256 |
| material.source_withdrawn | withdraw_material_source | event/project/material/event_at digests, sequence, generation, observed_version |
| knowledge.proposed, knowledge.accepted, knowledge.retracted | propose_candidate, _promote, retract_knowledge | run, topic digest; candidate, decision, owner; reason digest |
| memory.written, memory.forgotten, memory.proposal_decided | write_memory, forget_memory, decide_memory_proposal | owner, run; none; accepted, memory |
| routine.created, commitment.recorded | create_routine, record_commitment | kind, task, mandate, instruction digest; task, run, to UUID, text digest |
| channel.account_registered, channel.paired, channel.thread_started, channel.thread_joined | register_channel_account, complete_pairing, start_channel_thread, join_channel_thread | platform enum; person; task, kind; person |
| Any future entry name | its own ledger row | no unrecognized payload fields; omitted lists them |

The three unkeyed fields in the table (args_hash, proposal_hash and intent_hash) are available
only with content opt-in. The normal payload allowlist admits UUIDs, integers, booleans, known
enumerations and the documented digest fields; unknown or free-text values are omitted.

A proposal's disposition is held for needs_checker, refused for denied, and approved for
free/allowed/allowed_after_window. These describe recorded routing, not invented ledger entries.
A decision names its actor and decision UUID. Authority.method is core-decision for a decision;
a proposal names its governing mandate (which may be null), without proving a separate approval.
Dispatch means dispatch began, not that the destination received anything. Observations distinguish
succeeded, failed and unknown; reconciliation is a later fact. Lifecycle readback uses the effect
id and these enumerated dispositions, never a current mutable status.

### Connector error and non-delivery fixture cases

An invoked connector error is UNKNOWN, including refusal prose; the audit exporter
must preserve that committed observation rather than infer that nothing ran.
Dispatch admission alone establishes neither delivery nor success. FAILED remains
available when the local dispatcher positively establishes non-delivery before
invoking the destination. A pre-receipt refusal has no invented effect receipt.

The disposable audit-activity fixture keeps these cases separate. Person-released
draft and signed plain calls succeed. A distinct draft is admitted by Core, then
the sending door closes before the final connector check: its destination log
contains no invocation, Core records FAILED, and no UNKNOWN pause is created.
The invoked refuse_note error and the lost_note missing reply both remain UNKNOWN.
The repeat of the unknown call is refused; ending the plain signature leaves a new
call held, then explicitly discarded. Export tests bind the FAILED and UNKNOWN
lifecycles to their exact effect IDs; integrity and day reconstruction consume
the same fixture without relabeling its receipts. The day's additional 24 slots
are scripted local-dispatcher observations for ledger reconstruction, not remote
provider evidence; their failed branch represents a refusal before local work.

## Coverage gaps

- The record cannot say that a call went out under a permission, nor when one was given
  or ended. Connector permissions are mutable composition records. Both permission routes answer a
  Core decision as the person, with a free-text note whose keyed digest is all the ledger keeps.
  No note parsing, mutable-settings inference or synthetic permission event fills this gap. It
  needs structured Core approval bindings and permission receipts, owned by another package.
- Mandates record issued/revoked identities, carrier and an unkeyed intent hash. Terms, axes,
  budgets and expiry are present in mandate rows but not structured historical ledger payloads;
  they are not exported here. A new permission is a new mandate; piece changes are unregister/register.
- Run claims/endings are not every UI turn boundary. A claim identifies its piece registration,
  not a provider/model or later editable setting; a reclaim can add another claim. Person sign-ins
  are not tenant-ledger events. connection.signed_in is a connector sign-in, not person authentication.
- Pre-receipt refusals, local shell/web/process activity, direct connector reads and model traffic
  retain the effect-gateway contract's coverage limits. This is not a complete computer audit.
- No content export exists through a running app or daemon's API line. It needs an asked call
  confirmed by the person in the app. This unit deliberately refuses content for every line caller.
- Export is a read, creating no new audit receipt or independent authentication witness. Direct
  attribution identifies the database person used by the command; it does not prove a human ran it.

The November reference family 17 and its two research files were read on 10 November 2026 as
behavior references, not code dependencies or evidence of comparative product qualification.

## Content, authorization and known caller

Every default event lists prompt, answer, document, fileName, documentTitle, connectorArguments,
connectorResult and receiptStatement in omitted. Other excluded payload fields are listed too.
Private digest values are keyed again before default export; the published piece-file digest stays plain on registration facts. args_hash, proposal_hash and intent_hash are unkeyed;
low-entropy values can be confirmed by hashing guesses. All three are omitted by default and
listed as payload fields in every event's omitted array.

--include-content adds raw receipt/anchor hashes, raw retained payload digests, those three unkeyed digests and the immutable Core effect description as
receiptStatement, when visible to the person. No raw prompt, answer, document, note, arguments or
result is added. Statements can themselves contain sensitive work or credentials typed into them.
This option requires a command that opens an idle plaintext-key data folder itself. It is refused over
both interactive and read-only API lines, before the host or any confirmer is called.

The database session must be the data folder's active person, outside a run, with the existing owner or
admin role, as required by gov.ledger_words_match. The ledger SELECT policy is broader; export
uses the narrower existing admin check and preserves RLS for receipt enrichment.

ADR 0002 records the explicit same-user disclosure: ids, times, operation classes and outcomes
across the whole data folder, plus allowlisted structural metadata and Core receipt anchors. This data
comes from the database, not merely files already readable in the data folder. No raw private-content commitments cross. The keyed commitments do not provide an offline guessing oracle for omitted private values. The public piece digest identifies published engine code; concrete remaining inferences are stated below. An agent shell child or narrow tool with a narrow door permission can be a
same-user caller; the SQL session does not prove otherwise.

The header records transport and exportedBy. Direct export uses
{kind:home-person,personId}; API-line export uses {kind:same-user-process,uid}. uid identifies the
known server user, not an independently authenticated peer or human. The line never claims that
the person initiated it. A Keychain data folder therefore currently has content-free export only.

## Committed sequence, paging and resume

Ordering and cursor use app.ledger.seq. gov._append holds the workspace head row until commit:
B cannot commit N+1 before A commits N, and rollback leaves no hole. at is captured before that
lock and can move backwards. The initial SQL statement fixes sourceHead, scanThrough, a scalar
count and the first page together. Later pages read immutable ledger rows through that fixed
boundary and recheck SQL authorization. Later commits cannot enter that export midway.

Periods are half open: since <= at < until, using explicit RFC 3339 instants normalized to UTC.
A file is complete only through scanThrough (at most sourceHead). Future commits may still have
earlier times. Keep the same period and resume by cursor to collect them; never advance solely
by the last timestamp. A continuing collector can keep a broad fixed period and partition downstream.

There is no total event/byte cap. The production exporter and client retain at most a page of
64 events and await its full write before fetching another; memory also depends on the largest
individual record. --limit is a positive maximum number of source sequences scanned after the
cursor, including rows outside the period. scanThrough is the resulting boundary. The trailer
cursor names that last scanned entry, not always sourceHead. Even a filtered empty file advances
only its scanned boundary. Three limited runs join and contain the same facts as a full export.

A cursor is an unchanged, workspace-bound token. A foreign, malformed or missing Core anchor is
refused. Changing period with a cursor can lose earlier rows and is not a valid predecessor join.
No hidden cursor file is kept. The operator persists progress after verification and acceptance.

The audit.export API returns bounded JSONL pages and a random continuation session. Requests with
that session continue the original range/policy; cancel closes it. One process-wide holder slot
covers all its data folders: a second caller receives an explicit slot refusal. The CLI announces the wait and retries only that proven refusal every 500 ms, for at most three minutes. Every session has a fixed two-minute maximum lifetime, including page progress, and a 60-second idle expiry. The continuation is bound to the API connection that received it; another same-user connection cannot extend it even with its token. Closing or killing the owning client cancels its read. Use limited resumable batches if a full period cannot finish within that lifetime. There is no fairness guarantee against a same-user process repeatedly taking new slots. The CLI cancels unfinished sessions and awaits each page's
write; it never materializes a whole period. readAudit is a small, materializing test/reader API.

## File integrity and complete delivery

The first event chains from SHA-256 of the exact header line including LF. Each later event
previousHash is SHA-256 of the preceding event line including LF. The trailer contains count,
eventsSha256 over every event line including LF, lastHash and cursor. Its canonical JSON field
order is schema, type, count, eventsSha256, lastHash, cursor; cursor fields are id, sequence,
receiptHash. Trailing spaces, extra fields and reordered trailer keys are refused.

Files are UTF-8 with LF, no BOM, blank lines, CRLF or bytes after the trailer, and require a final
LF. Empty files still bind their header through the trailer. header.after joins the preceding
file's trailer cursor and the same keyed receipt anchor (raw only with content opt-in). Each file starts its own byte chain; source
anchors join files despite export-time or transport changes. --previous checks data folder, period,
content policy and this anchor. Time filtering can leave source sequence gaps; the byte chain
covers every emitted event, not source rows outside the period.

The CLI awaits stdout callbacks and file write/close before returning. A failed write exits
non-zero and says the export was not written whole; discard partial output and retain the prior
accepted cursor. Destinations use exclusive creation, mode 0600, outside the data folder. No destination
path crosses the API line and no network sender is installed.

Both small-reader and CLI verification use the same incremental verifier. The CLI retains one
line, hashes and envelope metadata rather than the whole file. Verification proves only internal
consistency relative to supplied envelopes. A party rewriting every hash can forge a consistent
file. It does not prove an unaltered source database, complete capture, or remote completion.
Stronger evidence needs timely source anchors and export digests kept outside the data folder, protected
permissions, trusted timestamps and independent append-only storage. This redacted file cannot
independently recompute the original Core chain without its canonical unredacted payload.

## Standalone snapshot custody

Standalone export never initializes, renews, migrates or recovers the source data folder. It
copies a stopped embedded database outside the data folder and starts only that copy. A source that
changes during copying, or contains symbolic/hard links or external tablespaces, is refused.
At least 8 GiB must remain free. A live or malformed source PID gives a truthful refusal; the
exporter never removes that source PID file or implies an orphan has an API line.

No vault, data folder data key or data folder password is copied or passed in arguments/environment. The copy
uses local trust on a Unix socket inside its 0700 folder, with TCP disabled. Its database files
necessarily contain role verifiers and work data until cleanup. The independent review measured
61.7 MB and 1,489 files for a nearly empty data folder; cost grows with the database and cloning support.

The allocating PID is recorded atomically in the folder name by mkdtemp. A supervisor starts
before the first copy, records owner/server identity, owns PostgreSQL and removes the copy on
completion or parent death. SIGINT, SIGTERM and SIGHUP abort and await cleanup. Export startup
sweeps only this user's recognized snapshots with dead recorded owners; EPERM counts as alive.
Live owners are never swept. A stale orphan is stopped only after PID, UID, its PID file and
process command establish that it belongs to that private folder. A reused/unprovable live PID
and older unmarked folders are preserved for investigation, not removed speculatively.

## Verification scope

Focused controls cover a slow real pipe above 64 KiB and a broken pipe; bounded backlog pages and
single-holder concurrency; redaction and the candidate-hash attack; all known/unknown payload
keys for every Core kind; full post-commit numeric ordering; canonical trailers and UTF-8 chunk
boundaries; source changes, links, low space and post-start failures; all nine requested signal
points; stale/live owners and orphan cleanup. The compressed 24-slot day reconstructs effects
from events alone and matches Core receipts one for one; it is not a 24-hour endurance run.

Mutation 2 (allow free payload strings except piece/version) fails the payload unit. Mutation 3
(order by event time) fails the two-writer ordering unit. Both were restored before normal
controls passed. Idle-session expiry and every OS I/O/startup failure are not individually injected. Socket length, maximum session lifetime, killed clients and stalled readers have focused tests. Windows and Linux without filesystem cloning remain unqualified.

Implementation lives in packages/platform/src/composition/audit-export.ts and audit-home.ts;
types and incremental verification in packages/platform/src/audit.ts, file verification in
packages/platform/src/audit-file.ts. The operator guide and JSON Schema above own consumption.

## Local validation, 10 November 2026

On c1d5b9e, the complete platform audit file set passed 31 tests, the CLI audit file set passed
4, and the API-line file passed 48. Platform, CLI and app typechecks passed. The disposable example
exported, verified and read back 13 events, all matching the line schema. Manifest/Docker-context
regeneration and the eleven static rules passed. Both requested mutations failed their named
adversaries and were restored. This is focused local evidence, not real SIEM delivery, a 24-hour
endurance result, cross-platform qualification or a new independent-review acceptance verdict.

## Hash inventory and guessing boundary (10 November 2026)

receiptHashMode is keyed-hmac-sha256 by default and raw-sha256 only with content opt-in.
The service role cannot execute sec.digest; no Core permission or function is added. The dedicated
32-byte audit key is HKDF-SHA-256 of the data folder's existing credential master, with the data folder UUID
as salt and fixed info backbone.audit.v1/digest-key. The credential store obtains that master
through Vault.masterKey(). Only a writable Host that
already holds the data folder prepares it at startup, after the readOnly return and before startup
recovery writes. General CoreLink.open, doctor, read-only Hosts, backup inspection, API-line
clients and standalone export never prepare a master.
An export reads the existing entry through Vault.get and freezes one derived key for the file.
The derived key is never stored. Master and derived key material never leave the data folder boundary:
they remain in the vault or trusted process memory, never exports, logs, argv, environment or
the temporary database tree. Only a 128-bit key identifier crosses: truncated HMAC-SHA-256 of
backbone.audit.v1/key-id, NUL and data folder UUID under the derived key. The header's digestKey records id and derivation.
Receipt/payload HMAC inputs remain backbone.audit.v1, NUL, data folder UUID, NUL, purpose, NUL, value.
The receipt purpose is shared by all anchors; payload purposes are payload plus dot and field.

A data folder never held by a writing Host since this change, or a legacy data folder, may have no
credentials.master entry. Vault.masterKey() would create it, so neither export transport calls
that method. Both use the existing service-secret fallback while the master is absent. The
header labels it legacy-service-secret and gives its own key identifier. The first writable
owning Host prepares the master once using the existing API; after that both transports use
hkdf-master-sha256. The switch changes the key identifier and --previous gives the changed-key
message; each file verifies alone. Read-only opens preserve vault.json bytes with or without a
master. Reopening a writable Host reuses the existing entry without rewriting it.
No leased vault implementation is changed. A legacy master.key data folder still requires app migration.

A credential-master change changes the identifier and receipt anchors. --previous then says
“these files were digested under different keys (the data folder's keys changed between them); each
verifies alone”, distinct from the refusal for an unrelated or forked history under one key.
Start a new chain and preserve both files. A database password rotation no longer affects
master-derived anchors. Rewrapping unchanged master bytes does not change their audit key.
Initializing a missing legacy master changes its fallback chain to a master-derived chain.

An auditor can tie these keyed representations to the Core's raw receipt hashes only through
a raw --include-content export. Today only a command opening a plaintext-key data folder with nothing
holding it can make that file. A data folder whose keys the app keeps has no such route yet: it needs
an asked content-export call confirmed by the person in the app. This is a stated gap; default
files and offline verification do not give an auditor the home key or authenticate Core hashes.
Matching ids and sequences across a raw and default export is an identity comparison, not an
independent proof of the HMAC mapping or of an unchanged source database.

| Hash-like field | Preimage and default treatment |
| --- | --- |
| header.digestKey.id | First 128 bits of HMAC-SHA-256 of the fixed key-id label, NUL and data folder UUID under the audit key. A public identifier, never key material. |
| receipt.hash, receipt.previousHash; sourceHead, after, scanThrough and trailer.cursor receiptHash | Raw Core ledger SHA-256 commits to previous raw hash plus canonical JSONB of workspace, sequence, kind, actor, subject, complete payload and microsecond timestamp. HMAC the raw hex string with receipt purpose. The genesis previous hash remains empty. |
| data.args_hash, data.proposal_hash, data.intent_hash | Unkeyed SHA-256 of Core canonical JSONB arguments, the decision proposal (arguments or classification changes), or mandate intent. Omitted by default. |
| data.digest | Published piece-file SHA-256, including its sha256 prefix, is retained as declared on piece.registered and piece.unregistered, so the default file identifies which engine was registered. Other kinds or non-manifest digest values remain keyed with payload.digest purpose. |
| data.tool_hash, description, note, error, scopes, title, goal, ref, content, tool, reason, topic, instruction, text | Core sec.digest HMAC of the corresponding tool name, words, scopes, document title/goal, source reference/content, reason or instruction. HMAC the retained hex string again with its field purpose. Known reason enums remain plain enums. |
| data.read_key, project, material, event, event_at | Core sec.digest of source-read key, project/material identity, withdrawal event identity or its timestamp text. HMAC again with field purpose. |
| data.original_sha256, transformation, episode_sha256, prepared_sha256 | Core sec.digest of original-byte hash text, canonical transformation JSONB text, or episode/prepared-text hash text. HMAC again with field purpose. |
| event.previousHash, trailer.lastHash | Unkeyed SHA-256 of the preceding exported line including LF (header for the first event). Its preimage contains only already exported data. |
| trailer.eventsSha256 | Unkeyed SHA-256 of all exported event lines including LF. Its preimage contains only already exported data. |
| id and anchor id | Base64url encoding of data folder UUID and decimal sequence; no content-derived hash. |

The allowlist admits no other hash-like payload fields. Future unknown fields are omitted.
Except for the published piece-file digest on piece registration facts, retained hexadecimal
digest strings, including future values under known keys, pass through the keyed boundary.
Public piece hashes deliberately identify published code; the keyed commitments provide no
offline test for guessed omitted private arguments, operations, slugs, workers, labels or mandate
intents without the secret. The default file confirms its disclosed metadata and exported bytes.
A holder with separate database/admin access or credentials has additional powers, including
Core word-matching calls; the file does not revoke them. Raw-hash opt-in exposes the Core
commitment oracle, so a holder can confirm omitted values by reconstructing ledger hashes,
even values not otherwise included by opt-in. Do not distribute it as a content-free file.

Event at keeps millisecond UTC precision for audit correlation and exact period-boundary
checks. Removing milliseconds would lose useful timing and still leave a small guessing space;
privacy relies on the keyed commitments, not timestamp obscurity. Sequence alone orders facts.
The day attack supplies even the exact omitted payload and microseconds to the attacker: it
reproduces all raw hashes, confirms zero through the default file, and succeeds against opt-in.
The payload unit exercises every admitted hash-like field separately.

Stale-copy sweep runs in exactly two places: standalone-export startup in its selected root,
and API-line startup once in the default root. A pure Core/line export never sweeps. If only
the supervisor dies, the owner aborts and stops the server it was told about before removal.
After an owner/supervisor double kill, the copy and trust server remain until the next such
startup or the manual sweep command in the operator guide. Sweep never removes a live owner.

The default scratch parent is the fixed per-user /tmp/backbone-audit-<uid> directory, mode 0700.
Before using it, check a real directory, this user's ownership and exactly that mode; never
follow a link at the parent path or silently repair a permissive directory. --scratch-root
selects another operator-owned 0700 parent for standalone copies, including on machines where
/tmp is a RAM filesystem or lacks space. The complete Unix socket path has a 100-byte limit,
checked before copying with a refusal naming the limit. TMPDIR never changes the default.
The ACP restricted profile excludes the lexical default-parent path and its macOS /private form
from reads, like the Host data folder and ACP storage. It never resolves a link planted there. That automatic exclusion does not cover operator overrides.

A sink that does not complete a page write within 30 seconds is stalled. Standalone export
aborts that write, ends its read-only transaction, stops the trust server and removes the copy;
the CLI reports failure and exits non-zero. The bound resets only when a page's full write
completes, not when a source page is read or an API request arrives. The line client has the
same write bound and cancels unfinished sessions. A real non-reading pipe exercises both the
standalone cleanup path (shortened trusted test timeout) and the command's production timeout.
A limit above 64 is tested across a second page while another writer commits: every page stops
at the initial scan boundary. Removing that pin must fail the named boundary test.

Mutation 4 (forget the scan boundary on later pages) failed “a limit above one page pins every later page to the original scan boundary” with a changed-count refusal. The mutation was restored.

## Second-review fix validation, 10 November 2026

The complete platform audit set passed 39 tests; CLI audit files passed 6 (including the
production 30-second stalled-pipe timeout); the API-line file passed 49; the complete ACP suite
passed 94, including its real macOS scratch-parent canary. Platform, CLI, ACP and app typechecks
passed. The disposable CLI example exported, verified and read back 13 schema-valid events.
The requested manifest/Docker regeneration and eleven static rules passed. Mutation 4 failed
its named boundary test and was restored before the normal boundary test passed. No heavy lock
or heavy suite was used, no leased file was edited, and no Core function or permission was changed.
At that reviewed head, the unavailable Core digest read led to a service-credential key. The
current master-derived key above supersedes that choice; any export with no credential master uses the labelled fallback without creating one.
This remains focused local evidence, pending independent review; it does not add an external
witness, real SIEM delivery, 24-hour endurance or qualification on another operating system.


API-line startup treats stale-copy cleanup as best effort. If the default scratch parent cannot
be checked or swept, it reports one fixed content-free diagnostic and still serves ordinary
reads. Audit exports on that line return the scratch-parent refusal until the parent is repaired
and the line restarted. The diagnostic contains no path, work text or caught exception detail.


The same value yields the same digest across events and files of one data folder, so a holder can see that two calls had the same description, can separate permissions that share the constant per-call note from permissions with their own note, and can count them; this is not a statement by the record and may change when the Core records the basis of a permission (another unit).
These comparisons concern the same digest field/purpose under an unchanged audit key; different purposes are separated.
Checked Core decision bases now project the finite data field approval_method (person or standing_signature). Unknown, legacy or malformed bases remain omitted; no person basis is inferred. The export still omits the structured permission UUID from the decision payload, and its conservative historical gap labels remain. A person override of an unsent standing-approved connector call exports the original standing decision, its cancellation, and a fresh proposal and person decision before dispatch.

## Third-review fix validation, 10 November 2026

The platform audit files passed 43 tests, CLI audit files 7, API-line file 52 and complete ACP
suite 95. The existing key-store file also passed its 8 tests after the normal-holder startup
change. Platform, CLI, ACP and app typechecks passed. The disposable CLI example exported,
verified and read back 13 schema-valid events. Manifest/Docker-context regeneration, all eleven
static rules and git diff --check passed. No heavy lock or heavy suite was used; leased files
were untouched. The three new adverse controls were red before their fixes: unusable scratch
parents stopped the line, a planted ACP link refused the session, and public piece hashes were
keyed. All pass after their fixes. Key tests cover transport joins, changed masters versus
forked histories, the explicit legacy fallback, and key-material scans after actual derivation.
At that reviewed head, CoreLink.open prepared the credential master; the rebased correction
above supersedes that general-open behavior. Only writable owning Host startup prepares it;
export and read-only opens do not initialize a master or write the vault. No audit-specific key is
stored, no Core function/grant changes, and the raw-export route for app-held keys remains the
stated gap above. This validation closes the requested local fixes, not a new independent review.

## Rebased diagnostic correction, 10 November 2026

On the integrator candidate c32d4b9 (base d8a6d3f), general CoreLink opening no longer prepares a
master. Preparation now occurs only after a writable Host has acquired ownership and passed
its readOnly return, before its existing startup recovery writes, and only while not closing.
The first such Host creates a missing master; later opens reuse it. Both export transports use
the labelled fallback when no master exists, without creating one. The regression covers Core,
read-only Host, backup inspection, API attachment, both key kinds across the first writable
start, and the changed-key join refusal. Protected app/system data folders are refused before store
access using explicit fake stores; the shared wrappers' real-store refusal remains enabled.

The whole CLI suite passed 100 tests, including the unchanged plaintext key-provider test,
both new doctor/master cases and telemetry diagnostics. Platform audit files passed 46,
API-line 52, platform keys/system-key files 114 and ACP 132. The example verified/read back
13 schema-valid events. Platform, CLI, app and ACP typechecks passed. Script self-tests passed
52 with zero failures; the existing npm-install opt-in case was skipped. The focused final
read-only and doctor rechecks passed 3 and 5 tests. Manifest/Docker-context generation, all eleven
static rules and git diff --check passed. READS retains audit.export and schedules.get; host.ts
is 1482 lines. No heavy lock, real key store, leased-file edit, push or merge was used.
