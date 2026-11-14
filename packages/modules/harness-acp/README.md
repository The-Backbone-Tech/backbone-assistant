# ACP engine — experimental restricted-writes agent route

Standalone use is exercised by a fake-agent test with a ToolHost in the [guide](../../../docs/how-to/use-the-acp-harness-alone.md); this does not qualify a real provider.

An ACP agent runs as you. With restricted-writes, it can read whatever you can read except the listed credential places, this Host's data folder, the default per-user audit scratch parent, denied folders and ACP storage outside its own folders. It can read environment variables and command lines of your other running programs, which often hold API keys. It has unrestricted outbound IP network, including loopback. The restricted-writes setting only stops it writing outside its own folders, signalling other processes and starting system background services. With person-rights, a custom agent can read and write this app's data folder, including settings.json, and reach machine credentials; OS restrictions are off. The credential places are listed in `CREDENTIAL_PATHS` in `packages/platform/src/ports/harness.ts`. The route is off unless this data folder explicitly sets `harnesses.harness-acp.acceptsProcessVisibility` to true; selecting the engine alone does not enable it.

This experimental module implements ACP v1 with the official Apache-2.0 TypeScript SDK pinned at 2.5.0. Configured agents own their model, billing and sign-in. Local fake-agent, Host and OS-rule tests pass; vendor-agent compatibility and sign-in remain unqualified. Linux and hosts without sandbox-exec refuse restricted-writes execution. Explicit person-rights is never a fallback for a failed policy.

## Use it alone

Import `createAcpHarness` from `@backbone-next/harness-acp`, provide an executable and literal arguments, and consume the Engine turn's events and outcome. Always close the engine. The [standalone guide](../../../docs/how-to/use-the-acp-harness-alone.md) and [Engine tests](test/harness.test.ts) give a runnable example using a local fake agent. These tests establish the adapter behavior, not a vendor account entitlement.

The route is off unless this data folder explicitly sets harnesses.harness-acp.acceptsProcessVisibility to true. Selecting the engine alone does not enable it. A standalone caller must likewise pass acceptsProcessVisibility: true. Home engine configuration is read when the Host opens; reopen the data folder after changing it.

For a home, use Settings → AI and models → Your own ACP agent. Enter the
command, arguments and environment variable names, choose Resolve executable,
review the real path and hash, and accept its risks before saving. Restart the
Host to activate it. Old hand-written settings without a bound acceptance stay
disabled. An API caller first uses settings.model.put with route agent-resolve and
a configuration draft, then submits its returned configuration and acceptance
with route agent, acceptsProcessVisibility: true and, for person-rights,
acceptsPersonRights: true after the person's review. The acceptance is specific to
that machine's executable; do not copy it from another installation.

`restricted-writes` is the macOS default. Changing this to `person-rights` is an explicit choice of the person's own filesystem and network rights. No product API silently makes that change. Explicit denied folders cannot be combined with person-rights execution.

The route identifies provider `acp:<agent name>`, kind `agent`, and model `chosen-by-agent`. The agent owns its model, authentication and billing; Backbone signs in to no account and resolves no platform provider credential. Named model requests refuse. Selection treats the route as networked and potentially metered.

## Current capability mapping and evidence

ACP means protocol transport, Backbone means behavior supplied around the agent, and Unavailable identifies a gap. Observations below come from the local fake and OS tests; they do not establish compatibility with every ACP agent.

| Port behavior | Owner | Current observation |
| --- | --- | --- |
| Restricted-writes agent startup | Backbone | The configured fake starts under the deny-default macOS profile. Real-profile tests deny direct outside writes and protected/sibling reads, outside signalling, job creation and desktop handoff. Process visibility requires explicit per-home risk acceptance. Linux and missing sandbox-exec return their specific reasons. |
| Start and streamed answer | ACP | The restricted-writes fake streams “rea” and “dy” through the engine port and completes a Host turn with “ready”. |
| Permission requests | Backbone | Generic native-operation approvals are never permitted; reject_once or cancellation remains the only response. Permission callbacks are a second check, not an OS boundary. |
| Client file methods | Backbone | Caller path must exactly equal the joined working folder and one plain non-dot filename; both session folder identities are checked before each client method, and the joined path is opened. Before any read or truncation, the Host rechecks the parent and compares fstat of the opened file with lstat of its name. Symlinked-parent/.., absolute outside, nested, dot, symlink and hard-link cases refuse. Reads have a fixed byte bound even if the file grows after fstat. |
| Client session/Stop guard | Backbone | Wrong session ids and file requests after Stop refuse in the local fake control. |
| Client terminals | Unavailable | No ToolHost command permission exists; terminal methods refuse. |
| Canonical files and memory/card/child tools | Backbone via ACP MCP | The bridge calls only the active ToolHost; a restricted-writes Host test creates canonical material through the gateway. Wrong tokens, the send gate and old-turn admission refuse. Parallel canonical writes serialize; REFUSED or unknown outcome closes further canonical writes. |
| Connector tools | Backbone via ACP MCP; read binding unavailable | Component tests carry complete/partial status and held proposals. A person can give a tool a permission; its effect calls then go out without asking again. A real Host ACP turn sends the signed fake tool once and records that authority. SENT/sent lets the turn continue; SENT/failed is an error result for the agent and lets it continue, since the server gave a definitive refusal. unknown outcome, including SENT/unknown or a thrown call, stops the turn and is never retried. A real Host turn refuses the read before the local fake provider is called or material is retained. The missing native invocation binding is the reason: ACP does not currently supply the pi/codex identity contract. No RPC counter is substituted. A thrown connector call is treated as unknown outcome; any connector unknown outcome stops the ACP turn and prevents further tools or success. Final cleanup waits up to stopTimeoutMs (500 ms by default) for in-flight connector/write receipts after abort; the outcome retains their recorded unknown outcome detail, or explicitly states that an unresolved call is unknown outcome, even after time-out, agent death or an early cancel reply. An end_turn answer cannot succeed while a connector or write receipt is unknown outcome or remains in flight after that wait: the outcome is interrupted and native state is discarded. |
| Reviewer and ask children | Unavailable | nativeCoordination now applies to ACP. The platform refuses reviewer and narrower ask children rather than claiming it can restrict native tools per child. |
| Live continuity | ACP | Existing session reuse remains conditional on permitted history and retained-source attestations. |
| Restart/load continuity | ACP | The fake replays history during session/load. Updates are ignored until a new prompt begins, so historical replay does not enter the answer or consume stream limits. |
| Unattested/revoked context | Backbone | Changed retained sources interrupt reuse; unattested tool data discards native reuse. Arbitrary native reads still have no source attestation. |
| Stop and close | ACP + Backbone | Stop sends cancel and invalidates the connection generation. Once final cleanup starts, Stop is inert and cannot arm a timer against the next turn. Cleanup joins any in-flight reconnect, closes its bridge and sends TERM to the live agent's process group; KILL follows after 250 ms only if the parent is still live. No group signal follows an observed parent exit, so surviving children are not guaranteed to be killed. Copy/discard I/O is joined and may extend the turn beyond its request deadline. |
| Folder nodes and incarnations | Backbone | The profile denies changes to the work/agent folder nodes while allowing writes inside. Host checks reject observed symlinks, changed identities and modes before bridge creation, spawn and client file methods; opened handles are compared with checked names before use. These are second checks behind the profile. Each new process gets random paths; a detached survivor cannot access the next incarnation. |
| State retirement | Backbone | The old tree is renamed outside its permissions and deletion is attempted in finally, including when copying fails. The profile refuses direct flag and ACL changes, but ACLs supplied at creation and flags inherited by file clones can still land. Host retirement attempts independent no-follow flag, owner-permission and path-ACL repairs before retrying removal. It never opens planted FIFOs, sockets or devices; special entries are unlinked. File metadata is batched, and external repair/removal commands have two-second deadlines that kill and reap their owned process groups. Relative system traversal handles trees beyond PATH_MAX, with system rm as the final fallback. A failed repair is not claimed as successful cleanup. File cloning stays available for ordinary agent copies. A sweep continues past anything it still cannot remove and reports that unresolved cleanup in the turn outcome; reuse blocked by unconfirmed cleanup names that reason. Outcome errors are not displayed for completed or interrupted turns by the current Host, so every unresolved removal and later sweep also writes a structured retired-state-removal-failed warning, including the retired folder path, to stderr. Standalone operators read their process's stderr; the installed daemon captures it in logs/daemon.log inside the data folder. That log remains available after the turn completes and subsequent sweeps repeat the warning until removal succeeds. Owner permissions are restored for removal; special files are skipped when copying. Stop/failure/withdrawal join setup and discard state. A cleanup error is reported without rejecting the outcome or leaving its stream/thread open; this session refuses reuse until cleanup succeeds. |
| Idle resources | Backbone | After 60 seconds idle by default, the process and bridge close. A load-capable fake resumes on its next prompt; without load support a new native session is needed. |
| Crash replay | Unavailable | Crash-cut turns are not automatically replayed. Canonical receipts and unknown outcome retain their existing owners. |
| Steering | ACP extension + Backbone | Agents advertising `_meta.steering.supported` receive `_session/steering` with the host-owned `promptRequired` idle behavior. Only `injected` confirms delivery; an unsupported agent or `promptRequired/noRunningTurn` returns to the existing Host queue. A lost, malformed or detached-turn response is unknown, stops the turn and is never resent. Component and fake-process tests cover these outcomes; vendor compatibility remains unqualified. |
| Bare/read-only engines and model/effort control | Unavailable | No claim that ACP can enforce these behaviors for an arbitrary native agent. |
| Usage and native completion receipts | Unavailable | Zero token counters are placeholders, not measured zero cost. Native activity does not become a canonical effect receipt. |

## Claude Code machine sign-in

Settings → AI and models offers the separately installed Apache-2.0
[Claude Agent ACP adapter](https://github.com/agentclientprotocol/claude-agent-acp),
version 0.105.0, the maintained successor to Zed's claude-code-acp. Sign in with
`claude auth login` outside the app. The explicit machineClient setting is claude
and requires person-rights plus the existing process-visibility acceptance.

The adapter receives the machine HOME, CLAUDE_CONFIG_DIR (by default the machine
home's .claude folder) and CLAUDE_CODE_EXECUTABLE (by default claude on PATH).
These are non-secret settings; no API key, OAuth token or Host credential is passed.
Before spawning it, the installed CLI's auth status JSON must report a claude.ai
sign-in. A signed-out, other-authentication, absent or malformed result refuses;
doctor shows only a class and its command source, never account output.
The diagnostic uses the same selected configuration directory and executable.
The [CLI reference](https://code.claude.com/docs/en/cli-reference) owns that status
command; the adapter's paths and CLI resolver own the two environment settings.

New and loaded Claude sessions use the adapter's supported session metadata to
pre-approve only the supplied backbone MCP server's tools. Each call still crosses
the Host bridge and its normal authority checks. The session disables the adapter's
bypass-permissions mode; requests for native permission keep the Harness port's
existing refusal. These settings do not contain the machine client or override
native allow/ask/deny rules or defaultMode. Hooks can also approve native activity without an ACP permission request. The [SDK permission reference](https://code.claude.com/docs/en/agent-sdk/permissions)
owns the MCP rule syntax and its evaluation order.

This mode runs with the person's rights. It can reach machine files, Claude
configuration and history, its credential services, native tools and network;
Backbone does not isolate native actions or claim receipts for them. The client
can also read the Host data home and other same-user ACP session folders;
0600/0700 permissions do not separate processes running as the same user. Only Host
MCP writes receive canonical receipts. Other credential environment settings are
refused, and inherited provider keys are omitted. Stop discards the private ACP
working/session state; it does not erase machine Claude login, history or native
writes. Machine config may contain instructions, hooks, MCP servers or credential
helpers that the trusted installed client executes. The generic restricted-writes
route remains unchanged and cannot use machine-client authentication.

The machine client and signed-out controls are in
[test/machine-client.test.ts](test/machine-client.test.ts). The explicit
[test/claude-startup.ts](test/claude-startup.ts) qualifies a separately installed
adapter's initialization with a disposable machine-CLI fixture, without a model
call. Real authenticated Claude use remains separate qualification.

## Resolve, accept and refresh

Settings first resolves the executable using absolute PATH entries and the
maintained tool-discovery install folders, so Finder launches can find common
installs. It shows the real path and SHA-256 before acceptance. The executable,
symlink target and ancestors must be owned by the person or root and must not be
group/other writable. The saved path, device/inode, bytes and configuration are
checked again before launch. Changed programs or arguments require fresh
acceptance. Person-rights has a separate checkbox for reading and writing the Host
home, settings.json and machine credentials. Entry-file checks do not seal all
loaded scripts or dependencies, nor contain an actor that can rewrite the saved
acceptance itself. A person-rights agent can change settings.json to persist a
new next-launch engine. Settings saving still applies managed engine, environment
and model-route requirements; personal acceptance cannot override them.

Sign-in checks run asynchronously. Settings reads return a cached class, initially
checking, without launching a process. Startup and the person's explicit sign-in
refresh action update it. Opening Settings only reads the class;
a launch awaits a fresh check before the adapter starts.

Claude may load the machine's backbone-door MCP server installed by Connect your
AI tools. This second route uses the door's grants, not the turn's, and asked writes
still need the person's app approval. The Host tool pre-approval glob does not
match backbone-door; a machine server named backbone collides with the supplied
server name. Native permissions.allow rules, defaultMode and hooks may run tools
without an ACP permission request, so the refusal applies only to requests the
client actually forwards.

## Write and service rules and process visibility risk

The old allow-default profile has been removed. The enabled deny-default policy is derived from openai/codex revision e1cc96712f9ad4f5404fe821b9eba7ff29598816, using the upstream Seatbelt base and network policies read on 10 November 2026. Copyright and Apache-2.0 notices are retained in [LICENSE.codex](LICENSE.codex), [NOTICE.codex](NOTICE.codex) and the source header. ACP omits IOKit, IPC, PTY and broad Unix-socket permissions, filters reads, and permits IP outbound access. The Codex-derived policy was chosen because it permits an explicit service allowlist and session-specific filesystem filters without another runtime dependency. The alternative Apache-2.0 sandbox-runtime 0.0.81 library was previously probed and exposed the same peer-environment limit.

Process visibility is a risk that requires the data folder's explicit acceptance; it is not a privacy guarantee. Other running programs' environment variables and command lines can expose their API keys to an ACP agent. Backbone's own bridge tokens and addresses stay in 0600 session-private files, outside argv and environments. The launcher passes a small environment allowlist, and the Host supplies no model-route credential to the agent.

The [known-limit test](test/seatbelt.test.ts) now asserts the observed exposure using a small compiled C helper and an owned target with a disposable canary variable. The opt-in field acknowledges this measured risk; it does not weaken filesystem, signalling or launch guards. [Shim tests](test/shim-secrets.test.ts) inspect both own and sibling shim processes inside the real profile, verify sibling capability-file denial, and attempt the other session's bridge using every recovered argument/environment value. Every attempt is refused.

The remaining OS canaries now pass: outside signals fail, own children can be signalled, launchctl print and submit refuse, open cannot start the command file, protected and sibling reads fail, own-folder writes succeed and IP network is reachable. The launchctl executable is explicitly refused because inherited bootstrap access otherwise permits metadata queries; job creation is independently checked with a compiled SMJobSubmit client. It refuses under the production profile and creates a disposable marker job under a test-only allow-job-creation variant; the test removes that job. The earlier copied-launchctl canary was invalid because macOS killed the copy independently of the profile. This does not claim all launchd metadata queries from hand-written clients are hidden. The default-deny lsopen/Apple-event boundary prevents desktop handoff. Node and the C helper start without additional service permissions. Retained network/user services are the Codex-derived DNS/configuration, TLS trust and directory lookup allowlist. No Python runtime is required by the canaries.

Restricted-writes reads remain broad: the agent can read everything the person can read except the credential places, explicit denied folders, this Host's data folder and the whole ACP storage folder (with exceptions for its own working and agent folders). Documents, repositories and shell startup files outside those exclusions remain readable. Other data folders on the machine are not automatically denied. Credential places are derived from the Host process's HOME and the supported credential-directory variables.

Outbound IP networking is unrestricted, including loopback. Local services that have no authentication are reachable; the bridge's bearer checks protect only the bridge. Unix socket connections are refused by the profile, including connections to the Host's Unix-socket doors. This is not a network privacy boundary or a network-free route.

Denied folders now resolve the deepest existing ancestor, including a symlinked ancestor of a folder not yet created. The whole ACP storage root is excluded by the read rule, with explicit exceptions only for that session's work and agent folders. The real-profile sibling-read canary passes. The work and agent directory nodes themselves have explicit file-write denials after their content permissions, preventing rename, replacement and chmod. The Host records each real directory's device, inode and mode and checks them before bridge creation, each spawn and client file access. After opening a scratch or capability file it rechecks the parent and compares the opened file with its named path before using it; spawn setup similarly compares opened directory handles. These Host checks are a second check behind the profile's node denial. They are not a complete authority boundary against a person-rights actor racing filesystem syscalls.

## Storage, authentication and secret inputs

Storage is created under a per-user private temporary-area root. Every storage/session folder must be owned by the current user, mode 0700 and not a symlink; the profile refuses a storage root that does not strictly contain both session folders; an existing wrong folder is refused rather than repaired. The Host's data folder deny is tested both at the registered-factory handoff and by a restricted-writes fake agent that attempts to read that disposable data folder's settings file and receives EPERM.

Each new process incarnation receives a fresh random session folder, including reconnects and restart/load. Before retained native state is copied, the old tree is renamed outside its permitted paths; the copy has new file inodes and deletion of the old tree is attempted in a finally block even if copying fails. Unresolved removal is reported in operator output. Owner access is restored inside retired directories for copying and deletion. Only regular files, directories and symlinks are retained; FIFOs, sockets and devices are skipped. Session creation sweeps orphaned retired trees in its private parent, leaving live retirement owners alone. Stop, failure and withdrawal invalidate pending connection work, wait for it to finish and discard native state instead of preserving it. The generation is rechecked after copying, after bridge creation and after agent initialization; any agent started by an abandoned connect is closed before cleanup settles. The protected per-thread pointer is outside the agent's readable/writable folders. Native agents that require old absolute state paths have not been qualified.

A detached descendant can survive Stop or its parent's exit. It keeps its old write-restriction profile: broad permitted reads, outbound network, process inspection and already-open file handles remain possible. It cannot use the new incarnation's paths to read its capability file or write its working folder; the real-profile detached-child test verifies both refusals after Stop. It may consume resources until it exits or the person stops it. The module does not promise to reap detached descendants.

For isolated agents, Stop and failure deliberately discard the agent HOME after joining any connection in flight. The outcome waits for that discard; large copies or filesystem cleanup can extend this wait. If cleanup cannot be confirmed, the turn reports the cleanup error, its stream still closes and the current session refuses native reuse until cleanup succeeds. ACP does not identify which files are sign-in state and which retain conversation or withdrawn source data; preserving that combined folder would preserve both without source attestations. Authentication state therefore does not survive Stop. Canonical documents, history and receipts remain with Backbone. A separate, attested authentication/custody boundary would be needed to change this decision.

Named environment input is limited by contract to non-secret configuration. Credential-shaped names (KEY, TOKEN, SECRET, PASSWORD, CREDENTIAL or AUTH) are refused both by the Host and the adapter. This name rule cannot detect secret bytes disguised as ordinary configuration. The manifest declares surrogate access for the scoped MCP capability token, not a permission to forward raw provider credentials. Agent-owned authentication is external to the core's credential service and is not qualified in this trial.

Under the write-restriction profile, plain cd in /bin/sh or bash --posix fails, even for cd . or a subfolder, because the working folder's ancestors are not readable. zsh, ordinary /bin/bash and /bin/dash work, as do sh with cd -P or set +o posix. An agent that shells out through /bin/sh with plain cd child && build will fail before the build runs. This module does not choose the agent's internal shell; configure an alternative only if that agent supports it. The real-profile shell canary checks these cases.

## What is not done

Real isolation for ACP requires running the agent as a separate macOS user or inside a virtual machine. Lima is installed on this machine (limactl is available), but this trial creates no VM, user or separate execution identity.

The follow-up qualification must start an owned Host-side process with a disposable environment canary and command-line canary. A Host-side positive control must see the canaries while the agent, running under the separate user or in the VM, must be unable to read that process's environment or recover either canary. Keep the existing write, service, lifecycle and ToolHost canaries alongside this new test. Neither that implementation nor its unreadable-environment test is built here; acceptsProcessVisibility only acknowledges the current route's risk.

## What it replicates and why

The module implements the neutral ACP client transport rather than one vendor-specific adapter. Protocol and operating-system boundaries have separate responsibilities. Sources: [ACP](https://agentclientprotocol.com/protocol/v1/initialization), [TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk), and [pinned Codex base policy](https://github.com/openai/codex/blob/e1cc96712f9ad4f5404fe821b9eba7ff29598816/codex-rs/sandboxing/src/seatbelt_base_policy.sbpl).

## Swap and removal

Close active turns before selecting another Engine. Canonical work and unresolved receipts stay with their existing owners. The module installs and signs in to no agent. Native state is not a portable backup. The independent review of the preceding follow-up accepted it with further fixes. This revision validates before dispatch, interrupts early completion with unknown outcome receipts, repairs metadata without opening special files, bounds and reaps cleanup utilities, tests unchanged outside-target flags, modes and ACLs through both repair paths and pins the write-side guards, and makes unresolved retirement visible in operator output. One redundant removal fallback was removed; the remaining system-rm fallback has its own regression test. It also states the measured plain-cd shell limitation. The focused tests include real macOS profile canaries and a real Host turn using a signed fake connector; removing either reconnect join, the spawn-directory comparison or the transport acceptance check makes its regression test fail. These repairs have not received a further independent review; real vendor-agent qualification remains separate.

## Manifest

<!-- generated from backbone.module.json by scripts/module-readme.mjs; do not edit -->
| Field | Value |
| --- | --- |
| id | `io.github.albertoangulo/harness-acp` (module) |
| version, licence | 0.0.0, Apache-2.0 |
| publisher | Backbone maintainers, namespace `io.github.albertoangulo` (github, pending) |
| stability | experimental |
| provides | Harness 0.x |
| consumes | ToolHost 0.x |
| capabilities | planes: personal; effect classes: 2; operations: workspace.write_document; network: agent-managed-network; secrets: surrogate |
| data | owns: agent session ids and private agent state; migrations: 0; export: canonical documents and history belong to the core; native agent state is not exported |
| depends on | @agentclientprotocol/sdk 2.5.0 (Apache-2.0) |
| conformance | bronze: `packages/modules/harness-acp/test/harness.test.ts`, `packages/modules/harness-acp/test/write-restrictions.test.ts`, `packages/platform/test/harness-acp.test.ts`, `packages/modules/harness-acp/test/mcp.test.ts`, `packages/modules/harness-acp/test/files.test.ts`, `packages/modules/harness-acp/test/seatbelt.test.ts`, `packages/modules/harness-acp/test/storage.test.ts`, `packages/modules/harness-acp/test/review-fixes.test.ts`, `packages/platform/test/harnesses-config.test.ts`, `packages/modules/harness-acp/test/shim-secrets.test.ts`, `packages/modules/harness-acp/test/folders.test.ts`, `packages/modules/harness-acp/test/incarnation.test.ts`, `packages/modules/harness-acp/test/reconnect-lifecycle.test.ts`, `packages/modules/harness-acp/test/open-identity.test.ts`, `packages/modules/harness-acp/test/retire-poison.test.ts`, `packages/modules/harness-acp/test/opt-in.test.ts`, `packages/platform/test/harness-acp-opt-in.test.ts`, `packages/platform/test/pieces.test.ts`, `packages/platform/test/selection.test.ts`, `packages/modules/harness-acp/test/cleanup-stop.test.ts`, `packages/modules/harness-acp/test/unknown-flight.test.ts`, `packages/modules/harness-acp/test/cleanup-report.test.ts`, `packages/modules/harness-acp/test/retire-native.test.ts`, `packages/modules/harness-acp/test/invalid-tools.test.ts`, `packages/modules/harness-acp/test/cleanup-command.test.ts`, `packages/modules/harness-acp/test/removal-fallback.test.ts`, `packages/modules/harness-acp/test/repair-links.test.ts`, `packages/modules/harness-acp/test/repair-dashes.test.ts` |
| exemption | real-agent qualification: transport and Host tests use a local fake; vendor sign-in and installed-agent compatibility remain unqualified |
| exemption | process visibility: off by default; acceptsProcessVisibility must explicitly acknowledge that other same-user process environments and command lines can expose API keys; bridge capabilities stay in session-private files and never process argv or environment |
| exemption | retained connector read invocation binding: the integrated Host requires native pi/codex invocation identity; this generic ACP route does not fabricate one from MCP request IDs and retained connector reads refuse |
| exemption | descendant process lifetime: detached descendants and children surviving an agent self-exit are not guaranteed to be killed; fresh random incarnation paths prevent access to the next capability file and working folder, while permitted reads, outbound networking and already-open file handles remain possible |
| removal | stop active ACP attempts before removal; canonical receipts stay with the core; refused while one of its effects is UNKNOWN |
<!-- end of generated block -->

The audit scratch read exclusion is the fixed path returned by the platform auditScratchParent helper. Operator scratch overrides elsewhere are not covered by that exclusion; supply them as denied folders before running restricted agents.

The audit-parent exclusion uses only its lexical path and macOS /private form; it never resolves a link planted there. A link cannot expand that exclusion to its target or make unrelated work folders overlap it. The real-profile link canary checks an ancestor remains readable, while the real-parent canary checks scratch contents remain denied.
