# Source map

Source routing reviewed 13 November 2026 against the current qualified line (`cdaeeada`, record tip `00721c3c`); older trial evidence keeps its original date. [README.md](../README.md) is the start page. A package folder means code exists, not that a complete product journey is qualified. Each package's package.json lists its actual dependencies, including development dependencies; its backbone.module.json records capabilities and test paths.

## Dependencies today

```text
platform -> core + kernel
platform -> harness-pi + connector-mail + telemetry-otel (composition)
modules -> platform ports/API
app, MCP, channels -> platform
CLI -> platform + channels
build tools <- explicit distribution input
```

Kernel and current Core are separate packages in the checked core layer. Core depends on kernel cluster, durable-file and lock primitives through a recorded exception. No module depends on the kernel.

The mixed scopes are historical package identifiers: `@backbone/core` and `@backbone-next/*`. They belong to the same repository; a scope rename is a later step.

Platform and some modules depend on each other today. Pi imports shared tool definitions; the sample mailbox also uses platform locking; telemetry consumes Host events. These are real cycles, not a strictly downward graph. [The exceptions](../scripts/structure-exceptions.json) record composition and peer edges; [the layer check](../scripts/structure.mjs) enforces the remaining boundaries. Modules do not import each other. Surfaces use platform entry points rather than core state. Packages and the default build must not depend on a particular distribution; [the neutrality check](../scripts/contamination.mjs) enforces that separation.

## Packages and independent use

“On its own” below means a guide or named test runs a piece without its usual app or host. It does not mean the package has no dependencies or is published. All examples need a workspace install unless the guide says otherwise.

| Piece and source | What it owns | What can run separately, and what it still needs |
| --- | --- | --- |
| [Kernel](../packages/kernel/README.md) | Pinned v0.8 SQL, provisioner; shared PostgreSQL, durable-file and lock primitives | Internal foundation. The v0.8 SQL is exercised by kernel/platform tests, not the ordinary app's authority store. No standalone adopter guide. Depends on embedded-postgres, pg and the native filesystem extension. |
| [Core](../packages/core/README.md) | Versioned schema, mandates, ledger, effects, knowledge and material-closure evidence | [Core alone](how-to/use-the-core-alone.md) uses its example without platform or app. Still needs kernel primitives and PostgreSQL; it is not dependency-free. |
| [Platform](../packages/platform/README.md) | Host composition, API, files, memory, scheduling, connectors, keys, recovery and offline thread workspaces | [Headless guide](how-to/use-the-platform-headless.md) uses a stub engine without a surface. Still needs core, kernel and installed composition modules. |
| [Pi](../packages/modules/harness-pi/README.md) | Engine adapter to Pi's tool loop | [Pi alone](how-to/use-the-pi-harness-alone.md) uses a scripted local model and an in-memory ToolHost, without a data folder. Needs Pi dependencies and platform port/tool definitions; the fixture model is supplied by platform testing. |
| [ACP](../packages/modules/harness-acp/README.md) | Configured ACP agent adapter | [ACP alone](how-to/use-the-acp-harness-alone.md) names a fake-agent test with a stand-in ToolHost. Needs the ACP SDK and platform types; restricted writes require macOS. No real provider qualification. |
| [Codex](../packages/modules/harness-codex/README.md) | Staged executor behind Engine | Internal module; fake-client tests and dated native trials are described in its README. Needs platform's ToolHost and a supported installed, signed-in Codex for real inference. [Native Codex guide](how-to/use-native-codex.md) covers prerequisites and the account-free sandbox probe; it is not a standalone work host. Linux defaults to contained and awaits hosted qualification after the security delta; the owner has paused hosted execution. |
| [Hermes](../packages/modules/harness-hermes/README.md) | Hosted Hermes adapter | Internal experimental module. Needs a compatible Hermes installation, its hook and a ToolHost. No app composition or standalone adopter guide. |
| [Mail](../packages/modules/connector-mail/README.md) | Sample mailbox; Gmail MCP adapter and preset | Internal module. [Mail measurement](how-to/measure-mail-triage.md) uses platform triage; [Gmail setup](how-to/connect-gmail.md) requires the provider route. Local fake-provider tests do not qualify live mail. Depends on platform types/locking and MCP libraries. |
| [Telemetry](../packages/modules/telemetry-otel/README.md) | Optional content-free OTLP traces with bounded close-time flushing | [Export telemetry](how-to/export-telemetry.md) exercises its subscriber with a fake Host/collector. This is adapter use, not a standalone work host. Needs platform API types and OpenTelemetry libraries. |
| [App](../packages/surfaces/app/README.md) | Electron shell and React UI | [App guide](how-to/install-and-open-the-app.md) builds without launching Electron; opening requires a screen. It includes platform, core and kernel. It is not a standalone engine. |
| [CLI](../packages/surfaces/cli/README.md) | Terminal commands and daemon | [CLI guide](how-to/use-the-cli.md) uses a stub with a real data folder, without the app; [install guide](how-to/install-the-cli.md) covers a local tarball. Depends on platform and channels. |
| [MCP door](../packages/surfaces/mcp/README.md) | Stdio gateway and read tools | [MCP guide](how-to/use-the-mcp-door.md) runs with a headless host instead of the app. The door alone opens no database; it still needs a running platform host, core, keys and an external permission. |
| [Channels](../packages/surfaces/channels/README.md) | Slack, Telegram, Discord and Teams direct/personal-message adapters | Internal surface composed with a Host, commonly by the CLI daemon. Source admits only supported direct/personal conversations; group work is not implied. Tests use fake endpoints. Real use needs bot credentials and account bindings; no standalone host. |

## Find the owner of a behaviour

| Behaviour | Implementation | Contract or procedure |
| --- | --- | --- |
| Task-level route choice and exact verification | `packages/platform/src/selection/`, `packages/platform/src/composition/selection-line.ts`, `packages/surfaces/mcp/src/selection-tools.ts` | [Solution-selection specification](specs/solution-selection.md); platform selection-diagnostics tests exercise actual loopback destination and original-version readback. J-solution comparative acceptance remains separate |
| Local model selection and engine compaction | `packages/platform/src/models/local.ts`, `packages/platform/src/composition/conversation-compaction.ts`, `packages/modules/harness-pi/src/compaction.ts`, `packages/modules/harness-acp/src/compaction.ts` | [Local models](how-to/use-local-models.md), [long conversations and browser work](how-to/continue-long-conversations-and-browse.md); fake endpoints and engine events do not qualify every real model or Codex context-limit continuation |
| Connector catalogue, install and OAuth lifecycle | `packages/platform/src/api-catalogue.ts`, `packages/platform/src/connectors/catalogue-controller.ts`, `packages/platform/src/connectors/catalogue-oauth.ts`, `packages/surfaces/app/electron/connector-catalogue.ts` | [Connector contract](contracts/connectors.md); installation, identity, tool permission and unknown-outcome recovery remain distinct. Gmail send is integrated; Calendar/Drive's composed journey is still pending |
| Managed policy and bundled notices | `packages/platform/src/policy/`, `packages/platform/src/notices.ts` | [Managed-policy contract](contracts/managed-policy.md), [bundled notices](contracts/bundled-notices.md); policy tests do not establish a deployed company, and ADR 0005 enforcement remains a follow-up |
| Database crossings, authority, receipts | `packages/core/schema/`, `packages/core/src/db/` | [Core recipe](../packages/core/README.md#the-api-recipe), [effect gateway](contracts/effect-gateway.md), [permission ledger](contracts/standing-signature-ledger.md) |
| Current Core SQL and schema upgrades | `packages/core/schema/current.json`, `packages/core/schema/versions.json`, `packages/core/src/db/schema-migrations.ts` | [Schema source owner](../packages/core/schema/README.md), [ADR 0003](adr/0003-source-evolution.md); frozen bootstrap and closed per-version definitions |
| Material-closure foundation and traced reads | `packages/core/src/db/material-closure.ts`, `packages/core/src/db/material-closure-read.ts`, `packages/core/src/db/material-closure-status.ts` | [Core schema evolution and traced reads](../packages/core/README.md#schema-evolution-and-traced-reads); candidate-input evidence and bounded recall, not material activation |
| Material-closure hardening and install follow-ups | `packages/core/src/db/material-closure-hardening.ts`, `packages/core/src/db/material-closure-hardening-profile.ts`, `packages/core/src/db/material-closure-hardening-pins.ts`, `packages/core/src/db/personal.ts` | [Schema owner](../packages/core/schema/README.md), appended material-closure-hardening-v1 manifest and generated release data; native hardening, install-lock, personal-follow-up and upgrade tests; no activation or backfill |
| Connector permissions, current permission checks and unknown outcomes | `packages/platform/src/connectors/`, `packages/core/src/db/signature-ledger.ts` | [Permission ledger contract](contracts/standing-signature-ledger.md); `ConnectorService.resolve()` and the connector tests |
| Turn wiring, files, work that resumes | `packages/platform/src/composition/` | [Platform API](../packages/platform/src/api.ts), [thread orchestration](contracts/thread-orchestration.md), [work material](contracts/work-material.md) |
| Offline code and SQLite in a thread | `packages/platform/src/workspace/`, `packages/platform/src/composition/workspace-tools.ts`, `packages/platform/src/composition/workspace-lifecycle.ts` | [Workspace contract](contracts/workspace.md), [use a thread workspace](how-to/use-a-thread-workspace.md). Host tool for Pi/Codex/ACP; macOS Seatbelt or installed Linux bubblewrap/Python. The platform workspace-policy export shares its macOS base policy with adapters. Not a separate package or a live-engine qualification |
| Content-free telemetry and shutdown flush | `packages/modules/telemetry-otel/src/subscriber.ts`, `packages/platform/src/composition/telemetry.ts` | [Telemetry module](../packages/modules/telemetry-otel/README.md), [export telemetry](how-to/export-telemetry.md); local collector tests, bounded refresh of unfinished turns at close, loss counted |
| Connector enabling and Tool permissions screens | `packages/surfaces/app/src/components/settings/Connectors.tsx`, `packages/surfaces/app/src/components/settings/SignedTools.tsx` | [Connector contract](contracts/connectors.md), [tool permissions](contracts/standing-signature-ledger.md), [Gmail walkthrough](how-to/connect-gmail.md). Desktop confirmation for enabling/permission; browser directs the person to the desktop app |
| Engine tools, model routes, mailbox and telemetry ports | `packages/platform/src/ports/`, `packages/platform/src/models/` | [Engine contract](contracts/harness.md); module READMEs name their adapter tests |
| Linked engine compaction | `packages/platform/src/composition/conversation-compaction.ts`, `packages/modules/harness-pi/src/compaction.ts`, `packages/modules/harness-acp/src/compaction.ts` | [Long conversations and browser work](how-to/continue-long-conversations-and-browse.md); original turns stay readable, summaries do not confer authority |
| Local keys and write admission | `packages/platform/src/system-keys/`, `packages/kernel/src/home-lock.ts` | [Key provider](../packages/platform/src/system-keys/README.md), [storage guide](how-to/install-and-open-the-app.md#storage-and-upgrades) |
| What a person sees | `packages/surfaces/app/src/`, `packages/surfaces/cli/src/` | [App contract](../packages/surfaces/app/CONTRACT.md), [CLI contract](../packages/surfaces/cli/CONTRACT.md) |
| ACP retired-directory ownership | `packages/modules/harness-acp/src/storage.ts` | `packages/modules/harness-acp/test/retire-owner-race.test.ts`; publishes a complete owner record so a concurrent sweep cannot remove a live retired copy |
| Native Linux Codex containment and admission | `packages/modules/harness-codex/src/linux-preflight.ts`, `packages/modules/harness-codex/src/linux-audit.ts`, `packages/modules/harness-codex/src/readonly-proof.ts`, `packages/modules/harness-codex/src/snapshot.ts` | [Native Codex guide](how-to/use-native-codex.md), [Engine contract](contracts/harness.md); contained by default, exact readback, owned canaries and private-write isolation. Current expanded Linux matrix is unrun; hosted qualification is paused by the owner. Earlier Linux observations do not qualify the current expanded matrix |
| Connector permission, permission coverage and recovery | `packages/platform/src/connectors/signature-coverage.ts`, `packages/platform/src/connectors/signing-view.ts`, `packages/platform/src/connectors/replacement-recovery.ts`, `packages/platform/src/composition/connector-person.ts`, `packages/platform/src/api-connectors.ts` | [Connector contract](contracts/connectors.md), [permission ledger](contracts/standing-signature-ledger.md); a person permits one exact call, one permission kind covers a tool's defined arguments, legacy limits remain until re-signing, unknown effects pause that tool on that connection |
| Unknown-call evidence and person resolution | `packages/surfaces/app/src/components/settings/HeldCalls.tsx`, `packages/surfaces/app/src/lib/connector-call.ts`, `packages/platform/src/composition/api-line.ts`, `packages/surfaces/cli/src/main.ts` | [Unknown-call inspection](contracts/connectors.md#what-the-person-can-inspect-about-an-unknown-call), [app contract](../packages/surfaces/app/CONTRACT.md#connector-approval-and-inspection); exact statement, releasing permission and retained dispatch witness; native happened/not-happened/keep-closed answers. CLI requests the app dialog and cannot resolve alone |
| Brand at build time | `scripts/lib/brand.mjs`, `packages/surfaces/app/scripts/build.mjs` | [Distribution settings](distributions.md), [Backbone configuration](../distributions/backbone/README.md) |
| Verification | `scripts/`, `oracle/`, `conformance/` | [Run checks](how-to/run-the-checks.md), [oracle](../oracle/README.md), [conformance jobs](../conformance/README.md) |

## Source and verification tools

| Owner | Source and purpose | Checks or limits |
| --- | --- | --- |
| Core schema build | `packages/core/scripts/closed-version.mjs`, `packages/core/scripts/closed-version-assembler.mjs`, `packages/core/scripts/closed-version-functions.mjs` | Closed inventory, exact function signatures, active-definition map and packaged release-data reproduction; [schema README](../packages/core/schema/README.md) owns the commands |
| Material closure pins | `packages/core/scripts/material-closure-pins.mjs`, `packages/core/scripts/material-closure-durability.mjs`, `packages/core/scripts/material-closure-hardening-pins.mjs` | Source/pin and native durability controls; `packages/core/test/material-closure-source.test.ts` and the material-closure native suites. A source check does not prove an installed catalogue |
| App workspace packaging | `packages/surfaces/app/scripts/workspace-runtime.mjs` | Stages the Python/libproc supervisors beside the bundled Host; `packages/surfaces/app/test/workspace-runtime.test.ts` checks the build closure, not an installed-app journey |
| Fixture readiness and hangs | `scripts/lib/test-child.ts`, `scripts/lib/test-hang.ts` | Child output or exit establishes readiness. A three-minute hang detector reports pending state; it is not a latency promise. Regressions: `scripts/test-child.test.mjs`, `scripts/test-hang.test.mjs` |
| Local qualification gate | `scripts/gate.mjs`, `scripts/gate.test.mjs` | Streams suite logs, atomically updates running/completed/timed-out evidence at each suite boundary and bounds each suite. [Gate instructions](how-to/run-the-checks.md#qualification-gate); partial evidence is not a passing run |
| Linux Codex qualification installation | `scripts/codex-qualification/package.json`, `scripts/codex-qualification/package-lock.json`, `.github/workflows/gate.yml` | Locked, integrity-checked client install and expanded native probes for the disposable hosted runner; future execution is paused by the owner, not a passing result |
| Schema and image checks | `scripts/structure.mjs`, `scripts/lib/docker-context.mjs` | Schema structure invokes the closed-version checker. Docker context includes workspace runtime assets and licence notices; it does not qualify a Linux workspace or the current Linux Codex security delta |

## Terminal work available today

Source and test coverage do not establish real use of every engine or the combined build.

The [CLI guide](how-to/use-the-cli.md) owns the exact commands now available: `backbone engine codex`, `backbone model codex --model gpt-6.1-sol`, `backbone files attach "$SOURCE"`, `backbone files read summary.md --version 1`, `backbone files save summary.md --base-version 1`, and `backbone send "Read this file and describe its columns." --thread "$THREAD" --attach "$SOURCE" --permission full`. The guide also gives the Pi route and the account-free stub practice job. Standalone data folders support these writes. The running personal app or daemon also carries `files attach` through its API line, with the same 25 MiB file limit; company sign-in directs attachment to the signed-in app. The line does not carry engine/model changes, send attachments or Save.

| Behaviour | Source | Controls and limits |
| --- | --- | --- |
| CLI selection, attachment and document Save | `packages/surfaces/cli/src/first-job.ts`, `packages/surfaces/cli/src/commands.ts`, `packages/surfaces/cli/src/main.ts` | CLI first-job, attachment-file and commands tests; regular files at most 25 MiB, expected-version Save; [CLI guide](how-to/use-the-cli.md) |
| Effective engine and model settings | `packages/platform/src/composition/engine-settings.ts`, `packages/platform/src/model-setup.ts`, `packages/platform/src/models/route.ts` | Engine-settings tests; same data folder settings as the app, environment overrides still apply |
| Truthful failed and unfinished turns | `packages/platform/src/completion.ts`, `packages/modules/harness-pi/src/completion.ts`, `packages/platform/src/ports/harness.ts` | Engine completion signals; CLI exit 6 FAILED and 7 UNFINISHED, partial text retained; completion and first-job tests |
| Work-record credential redaction | `packages/platform/src/ports/redaction.ts`, `packages/modules/harness-codex/src/events.ts`, `packages/platform/src/composition/harness-turn.ts` | Redaction and Codex event tests; known keys, explicit credential forms and token-shaped strings removed before recording; records are not replay scripts |
| Registered versus unregistered files | `packages/platform/src/composition/project-files.ts`, `packages/surfaces/app/src/lib/file-classes.ts`, `packages/surfaces/app/src/components/tabs/FilesTab.tsx` | File-class and current-author tests; folder copies are not engine inputs until attached |
| macOS 15 snapshot publication | `packages/platform/src/composition/snapshot.ts` | Publish writable tree, verify digest, then freeze before importing; snapshot tests |

[Architecture](architecture.md) owns invariant IDs and trust limits, not another piece map. [Repository design](repo-design.md) owns manifests and loader mechanics. [Contracts](contracts/) describe interfaces; the [Engine contract](contracts/harness.md#local-working-environment) now links the implemented offline workspace. Some contracts describe intended work, so check their status against source. [ADRs](adr/) preserve expensive decisions and their reasons. [Product acceptance jobs](../acceptance/README.md) are local and extend conformance; they are not prerequisites for local builds or guides. [Product owners](../GOAL.md) and [specifications](specs/README.md) now share this checkout. The integrator maintains the [local execution record](execution.md), including the qualified candidate and queue.

For a Core change, test every dependent workspace package from the checkout root:

```bash
pnpm --filter '...@backbone/core' test
```

The leading dots select Core and the packages that depend on it; this is broader than the Core suite alone. Package tests do not replace installed-app acceptance.

The platform's [managed policy](contracts/managed-policy.md) verifies one signed
system file for every data folder. [Manage data folders](how-to/manage-homes-with-a-policy.md)
explains deployment, administrator commands and the protected version record.
The live Host, vault, connector and Settings paths enforce its requirements.
Managed policy integration is applied
and archived; the current build has no deferred requirement keys.
Read-only data folders: the [data folder contract](contracts/readonly-home.md) records the
F7 completion preflight, baseline write inventory, PostgreSQL runtime exception and
Host/Core/CLI proving controls. Reads refuse incomplete data folders without initializing them.
