# routines-commitments and scheduler service contract (DRAFT 1, 23 Oct 2026; slice 4)

**Owner:** service owner, to be assigned.

**Layer:** L1 service.

**Status:** built in part, inside `packages/platform` (`src/composition/proactivity.ts`, `src/composition/triggers.ts`, `src/schedules/rules.ts`); see [Built](#built). The old repository has routines (`0008`) and the `croner` scheduler.

## Purpose

Scheduled and event-triggered work. Each occurrence fires once and has exactly one owner. A routine moves, is copied or is restored only by an explicit intent, and after any of these it resumes only on the person's word.

## Owns

- routines and commitments;
- schedules;
- `owner_instance_id` and `owner_epoch`;
- provenance: source instance, last slot fired, archive digest;
- handed-off tombstones;
- catch-up policy per routine (latest-once or skip);
- occurrence keys.

## Provides

- create, pause and retire;
- **resume**, which is an ownership claim (`epoch += 1`);
- run now;
- `due()`, which only the owner's scheduler may claim;
- the resume view: routines, missed slots, provenance and the copy warning.

## Consumes

- the work-ledger (runs, leases);
- the effect gateway (each occurrence's key);
- mandates-decisions;
- the Portability port (`export --move | --copy`, import, restore).

## Rules

| Rule | R-ID |
|---|---|
| `export` requires `--move` or `--copy`. A move marks the source's routines handed off: paused, with a tombstone naming the archive digest. A copy leaves them active. Restore is disaster recovery | R-ROUT-MOVE-01 |
| Import and restore create every routine paused, with its provenance | R-ROUT-IMPORT-01 |
| Only the owner's scheduler claims an occurrence. Resume increments the epoch. Resuming a copy warns that the routine was active in the source at export time | R-ROUT-OWNER-01 |
| `occurrence_key = hash(routine_id, scheduled_slot)` is the effect's idempotency key. It is forwarded to destinations that support idempotency (Stripe `Idempotency-Key`, Slack `client_msg_id`, email `Message-ID`) | R-ROUT-OCC-01 |
| Missed slots are listed on resume and handled by the routine's policy (latest-once or skip). Resume is one action with no extra prompts | R-ROUT-CATCHUP-01 |
| A copy resumed while its source may be active is protected only by destination idempotency. The UI warns, and lists destinations without idempotency | R-ROUT-RESID-01 |
| A routine acts within its mandate and asks its owner at most once. A cheap trigger decides whether to wake the expensive model (DR B6) | R-ROUT-01 |

**Residual risk (accepted, recorded).** Two disconnected instances share no authority. A copy resumed in both places is protected only at destinations that support idempotency; others may receive duplicates.

## Built

The api port: `schedules.get`, `schedules.parse`, `schedules.create`, `schedules.update`, `schedules.delete`, `schedules.run`, `heartbeat.put`, `brief.put`, `brief.done`; `Schedule`, `ScheduleRun`, `DailyBrief`, `Interruptions`; the `schedules` event and its `urgent` field. Tests: `packages/platform/test/proactivity.test.ts`, `packages/platform/test/schedule-rules.test.ts`.

The host runs schedules while it is open, on a timer. The background service runs the same host with the app closed; its data folder and key requirements are described in [run the daemon](../how-to/run-the-daemon.md). A schedule targets a chat (each run a turn in it) or works toward the chat's goal; one heartbeat runs a standing check inside active hours. Rules are a person's words read back as an RRULE subset (every N minutes or hours, daily, weekly on named days, at a time), a five-field cron, or one moment. Nothing is guessed: words it cannot read are refused with the reason. The app shows the parsed rule and first run before Save; creation and time edits pin that preview, refusing it if its first occurrence has passed. An edit keeps the version opened by the person, so live events preserve typed words and a conflicting save is refused. Invalid edits leave the saved schedule unchanged. The Scheduled page and chat cards offer Edit, Run now, Pause/Resume and Remove.

| Rule above | State |
| --- | --- |
| Occurrence key | Built, inside the data folder: a run's id is `hash(schedule, slot)` and its turn's client key follows from it, so a run recorded but not admitted before a stop is admitted again and finds the turn it made. Not yet forwarded to any destination: nothing scheduled sends outside the app |
| Catch-up | Built as latest-once for schedules: one run stands for every slot missed while closed and says how many (`ScheduleRun.caughtUp`). A heartbeat skips what it missed. Resuming a paused schedule runs what is due now, not what was missed. A per-routine policy is not built |
| Asks at most once | Built as the daily brief: what needs the person waits for one brief a day, each item one click; only a heartbeat's security or money emergency is told at once, and each is counted (`Interruptions`). Scheduled turns run with the settings saved on the schedule, through the one admission, so held actions, unknown outcome and withdrawal hold unchanged |
| Owner, epoch, move, copy, import, restore | Not built: one host owns its data folder's schedules. There is no export, so no move or copy yet |

**Event triggers** (`src/composition/triggers.ts`; api `triggers.get`, `triggers.create`, `triggers.update`, `triggers.delete`, `triggers.resume`; `Trigger`, `TriggerRun`; the `triggers` event; tests `packages/platform/test/triggers.test.ts`, `packages/platform/test/restart-runs.test.ts`). Beside schedules, a trigger starts a run on an event, attached to a chat or its goal as a schedule is. Each run goes through proactivity's one admission (`admitProactive`) under a client key that follows from the run, so held actions, unknown outcome and withdrawal hold unchanged and a run recorded before a stop is admitted again and finds its turn; what it comes to goes through the same daily brief (`report`): it interrupts no one unless its answer asks for the person (`NEEDS-YOU:`), and only a security or money emergency is told at once and counted. Both markers count only at the very start of the answer's first line. A run started by outside data (a webhook or a file event) never interrupts: an emergency it claims waits for the brief and is counted in `Interruptions.suppressed`; only a mail trigger's run, whose text carries no mail, can raise one. Events that arrive while a trigger's run is going wait and become one follow-up run (at most 20 shown, the rest counted; at most 60 runs an hour). Each trigger's open run and the start times of its runs in the last hour are kept apart from the run history shown (the latest 200), so trimming the history drops neither. A run whose turn a kill cut short is carried on with that turn once the host resumes work; if the turn did not finish, the run (a schedule's too) is `interrupted`, never `stopped`, waits for the brief, and says whether a write's outcome is unknown; nothing of it is resent. `triggers.resume` carries an interrupted trigger run on, once, and is refused while a write of the cut turn is unknown outcome (as a goal run is blocked): a new run in the same chat, told to check what the cut-short turn left and never to repeat a write whose outcome is unknown (`TriggerRun.resumedBy`). An interrupted schedule's run is carried on by `schedules.run`. Triggers, waiting events and runs are kept in `<data home>/triggers.json`; pausing drops what was waiting and starts nothing; removing revokes a webhook's secret.

- **File changed.** The project's folder is watched (Node's recursive `fs.watch`), filtered to the trigger's path inside it; a burst is gathered for one second into one event that names the changed files. Because FSEvents and inotify drop or fold events under load, each tick also looks for files changed since the watch began and not yet told (by change time, at most 1,000 files), and no file's change is told twice. Only regular files are read, after an `lstat`, never through a link, only inside the folder's real path, asynchronously, opened with `O_NOFOLLOW | O_NONBLOCK` and checked to be the file `lstat` saw; links, pipes, sockets and devices are skipped, and a file over 1 MiB is known by its size and modification time, not its bytes. What the app wrote or moved itself (the person's saves and uploads, withdrawals, restores and held files moved aside or back, a turn's documents: the host records each projection write and move, `AppChanges`) is not a change, nor is `.git`, a `.tmp` file, a folder, or anything changed before the watch began; changes made while the app was closed are not caught up. The changed files' names reach the model as quoted untrusted data, as a webhook's body does.
- **Legacy bearer webhook.** One endpoint, bound to 127.0.0.1 only, on a port kept across restarts. It accepts exactly `POST /hooks/<trigger id>` with `Authorization: Bearer <secret>`, a `Host` of `127.0.0.1:<port>` or `localhost:<port>`, no `Origin` header, and a body of at most 64 KiB read as UTF-8 text; a body declared or crossing over that is refused (413) and its connection closed at once. The headers must arrive within 5 s of connecting and the whole request within 10 s of its headers, each held by a timer of its own (Node's own timeouts are checked only periodically). Each trigger's secret is 32 random bytes, shown once in `triggers.create`'s answer and kept sealed in the credential store; only its SHA-256 is held in memory and the presented secret's hash is compared in constant time, against a dummy for an unknown trigger, so both are refused alike (401). Answers: 202 accepted, 401 (Origin, Host or authentication), 404, 405, 409 (paused), 413, 503 (closing). The body reaches the model only as quoted lines (`> `) under a statement that it is untrusted data, never instructions; one run quotes at most 128 KiB of it.
- **New mail.** The connected mailbox's own watch, the one triage's new-mail wake listens to, also feeds mail triggers; triage's behaviour is unchanged. The run is told that mail arrived, not what it says: reading mail stays triage's mandate.

Signed Standard Webhooks ingress is built for an operator-provided HTTPS relay; internet
reachability and a real provider delivery remain unqualified. A built-in public TLS listener
and per-trigger filters beyond a path are not built.

### Proactivity security boundaries (11 November 2026)

**Person-side script configuration.** A wake gate runs a trusted program with the person's OS
rights. Electron's general renderer API and the browser bridge refuse `wakeGate` on create or
update, including removal. Only the dedicated native-confirmation route can set it from the
page. Main snapshots the request and shows the exact program, argument array, deadline and
schedule before taking the person's click; a changed schedule version is refused. API-line
creation refuses the gate field, updates are not carried there, and doors/MCP offer no gate
mutation. API-line and MCP reads remove the entire program configuration and report only
`hasWakeGate`. Direct trusted Host callers remain person-side operators, not renderer clients.

**Outside-trigger ceiling.** A signed trigger's own `webhook.permission` is `auto-review` by
default and can be lowered to `ask`. Its saved/requested permission is intersected with that
cap on creation and again on every admission, including resume and pre-upgrade Full records.
Full is never admitted from a signed trigger. Here the middle tier uses the existing turn
permission `auto-review`; this does not activate the separate global Balanced connector preset.
The signature authenticates possession of a shared sender key, not safe instructions or the
payload's claimed identity. Its body remains quoted untrusted data and names the receiving
origin and trigger. Quoting is context for the engine; the permission cap is the authority
reduction. Existing Core effect checks, held/UNKNOWN writes and suppressed urgency still apply.
The permission label alone is not an executor boundary for every engine. Trusted admission
also stamps the turn with signed-trigger provenance; unfinished pre-upgrade turns receive it
before recovery, while completed history is preserved. The engine consumer forces the existing
read-only request/tool policy for stamped turns: no workspace commands, delegation, canonical
writes or connector effects. Adapters unable to enforce read-only refuse the work. This is a
deliberately stricter ceiling than Balanced until a general Balanced executor exists; compatible
engines can inspect and report, and a person can explicitly continue with a separate ordinary turn.

**Gate scheduling and shutdown.** Each Host has four tracked child slots. A check's deadline
includes time queued for a slot; it resolves failed on timeout or abort without awaiting an
exit event. An orphan keeps its slot until reaped, so a stalled OS process cannot create an
unbounded population of children. The reaper and surviving child handles are unreferenced.
Ticks dispatch gates without awaiting them; other schedules and the daily brief proceed.
Close aborts active/queued checks and `whenIdle` excludes gate tasks. Failed or interrupted
checks pause for inspection; no unknown script outcome is automatically retried.

**Listener and replay budgets.** Origin/Host/authentication refusals use the same 401 body.
The listener is still loopback-only, allows 32 connections and one request per socket, and
admits at most 600 requests per fixed minute across all IDs, including unknown IDs. Its
existing 64 KiB body and independent header/request deadlines remain. The delivery ledger
retains at most 10,000 ID hashes per trigger and at most 1 MiB of formatted ledger data per
profile write. New claims beyond either cap receive 429; no prior claim is evicted. An older
oversized ledger disables trigger admission and is not rewritten above that bound.

**Remaining limits and follow-ups from the security review.**

- D1 — Thread-history authority (MEDIUM, open): the signed-trigger cap covers its turn, not
  its thread. A later Full person turn, schedule, heartbeat or goal run in that thread can
  consume the outside payload and its answer in history without the read-only port. Quoting
  does not remove that prompt-injection risk. Follow-up: propagate outside-data provenance
  to the thread and cap its automated turns, or isolate signed triggers in dedicated threads
  and refuse a supplied thread with Full automation. Prove that a later Full automated turn
  sharing signed-trigger history is capped or refused, including after restart. This unit
  does not claim thread-wide taint tracking or change a person's later ordinary turn.
- D2 — Ingress fairness (LOW, open): unauthenticated traffic consumes the same 600/minute
  bucket as legitimate signed deliveries, so a relay caller can force retries with 429s.
  Follow-up: separate failed-authentication and verified-delivery budgets without allocating
  unbounded attacker-keyed state; test a failed-authentication flood alongside valid work.
- D3 — Stuck gate visibility (LOW, open): four never-exiting children retain all process
  slots for this Host's lifetime; queued checks then fail closed and pause their schedules.
  Follow-up: expose the stuck count and occupied slots in schedule detail, with a test that
  verifies the person's explanation while the daily brief and shutdown remain responsive.
- D4 — Native-dialog nuisance (LOW, concurrent repetition fixed): one native wake-gate
  confirmation per Host may be pending, including its final write; overlapping renderer
  requests are refused, never queued. Cancellation or dialog failure releases the slot.
  Follow-up: a shared person-side cooldown/dismissal policy for sequential prompt spam across
  native confirmation families. Ordinary edits to a confirmed schedule's text/time remain
  the pre-existing Full-schedule authority; changing its program/argv still needs confirmation.
- L1: the relay must forward only the signed path, preferably preserving Host. Forwarding the
  whole origin while rewriting Host to loopback would expose legacy bearer endpoints too.
- L3: the shared fixed-window bucket is basic resource protection, not sender fairness or
  protection against distributed saturation. Company relays need sender-specific limits and
  TLS qualification. Per-sender buckets are a future deployment concern.
- L5/L6: home file permissions and trusted person-side code are the boundary. A same-user
  process able to edit the stored gate already has those OS rights. Process-group kills are
  best effort, not containment: grandchildren that create a new session can escape; normal
  exit does not prove that all descendants stopped. Never run an untrusted program here.
- L7: the ledger remains inside the state snapshot with a bounded contribution to each write.
  A separate durable inbox/append-only ledger and migration of older oversized profiles remain
  follow-ups; migration must preserve every replay claim. Other state/history bytes are not
  covered by the ledger's 1 MiB bound.

## Validation (oracle cases; expected failures on legacy until fixed)

1. **CLI cases.** Each runs through the real command line on scratch Homes.
   - Import arrives paused (legacy: fails).
   - Restore arrives paused (legacy: passes).
   - A move pauses the source with a tombstone, and the target stays paused until resumed.
   - A copy leaves the source active and the target paused.
   - Resume increments the epoch.
2. **Two-instance adversarial test.** Start two embedded Homes from one archive and resume in both, the worst case. Advance a fake clock across N slots, with a routine posting to the fake Slack (idempotent) and a fake CRM (non-idempotent).
   - Under move or restore, each (routine, slot) produces at most one effect.
   - Under copy resumed twice, duplicates appear only at the non-idempotent fake, and they are reported.
3. **Property test.** Random sequences of export (move or copy), import, restore, pause, resume, crash and clock steps, over two instances. Invariants:
   - each (routine, slot) fires at most once under move or restore;
   - every missed slot is reported;
   - no routine is ever active at two owners in one database.
4. **Kill tests.** Kill during the handed-off marking, during import and during resume. Each must end with one owner or a paused state, never two active owners.
5. **Installed-app check.** A routine posts to a fake Slack. Export with `--move`, import into a second Home, then resume. Exactly one post appears. Real Slack comes later, with the maintainer’s authorisation.
6. **Friction.** Resuming takes one action, which lists the routines and missed slots, with no extra prompts.

## Acceptance

Slice 4: R-ROUT-01, R-ROUT-MOVE-01, R-ROUT-IMPORT-01, R-ROUT-OWNER-01, R-ROUT-OCC-01, R-ROUT-CATCHUP-01, R-ROUT-RESID-01.

## Exit test

The scheduler implementation (`croner`, a Postgres queue or `pi-durable` wake-ups) can be swapped, and owners, epochs, pause states, tombstones and occurrence keys survive.

## Change procedure

Inside the service. The occurrence-key format is shared with the effect gateway and the connectors' capability manifest (R-EFF-CAP-01 declares which destinations accept a forwarded key).

**Sources.**
- Root Claude's design of 23 Oct, from P-04's CLI lifecycle finding (branch `claude/p04-core-oracle-2d71c1`, `oracle/behaviour/lifecycle/portable.test.ts`, deviation `import-routines`).
- References: GitHub fork workflows, Zapier duplicated Zaps, Vercel production-only cron, n8n inactive imports (third-party sources only), Temporal Schedules catch-up and overlap, Kubernetes `startingDeadlineSeconds`; Red Hat OADP restored CronJobs as the counter-example.
