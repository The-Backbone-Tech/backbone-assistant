# Native Codex staged executor

This is an internal module behind the platform engine port. Real inference needs a supported installed Codex client and sign-in; local tests use a fake client.

This experimental HarnessV1 adapter runs the installed official Codex client on its existing managed ChatGPT login. It does not read, copy or export authentication tokens, resolve API credentials, install models or fall back to another model/provider. The executable version is pinned to 0.165.0. macOS and Linux are accepted only after the same native sandbox probe passes. Linux adopts the pinned client’s bubblewrap namespaces and seccomp backend; it never falls back to unconfined execution or legacy Landlock. See [machine requirements and refusal guidance](../../../docs/how-to/use-native-codex.md).

**Linux security delta, 10 November 2026:** Linux defaults to contained; Mac
keeps full. Full requires an explicit per-home choice and has rename/late-creation
credential-read gaps. Visible Host datagram sockets refuse admission; full can
expose sockets created later. The expanded Linux security matrix has unit tests
but **has not run on Linux** while hosted execution is unavailable.

Linux read-only instructions and its native turn work note state that writes are
discarded and nothing outside the staged copy persists. Structured answers remain
unchanged. Earlier hosted evidence predates this delta.


The executor makes copies of the active project's permitted text sources in an owned temporary directory. Native shell and patch operations work on those copies under a named restricted-read permission profile; completed new text drafts are captured into host-owned immutable strings and proposed through a conditional ToolHost crossing. Existing-document edits and deletions are refused. Canonical documents, receipts, source versions and unknown outcomes remain the core's responsibility.

This is a trusted native client with inherited global Codex instructions and managed authentication, not an exclusive three-tool or no-ambient-context engine. Its local command profile is not blanket confinement of the trusted app-server host, operating system or every native capability.

## Environment contracts

The Host runs shared projects in `contained`, even with Full permission: native account tools are available only when the live project audience is the device owner alone. Schedules and goals recheck this at execution time. The trusted request flag `nativeAccountTools: false` overrides a configured `full` environment.

Trusted composition chooses the environment a turn runs in; a model, message or document cannot. In both, native command writes are confined to the staged workspace and there are no command escalations (`approvalPolicy: never`). The command sandbox does not confine the trusted app-server or its native account tools. A project file changes only through the versioned import below, and a person's edit made meanwhile is kept beside the agent's.

- **`full`, the macOS default and an explicit Linux choice.** Codex's own working capabilities are on, as when the person uses it directly: memories, skills and their instructions, subagents, goals, live web search, image viewing, and the person's existing native connectors/apps, configured MCP servers and plugins. Codex retains global feature gates, each enabled/disabled choice and native tool permission; the adapter does not force apps, servers or plugins on. Image generation stays off until a generated image has a path to the person or the project. Commands can read the machine, except the credential and session locations listed in `CREDENTIAL_PATHS` under the data folder (with the skill/package read carveouts below): `.ssh`, `.aws`, `.config`, `.codex`, `.claude`, Keychains, Application Support, MCP servers' OAuth token caches (`.google_workspace_mcp`, `.mcp-auth`) and the like. Linux full masks are startup snapshots: replaced files or newly created paths can become readable. Web search runs at the provider, so it carries no local credential.
- **Off in every environment:** command network, lifecycle hooks, browser and computer-use feature switches. Hooks stay off because they run outside the proven command boundary. A native plugin or configured MCP server is trusted code with the person's own rights; these feature switches do not confine its implementation.
- **`contained`, the Linux default.** The working capabilities are off too, there is no web search, native apps/plugins and every configured MCP server are off, and commands read the staged copies plus minimal system runtimes. This is the profile the earlier evidence below describes.

## Native account tools under Full access

The platform requires Full project permission for ordinary Codex turns. In the
`full` environment the app-server uses the person's existing Codex home, sign-in,
connector authorizations, plugin configuration and skills. No account is connected
again in Backbone. Disabled servers/plugins stay disabled. Bare and read-only
turns still disable these capabilities. Linux's contained default stays unchanged.

Native account calls run in Codex under its own permissions, outside Backbone's
effect gateway. They do not acquire Backbone signatures or receipts, source-version
tracking or withdrawal enforcement. A native skill can name a missing dependency;
automatic skill MCP dependency installation stays off. Native client requests for
additional approval, authentication, elicitation or host action fail closed and
terminate the attempt under the existing transport policy. The adapter does not
manufacture approval or add a confirmation flow. Configure
such tools in Codex itself before using them here.

The command sandbox permits reads of the native `skills` and `plugins/cache`
subtrees inside `CODEX_HOME`, so discovered skills can load their instructions and
supporting files. The rest of that directory, including authentication,
configuration and history, stays denied. Explicit arrangement denies and moved
credential-cache denies override these read carveouts. The launch environment
retains its existing allowlist; arbitrary ambient environment credentials are not
inherited by native servers. A server's own configured environment or managed
credential store remains its responsibility.

The work record projects reported `mcpToolCall` starts/completions for the parent
and its validated sub-agents, naming only server/tool and native status. Arguments,
account content and native errors are not copied into these steps. A done step
means Codex reported completion, not an independently verified source-system
receipt. A client-reported failed or declined call is a failed step saying the
tool reported an error; it lets the turn continue regardless of read-only status.
Server-labelled read-only calls set no account-activity marker and never create
an unknown outcome, including failure, Stop and missing completion. Read-only
Stop and kill/reopen leave restart, rewind and goal recovery unblocked. Only an
unfinished possible-write call becomes UNKNOWN, interrupts the turn and prevents
draft imports. The harness never replays a native turn or retries an account call.
Reconcile in the source system before another attempt. Calls the client does not
report cannot be inferred from the answer, and killing the process cannot undo an
outside action. Backbone's own connectors and document imports retain their
existing checked crossings and receipts. After a hard process loss, recovery
preserves possible-write native work notes and marks the account outcome unknown
before continuing. Core receipts cannot settle it, even when Core work completed.
Goals stay blocked on that uncertainty. Restart and rewind refuse possible-write
native activity whenever the turn is not done. A person-facing action to mark a
native unknown as checked is a separate follow-up unit; inspect the source system
before deliberate fresh work.

When an existing data folder receives this engine's wider native account reach,
the desktop app asks once in plain words. Only Allow registers and grants the new
capabilities; Don't allow leaves the engine unopened and explains reinstalling
the previous app version. Bundled same/narrower-capability content updates are
registered without a dialog; configured/development paths still ask. CLI and
daemon refuse unregistered or widened content and direct the person to open the
app once. See the [engine contract](../../../docs/contracts/harness.md#native-codex-account-tools-13-november-2026)
for registration history and observation limits.

Read-only hints are supplied by the trusted native server, not independently
verified. The skill/package read carveouts expose all files in those code roots,
including any embedded credentials. Plugins can provide browser/computer-use tools
independently of the disabled feature switches.

**What admission checks:**
- The effective configuration against the chosen contract, in both directions: a capability that should be on but is off refuses the turn, as does one that should be off but is on.
- The filesystem map entry for entry, including every credential deny.
- Folders a run arrangement denies: `deniedFolders` in the data folder's `settings.json`, a list of absolute folders, is added to every profile's explicit denies and read back exactly, together with the Host data folder; a folder that cannot be named exactly stops the environment. Anything other than a list of folder paths, or a list for an engine that cannot deny them, refuses the host before any engine starts. It denies the original folders only: a copy already given to the turn as a project file, memory, a skill or instructions is not covered, so a run arrangement keeps such copies out of the arm's data folder. The J-solution method's isolation uses it for scoring, labels and the other arm's work.
- The child environment: `inherit=none`, and every variable a config layer sets is overridden to an empty string. Layers merge, so a variable cannot be removed, only emptied. PATH alone is set, from the host's absolute folders plus the system ones, so the shell finds programs by name.
- The real sandbox canary proves the filesystem and command loopback network denial, with a reachable Host-side positive control and an owned stand-in for a credential path. Protected reads are checked directly, through a symlink and a child process, and through the Linux proc-root alias (absent on macOS). Direct writes to Host files outside the staged copies are refused. Linux read-only may write private discarded views. Broad outside reads are allowed only in `full`; its Linux startup-mask limits are described above.

**Limits.** A turn in `full` can see readable files outside the credential locations, and the model's own web search queries leave the machine, as in the reference. The deny list covers the usual locations under the data folder, not every place a credential could be. The app-server itself is trusted and runs outside the command sandbox. Public network reads for commands (documentation, packages, repositories) are not given. Codex 0.165.0 accepts a per-domain map (`permissions.<profile>.network.domains`), but on 2 November 2026 it did not enforce it: with network on and only `registry.npmjs.org` allowed, a sandboxed `curl` still reached `example.com`, with or without `features.experimental_network`. Turning command network on would therefore mean all network, so it stays off. Native account tools have their separate Full-access contract above. Revisit when a pinned Codex enforces the map in a real sandbox probe. A second cold review on 2 November found the escalation, hook and environment findings resolved and no new write path; its remaining objections were these missing capabilities.

**Evidence, 2 November 2026,** the real Codex 0.165.0 client with `gpt-6.1-terra`:
- In `full`, one request searched the web and cited a current permission note. It read `/etc/hosts`, could not read `known_hosts` in the data folder's `.ssh`, could not reach `https://example.com` with curl, and imported `answer.md`.
- In `contained`, the same request said it could neither search nor read outside the workspace.
- A first cut that gave commands network and routed escalations to Codex's auto-review was rejected by a cold review. Network plus readable credentials could write to the person's accounts, and an approved escalation could bypass the import.

## Optional Host tools

An ordinary turn offers `memory_search`, `propose_memory`, `propose_goal` and
`message_card` only when its ToolHost supplies the corresponding method. They use
the same acknowledged client-side dynamic-tool channel as the Host's connector
calls. The descriptions come from `packages/platform/src/ports/host-tools.ts`; ACP
imports them too. Codex uses that table's JSON argument schemas. Pi keeps its native
TypeBox schemas: compatibility tests pin its declarations byte for byte against
c23b6d1 and check semantic equality with the shared schemas. This preserves Pi's
existing argument coercion as well as the exact declaration bytes.

Memory answers pass straight from the Host, which records their sources before
returning their words. They are data, never the person's instructions or authority.
Memory proposals wait for the person to keep or discard them; goal proposals leave
the goal unchanged until accepted. A card message carries a peer's words and permissions
nothing. Card refusals return their reason and detail as a tool error; memory tools
return the Host's words unchanged. Invalid arguments cause no Host call and return
a tool error to the agent. A Host exception returns a fixed tool error without
exposing raw exception details. These errors let the agent continue. Stop interrupts
the turn and suppresses a late tool answer. An unoffered tool fails the turn through
the existing client handler. Bare and read-only turns offer none of these four tools.

The remaining differences from Pi are intentional:

- Pi passes a thrown Host error's message to the agent. Codex returns exactly
  "Host refused the tool call or could not return its result." to keep raw
  exception details, including local paths or configuration, out of the native
  transport's result. Both let the agent continue after this tool error.
- Pi retains its TypeBox coercion (for example, null becomes the string "null").
  Codex validates strict string types and lengths before dispatch and calls no Host
  method on invalid arguments. Its explicit JSON boundary does not use Pi's validator.
- Pi answers an unoffered tool with a tool error and continues. Codex fails the
  turn because its native handler treats a request outside the admitted catalog,
  namespace or acknowledged turn as a protocol-boundary failure.
- Pi schedules these tools sequentially. Codex handles incoming native tool
  requests concurrently, as it already handles connectors. Calls can overlap;
  each awaits the Host's own checks and read recording before returning data.
  The adapter promises no Pi-style serial order and adds no result cache.
- The tool key is the same across Pi and Codex. Pi labels its events with that key
  (for example, `memory_search`); Codex uses the shared readable label ("Search
  memory") for its work display. Stop closes every pending Host-tool event as
  `unknown`: the agent has no confirmed answer, even if the Host later finishes.
  That event is not a canonical receipt. A late answer closes no event twice.
- Codex passes only declared fields to `proposeMemory` and `messageCard`. Pi's
  existing argument handling is unchanged; its Host still ignores extra keys.

Open question for the owner: a card message returning SENT with delivery state
unknown is currently reported to the agent as success on Pi, Codex and ACP, and
the turn continues. Should that uncertainty stop the turn or be presented as a
tool error? This task records the question and leaves that behavior unchanged.

The coordination split is deliberate:

| Engine | Optional tools supplied by the Host | Coordination supplied by the engine |
| --- | --- | --- |
| Pi | `memory_search`, `propose_memory`, `propose_goal`, `message_card`, `add_card`, `start_child`, `await_child` | None; Pi uses the Host's board and depth-one children. |
| Codex | `memory_search`, `propose_memory`, `propose_goal`, `message_card` | Codex's own collaboration tools, such as `spawn_agent` and `wait_agent`. Host `add_card`, `start_child` and `await_child` remain unoffered. |
| ACP | `search_memory`, `propose_memory`, `propose_goal`, `message_card`, `add_card`, `start_child`, `await_child`, when supplied | The configured agent may provide its own coordination. The bridge also supports the listed Host tools. |

Codex and ACP retain their `nativeCoordination: true` registrations. Codex already
owns its sub-agent lifecycle, sandbox and completion accounting; adding another
child mechanism would duplicate that ownership. ACP retains its existing
`search_memory` wire name and result format for compatibility. Actual availability
still depends on the Host's per-turn scope and the engine's read-only restrictions.

Each Codex turn starts a fresh ephemeral app server and rebuilds the dynamic-tool
catalog from that turn's Host, including after recreating the engine. Interrupted
native turns still refuse `resumed: true` before dispatch, as connector turns do;
reconciliation precedes a new turn. This change adds no persistent native resume.

Tests: `packages/modules/harness-pi/test/host-tools-compat.test.ts` pins Pi's
baseline declarations, null handling and schema equality.
`packages/platform/test/engine-tools-conformance.test.ts` drives Pi with the
scripted model, Codex with its fake native executable, and ACP with a fake agent.
`test/host-tools.test.ts` covers availability, validation, refusal and Stop for each
Codex tool; `test/host-tools-boundaries.test.ts` covers call-time withdrawal,
namespace refusal and turn-level connector uncertainty;
`test/host-tools-restart.test.ts` covers fresh turns, engine recreation and replay
refusal. No real Codex binary or model was driven for this change; these
tests qualify the adapter's fake transport path, not a vendor-client deployment.

## Bare turns

A turn that asks for no tools (`TurnRequest.bare`, memory consolidation's judge) runs with nothing staged or imported, the shell and web search off, every feature Codex reports on (`codex features list`) forced off except `code_mode_host` and `skip_host_skill_discovery`, and a tool-free copy of the model catalog Codex reports (`codex debug models`). On 0.165.0 the catalog, not the features, adds code-mode `exec`, `wait` and the sub-agent tools to every listed model. The copy is written into an owner-only (`0700`) folder of the attempt and its SHA-256 recorded. Before the real request, the same settings run once against a loopback stand-in provider on a random secret path, which takes only a POST naming the expected model and then closes; the turn is refused if that request offers any tool. The real client's config read-back must name the catalog, and the catalog's bytes must still match the digest after that read-back and again before the turn starts. Any reported item other than the prompt, reasoning and the answer fails the turn.

**Boundary.** A process running as the same user is outside this boundary: it could already read the data folder, and could race the stand-in or the catalog file. The checks above defend against the model and the person's Codex configuration, not against such a process.

## Sub-agents

On 0.165.0 the model catalog, not the feature flags, decides that Codex's collaboration tools (`spawn_agent`, `wait_agent`, `interrupt_agent` and the rest) are offered, so the model can delegate in `contained` as well as `full`. A sub-agent is another thread in the same app server, under the parent's sandbox: a real canary on 4 November had macOS seatbelt deny a sub-agent's read of a denied sentinel and its write outside the workspace in `contained`.

A turn accounts for the sub-agents it spawns:
- **Which threads count.** A thread is the turn's only once a spawn item names it (`subAgentActivity` of kind `started`, or a v1 `collabAgentToolCall` `spawnAgent` with its receiver threads), in the parent's validated turn or a validated turn of an accepted sub-agent, whether as an item notification or only in a terminal snapshot's `items`. Every sub-agent turn notification must carry a `rootTurnId` equal to this turn's id, checked at receipt and again when held notifications are replayed; a missing or different root refuses the turn. A sub-agent item counts only inside one of its validated turns, so it cannot open a turn or register descendants first. Once that turn has ended, only a later lifecycle report about one of its descendants (`subAgentActivity` of a kind other than `started`) is still accepted, as for the parent, because Codex reports a descendant's lifecycle on the turn that spawned it; any other item after completion refuses the turn. Codex can report a child's first status before the spawn item, so notifications for a thread not yet named are held, at most 256 and 8 MB. Past either bound, when held notifications are still unclaimed at the end, or when a new thread appears after nothing could still spawn one, the turn is refused as before: "Native notification targeted another thread." Sub-agents (32), their turns and their tools (1,000 each) are bounded on every insertion path.
- **What the person sees.** A sub-agent's start, its command and file-change items, and how it ended are the turn's tool events under `native_subagent`, labelled `Sub-agent <its path>`. Its own messages are not the turn's answer. Its token use counts toward the turn's. Whether its shell commands surface as command items is Codex's choice: they did in the `full` check below, not in the `contained` canary, where only its start and end showed.
- **Its files.** It works in the same staged workspace, so its drafts reach the project only through the same snapshot and versioned import as the parent's, after the whole turn ends. There is no other path.
- **unknown outcome latches the turn.** A sub-agent turn that ends other than `completed`, a finished sub-agent tool reported again differently (the same semantic fingerprint as the parent's tools, applied to streamed items and to every item in a terminal snapshot), or an ended sub-agent turn reported again with a different status makes the sub-agent's work unknown outcome. A repeated completion is read in full, spawns included; only an identical repeat changes nothing. As with a parent unknown outcome, nothing is imported, and the turn ends `interrupted` with the reason and the sub-agent named.
- **The end of the turn.** The turn is over when the parent's turn has completed and every sub-agent's turn has too: a parent that finishes first waits for its children. Stop asks each running sub-agent and the parent to interrupt, waits at most a second for those answers, then ends the process group. At the deadline, a sub-agent still running makes the turn `interrupted`, with the reason and the sub-agent named, its tool event `unknown`, and nothing imported. Any other failure while a sub-agent runs says so in the error. A sub-agent whose own turn has not yet started has no turn to interrupt; the process-group kill ends it.
- **Real check, 4 November 2026** (Codex 0.165.0, `gpt-6.1-sol`, signed-in subscription, one turn in `full` on a one-file staged workspace): asked to delegate counting a note's lines to a sub-agent, the model spawned `/root/read_note_retry`; the turn ended `done` with the right answer, its events showed the sub-agent's start, its command (proposed, done) and its finish, usage included the sub-agent's tokens, and nothing was imported. Repeated after the strict root, snapshot and unknown outcome rules: the same result, with every turn notification, the parent's and the sub-agent's, naming the parent turn as `rootTurnId`.
- **Not covered.** A client-side tool call (the person's connectors) from a sub-agent's thread is refused like any unoffered call and fails the turn. A parent turn that Codex restarts after it completed, for example to deliver a child's result, is refused as another turn.

## Use

The factory exported by this package is `createCodexHarness()`. The optional factory options select a trusted executable command, standalone snapshot Node executable, temporary root and bounded protocol/turn timeouts; model messages and documents cannot set them. Its additional `listModels()` method makes a no-turn, ChatGPT-checked catalog probe and reports model identifiers, labels and supported numeric efforts. Catalog presence does not prove generation entitlement or credit availability.

The experimental local `snapshotNode` factory option takes an absolute path to an already-installed standalone Node executable. It wins over the operator environment fallback `BACKBONE_CODEX_SNAPSHOT_NODE`; the value is resolved once when the factory is created. An Electron host requires one of those explicit settings and never uses its Electron executable for snapshots. A standalone Node host defaults to its own executable when neither setting is present. This is trusted local configuration, not a new app setting or model-controlled path; the adapter never downloads a runtime or adds read permissions.

Each execution requires an explicit native/codex route with a null credential. The adapter validates its model and effort against the current catalog and refuses substitutions. Efforts map 1→minimal, 2→low, 3→medium, 4→high and 5→xhigh; unsupported choices are refused.

Conditional import requires a ToolHost method with this exact contract:

```ts
writeIfVersion(name, body, {
  targetVersion: null,
  sources: [{ name, version }]
}, signal): Promise<WriteOutcome>
```

The host must atomically check target absence and every staged source version through gateway commit, in the same serialization domain as person saves and attachments. The adapter never falls back to an unconditional write or an ignored extra argument. The shared port/composition crossing is owned separately; this package does not enable a route in the app. Until that crossing is installed, read-only turns can complete but draft imports fail closed.

## Admission and lifetime

Before any model turn, the adapter verifies the pinned CLI, runs a real owned filesystem canary, copies sources through ToolHost, discovers MCP names through config/read without a thread, restarts with every discovered server disabled, checks the effective feature/profile controls against the environment contract and managed ChatGPT authentication, and validates thread model/profile/workspace/environment results. After staging sources and connecting, the same restricted standalone helper captures and validates the unchanged source snapshot before any turn/start request. A missing or failed helper therefore refuses inference with a fixed snapshot-phase error, and raw stderr is never exposed. The model receives host-supplied source names and versions, and instructions permit only new drafts with existing sources unchanged. Unknown enabled MCP entries, config drift, unsupported names, unexpected server requests, model changes and malformed JSONL fail closed. Clock-only server requests may be answered; approval, elicitation, auth refresh and dynamic tool requests are never executed by this adapter.

In `contained`, the native command profile denies the filesystem root, permits the platform's minimal runtime read paths and permits writes only through the staged workspace roots, with command network access disabled, and apps, plugins, lifecycle hooks, memory, browser/computer-use, delegation, image viewing/generation and other unprofiled capabilities are separately disabled using pinned supported keys; the model catalog still offers the collaboration tools (see Sub-agents). In `full`, the root is readable with credential-path masks; Linux rename/late-creation and Unix-datagram limits above apply. Command IP network stays off and direct Host writes stay in the staged roots. Native patch execution uses the selected environment's filesystem sandbox context and tool orchestrator. The profile does not govern native auth/service traffic or global instruction loading. Utility config overrides omitted from config/read v2 are not advertised as independently verified capability barriers.

Source names remain bounded relative NFC paths without traversal or case-folded collisions. Hidden and native instruction-like inputs are inspection-only data: the adapter maps them to neutral text paths with a manifest retaining their logical names, versions and classes. Native instruction-name classification uses Unicode-aware case-insensitive matching after NFKC normalisation; the original names are never rewritten into active configuration targets. Raw output paths still refuse hidden and native instruction names. At each capture, the trusted snapshot validates the entire inspection view against Host-held text before offering normal output proposals; changed, missing, extra or linked inspection entries refuse that capture. An earlier validated stable checkpoint can remain recoverable if a later mutation is interrupted before the next capture. This view does not constrain trusted global instruction configuration or prove universal prompt-injection containment. A trusted inline Node snapshot helper runs under the same restricted native profile; the host never traverses model-controlled output paths with its own unrestricted filesystem rights. The helper rejects symlinks, hard links, nonregular files, invalid UTF-8, binary data, unstable file metadata and oversized sets before the first proposal. The standalone Node helper uses an empty OpenSSL configuration and rejects an Electron runtime. No extra filesystem read permission is added for the helper. Captured strings are immutable snapshots: killing the original process group does not establish that a detached descendant has died. A detached producer cannot mutate already captured host strings. Stop aborts imports and terminates only the owned native process group. Shutdown waits for the owned parent's exit with a 900 ms deadline, escalates after 300 ms and explicitly destroys this attempt's stdin/stdout channels. It never treats inherited-pipe closure as proof of parent exit or waits indefinitely for an escaped stdout holder. An interrupted or unobserved import becomes unknown outcome; unknown outcome or REFUSED closes the import latch, and no subsequent draft is proposed. Resumed interrupted attempts are refused rather than replayed. If Stop wins while a conditional host write is still settling, the module reports interruption/unknown outcome without joining that write indefinitely. The owning host must track and join its actual in-flight conditional-write promises before final accounting, lease completion and answer persistence. The host also owns explicit per-turn permission admission; this scoped cut requires Full and must refuse Ask rather than silently broadening it.

Temporary files are removed when the attempt settles. Native attempts are ephemeral. No raw native config, provider errors, process stderr or credentials are emitted as user events. Source text and assistant text remain model-visible task content.

## Verification and limits

Run `pnpm --dir packages/modules/harness-codex test` and `pnpm --dir packages/modules/harness-codex typecheck` after workspace dependencies are linked. The tests use a fake executable and prove transport validation, import refusal, Stop, unknown outcome handling, file-name/type checks and sub-agent accounting (acceptance and attribution, refusal of another thread and of a missing or other root, spawns from terminal snapshots, unknown outcome children and conflicting reports, bounds, waiting, Stop and the deadline). They do not prove native confinement or model acceptance. The separately retained real native canaries use owned staging/sibling files, an isolated fake MCP data folder and an escaped process-group producer; they make no model calls or auth changes.

Shared host/API integration, independent authority/effect review, atomic conditional-create tests and a bounded real-model app journey are acceptance work outside this module. This cut accepts new-draft creation and reading/follow-up only; concurrent edits to existing documents are not accepted. There is no subscription balance or blanket safety guarantee.

## Swap and removal

Select a different Engine module through composition after pending effects are reconciled. Stop active attempts first; canonical documents and unknown outcome receipts remain with the core. This module owns no durable product state. The installed Codex executable has its own lifecycle and is not installed or updated by this package.

## Required model tool transport

The selected current model catalog declares `tool_mode=code_mode_only`. That model-authoritative value takes precedence over the optional Code Mode feature switches, and this mode does not fall back to direct tools. The adapter therefore requires `features.code_mode_host=true` and verifies the effective control before inference. It uses the installed Codex package's bundled V8 Code Mode host; it installs or downloads nothing. Every other feature disable and the staged command/file/network profile remain unchanged.

An earlier diagnosis interpreted an empty top-level tool-schema inventory as absent tool advertisement. That interpretation was wrong: Responses Lite carried the tool declarations in its serialized input, while the Code Mode execution host was disabled. The retained isolated fake-provider differential distinguished those cases. With only the host enabled, the fixed synthetic exec reached native staged command execution and the outside write was denied. The mocked continuation still failed; these facts are runtime-boundary evidence, not a passed model job or whole-app acceptance.

The V8 host supplies admitted tool callbacks and value/output helpers, with no Node/process/fs/fetch bindings. Module imports reject; image/audio/generated-image helpers accept inline data and reject host-file/HTTP inputs, while text and store/load serialize or retain values. Inspected output adapters preserve inline data rather than loading paths or fetching URLs. This is a pinned trusted-runtime boundary, not an operating-system confinement guarantee for the native host. Native tool calls still dispatch through the existing turn context and selected staged permission environment.


## Manifest

## Protocol and message projection

This adapter pins Codex 0.165.0 and its experimental app-server schema. The
source revision and selected-schema fingerprint are recorded in `src/native.ts`.
A mismatching CLI version still refuses execution. Schema generation and source
inspection establish compatibility of the consumed fields, not effective account,
configuration, sandbox or serving admission; those require the separate native job.

Agent text is keyed by native item ID. Commentary remains in the existing work
block; partial and final items remain distinct; a completed item supplies its
actual text even if no deltas arrived. Null/absent phases use the last unphased
message as the documented legacy fallback, without inferring phase from prose.
An explicitly full terminal item view replaces message membership and order in one
snapshot, including items missing from individual notifications. Summary,
not-loaded and legacy views do not claim full membership or global order.
Repeated semantic completions are idempotent; changed execution/outcome data,
wrong thread/turn/item identity, invalid usage and out-of-bound buffers fail before
import. Command identity includes command, working directory, process/source and
plugin/script references, output, exit code and status. File-change identity
includes the ordered paths, kinds, move targets, diffs and status. JSON key order
and omitted versus null optional fields do not change identity; duration and
best-effort command-action parsing are presentation metadata. Only bounded
fingerprints are retained for terminal tools, with a 2 MB semantic-payload limit. Native completion must agree with the turn/start acknowledgement, even
when notifications arrive first. Staged tool observations never become canonical
write receipts. Source/target validation, Stop and exact gateway-result versions
keep their existing owners.

Projection follows the typed item protocol in
[Codex's pinned source](https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/app-server-protocol/src/protocol/v2/item.rs)
(Apache-2.0); no new runtime framework or policy authority is introduced.

<!-- generated from backbone.module.json by scripts/module-readme.mjs; do not edit -->
| Field | Value |
| --- | --- |
| id | `io.github.albertoangulo/harness-codex` (module) |
| version, licence | 0.0.0, Apache-2.0 |
| publisher | Backbone maintainers, namespace `io.github.albertoangulo` (github, pending) |
| stability | experimental |
| provides | Harness 0.x |
| consumes | ToolHost 0.x, ModelRoute 0.x |
| capabilities | planes: personal; effect classes: 2, 6; operations: workspace.write_document, native.account_tools; network: native-codex-managed, provider-web-search-in-full, native-codex-account-tools-in-full; secrets: none |
| data | owns: none; migrations: 0; export: Temporary native drafts are removed; canonical documents and receipts belong to the core. Native account activity is observed without gateway receipts. |
| depends on | none |
| conformance | bronze: `packages/modules/harness-codex/test/harness.test.ts`, `packages/modules/harness-codex/test/events.test.ts`, `packages/modules/harness-codex/test/native-connectors.test.ts` |
| exemption | shared harness port conformance suite: transport tests use a fake native executable; native, atomic crossing and app journey acceptance remain separately required |
| removal | stop active native attempts first; held UNKNOWNs remain with the core gateway; refused while one of its effects is UNKNOWN |
<!-- end of generated block -->
