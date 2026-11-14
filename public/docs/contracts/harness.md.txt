> Isolated proposal, 27 October 2026: this assembly trials a native staged
> executor. Native commands operate on isolated temporary text projections; only new drafts may
> import through atomic source/target version validation held through the existing gateway commit.
> This is not exclusive ToolHost execution or a no-ambient vendor-context adapter. Codex retains
> its own trusted authentication and global instructions. Canonical work still enters through the
> platform gateway. The original API-engine rules below remain applicable to Pi; this trial does
> not amend the accepted shared contract or establish three-repository acceptance.

## Native Codex account tools, 13 November 2026

Ordinary Codex turns require the platform's Full project permission. In the native
`full` environment the installed client retains its existing connectors/apps,
configured MCP servers, plugins and skills, with its own sign-in and per-tool
permissions. Backbone inherits the native apps/plugins feature gates and individual
enabled/disabled choices. A Codex turn receives these account tools only when the
project's live audience is the device owner alone. The Host sends
`TurnRequest.nativeAccountTools: false` in shared projects, overriding a configured
Full environment with contained execution and one visible explanation. Contained,
bare and read-only turns keep native account tools off. Command network, lifecycle hooks, browser and
computer-use feature switches remain off; they do not confine the trusted native
app-server, plugin code or configured MCP processes.

Native calls use Codex's authority and do not pass through Backbone's effect
gateway. They have no Backbone permission, idempotency receipt, source-version
record or withdrawal enforcement. The engine does not invent approvals for native
requests that still require a person; unsupported host requests terminate the
attempt under the existing transport policy. Existing
Backbone connector crossings and versioned draft-import receipts are unchanged.

Reported `mcpToolCall` items in validated parent/sub-agent turns become work-record
steps with server/tool and native status only. Account arguments, results and error
text are excluded. A done step records Codex's completion report; it does not prove
an outside action independently. A client-reported failed or declined call is a
failed step saying the tool reported an error; the turn can continue, whether or
not the tool is read-only. For a call that may have changed something, the step
also says that an error does not prove the account was left unchanged. The read-only
label comes from the tool's own server: a server that labels a writing tool
read-only removes these holds for it, so a person-configured server is trusted to
that extent. A server-labelled read-only call never creates an
unknown outcome, even if stopped, failed or left unfinished. Read-only calls set
no account-activity marker and hold neither restart, rewind, board retries nor
goal recovery. Only a possible-write call without completion has an unknown
outcome: Stop, transport failure or missing terminal completion interrupts the
turn and prevents draft imports. The engine does not replay or retry those calls.
Reconcile in the source system before another attempt. Unreported native activity
remains unobservable; process termination neither proves non-delivery nor undoes
an action.
Possible-write native account activity is retained as a turn marker and in its
closing journal state. A failed or recovered board worker with that marker is
never retried automatically, even after a reported successful call. Unknown
evidence blocks goals before stopped-turn continuation. Native unknown outcomes
have no gateway receipt to reconcile automatically. A person-facing action to
mark a native unknown outcome as checked is a separate follow-up unit; until then,
inspect the source system before starting deliberate fresh work. The module
declares native account reach separately from its staged document operation,
including its possible highest effect class.
After a hard process loss, recovery preserves possible-write native work notes
and marks the account outcome unknown before continuing any recovery. Core
receipts cannot settle that uncertainty, even when the turn records completed
Core work. Restart and rewind hold a turn with possible-write native activity
whenever its status is not done. Read-only Stop and kill/reopen leave those
controls available and do not block goals.

The packaged desktop app accepts bundled engine content with the same or narrower
declared capabilities without a dialog, using the existing registration and permission
mechanism. Main supplies bundle provenance only when packaged; the piece's real
directory must be inside the app's own resources. Configured and development paths
still ask, as does restoring explicitly revoked content or permission. Wider
capabilities ask once, naming the manifest additions in plain words; only **Allow** registers them with the new permission. **Don't allow** leaves that
engine unopened and its registration and permission unchanged. The dialog explains
how to reinstall the previous app version with the same data folder. Existing
runs retain their original binding. CLI and daemon do not prompt; they retain
refusal and tell the person to open the app once to allow the update.
Core's registration history retains the new version, digest and registration
time. Its existing SQL payload cannot hold the previous identity or reason, so
the app log supplements it with old/new version and digest, time, added
capabilities and reason: "bundled update within existing permission" or "person
allowed wider capabilities" (configured same-capability changes say "person
allowed configured update"). No Core SQL definition changes.

Read-only hints come from the trusted native server. A server that mislabels a
write can therefore report it as a failed read. Skill/package carveouts expose
all files inside those code roots, including any embedded credential; they do
not scan package content. Native plugins can supply browser or computer-use tools
independently of the disabled feature switches.

Full project permission authorizes this native route for ordinary work, including
scheduled and delegated work admitted at Full, within that same audience rule.
Audience is read when work runs, so later sharing also narrows existing schedules
and goals from their next run. It adds no native-account opt-in or
confirmation layer. Existing module registration and upgrade rules still apply to
the changed declaration. Native tools retain Codex's account permissions rather
than Backbone's operation ceilings.

See the [adapter contract](../../packages/modules/harness-codex/README.md#native-account-tools-under-full-access).

## Native Codex Linux route, 10 November 2026

The native staged adapter may admit macOS or Linux only after the pinned client's own
sandbox proves the requested environment. Linux uses Codex's maintained bubblewrap
filesystem view (user and mount namespaces) and seccomp with no_new_privs for command
network restrictions. Legacy Landlock is not an alternative for this route: the pinned
client rejects it for restricted filesystem policies and never falls back to it after
bubblewrap failure. This is adoption of the client backend, not a Base sandbox.

The pin and source revision are recorded in CODEX_PROTOCOL in
`packages/modules/harness-codex/src/native.ts`. The inspected upstream
[Linux helper](https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/linux-sandbox/src/linux_run_main.rs),
[filesystem view](https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/linux-sandbox/src/bwrap.rs)
and [seccomp implementation](https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/linux-sandbox/src/seccomp.rs)
own enforcement. Codex discovers system bubblewrap on PATH or its verified bundled
copy. Linux needs working unprivileged user/mount namespaces and seccomp. Container
runtimes must also allow nested namespaces; a hosted VM runner has no outer container
seccomp/AppArmor profile to relax.

Both platforms use the same named generic permissions: root read in full, root deny
with minimal runtime reads otherwise, workspace write (read for read-only turns),
explicit credential/arrangement denies and network disabled. Non-full writable profiles also deny system scratch ancestors (/tmp, /var/tmp and
their macOS aliases). These constrain Seatbelt's implicit scratch permissions and Linux's
writable synthetic parent directories. Mac read-only profiles keep that supplement;
Linux read-only uses the original root-deny/minimal/staged-read map. Every mode must
still prove its required inside access and outside invariants before use; no
profile's failure is waived.
Configuration is read
back exactly; initialize must report the actual host OS. Thread admission retains
the selected profile, staged roots, no network and approvalPolicy never. The same
native sandbox invocation captures immutable proposal bytes with a standalone Node.

Before staging sources or inference, an owned probe must allow required inside reads
and writes, deny outside writes (including owned /tmp and /var/tmp siblings,
with the Linux read-only isolation qualification below) and
protected direct/alias/child reads of currently masked paths (the Linux full
temporal limits below apply), and deny command
loopback networking with a reachable host-side positive control. Read-only denies
inside writes too. No malformed, missing or unexpected probe result is success.
Unsupported OS, client/version/configuration mismatch, unavailable bubblewrap, namespace
or seccomp failure, and any failed required profile check refuse before a model request/import.
There is no unconfined retry. When a kernel blocks user namespaces, diagnostics name
that prerequisite; an administrator must permit this executable through the machine's
namespace/AppArmor policy. A disposable CI VM may relax its userns restriction; a
person's machine needs an administrator's policy decision, not an automatic sysctl.

### Linux default and native limits — security decision, 10 November 2026

Linux defaults to **contained**: an empty root with minimal runtime reads and the
staged workspace. macOS keeps its full default. A person may explicitly select
full in the per-home harness-codex environment setting. The Host passes its data
data folder and configured denied folders through extraDenies in every profile; physical
probe overrides retain that real list rather than substituting only a test deny.

Linux full reads the Host root through a read-only mount. Its deny masks cover
paths present at command startup. If the Host replaces a denied single file by
rename, the new file can become readable. A denied path missing at startup can
also become readable when the Host creates it. This includes credentials and
history files: **full cannot promise the macOS credential-read protection during
such changes**. Contained keeps those Host paths outside its filesystem view.
Product preflight runs the Node-only Linux audit for the profile in use on every
turn, before admitting the route, and passes its parsed results to assessLinuxAudit.
It tests an initially denied single file, a Host replacement by rename while the
child lives, and a denied path created after child startup. Full must exhibit its
known rename/creation limits; contained, bare and read-only must continue denying
those reads. It also tests synthetic data-home/arrangement canaries through the
same extraDenies map and attempts reads of each existing, Host-readable configured
deny (including the actual data folder). Missing configured paths have no existing
bytes to probe; the owned late-creation case tests that class. Unsupported or
unreadable positive controls refuse rather than silently omitting a readable path.

The Node audit tests UDP and a DNS-format query to owned Host loopback listeners,
pathname and abstract Unix stream connects, /run visibility, distinct network namespace identity,
and reads of /proc/<engine pid>/cmdline and environ without printing contents.
Owned listeners complete Host positive controls first. A fresh proc mount requires
both a distinct PID namespace and matching proc-self mapping. Restricted profiles
must hide both Host proc files; full may expose cmdline in the documented container
fallback, but must hide environ. Missing namespace evidence, malformed output,
command errors, unexpected probe results or Host deliveries refuse admission.
These checks supplement the existing write/read/TCP and immutable-snapshot probes.

Only the two **raw unconnected AF_UNIX datagram sendmsg** cases (pathname and
abstract) remain CI-only: Node has no public Unix datagram/sendmsg API. The Python
CI helper measures those syscalls and Host datagram-path visibility/delivery;
ordinary machines need no Python. Product preflight does not claim to execute
those syscall canaries. Instead it requires a distinct native network namespace
and the following pathname socket inventory, since the pinned seccomp policy does
not block sendmsg to a visible Host datagram socket.

The inventory scans the native view of /run, /var/run, /tmp, /var/tmp, /dev, workspace
bindings, other writable mount points and Host socket-bearing parent directories
reported by the Host Unix socket table. It does not walk the whole filesystem or
read-only /usr, /etc, /lib and /lib64 runtime trees. Explicit writable or known
socket-bearing submounts/subdirectories within those trees are included; a socket
reported directly at an excluded runtime root refuses instead of scanning that
root. Those read-only runtime trees must contain no other Host sockets; arbitrary
renamed endpoints outside the selected paths are not exhaustively discovered.
Within the selected paths the scan preserves byte-exact names, finds sockets
renamed after binding and deduplicates aliases. Any visible Unix socket entry
(including stream/stale entries), opaque traversable directory or incomplete scan
refuses without contacting an existing service. Each scan is bounded by 250,000
entries and 10,000 ms; refusals show actual entry count and elapsed time alongside
both limits.

Successful stable-path inventories are cached per Host engine instance and
profile, keyed by the Host mount table, normalized native mount table, socket
table, runtime, denies and scan paths. Workspace bindings are rescanned each turn.
Changed key material invalidates the result; failures are never cached. This is
still a preflight snapshot: a socket created or renamed later can escape the cached
inventory. **Full on a Linux desktop is expected to refuse while Host sockets are
visible under /run, because an unconnected datagram could reach them.** Full is
an explicit choice with those temporal and scope limits, not an unconditional
command-network isolation or macOS-equivalent confidentiality claim. Contained
hides Host service paths; keep sockets out of its read-only runtime roots too.

The Node product audit, inventory/cache and expanded Python CI matrix have unit
coverage on Mac but have **not run on Linux** since this security delta. Hosted
execution remains blocked by the organisation's spending/billing restriction;
no provider or account setting is changed to overcome it.

### Read-only property decision — 10 November 2026

The direction owner defines a read-only turn's property as **changes nothing
outside its staged copy**, rather than requiring every outside write syscall to
fail. On Linux only, the maintained bubblewrap view may report a successful write
to namespace-private storage. The engine can believe that write happened, while
the Host sees no change. This engine-visible difference must be documented; it
does not authorize a persistent write or an import from private outside storage.

Linux read-only instructions and the persisted native work note say: "On Linux
read-only turns, writes are discarded and nothing outside the staged copy persists."
The notice does not alter structured judge answers.

Linux read-only admission therefore verifies owned Host trees and file contents
before and after all write attempts, rejects every added outside entry or changed
canary, and proves private writes cannot be read by a concurrently running fresh
sandbox or a later invocation. A ready/release handshake keeps the writer alive
during the concurrent observation; namespace identities must differ. The Host
checks its paths while that writer lives and after exit. Read-only staged writes,
protected reads and command networking still must be denied. macOS retains its
existing outside-write refusal assertions. Full, contained and bare keep their
existing denial checks without this exception.

Each native sandbox invocation creates a fresh user/mount namespace and tmpfs
view; no private view is saved with a turn or supplied to a later turn. Processes
inside the same invocation may inherit its private mounts; they are part of that
turn, not independent sandboxes. The claim excludes a privileged administrator
entering another process's namespace. Ordinary independent commands and the Host
do not inherit it. Missing readiness, namespace reuse during the concurrent check,
Host changes, visible private data or missing proof all refuse admission.

Fake transports qualify dispatch, source versions, Stop and unknown outcome only. Real-client
OS probes with isolated synthetic data folders qualify confinement without an account or
model call. Live vendor-model acceptance remains separate.

## ACP trial, reviewed 10 November 2026

An ACP agent runs as you. With restricted-writes, it can read whatever you can read except the listed credential places, this Host's data folder, denied folders and ACP storage outside its own folders. It can read environment variables and command lines of your other running programs, which often hold API keys. It has unrestricted outbound IP network, including loopback. The restricted-writes setting only stops it writing outside its own folders, signalling other processes and starting system background services. With person-rights, a custom agent can read and write this app's data folder, including settings.json, and reach machine credentials; OS restrictions are off. The credential places are listed in `CREDENTIAL_PATHS` in `packages/platform/src/ports/harness.ts`. ACP is off unless `harnesses.harness-acp.acceptsProcessVisibility` is explicitly true when the Host opens. Without it the Host refuses before loading an ACP engine, offers no ACP route/model, and returns the risk in Settings. The module checks acceptance again before creating state or starting a process.

The experimental [ACP module](../../packages/modules/harness-acp/README.md) supplies a generic
stdio route to configured agents. Its model route has kind `agent`, provider `acp:<agent name>` and
model `chosen-by-agent`; it claims no vendor model, account or billing entitlement. The OS write-restriction profile,
permission refusals and scoped MCP ToolHost bridge have separate responsibilities. Fake-agent,
Host and real-profile macOS canaries now pass for direct outside writes, protected and sibling
reads, outside signals, job creation and desktop handoff; network remains available. Restricted-writes startup
is available after explicit acceptance on macOS and refuses Linux or a missing sandbox-exec. Permission callbacks always refuse
agent-owned operations; they are a second check alongside the write-restriction profile.

Process visibility is a measured risk requiring explicit per-home acceptance: a restricted-writes agent can read environment variables of the person's other running programs,
including tokens those programs started with, as well as their command-line arguments. Backbone's ACP bridge address and bearer token are
instead kept in a 0600 file inside the session's agent folder, with no secret in shim argv or environment.
The real-profile tests inspect own and sibling shim processes, refuse sibling capability-file reads,
and reject every attempted cross-session bearer recovered from those observations.

A person can give a connector tool a permission. Its effect calls on the ACP route then go out without asking again; without that authority the Host holds a proposal. SENT/sent lets the turn continue. SENT/failed carries the server's definitive refusal as an error result for the agent and lets the turn continue. SENT/unknown stops the turn. A real Host ACP test sends one signed effect to the fake MCP server, records the standing authority and leaves nothing waiting.

A thrown connector call is treated as unknown outcome. Connector unknown outcome stops ACP without continuing the model or retrying. Retained connector reads in the
integrated Host require native invocation binding; ACP currently lacks that binding and those reads
refuse. ACP never fabricates pi/codex identity from an MCP transport request ID. For isolated agents, Stop discards combined
native authentication/context state because ACP cannot partition sign-in files from withdrawn context.
A real ACP Host turn now verifies the missing-identity refusal without a provider tool call or retained
connector material. The folder-node write denial prevents an agent from renaming, replacing or changing
the mode of its work and agent directories while normal writes inside still succeed. The Host, running with its normal rights,
checks real-directory type, device, inode and mode before bridge creation, every spawn and client
file method. It compares opened files with lstat of their names before reading, truncating or writing
capability bytes, and compares opened directory handles during spawn setup. These are second checks
behind the profile's node protection, not a complete boundary against a filesystem racer running with the person's rights.
Profile construction refuses unless the storage root strictly contains both session folders.

Every new agent-process incarnation uses fresh random paths. Retained state is copied only after the
old tree is renamed out of its permissions. Retired trees are deleted in finally even if copying fails;
owner permissions are restored before traversal/removal. Only regular files, directories and links
are copied; FIFOs, sockets and devices are skipped. Session creation sweeps orphaned retired trees
in its private parent, leaving live retirement owners alone.

Stop, timeout and close invalidate the connection generation and join setup already in flight.
Generation checks after copying, bridge creation and initialization prevent an abandoned reconnect
from launching or retaining an agent. Any agent it already started is closed. Stop, failure and
withdrawal discard native state after joining setup; large filesystem operations can extend the wait.
Cleanup errors remain explicit outcomes: the stream closes, the thread's busy flag is released and
the current session refuses reuse until cleanup succeeds. TERM targets the live parent's process
group, with KILL after a bounded wait only if the parent remains live; it is not a guarantee that every
child dies. A detached survivor
cannot read the next capability file or write the next working folder, as the real-profile canary shows.
Detached descendants can still run, use permitted reads and outbound network, inspect processes and
retain already-open file handles. If the agent exits on its own, surviving children are not killed,
including those still in its process group; the module avoids signalling an already-exited PID.

Restricted-writes reads cover everything the person can read except credential places, explicit denied folders,
this Host's data folder and ACP storage, with exceptions for its own work and agent folders. Other data
data folders are not automatically denied. Outbound IP network includes loopback and unauthenticated local
services; Unix sockets are refused. Job-creation qualification uses a compiled SMJobSubmit helper with
an allow-job-creation positive control that creates and removes only a disposable marker job.
The new repairs remain subject to further independent review and vendor qualification.

## ACP Claude machine client, 10 November 2026

An explicit machineClient: claude selects the installed CLI's own login, never a
Host-supplied API key. It requires person-rights and the existing risk acceptance.
The client receives machine HOME, CLAUDE_CONFIG_DIR and CLAUDE_CODE_EXECUTABLE;
all inherited authentication variables are omitted. Its own auth status JSON
must confirm a claude.ai login before the adapter starts. Other authentication,
signed-out, missing and malformed states refuse. Doctor returns a content-free
class sourced to that command. Generic ACP retains its isolated HOME and checks.

Claude session metadata pre-approves only tools on the supplied backbone MCP
server, whose actual calls retain the Host bridge's authority checks. It disables
the adapter's bypass-permissions mode on new and loaded sessions. The Harness port
still refuses native permission requests; machine policy and native execution
remain outside the Host's containment boundary.

Person-rights permits machine files and Claude configuration, credential services,
native tools and network, including the Host data home and other same-user ACP
session folders. File permissions do not isolate same-user processes. The machine configuration can activate instructions,
hooks, MCP servers and credential helpers. Native activity has no Host receipt.
Stop clears private ACP state, not machine login, client history or native writes.
The [module's machine-client section](../../packages/modules/harness-acp/README.md#claude-code-machine-sign-in)
names the maintained adapter, sources and offline qualification boundaries.

## ACP executable acceptance and cached diagnostics

Settings resolves the executable before acceptance against absolute PATH entries
and the maintained tool discovery locations, including the usual Finder installs.
Child PATH uses those absolute locations too, so an installed Node shebang works
when Finder supplies only system paths; no login shell or profile is executed.
Relative paths and relative or empty PATH entries never select a program from the
agent's working folder. The selected link, real target and their ancestors must
be owned by the person or root and must not permit group or other writes. Settings
shows the resolved path and SHA-256 before the person accepts it. The saved
acceptance binds that real path, device/inode, content hash, arguments, named
variables and rights. Person-rights has a separate acceptance naming the Host home,
settings.json and machine credentials. Changed settings or executable identity
require resolution and acceptance again; launch rechecks the identity. This binds
entry files, not all code or dependencies an executable may load. A same-user actor
that can rewrite both settings and the acceptance record is not contained by it.

The native sign-in probe is asynchronous and bounded. Settings reads return the
last content-free class immediately, initially checking; they never run a probe.
Host startup and the person's Refresh engine sign-in action refresh the selected
Host's cache. Opening Settings only reads it; it issues no settings command.
Doctor can await that pending class with bounded asynchronous reads; it does not
launch an extra probe through the API line.
A launch awaits a fresh check and rechecks cancellation and executable identity
before starting the adapter. No Core crossing is awaited under a home lock.

A person-rights agent can persist a different next-launch engine by rewriting
settings.json. Claude's machine configuration can also load the backbone-door
server installed by Connect your AI tools. That is a second Host route under the
door's own grants, rather than the current turn's grants; asked writes still need
the person's app approval. The mcp__backbone__* pre-approval does not match
mcp__backbone-door__*. A machine server literally named backbone collides with the
supplied server name and is not a separate trustworthy channel merely because of
its name. Claude's own permissions.allow rules, defaultMode and hooks may run native
tools without sending an ACP permission request. Only requests actually forwarded
to the Harness are refused; the Host does not claim to override those native rules.

## ACP follow-up identity boundary — not built

Real isolation for this route requires a separate macOS user or a virtual machine. Lima is an
available VM candidate on this machine; no user, VM or separate execution identity is created by
this trial. Qualification must add a test with a live owned Host process carrying disposable
canaries: a Host-side positive control sees its environment and arguments, but the agent under
the separate identity or in the VM cannot read that environment or recover the canaries. Keep
the current write, service and ToolHost checks as well. This implementation and unreadable-
environment test remain follow-up work, not a guarantee permitted by acceptsProcessVisibility.

## Runtime availability, 5 November 2026

Describe permitted capabilities separately from installed commands. The native prompt's unconditional
claim that Python was unavailable was contradicted by the full-sandbox probe and native task in
`backbone-arena:research/2026-11/capable-work-20261105/runtime/`. Check a required command or
interpreter before replacing a supplied workflow; do not assume it is installed or absent across
environments. The earlier prompt test asserted that environment assumption, not sandbox enforcement;
its correction rejects the disproven claim in both prompt modes. Existing capability tests continue
to own the filesystem, network and credential boundaries. This clarification gives no new access
and does not establish directory import support.

Native staging carries each source's host-supplied class into the model request. Originals remain
unchanged; revising one requires a new working copy. Working and accepted documents may be revised
in place, subject to the existing exact-version checks. Staging refuses a class that differs between
listing and reading. Prompt metadata stays separate from the name/version references used for
conditional imports and checkpoints; source content cannot supply its own class or permission write
authority. The host still enforces these rules regardless of model behavior. This addresses the
missing class guidance observed in the same runtime exercise; default-route requalification and
directory support remain separate work.

Each native attempt owns a reserved `.backbone-tmp` folder inside its already permitted workspace.
The host supplies `TMPDIR` and zsh's `TMPPREFIX` for that folder and verifies their exact effective
values alongside PATH; other shell variables remain absent or emptied. No additional filesystem
permission is added. The trusted snapshot excludes that reserved top-level folder without traversing it,
so temporary or binary scratch data cannot become an imported document. Raw source targets still
refuse hidden and native instruction/configuration names. Logical inputs with those names use
neutral text files and a source-map manifest in a private per-attempt inspection view instead.
The trusted snapshot separates that view from output proposals and checks it against host-held
text at each capture; changed, missing, additional or linked inspection files refuse that capture.
An earlier validated stable checkpoint can remain recoverable if a later mutation is interrupted
before the next capture. Original
logical names and versions still bind withdrawal checks, checkpoints and conditional imports.
This data-only input exception does not permit hidden/configuration output targets or load source
contents as native settings. Cleanup removes the view and scratch with the attempt. The installed sandbox
probe must verify heredocs, denied writes outside the workspace, snapshot exclusion and cleanup;
an unsandboxed fixture alone does not prove physical isolation.

## Conditional managed outputs

Conditional managed outputs may use relative text-document paths. These names remain custody
metadata under document ids; they neither project into the project's physical folder nor permission
filesystem access. Structured names use non-empty NFC/UTF-8 segments, without traversal, hidden
segments or drive syntax. Unicode controls, format characters and line/paragraph separators are refused.
Case comparisons use Unicode lowercase; Unicode confusables retain their distinct spelling. File/folder conflicts are refused at admission and at the
material commit, including recovery. Existing flat managed labels retain their naming behavior.
Input labels receive an available name before creation; agent write targets retain their exact names
and receipts. Logical custody preserves OS-specific names such as `CON`; a physical exporter must
validate the naming rules of its actual destination.
Source/target version checks, original immutability and unknown outcome handling continue to apply.
Recovery uses the retained proposal and original receipt rather than running the producer again.
Generated held and beside revisions allocate an unused name in the same logical namespace, including
case aliases. Qualifiers belong to the leaf. A long leaf is shortened without cutting a Unicode code
point; if its directory leaves no room for the qualifier, the revision uses a bounded logical label
with a hash of the original name. The receipt and retention note name that actual destination, and
only a DONE write is described as kept. The person's current version stays unchanged.
A checkpoint keeps the host's binding from each requested name through any pre-proposal beside/held
transitions to its final destination, including shortened names, before proposing the effect. Reserved
destinations belong to their originating request while in flight. Later producer checkpoints preserve
these bindings; producer-supplied data cannot set them. Bindings alone create no checkpoint or recovery
work. Recovery matches the exact recorded effect at the final destination rather than allocating
another name. The mapping is data, gives no write, and cannot replace receipt, source/version or
custody checks. Repeated requests stay refused and unknown outcome stops checkpoint import. Legacy matching
remains available for all legacy files until consumed, even after a new binding is added or reopened.
Only a recorded effect freezes a recovery destination. An identity write needs no alias binding.
After a crash, bindings with no recorded effect are provisional and are re-derived through current
source/version and retention checks; they neither lose the work nor override a person's later edit.
A recorded unknown outcome still stops all import. An inconsistent binding with a recorded effect reports the
problem without proposing a replacement or throwing out of recovery.
Ordinary writes retain their flat-name boundary. Structured source import, export/restore path
preservation and the installed end-to-end directory journey are still separate required work;
this managed-output support does not qualify direct physical-repository writes.

## Coordination tools

`ToolHost.startChild`, `awaitChild` and `proposeGoal` are optional: an engine offers them only when the
host does, and never on `TurnRequest.readOnly`, where it offers only the tools that read. They carry no
effect of their own: a child acts through its own turn's ToolHost. A report from `awaitChild` is data.
A `ChildRequest` may name the child's `model`, `effort` and `fallback`; the host decides them at admission.
`HarnessV1.listModels` takes the route when the engine reaches models through one: Pi reads the
provider's own model list (a read that calls no model), with the credential only in the request header.
Rules are in [thread-orchestration](thread-orchestration.md).

### Optional memory, goal and peer-message tools

On ordinary turns, Pi and the experimental Codex adapter offer `memory_search`,
`propose_memory`, `propose_goal` and `message_card` when the Host supplies their
optional methods. The engine port exports their shared descriptions and Codex's
JSON schemas from `packages/platform/src/ports/host-tools.ts`. Pi keeps its native
TypeBox schemas and coercion. Its captured declarations are pinned byte for byte
against c23b6d1, with a separate equality test against the shared schema content
(`packages/modules/harness-pi/test/host-tools-compat.test.ts`). ACP uses the shared
descriptions with its existing `search_memory` name, looser schemas and MCP result
format; those names and schemas are unchanged.

The Host records a memory lookup's sources before returning the words; adapters
await that answer directly without caching or rewriting it. Tool results and peer
messages are data, never the person's words or authority. Proposals do not accept
themselves. Codex carries these calls through the same acknowledged-turn dynamic
tools as connectors: invalid arguments dispatch nothing and return a tool error;
a Host refusal is data the agent can respond to, and Stop suppresses late data.
An unoffered call retains the native handler's turn-failing behavior. Bare and
read-only Codex turns do not offer these tools.

The remaining Pi/Codex differences are intentional. Pi passes a thrown Host
error's message through; Codex returns exactly "Host refused the tool call or could
not return its result." so raw exception details do not cross its native transport.
Conformance asserts each engine's exact error result, including ACP's existing
generic refusal. Pi retains TypeBox coercion, including null to "null"; Codex
requires valid string types and lengths before any Host call because it uses an
explicit JSON boundary rather than Pi's validator. Pi lets an unoffered tool error
continue; Codex fails the turn when the native client requests a tool outside its
admitted catalog or scope, preserving its existing protocol-boundary rule.

Pi runs these tools sequentially. Codex keeps the native connector handler's
concurrent dispatch: calls can overlap, each awaiting the Host's own checks and
read recording before its result returns. No serial order is promised or cache
added. Both engines use the same tool key; Pi's event label is that key, while
Codex uses the shared readable label for the work display. Stop closes a pending
Codex Host-tool event as `unknown`, since no answer is confirmed to the agent;
this does not claim anything about the canonical receipt. Late answers are
suppressed and never close the event twice. Codex also projects only declared
proposal/message fields before calling the Host; Pi's argument handling is unchanged.

Open owner question, with no behavior change here: every engine currently reports
a card message whose SENT delivery state is unknown as a successful tool result
and continues the turn. The owner must decide whether that uncertainty should
stop the turn or be presented as an error.

Codex keeps native coordination and does not offer the Host's `add_card`,
`start_child` or `await_child`. Pi uses those Host tools; ACP's bridge supports them
when supplied, alongside any coordination its configured agent provides. See the
[engine tool matrix](../../packages/modules/harness-codex/README.md#optional-host-tools).
Fresh Codex turns rebuild the tool catalog even after engine recreation; interrupted
native attempts remain non-replayable. The shared fake-agent conformance file is
`packages/platform/test/engine-tools-conformance.test.ts`; it establishes no real
Codex binary or vendor-model qualification.

## Proposed continuity and recovery boundary

An ordinary replacement is based on text actually read by this turn. Each write
freezes source identities and versions. Later reads cannot rebase an already
pending proposal, including after a restart with identical output bytes.

Before Kernel proposal, the existing private StoredThread file durably retains
versioned recovery provenance: original run and turn, project, document/name,
exact body, target base, source IDs/names/versions and managed mode. Its digest is
an integrity check, never authority or a substitute Kernel operation hash.
Ordinary thread projections preserve that private field and the original task;
stale projections cannot delete stored turns. Renderer drafts, public Turn,
events, model history and diagnostic receipts do not contain this metadata.
The current private text schema bounds a body at2,000,000 UTF-8 bytes and a source
set at2,000 entries. These are replaceable implementation limits, not Kernel
invariants. This is not a general binary-artifact recovery format.

Definitive local refusal checks run before retaining a fresh proposal. A source
conflict, raw-path collision or pre-proposal Stop cannot create an uncertain
operation that was never attempted. Once an attempt may have crossed the Kernel
boundary, its custody remains available even if its acknowledgement is lost.

The host first inspects the original durable receipt. Only a known allowed or
claimed original may continue through current authority and the existing
claim/dispatch/material operation, without a model or native-client replay. No
replacement proposal, run, key or argument substitution is made. A changed
source or target, or missing/corrupt custody, cannot silently become a new base.
Cancellation uses the existing SQL crossing before dispatch and is reported only
from a durable read; a failed cancellation stays unresolved. A lost proposal
acknowledgement retains its original run and custody rather than inventing an
effect or absence of one. Explicit reconciliation remains due for that uncertain
case; this prototype does not promise automatic resolution of every failure.

A dispatched/unknown outcome original is never resent. Exact completed versions are
linked only after both the material bytes/agent-version record and the matching
Kernel document/history version and effect witness are verified; newer human
saves remain current. A material-only write is not proof that the Kernel crossing
completed. Mixed outcomes, missing routes and later errors retain verified links.
Pending originals remain discoverable independently of the last UI status; the
host never finishes away their only recoverable run or lets a new turn replace
that pending work. A conversation with running or unresolved original work cannot
be moved to a different project or deleted, including before a proposal receipt
is confirmed. Renaming remains available. A terminal receipt must match the
original run, turn/key, target and arguments; a title alone cannot clear custody.
Turn admission and client-key idempotency are serialized with lifecycle changes;
only one producer owns the conversation's running turn and Stop controller.
The producer starts after that serialization is released.

Stop and producer failure join host-owned in-flight writes before final
accounting. Accepted tool calls reserve their name before asynchronous progress
persistence; late calls after closure are refused. Native managed imports never
project over raw workspace files. Source/target checks and mutation use the same
data-home serialization as person saves and attachments. This is not a guarantee
about arbitrary filesystem writers outside that protocol.
Direct material reads/listings and workspace file listings take that same lock.
Within the host process, the existing material store also distinguishes a live
Save from an interrupted intent. Lightweight thread/effect projections remain
observable during a held dispatch so Stop can act before it completes.

These mechanisms remain a proposed implementation until exact-source
independent review and real-gateway crash/restart/Stop evidence pass. Controlled
producer fixtures do not prove live native client, model or subscription access.

# engine contract (DRAFT 1, 23 Oct 2026; DR B1 and the 23 Oct addendum)

**Owner:** integrator (port), with one adapter owner per module.

**Layer:** L1 port; L2 modules.

**Status:** decided (DR B1). **Built, 24 Oct 2026:** the port is `packages/platform/src/ports/harness.ts`, and `harness-pi` (Pi 1.4.0) is the app's engine; `createHost` selects the engine from configuration, and tests default to the labelled stub. Not built yet: Codex and Claude Code executors, goose, ACP, the validation tasks, and permissions beyond document writes (commands, fetches). In the old repository the prior art is `runtime/src/loop.ts` and the executors in `server/src/native/` (35 files).

## Purpose

Backbone ships its own configurable, white-label engine. The engine (Pi 1.4.0, MIT) sits behind a plug shaped like the AI SDK `HarnessV1`, with goose as challenger. Codex app-server and Claude Code headless run as executors on the user's licence. ACP is the boundary towards clients.

Everything that makes Backbone what it is lives outside the engine: crossings, receipts, planes and proactivity. So swapping the engine changes no S property (V6).

**Previous purpose (draft 0, kept for comparison):**

Run the agent's turn through Backbone's own loop or a vendor's native client (Codex app-server, Claude Agent SDK), under the same mandates. Swapping the engine does not change the product.

## Owns

- **Port:** nothing durable.
- **Adapters:** per-attempt journals only (`codex-task-journal.ts`). These are evidence, not truth.

## Provides (port)

- start, steer, interrupt and resume a turn; an engine that can say what became of steered words sets `steers` and offers `deliver`, whose `DELIVERED` needs its own confirmation;
- expose the tools permitted by the mandate;
- raise a decision request;
- report usage;
- report the turn outcome: done, failed, interrupted, or unknown outcome for each pending effect.

The types build on `runtime/src/ports.ts` (`ToolSpec`, `ToolHost`, `StepStore`, `ModelResponse`).

## Consumes

- the work-ledger (steps and leases);
- the effect-gateway (every outward tool call);
- the ModelRoute port;
- secrets (handles only);
- the Connector port (MCP).

## Rules

- **No ambient vendor settings.** Executors exclude the user's ambient configuration (audit-1 #25, PASS).
- **Tool discovery and re-observation are scoped to the active thread and its mandate** (R-HARN-01). The old app's matching defect (candidate `f134c58c`, never merged) is evidence only.
- **A vendor subscription is used only through the vendor's own client.** Billing is shown (R-MODEL-01).
- **A crash mid-turn leaves pending effects pending or unknown outcome.** The adapter never replays a tool call.

### Connector outcomes in Pi and Codex

| ToolHost result | Pi | Codex |
| --- | --- | --- |
| `SENT`, state `sent` | Successful tool result; continuation allowed | Successful client-side tool result; continuation allowed |
| `SENT`, state `failed` | Error tool result; the model may read it and continue | Unsuccessful client-side tool result; the model may read it and continue |
| `SENT`, state `unknown`, or `UNKNOWN` | Abort the Agent, stop the remaining tool batch and prevent model continuation | Stop the native turn through `carryCodexConnector`; no further connector dispatch or draft import |

Unknown is never success or an invitation to try different arguments. The Host
marks the turn stopped and puts the connector's detail in its answer. An unknown
signed effect has a terminal unknown held-call record telling the person to check
the provider; it creates no read observation or reconciliation decision and does
not keep the producer run open. The ordinary stopped-work notice in Needs you can
be cleared by archiving the thread. A read with a retained response awaiting a
decision keeps its original run open and source withheld for the person-only
`connectors.resolveRead`; a response-less read has a discard-only card and can
already have a finished run. See [connectors](connectors.md).

## Engine compaction observations

HarnessEvent may carry an engine-owned compaction observation: stable item and
session identity, lifecycle status, optional user-displayable summary and
reported usage. The Host retains it beside links to the original thread turns;
it never replaces or deletes those turns. Encrypted or internal replacement
context is not a readable summary. A summary is reference data and never grants
authority, confirms an effect or changes source-withdrawal eligibility.

Pi adopts its maintained coding-agent cut-selection and summarization functions
through the Agent context hook. Its extra summarization usage belongs in both
the compaction record and the total turn usage, counted once in that total. Its summarization projection labels tool-result provenance before serialization; custom instructions keep page claims outside the person's goals, constraints and next steps. The projected summary is escaped inside an explicitly untrusted engine-summary envelope, including saved-summary reuse. Its user transport role does not make it a new person request. HELD calls wait for the person; the model must not reach the same effect through another tool or reworded request.
Codex and ACP retain native decisions and expose only the data their protocols
supply. Failed and cancelled compactions do not establish a completed
continuation. An ACP compaction count or text limit fails the active turn, closes its tool access and discards native state; notification errors never establish success. The [usage guide](../how-to/continue-long-conversations-and-browse.md)
state the route-specific limits and current evidence.

## Acceptance

- J-01 on Codex, plus J-01 on the second route (P-standalone).
- **Adverse case:** kill the vendor client mid-turn. On restart, the thread shows the turn as interrupted, effects are reconciled and nothing is sent twice.

## Validation and switch triggers (adopted 23 Oct under delegation, revisable when measured)

- Compare complete supported tasks through each eligible engine; preserve authority, edits and unresolved outcomes.
- In-plane overhead: ≤ 5% tokens and ≤ 150 ms per call against the ungoverned baseline.
- Proactive classifier misses: ≤ 5%.
- Cost per success: ≤ 1.2× the cheapest.
- Switch to goose if any of these holds: Pi's licence or governance changes; `pi-durable` is still experimental or fails tasks 2 and 7; a paying customer needs foundation governance or in-process Python or JVM; goose wins on success beyond the confidence interval and ties on cost.
- **Correction (23 Oct, verified against Vercel's READMEs):** Pi is *not* the only host-side `HarnessV1` adapter. `harness-cline` and `harness-fx` also run on the host. Credentials-outside-the-sandbox therefore does not single out Pi.
- **To check:** whether the Claude Agent SDK terms allow driving the user's own Claude Code headless.

## Changing engines

A Host selects its engine when opened; changing the data folder setting takes effect after closing and reopening that data folder. The offline Host journey in `packages/platform/test/engine-swap.test.ts` checks Pi, ACP and Codex in each direction between different engines: the next engine receives the earlier conversation, and the thread identity, title and ordered turns remain. A signed connector tool still acts on that permission, an unsigned call still waits, and a pending call can be released once with its receipt tied to the original turn. Pi and ACP read the first engine's document through `read_file`; Codex reads a Host-staged workspace copy, and its own new file is imported through the effect gateway. A kept memory line reaches Codex in Host-provided recall, and all three engines can look it up with their memory tools. Removing ACP private state before moving to Pi does not prevent that journey; ACP-specific session continuity is not retained. The test uses fake local agents and a fake connector, and does not cover every connector or failure.

## Exit test

1. Run the same J-01 thread with harness-codex, then continue it with harness-claude, or the own loop.
2. Threads, pending effects, held unknown outcome and permissions must be unchanged.
3. Memo 05 owns the ACP trial: adopt ACP only if it replaces the adapters under the same mandates.

## Change procedure

- An adapter change stays inside its module.
- A port change needs this contract to change first, and both adapters to update in the same PR.

## Native item projection proposal — 29 October 2026

The isolated native-protocol successor targets the inspected 0.165.0 experimental
app-server schema. It does not enable or qualify a native route by default.
`HarnessEvent` keeps delta-only producers compatible and may additionally carry
a full `HarnessMessage` snapshot: item ID, text, nullable phase and completion.
When present, the snapshot is authoritative over accumulated deltas, including
a completed message delivered without prior deltas. Commentary projects into the
existing work block, separately from the answer; no phase is inferred from prose.
Unknown phase uses the last unphased item as the legacy terminal fallback. Native
text/usage/tool items are bound to the admitted thread and one confirmed turn;
matching completion and start acknowledgement are both required before import.
An explicit full terminal view supplies an authoritative ordered complete message
set (`messages` event), atomically replacing provisional message membership and
order even when a repeated individual completion emits no delta. An empty full
set clears the provisional answer. Summary, not-loaded and legacy views retain
their partial status rather than asserting complete order or deleting unseen
messages. Staging observations cannot create effect receipts.

Repeated terminal tool completions compare execution inputs and outcomes, not
only status. For commands this covers command, cwd, process/source/plugin/script
identity, aggregated output and exit code; for file changes, the ordered path,
kind, move target and diff set. Key order and absent/null optional values are
normalised; duration and derived command-action hints are not execution identity.
Conflicts fail before import. The reducer keeps bounded fingerprints, not raw
terminal outputs, with a 2 MB semantic-payload limit.

Message text, item count and queued event bytes are bounded implementation limits.
The existing ToolHost, pending-write join, source/target validation and exact result
versions retain their D1 semantics. Persistent native resume, credential/physical
admission, installed composition and a new live serving trial remain separate work.

## Local working environment

The optional workspace_run Host tool supplies the prepared offline thread filesystem
described by the [workspace contract](workspace.md). Pi, Codex and ACP carry it through
ToolHost. Local scripts and SQLite tables need no effect permission; project material still
uses the existing write proposal. Native engines retain their separately documented environments.

A tool event may carry a structured `denied` signal naming a macOS protected folder; it contains no command output and is retained on the corresponding work step.
