# identity-tenancy contract (DRAFT 0)

**Owner:** integrator (core).

**Layer:** L0.

**Status:** have.

## Purpose

Every row belongs to one workspace, and every request acts as one principal. With no context, there are no rows.

## Owns

- workspaces;
- people and accounts (`auth.*`);
- memberships and roles;
- sessions;
- run identity (fence plus secret hash).

## Provides

- `sec.current_workspace()` and `sec.current_principal`;
- `gov.claim_run` (run identity);
- sign-in and SSO/SCIM entry (ADR 0022), as the boundary into `auth`.

## Consumes

Nothing. This is the bottom of the stack.

## Rules

- Forced RLS and a restrictive `workspace_id = sec.current_workspace()` policy on every table, including future ones.
- The service refuses superuser and BYPASSRLS roles.
- Composite foreign keys carry `workspace_id`.
- The throttle lives in the database, per account and per address (M0015).

## Acceptance

- R-GOV-TEN-01.
- Tests: `db/test/catalog.test.ts:600-622` and `server/test/service-role.test.ts`.
- **Adverse case:** a query with no workspace set returns zero rows; a role with BYPASSRLS is refused at start.

## Exit test

None. This piece is not replaceable. A change goes through the change procedure and the catalog test.

## Change procedure

- The integrator plus a cross-model review (guardrail 10).
- Delivered as a migration after the baseline, with the fingerprint updated deliberately.

## Oracle spec gaps the successor must close (P-04)

- **SG-CORE-01.** Provide a **named operator crossing to create a workspace**, with its authority stated, that a successor adapter can call without a superuser. Today every oracle fixture creates workspaces through `gov._create_workspace` on the administrator connection.
- **SG-ISO-02.** Keep the successor's own pinned lists (published functions, tenant tables, role names) as a structural test of its own repository. The oracle checks only the target-neutral rule: no internal function is executable, and every store is walled.
- **SG-PRO-02.** Either provide a public crossing that ends a membership while the principal stays active, or state that this state cannot exist. The second option retires that half of the case.

Source: P-04 `oracle/RESULTS.md` on branch `claude/p04-core-oracle-2d71c1` at `15538047`, 23 Oct; cross-family review pending.

## Successor status of the spec gaps (S1-02, 24 Oct 2026)

- **SG-CORE-01: closed.** `operator.create_workspace` is executable by the `backbone_operator` role alone (neither a superuser nor able to bypass RLS). The service creates only an installation's first workspace (`gov.create_workspace`, from an empty session).
- **SG-ISO-02: closed.** `packages/core/test/pinned.json` pins the roles, the tenant stores, the stores closed to the service and every function the service may execute; `packages/core/test/catalog.test.ts` checks them.
- **SG-PRO-02: retired, 24 Oct 2026.** A membership is its principal: ending it is the principal's status, so "a membership ended while its principal stays active" cannot exist.
- **Store count.** Two frozen isolation cases asserted more than 100 stores (the legacy schema's size). With the owner session's approval they now assert the target's own declared catalogue both ways (`oracle/AMENDMENTS.md`, A-1 and A-2, 24 Oct 2026); for the successor that catalogue is `packages/core/test/pinned.json`.

## Identity and project extension (11 November 2026)

Closed versions identity-v1 and identity-work-v1 add invitation issuance, immutable
workspace/issuer/subject account bindings, hashed expiring sessions, directory
records, projects and viewer/editor permissions. Existing owner/admin/member/guest
roles remain the workspace roles. Email never establishes account linkage. An
invitation is a one-use bearer capability with an explicit role and deadline.
Only the last live owner guard may prevent removal or a role change.

Identity removal holds the workspace identity mutex before the ledger mutex. It
revokes sessions, descendant mandates and owned agents, cancels queued/running
work and pending effects, then marks the person removed in the same transaction.
Directory deactivation acknowledges that commit; stale sync cannot resurrect the
binding. Directory credentials address one configured workspace and issuer;
SCIM externalId is that issuer's exact subject. Directory sync cannot assign roles.

Project owners share one project. Guests receive viewer permission only. Host
admissions re-read the live person and project permission for every request and async tool.
A shared admission ends before a model wait; revocation takes the
exclusive identity mutex and subsequent admissions refuse. Filesystem projections
never choose the process's device owner for an authenticated person. Their prefs
and drafts have person-specific namespaces. Non-device work uses project file
tools and its own carrier; personal memory, connectors, native client engines and
unscoped management APIs remain unavailable to it. A resumed turn restores its
recorded person and carrier, or starts no work.

Core retains immutable task_people audience history so shared words do not become
private again on revocation. Restrictive policies separate project reads from
writes through legacy crossings. The explicitly versioned sec.task_visible_to
replacement also checks the named reader's current project permission, including
system-recorded reads. The holder's existing run-secret accounting exception
survives revocation; it provides no read or work authority. Complete native identity
pins independently attest additions, policies and that reader replacement before
the material verifier accepts this explicit extension. Every other historical
material function and catalogue assertion stays checked.

OIDC uses openid-client (MIT), code flow, PKCE, state, nonce, exact issuer and
subject, explicit cryptographic JWT signature validation and an initiating-browser
binding.
There is no automatic enrollment from provider claims. SCIM uses SCIMMY (MIT).
The team HTTP service accepts an explicit session bearer and never inherits the
device owner. Desktop Main binds a session to one renderer, drains drafts before
switching and keeps bearer tokens outside the renderer. Configuring company
sign-in makes new app windows start signed out. An unconfigured personal app
retains its trusted local OS owner bootstrap.

Proving owners: packages/core/test/identity.test.ts and identity-work.test.ts;
packages/platform/test/identity-host.test.ts, identity-http.test.ts and
identity-keycloak-docker.ts; packages/surfaces/app/e2e/identity.electron.spec.ts.
The catalogue distinguishes installed evidence from disposable-provider tests.
Custom capability roles, directory groups and SAML are outside this extension.

### Reservation and revocation follow-up

Turn admission serializes preparations in process without retaining the lock on
the data folder. Core opening, recovery inspection, task/conversation creation
and run claiming happen outside it. The short local reservation rechecks the thread,
project, attachment versions/withdrawals, queued-message revision and producer
validation before journalling the client key and controller. A Stop's generation
is captured before authentication. Only an authenticated, resource-authorized Stop is registered as pending.
Turn-start requests wait for one bounded snapshot of those Stops before entering
the request or producer admission queue, outside the lock on the data folder.
The wait has a one-second deadline; newly arriving Stops do not extend it. A Stop still pending
at reservation refuses that send with its message retained, without a retry loop
in the shared queue. Ready turn-start requests queue before taking identity admission
connections, leaving capacity for Stop. Solution selection probes routes outside
that queue so a later choice can finish while an earlier probe waits. Its prepared
turn still enters producer admission and rechecks Stop after the probe. An invalid Stop changes no generation or
pending-Stop state and cannot delay those queues through its authentication.
Core may retain a prepared private task or conversation line after local
revalidation refuses the turn; no producer or outside effect starts from it.

The turn-admission-lock test fails on the old Core-under-lock path and also
proves concurrent withdrawal, duplicate keys and Stop with eight pending sends.
The same admission owns reservations for queues, goals, proactive work, merges
and board retries; their callers do not retain an outer lock on the data folder.

### Security review follow-up

Host authorization derives a thread or material's project from the stored
resource. A supplied project hint must agree; missing resources refuse. The
trusted device owner's data requests use the same project permissions. Local
resources are rechecked after reads and under an acquired write lock so a move
while awaiting admission cannot substitute another project's data. Thread moves
and deletion inspect Core outside the lock on the data folder, then refuse an
intervening local edit instead of overwriting it. Revocation may remain committed when deletion
refuses. Non-device Now views omit the owner's held connector actions.

An automation invocation takes one shared workspace identity admission for the
named person and validates the invoking administrator's active role and current
project permission under that administrator's own actor scope before starting any
work. Actor switching uses the same held lock; it cannot request another shared
lock behind a queued exclusive revoker. Existing per-tool checks take fresh
admissions and removal aborts remain in force. This does not introduce a separate
runner-attribution field.

With company sign-in configured, local invitation-code acceptance refuses at the
Host for every transport. Joining requires the provider proof; the code remains
a bearer secret. HTTP unauthenticated starts allow eight per client per minute,
based on the socket address unless composition supplies a trusted address hook.
Forwarded headers confer no trust. Bounded, expiring pending pools evict their
oldest entry. A revoked event stream sends one urgent notice and closes.
SCIM duplicate identities return a known uniqueness conflict. DELETE removes the
resource from directory reads while retaining its terminal account reservation;
GET and repeated DELETE then return not found.

The appended identity-resource-guard-v1 schema release fails closed for unbound tasks
and unnamed connections. A synchronous task trigger and upgrade backfill bind
legacy tasks to private projects without losing their historical audience.
Explicit legacy workspace publication records that one task's workspace audience,
including later members; it does not widen Host project sharing. Channel joining
checks a live paired account and permits access only to that thread's project.

An administrator role alone permits no run/effect payload reads in private
projects. Cancellation uses a private, bounded service after checking revoked
mandates and the caller's authority. Worker claims retain their explicit empty
session entry through bounded internal service context. An assigned decision
checker or verifier retains the native rule-of-two capability for that exact
proposal, without gaining general project reads. Complete identity catalogue
pins attest these named replacements, policies, stores and the task trigger;
the inherited material profile accepts only that independently attested phase.

Refusal owners: identity-security.test.ts, identity-http-security.test.ts,
identity-revocation-live.test.ts and identity-view-boundary.test.ts in platform;
identity-resource-security.test.ts in Core. The local-provider mid-run tests
assert session refusal before releasing a held model answer, then assert that
no late answer is published.

### Trusted device controls and channel scope

Project filtering covers the device owner's ordinary Host project/thread/file
requests. Device-only installation controls remain a trusted OS-user boundary:
backup.export and audit.export include other members' private projects and their
workspace records. Board and schedule controls are also device-only and unscoped.
The local API-line inherits that device authority. A device operator who must not
hold that authority needs an authenticated person surface instead of those
controls; project permissions do not narrow an export of the entire data folder.

A paired channel identity joining a channel thread currently receives a project
permission: editor for a working role, viewer for a guest. Channel-created tasks keep
their own default private task project, so that project normally contains just
that thread. If such a task is ever bound to a larger Host project, joining permits
access to the entire project, including its other tasks. The current crossing
does not refuse that binding or restrict its permission to one thread. A future Core
hardening must refuse project_id <> task_id or introduce a task-only permission before
any channel-to-Host-project binding is offered. The C1 correction below does not
offer channel-to-Host-project binding or narrow this existing join scope.

A successful write returns its committed receipt even if a different request
moves the resource immediately afterwards. Reads still revalidate resource
identity after dispatch to avoid returning substituted content. Retained renderer
layout snapshots are keyed by the signed-in person; an old unbound snapshot is
discarded rather than assigned to the next person in the window.

### Complete C1 runtime and authority accounting (12 November 2026)

C1 is not migration-free. Its first four ordered steps are identity-v1,
identity-work-v1, identity-role-revocation-v1 and identity-resource-guard-v1.
The appended identity-admission-closure-v1 step preserves their released bytes
and supplies the corrections from Root review. Upgrade qualification may accept
an exact predecessor; runtime identity admission requires the entire supported
history and the exact final identity and inherited material profiles. Owned,
external and read-only opens report a typed verified or paused identity status.
An incomplete, failed or altered profile exposes no C1 admission. IdentityCore,
Host sign-in, SCIM and authenticated calls refuse before their work; HTTP returns
a typed paused response with status 503. The app explains the paused capability.
An older Core can remain mounted for its other capabilities without making
multi-person access available. This is mount-time attestation, not a monitor of
later privileged database DDL.

Run-secret and project RLS continue to hide other runs' payloads. A private,
non-executable-by-service accounting function gives internal mandate evaluation
the complete workspace-scoped ancestor/subtree token, cost and effect totals.
It returns aggregates only and restores the calling identity on both success and
failure. Revoking a project's permission cannot erase its past spending. Internal
quote propagation similarly preserves both taints from earlier runs/effects;
private reason strings pass only when the receiving person still has access to
the quoted project. Otherwise only generic taints pass. Piece unregistration
checks across all its projects for effects with an unknown outcome or an active
dispatch before making a decision; administrator payload isolation cannot turn missing rows into
permission to unregister. Native permission issuance rechecks the person after
the ledger lock, and decision answering rejects a no-longer-active checker.
These bounded internal observations do not give callers general payload reads.

The native document API also has an explicit workspace-wide scope: a document
created with task_id NULL is shared workspace material, not a task with a missing
project binding. A document-specific guard preserves this scope for active
people and named live verifiers, and permits writes only for working roles. Guests can read its content
and earlier versions but cannot write them. Unnamed connections cannot read
either; non-NULL tasks still require an actual project binding and current
permission.
The general task guard remains closed for NULL or orphan tasks. This distinction
preserves the native workspace-document and rule-of-two contracts without making
an absent task/project a source of authority. A source explicitly recorded for
neither task nor run is likewise workspace evidence; a source tied to a run must
instead pass that run's project permission. Verifiers can read shared workspace
evidence without gaining permission to a private project. Native promotion and
decision checks retain their existing evidence rules.

An unnamed elevation question can designate any independent eligible admin.
That exact question permits access to its effect through the native may_decide
rule, and its actual answered_by keeps that exact receipt available for settlement.
It permits access to no other effects or project documents. A removed principal
cannot use that decision capability. This preserves the native checker crossing without
restoring role-wide project payload reads.

Mounting a data folder is separate from renewing its original device person's
permissions.
If another owner remains, removing that original person leaves core.json intact
and their mandates revoked. Writable startup may mount the already registered
engine but cannot register it, renew permissions, substitute another owner or fall
back to a stub for the removed person. A remaining owner signs in and runs under
their own current account and carrier. Device-owned directory credentials do not
silently transfer to another owner; a removed configuring person cannot remain
a directory administrator.

Every Host project task creator, including children, forks and side questions,
binds the destination project before work starts. Rebinding requires write
access to both projects, appends the destination's current recipients to durable
task_people history, and preserves earlier recipients. The rule-of-two private
publication exception also inspects the current project audience, including
workspace publication, so a later permission cannot silently create a private
exemption. A revoked recipient loses reads without making already shared words
private again. Child/fork preparation runs outside the lock on the data folder
and revalidates its local source and Stop state under a short write lock. A move whose Core bind
committed but whose local snapshot changed reports an unknown outcome. Audience history
stays conservative; the next admission or startup rebinds the actual local
project instead of claiming that the failed local move committed.

C1-M1 remains a named Core identity follow-up: legacy gov.change_role does not
yet enforce all invariants of the new identity role crossing. This correction
does not claim that the legacy route is hardened.

Native refusal owners are identity-admission-closure.test.ts and
identity-runtime-status.test.ts in Core. identity-core-review.test.ts in platform
proves two-owner removal/restart with the real Pi engine and a local scripted
model, and shared child/fork audiences with native rule-of-two proposals.
identity-runtime-gate.test.ts proves typed refusal at the composition boundaries.
These are disposable native/test proofs; the installed suite and whole-suite
evidence remain the integrator's stack gate.

### Native guarantees and the sole-device surface (12 November 2026)

The sixth ordered C1 step, identity-guarantees-v1, preserves all earlier released
bytes. Every identity store has the canonical restrictive tenant wall, forced
row-level security and the native owner-role refusal of TRUNCATE. Its exact
catalogue, seven identity steps and four closed hardening versions are part of
current C1 runtime admission.

Project isolation must not hide the facts a native guard needs to refuse an
operation or evaluate evidence. Private, non-service-executable observations
can inspect an effect's beneficiary for internal authority checks. Public
`queue_run` and `propose_undo` refusals use `not_found` for both absent and hidden
targets. `propose_candidate` uses the same `denied` refusal for absent and
invisible evidence, checked under the original audience before privileged reads. Candidate capture checks sources against the named receiving
person, including System-recorded sources, before accepting any citation. The
kept-knowledge verifier evaluates source eligibility independently of its own
project membership. These bounded internal observations restore the original
identity on success and failure; they do not make payloads readable to another
person, an administrator or an unrelated run. The oracle, including non-disclosure amendments A-4 and A-5, owns these
store, undo, unknown-repeat and rule-of-two guarantees.

C1 readiness gates new identity operations and every authenticated or company
request. It does not replace existing vault, schema, owner or data folder refusals
with an identity pause. Ordinary device calls retain the earlier single-person
surface only after confirming the original device is an active owner and no
other person, including a removed person, has existed in the workspace. Unknown
or altered principal policies cannot establish that condition. The observation
and ordinary dispatch hold one shared identity admission, so account acceptance
and revocation cannot change it before that request settles. A shared data folder
never falls back to this path. The app accepts this legacy surface only through
the backend's specific sole-device paused result, not a generic identity error.

Projects created on that surface are registered before later sharing; a failed
metadata registration preserves the committed local receipt and retries the
bootstrap at the next C1 operation. Enabling a second person preserves the
original device's existing preferences and drafts without assigning them to the
new person. An admitted Host request settles before its Core pool closes, and
import admission accounts for identity-local writes as well as ordinary ones.

C1-M1 and C1-D1 remain deferred: legacy role convergence, and checking
unregister_piece's administrator before waiting for its workspace lock.

### Platform compatibility correction (12 November 2026)

The seventh ordered step, identity-platform-v1, keeps the previous six artifacts
unchanged. The synchronous task-binding trigger temporarily uses its already
admitted row's workspace, then restores the caller's workspace on success and
exception. This supports privileged imports without weakening any tenant wall.
Statement-level actor admission on evidence, candidates and the ledger refuses
unnamed service/table-owner mutations as frozen even when restrictive project
policies hide their target rows. Existing row immutability still applies to every
admitted statement. A superuser can explicitly disable that existing enforcement
to test ledger corruption detection; no runtime service uses a superuser.
Runtime C1 readiness requires the initial seven steps and the later role, piece
admission, lookup and invitation compatibility closures.

The trusted local read-only connector list inspects files without a Core query.
It cannot enable or invoke tools. Person and company transports retain their
usual identity checks. Material recording constructs no identity admission pool:
its dedicated connection still owns durable retention and commit uncertainty.
A Stop authorized during recovery's final Core reads is rechecked before the
live carrier is retired, preserving original effect receipts and clearing only
confirmed stopped recovery data.

Recovery observes native lease expiry again after each bounded wait. At most
three observations precede a claim; a still-held lease retains recovery data. The
claim crossing makes the final atomic decision. One reclaim attempt never
resends a claim after a transport failure or unknown result. Later recovery must
re-observe the original run and its native lease; it creates no replacement run.

### Team hardening (13 November 2026)

The service cannot call the superseded `gov.change_role`, `gov.add_person` or
`gov.accept_invitation` functions directly. The identity role crossing retains
last-owner protection. Direct-provisioning Core clients use
`gov.identity_add_person`, which takes the identity mutex and workspace lock
before creating a person. Invitation clients use `gov.identity_invite` and
`gov.identity_accept`, as the shipped Host does. Core clients retaining the
released empty-session invitation ABI use `gov.identity_accept_legacy`. It
serializes acceptance, rechecks the inviter after locking and records the new
person as the audit actor; the legacy service crossing remains closed.

A colleague or named automation may use only a known engine whose checked
manifest declares `capabilities.nativeTools: "none"`. Missing declarations and
unknown engine identifiers refuse admission. Interrupted work rechecks this
declaration on restart, so an engine change cannot lend the owner's native client
to a colleague or named automation. The built-in stub and scripted
engine declare this in composition because they have no loadable module.

At execution time, an engine receives native account tools only if the live
project audience is the device owner alone. The Host checks every active person's
project access, including workspace-wide project access, under one shared identity
admission so concurrent permission changes cannot manufacture a private audience. Shared projects select
the contained Codex launch profile and show “Your Codex connectors are off in
shared projects” once per turn. Engines without containment, including ACP, refuse
shared projects before launch. Only checked engines declaring `nativeTools: "none"`
can skip this audience check. Mailbox triage uses the same check per message;
side questions and memory judging require read-only or bare engine support. Schedules, goals and resumed work use this same
execution path and re-evaluate the audience on each run.

`unregister_piece` takes the workspace lock before reading its principal and role.
Its native lock-wait control refuses a demoted administrator; the companion
`propose_undo` control refuses an administrator removed during the wait.


### Team update recovery (13 November 2026)

Only native app main admits the irreversible Team update on an existing data
folder. CLI and daemon opens refuse with “Open the app once to update this data
folder.” A missing device core record refuses the update.
An owned existing one-person data folder exports through the same inspected,
credential-scrubbed mechanism as Settings > Backup before its first identity
artifact. The trusted startup path alone may put that export inside `backups/`;
ordinary renderer exports still require the picked external destination. Its path
is recorded in `logs/identity-upgrade.jsonl` before DDL. A refused export admits
no identity step and leaves the old device surface available. A failed cohort
reuses its inspected copy while a durable SHA-256 of all source work bytes,
receipt report and resolved credential inputs is unchanged. Runtime files, logs
and copies do not alter that fingerprint. Changed source data or an invalid copy
requires a fresh export; no copy is accepted merely because a path exists.

The identity and hardening cohort, including identity-device-current-v1, shares
one bounded transaction and schema lock. Every closed installer verifies its own
prerequisite, payload, catalogue and receipt inside it. Failure rolls back the
whole cohort. A separate connection inspects committed history and runtime after
a missing acknowledgement: only confirmed unchanged history gets “Nothing was
changed”; an unconfirmed result remains unconfirmed. Released bundles and the
baseline are unchanged. The portable export is supplementary recovery of work,
not a database rollback: it excludes schedules, credentials and authority.

The device's trusted main process can call the independently pinned
`operator.identity_restore_device_access(uuid)` through its operator connection,
even when ordinary identity admission is paused. The service has neither schema
usage nor EXECUTE. The Host binds workspace and person to its device identity;
SQL independently binds that person to the append-only workspace creation receipt;
a removed colleague cannot be its subject. No API Method, remote session, colleague window, engine or HTTP endpoint exposes
the control. Main checks the local page and the device-owner window binding.
The crossing serializes with identity mutations and restores the device person
only during an access failure with no other active owner. If another owner exists,
it refuses without changes: “Another owner manages this workspace. Ask them to
restore your access.” A healthy owner cannot invoke the control. It restores
active owner status and appends `identity.device_access_restored` with that actor
and prior role/status, visible to every owner in People and roles. It revives no session, automation, agent or revoked permission.
A removed direct worker is replaced, preserving revoked permissions as history.
The app offers “Restore my access on this Mac” and reopens after repair. This
repairs local membership. Unrelated catalogue damage keeps Team features paused.
An independently pinned operator query admits the device owner from current facts:
that owner is the only active person, no unexpired unrevoked colleague session
exists, and no live automation acts for another person. Historical colleagues do
not strand current personal work. Its function and the policies of every table
it reads are separately attested. Pre-Team folders retain their stricter old path.
When these facts do not hold, the app says “Team features are paused on this Mac.
Your work is safe; export it from Settings › Backup.” It offers Backup on the
failure page. Only the active device owner can export there; colleagues and
removed device people gain no fallback. Export holds identity admission throughout.

Native account turns hold a project session lease from before audience admission
until the engine settles, including mailbox triage. Sharing takes the exclusive
counterpart without waiting. If work still holds it, sharing refuses with “Stop
the running work in this project first.” It changes no permission and stops no turn.
Contained and host-tools-only turns release that lease before running.


## Composed personal controls

The local device window alone may acknowledge an unverifiable unknown outcome in
its own conversation. A shared-project reader does not receive that offer; neither
a conversation owned by a colleague nor a named-person automation can be checked
through the device capability. The journal retains the unknown and its checker.
`identity.sharing` reports the same live `nativeAccountTools` audience decision
that engine admission uses. The first-run Full access card uses that decision and
shows no personal Codex connector promise for a shared project. Signed-in
non-device windows and viewers do not receive the card.

Quitting withdraws both a pending engine update and device access recovery.
Recovery carries Main's cancellation through the operator transaction and checks
it before COMMIT, rolling back membership and its audit entry together. Changing
accounts or closing the bound window also withdraws its pending recovery.


## Shared service, stage 1 (14 November 2026)

The headless daemon opens no shared listener unless its owner supplies an explicit
numeric address with `daemon run --share <ip>:<port>`. That listener is TLS only;
plain HTTP remains available solely to loopback composition callers. OpenSSL
creates a self-signed certificate on first use. The existing vault seals its private
key and retains the certificate; its key provider owns at-rest access. Temporary
certificate files are confined to an owner-only folder and removed after sealing.
A copied data folder without its key holder cannot recover the key.

One-use join links carry an HTTPS origin, SHA-256 certificate fingerprint and
invitation in the URL fragment. The platform RemoteClient validates the pin before
constructing any HTTP request, including acceptance and sign-out. It uses neither
redirects nor proxy configuration and never retries a lost mutation. The colleague's
vault holds the connection record and bearer session; requests carry the bearer
only in Authorization. Session lifetime remains 12 hours, with no refresh.
Acceptance has an independent eight-per-minute socket-address budget. A proxy's
address header gives no authority; only explicit composition may supply an address.
The sign-out endpoint ends only the presented session. Join and sign-out cross the
network outside the data-folder lock; only the vault write holds that lock. A
failed or unconfirmed sign-out keeps the local session and reports uncertainty;
only a confirmed ended reply, HTTP 401 or explicit accessEnded clears it. A
concurrent join cannot be erased by an older sign-out.

Every API call goes through callAuthenticated with a nonempty bearer; missing
credentials never select the device path. No endpoint exposes device recovery,
unknown-outcome checking, owner connector credentials or device-only methods.
The same-user local API line exposes four explicitly opted-in team controls
(identity.get, identity.invite, identity.share, identity.remove) only when the daemon
has enabled sharing. Invitation issuance on this line allows member or guest only;
admin invitations stay in the app. Ordinary app and daemon lines retain their existing method
list and refuse these controls. The network listener cannot enable this option.
Members remain bound to live project access and may send only through a known
host-tools-only engine. Native-account refusal tells the owner to select Pi and
configure its model, without weakening engine admission.

Authenticated streams capture accessible projects and revalidate session and
project access on identity changes and once every five seconds while idle. Opening
a network stream waits for its initial project snapshot; temporary recheck errors
never reset that starting set. Each session shares one timer and at most one pending
recheck. At most two audience checks run at once, on the ordinary request lane,
leaving the Stop/status connection reserve available. HTTP admits at most two
streams per session and 32 in total. The listener caps raw connections before TLS
at eight per peer address and 64 globally. Temporary access-check errors pause
project events and send a temporary-problem notice without ending access. Expiry, removal,
sign-out or withdrawal of any captured project ends the stream after one existing
“Access ended. Sign in again.” notice. A client can reopen to inspect its remaining
shares; this gives no access to a withdrawn project. CLI confirmed expiry/revocation messages
explain obtaining a new invitation. HTTP 429/5xx and stream transport failures
are temporary problems, not evidence that access ended. A CoreRefusal is a
REFUSED response only when its originating database answer is a definite server
refusal. Connection loss, unknown completion and unclassified errors remain
unknown outcome, including a committed mutation whose metadata follow-up loses its reply.
The CLI says to check the work and never resends it. The reusable platform client and vault session
store are the stage 2 app boundary; no renderer integration is claimed here.

Proof: shared-service.test.ts in platform runs the daemon and colleague CLI in
separate processes and separate disposable data folders, using a machine-local
non-loopback address when available. It proves shared-only listing, conversation
reads, a scripted answer attributed to the colleague, viewer refusal, certificate
mismatch, plain-HTTP refusal, invitation reuse refusal, share withdrawal and
removal, and enumeration of all API Methods without device authority.
shared-service-client.test.ts and shared-service-security.test.ts cover parsing,
pinning before secrets, throttling, sign-out, idle expiry and engine guidance.

The shared listener exposes exactly `POST /identity/accept` (one-use invitation),
`POST /identity/sign-out` (session bearer), `POST /api` (session bearer and live
method/project authority), `GET /api/events` (session bearer and live audience),
and `/scim/v2/*` (configured directory bearer bound to workspace and issuer; no
configuration permits no access). Company sign-in routes
`POST /identity/company/begin` and `POST /identity/company/complete` are local
composition HTTP only and return 404 on the shared TLS listener. They authenticate
through configured OIDC proof with browser-bound one-use attempts, PKCE, state
and nonce; they are unnecessary for this invitation journey. No other shared
route is exposed. The shared listener caps connections at 64, TLS handshakes at
five seconds and headers at five seconds.

The join command without a link asks for it at a hidden terminal prompt so it
does not enter process arguments or shell history. Invitation links remain
single-use with a one-day expiry. Known limits for a later unit: certificate
rotation/revocation tooling, and evasion of the acceptance throttle through
rotating socket addresses. The certificate remains pinned until replaced out of
band; certificate age is not a rotation mechanism.


## Shared app, stage 2 (14 November 2026)

The device owner opts into network sharing under People and roles, selecting one
available numeric address and port. Wildcard addresses are refused. Main wraps
the app’s existing Host with serveIdentityApi and sharedCertificate: the routes,
TLS pin, engine restrictions, budgets and admission are the stage 1 composition.
No second Host opens the data folder. The encrypted vault retains the opt-in
choice. It defaults off; a missing saved address leaves it off with a notice.
Turning it off or quitting closes the listener and streams. Local admins can
create join links, including admin invitations; only the device owner can change
this computer’s listener. The local command line refuses admin invitations:
it is a deliberately narrower entry point; the app exposes that role through its
explicit People and roles control under the signed-in administrator’s authority.
Native-account engines carry the sharing-page warning. When the saved address is
available at start, sharing resumes and the menu-bar menu displays “Sharing with
other computers is on: <address>” with a route to turn it off in Settings. A startup
setup failure stays visible on the Sharing page and does not prevent quitting.

RendererIdentitySessions binds each window either to the device Host, a local
accepted session, an empty session, or a captured remote client. RemoteClient
performs pin checking and all network requests in Main. remoteWorkspace holds
the saved session in the app’s existing vault using its HomeKeys. The renderer
sees only the origin and connection state. Joining drains drafts through the
existing close protocol before changing accounts. Empty or ended sessions never
borrow device authority. The local window keeps its own projects and drafts.
The vault records the joining local person’s id, or “device owner” when company
sign-in is absent. Company windows can join, restore or leave only under that
same local person’s authenticated session. A local sign-out closes their remote
access while retaining the record for that person. After restart, company mode
waits for that person’s local sign-in and an explicit menu or Settings open in a
dedicated window. Local sign-in and Settings never replace the local project
window with a remote session. Main resolves the owning person once for each
remote session, retaining its token binding until local access ends or changes.
Without company sign-in, only the device owner’s dedicated workspace window can
join; a same-Mac member window is refused. The one-person device-owner case
restores automatically in its dedicated window. Legacy records with no owner do
not restore in the app; joining again assigns their owner. Leaving requires a confirmed remote sign-out and
preserves the session on uncertainty.

A joined window offers shared project/conversation reads and editor sends, with
a read-only composer for viewers and conversations owned by another person. The
Host projects live conversation editability; the projection is never authority.
It offers no local file pane, schedules, memory, engine selection or owner-computer
settings. Each window owns one event stream, below the two-per-session limit. A
temporary stream failure keeps its route and reconnects; a five-second refresh
keeps project permissions and the open conversation current. Only an explicit
access-ended notice or RemoteError.accessEnded ends the window’s access.

Before an app send crosses the network, remoteWorkspace seals its reservation
under the session and request key. An unconfirmed reply or interruption retains
it across restart, and repeating that key refuses without a network request.
The draft also keeps its submission before sending. The page says unknown, names
the conversation to inspect, and never offers a send retry. A read that finds the
turn carrying the same client key, or the person’s “I checked the conversation”
control, clears both submission draft and reservation without resending or claiming
that the work succeeded. Reservations belong to the captured session, expire after
12 hours (the session lifetime), retain at most the latest 4,096 entries, and clear
on leave. Expiry does not clear the unknown submission draft or trigger a resend.
No session or TLS
private key is returned through renderer IPC.

Proof: shared-app.electron.spec.ts drives two app instances with separate
disposable data and user folders on one loopback address. It covers opt-in,
invitation links, filtered projects, conversation reading and scripted sending,
saved-session restoration, editor-to-viewer changes, removal and the untouched
local project. Focused session and vault tests cover routing, uncertain sign-out,
temporary notices and durable unknown-send custody; shared-listener tests cover
the saved preference and unavailable-address startup. This is local-run evidence;
an installed build or real second-computer use must be recorded separately.
