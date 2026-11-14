# Managed policy

Owner: platform policy and each consuming decision point. Contract read against
base dbbfdd66 on 10 November 2026. This is a neutral mechanism, not a distribution's
choice of restrictions. JSON follows the data folder's existing settings format.

## References and deliberate differences

Read 10 November 2026: Backbone's family 18 in
[docs/references-2026-11.md](../references-2026-11.md), and its two research files
[docs/references/2026-11-codex-hermes-paperclip-gemini.md](../references/2026-11-codex-hermes-paperclip-gemini.md) (families 11, 18,
19; researched 9 November) and
[docs/references/2026-11-claude-openclaw-opencode.md](../references/2026-11-claude-openclaw-opencode.md) (families 18, 19;
researched 9 November). These are documentary research, not installed-client tests.
Official pages were checked again on 10 November:

- [Codex managed configuration](https://learn.chatgpt.com/docs/enterprise/managed-configuration):
  requirements constrain editable configuration; cloud bundles carry defaults and
  requirements. System requirements are under /etc/codex on Unix and
  ProgramData/OpenAI/Codex on Windows; macOS also has MDM. A valid identity-bound
  signed cache is used at startup; failure to fetch without one fails startup.
  Refresh does not promise to update a running task. Legacy managed defaults have
  stronger precedence than ordinary cloud defaults; these are distinct mechanisms.
- [Claude Code managed settings](https://code.claude.com/docs/en/managed-settings):
  managed settings outrank user, project, local and command-line settings, with
  specific exceptions allowing stricter lower settings. Files live under
  /Library/Application Support/ClaudeCode on macOS, /etc/claude-code on Linux,
  Program Files/ClaudeCode on Windows. Multiple managed sources normally select
  one source; composition is configurable. Status and doctor expose the source.
- [Claude server delivery](https://code.claude.com/docs/en/server-managed-settings):
  startup and hourly fetch, cached policy on failure, and normally no policy on a
  failed first fetch. forceRemoteSettingsRefresh changes applicable startup to
  fail closed and may be delivered by the endpoint before the first fetch.

Replicated: defaults beneath personal choices, requirements above every personal
choice, protected endpoint delivery and named effective-policy diagnostics.
Changed: one signed offline file, no account/network dependency, no source
selection, mandatory refusal of every present-but-invalid policy, strict unknown
requirements, explicit scope, expiry, version and digest pinning. Defaults remain
editable (unlike legacy Codex managed_config defaults). Symlinks are refused
rather than warned about. These differences remove ambiguous trust and offline
fallback paths. This does not implement cloud delivery, MDM, roles or tenancy.

## Format and decisions

A usable example for this build:

```json
{
  "id": "company", "version": 3,
  "notAfter": "2027-01-01T00:00:00Z",
  "requirements": {
    "acceptsProcessVisibility": false,
    "personRights": false,
    "telemetryHost": "collector.example.com",
    "telemetryEndpoint": "https://collector.example.com/v1/traces",
    "auditContent": false,
    "modelProviders": ["openai", "anthropic"],
    "modelRoutes": ["own", "native"]
  },
  "defaults": { "personRights": false }
}
```

Requirements are limits a person cannot loosen. Defaults supply choices where
there is no personal choice. A default cannot supply consent, add a credential or
weaken protection: personRights may default only to false; keyHolders may default
only to keychain. Explicit personal choices still take precedence over defaults.
Unknown requirements refuse. Unknown defaults warn and are ignored. Duplicate
JSON keys, unknown metadata and invalid values refuse.

Every listed requirement now has product enforcement. The
[enforcement table](../../packages/platform/src/policy/enforcement.ts) is empty;
a future known field without a complete mechanism must be refused in both
sections before being shown as in force. Integration
was applied and retired.

| Field and plain meaning | Existing setting / enforcement |
| --- | --- |
| `harnesses`: engines a person may choose | Canonical engine ids in BACKBONE_HARNESS, settings.json and HostOptions. The live engine selector and saved-choice writer check requirements; defaults yield to explicit personal choices. |
| acceptsProcessVisibility: whether an engine may inspect the person's processes | ACP acceptsProcessVisibility; false refuses ACP despite personal acceptance. |
| personRights: whether ACP may run with unrestricted personal rights | ACP environment; false refuses person-rights. A false default leaves restricted-writes unless the person explicitly chooses otherwise. |
| keyHolders: ways to protect a data folder's keys | plaintext or keychain. CLI selectors, Host startup, Electron selection, vault opens, writes and retained handles check the holder. |
| standingSignatures: whether tools may have tool permissions | Checked at creation, before the ledger permission, before local publication and every use. Ending a permission remains available. |
| standingServers: servers eligible for tool permissions | Exact canonical connector server ids; checked at those same creation and use boundaries. |
| telemetryRequired: whether telemetry must run | The Host starts the exporter before opening Core or admitting governed work. Startup failure refuses calls and recovery; Electron closes the failed Host. |
| telemetryHost: permitted collector host | Exact normalized endpoint hostname, checked on read and write. |
| telemetryEndpoint: collector traces address | A required address fixes where telemetry goes and overrides a personal one. Telemetry is best effort at start-up in this build; the address does not require a running exporter. A default address yields to a personal choice or explicit off. |
| auditContent: whether audit exports may include content | Checked before standalone and live Core audit reads; false forbids content. |
| modelProviders: permitted model providers | Configured routes, actual pinned routes and embeddings dispatch; includes exact acp:agent identifiers. |
| modelRoutes: permitted kinds of model route | own, gateway, endpoint, native or agent; checked at those same boundaries. The native and agent routes leave provider and model choice to the vendor client. |

Lists in requirements permit only their entries; an empty list permits nothing.
For permission booleans, true permits but never supplies personal consent.
telemetryRequired:true additionally needs telemetryEndpoint or telemetryHost in
requirements. A personal loopback sink alone cannot satisfy it. Once enabled,
this would be startup admission, not a guarantee of delivery during a later
collector outage. Defaults currently support personRights:false and a validated
telemetryEndpoint. Other known defaults with no automatic choice warn and are
ignored unless the enforcement table requires refusal first.

A forbidden selection raises PolicyRefused with a stable code and safe explanation.
A requirement does not change a person's stored settings; it applies at use.
Read-only visibility includes id, version, warnings and fixed setting names. No
policy documents or private paths cross the API line. Settings shows the policy id, version and each fixed setting with its plain meaning. Its separate read stays available when a model route is refused. The desktop endpoint control is disabled when the destination is fixed.

## Signature, trust and deployment

Files are managed-policy.json and managed-policy.json.sig (raw 64-byte Ed25519
signature of the exact policy bytes), beside policy-trust.json. There is no
canonicalization before signing. Node built-in crypto verifies Ed25519 only.
No private key is installed in a data folder or committed. The trust file format is:

```json
{
  "keys": ["-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n"],
  "deployment": { "id": "company", "version": 3, "sha256": "64 lowercase hex characters" },
  "organisation": "example"
}
```

Directories: /Library/Application Support/backbone on macOS, /etc/backbone on
Linux, C:/ProgramData/backbone on Windows (Codex's Windows system convention).
No `HOME`, `ProgramData`, `NODE_ENV`, data folder setting or other environment override is
read. The verifier takes explicit bytes for tests; production discovery has no
path override. CLI verify can inspect an arbitrary candidate using system trust,
but cannot cause that path to become effective for work.

On POSIX the files and every ancestor must be root-owned, not group/other writable,
not symlinks; macOS extended ACLs are refused. /etc resolves to /private/etc on
macOS only via the fixed operating-system path choice. Windows policy discovery
refuses present policy until an ACL verifier is qualified. Unmanaged Windows
without any policy artifacts remains unchanged. Until ACL verification exists,
an ordinary Windows user may create this fixed ProgramData directory and cause
other users to refuse startup. The installer must reserve it with an administrator
ACL before first launch. This denial-of-service limit is not Windows policy
support. Production code never writes system state or a data folder to remember a version.

The installer/admin owns the version high-water mark in deployment.version and
pins the active bytes with deployment.sha256. Promotion updates the protected
trust record before the policy; intermediate disagreement refuses. Pinning means
another validly signed older file, an alternative same-version policy, an old
signed rollback or another id cannot be replayed. Runtime cannot reset this
record by replacing a data folder. Installers MUST preserve the highest version ever
activated, including across data folder deletion. They must not lower this floor.
A deliberate lower version additionally carries rollbackOf equal to the protected
high-water version and is signed and explicitly pinned as the active digest by
the administrator. The floor remains high. This administrative deployment record
is required because an unprivileged runtime cannot safely persist machine-wide
anti-rollback state. Replacing protected trust is administrative authority, not a
runtime rollback exception. There is no automatic installer in this increment.

Scope machine matches the OS hostname, organisation matches protected trust;
neither comes from a data folder or environment. Expiry is an RFC3339 UTC instant and
refuses at equality. A process caches verification by the three files' ctime and
size, device/inode,
owner/mode and every ancestor's metadata. Metadata changes invalidate the cache;
expiry is checked even on a cache hit. ACL subprocesses and signature verification
are reused only while that fingerprint is unchanged. Decisions already sent
are not undone. The Host and each inference send recheck policy before dispatch.

No artifacts means no policy and exactly existing behavior. Any artifact (trust,
policy or signature) means managed mode: missing/unreadable companions, malformed
JSON, untrusted signature, insecure trust, unsupported ACL validation, expiry,
scope mismatch, rollback, digest mismatch and unknown requirements refuse work.
Diagnostics remain available. There is never silent fallback to no policy.

## Threat model and qualification

A managed installer/root administrator controls protected policy, signature, trust,
version floor and application binaries. The person/agent controls data folder files,
settings, environment and explicit choices, but cannot alter those protected
files. The policy constrains supported decision points, not arbitrary programs
running as the person. Trusted in-process code is not a hostile-code sandbox.
It does not defend against root, a replaced application, debugger/code injection,
clock manipulation by an administrator, or an unmanaged owner simply removing all
policy artifacts. A managed user must not be an administrator; deploy application
integrity and filesystem protections separately. Installer protection is a
prerequisite, not a claim inferred from a filename. No container marker controlled
by a person is trusted as permission to use plaintext; administrators may deploy a
separate policy allowing plaintext in an actually isolated container.

The real temporary-tree test uses the same internal reader constructed with a
current-user-owned test root. It covers linked files, linked parents, writable
ancestors and O_NOFOLLOW without mocked metadata or opens. Mutations removing
the ancestor walk, mode check or O_NOFOLLOW each fail it. This proves the mechanism
on that filesystem, not a real uid-0 deployment, administrator-only protection of
system ancestors, a hostile cross-user race, Windows ACLs or Linux qualification.
Production constructs the reader with the fixed system paths and uid 0; no data folder,
environment or runtime argument can replace them. Live consumer tests cover the Host, CLI, retained vault handles, tool permissions and required telemetry.

## Follow-ups from the wiring security review

The 10 November 2026 review left these low-priority follow-ups after the connector
settlement and triage dispatch fixes:

- L1: native Host methods outside call, including enabling connectors, connecting
  AI tools and forming a triage capability, should check live admission after
  startup. Keep authority-reducing operations available. This needs the Host
  owner; the current fix does not change those methods.
- L2: the unused standalone hostDoors helper should be removed or require an
  admission callback. Its present guard refuses required telemetry, but it does
  not supply the other live Host checks itself.
- L3: Electron key-holder refusal should use the startup policy dialog instead of
  an uncaught main-process exception. It currently fails closed.
- L4: memoise successful Host readiness, retaining live endpoint comparison at
  dispatch. Required telemetry currently resolves its headers again on API calls.
- L5: add direct regression journeys for per-call door admission, the ordinary
  turn's send gate, and a running Host whose required exporter is no longer on or
  whose permitted destination changes. Triage now has dispatch-gate coverage;
  standing-signature tests now observe the service's exact policy refusal.

The accepted delta review of e05aca87 and d82280aa also records:

- L-d1: a Pi send-gate refusal inside a triage message is recorded as an
  unusable note and the item is marked done. Preserve the typed policy refusal,
  fail the run and leave the item pending so it can be triaged after policy is
  repaired. No model request is sent, but the current record can lose a message
  to triage, especially when it is the run's last message.
- L-d2: an unexpected non-policy error in the held-call check sets the policy
  refusal flag, which skips the more specific ended-signature cancellation
  reason. This fails closed; distinguish the causes to improve the record.
- L-d3 (addressed): the triage send-gate test now asserts the run's signature
  policy-refusal reason outside the engine stub. A missing send gate therefore
  fails the test instead of passing because a stub assertion fails the run.
