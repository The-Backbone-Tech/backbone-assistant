# Use native Codex on Linux or macOS

The experimental [Codex adapter](../../packages/modules/harness-codex/README.md)
runs the installed official client pinned by CODEX_PROTOCOL in
`packages/modules/harness-codex/src/native.ts`. Select harness-codex in the Host's
settings. For ordinary work the client uses its own managed ChatGPT sign-in; the
adapter never resolves an API key or silently substitutes another model. Linux
support here concerns the native staged execution boundary. The separate Linux
[data-home opt-in and storage requirements](install-the-cli.md#linux) still apply.

## Existing Codex connections

Choose Full project permission and the native `full` environment to use the
connectors/apps, configured MCP servers, plugins and skills already enabled in
your Codex client. The adapter uses the same `CODEX_HOME` and managed sign-in; no
new OAuth app or account connection is needed in Backbone. The client's global disables and individual native tool choices are inherited. Skill and
plugin-package files can be read inside `CODEX_HOME`; its credentials and history
remain denied to commands. Configure missing permissions in Codex itself. Bare/read-only turns
and the contained environment do not expose these account tools.

An engine update that adds native account reach asks once in the desktop app;
Allow registers that permission. Headless clients direct you to open the app once.

Native connector steps report Codex activity, without Backbone receipts.
Read-only calls hold no recovery controls. Reported failed or declined calls are
failed steps; only unfinished possible-write calls have an unknown outcome. If a call
has an unknown outcome, check the source system before attempting it again. Backbone's own
connector and document-write receipts keep their existing meaning. See the
[scope and observation limits](../../packages/modules/harness-codex/README.md#native-account-tools-under-full-access).

## Current qualification

Linux now defaults to **contained**; macOS still defaults to full. The turn's
engine label shows the selected environment. Contained starts from an empty
filesystem and exposes minimal runtime roots and the staged workspace.

To explicitly choose full, set the per-home settings entry:

```json
{ "harnesses": { "harness-codex": { "environment": "full" } } }
```

Use environment contained to select it explicitly. Reopen the data folder to apply the
choice. This engine setting is separate
from the Host's Full project permission. **Linux full can read a credential file
that the Host replaces by rename, or a sensitive path created after a command
starts, despite its deny list.** It reads the broader Host filesystem; contained
keeps these paths out of view. Full is only for a person who chooses that limit.

Full can also send an unconnected Unix datagram to a visible Host socket because
the pinned seccomp policy does not block sendmsg. Admission scans service/temporary paths, writable mounts, socket-bearing paths
and workspace bindings, caching stable scans per Host/profile and mount tables.
It conservatively refuses any visible Unix socket, incomplete inventory or unproved
network-namespace separation. Full on a Linux desktop is expected to refuse while
Host sockets are visible under /run: an unconnected datagram could reach them.
Within selected paths, it finds renamed sockets rather than trusting their original
bind names. A socket created later can become visible in full; that
profile has no unconditional networking guarantee for this case. Contained hides
the Host service paths under /run; keep Host sockets outside minimal runtime roots.
If a container cannot mount fresh proc, full may expose Host command lines; the
new probe tests Host cmdline and environ, with Host/client PID-namespace evidence. No container fallback was tested here.

**The extended Linux probes have not run on Linux.** Hosted execution is paused by the owner’s choice. This security delta remains
unqualified until a hosted run passes; this entry update dispatches no workflow. The expanded matrix still needs execution on Linux.
The earlier run at 4a6700c8 predates these fixes.

For Linux read-only, commands may observe successful namespace-private writes.
Host paths must stay unchanged, and concurrent and later fresh sandboxes must not
see private data. The engine instructions and turn's native work note say writes
are discarded and nothing outside the staged copy persists. The answer itself
is preserved so structured judge results stay parseable. macOS retains refusal.

## What the machine needs

Use the pinned client and a standalone Node.js 22.18 or later. When the Host runs
inside Electron, its trusted composition must supply snapshotNode or set
BACKBONE_CODEX_SNAPSHOT_NODE to the absolute standalone Node executable before
creating the engine. The same runtime executes the admission probe and immutable
snapshot capture; a missing or unusable runtime refuses the attempt.

On Linux install bubblewrap, for example with `sudo apt-get install bubblewrap`
on Debian/Ubuntu, unless the client has its verified bundled copy. Codex discovers
system bubblewrap on PATH first. Keep CODEX_HOME outside the system
temporary directory so the pinned client can create its helper aliases there,
rather than relying on its executable fallback. The kernel must support seccomp and allow the
client to create unprivileged user and mount namespaces. This route uses the
client's maintained namespace/bubblewrap backend and seccomp, not legacy Landlock.
For contained, bare and read-only Linux profiles, install both the client binary
and standalone Node under a system runtime root readable through :minimal, such
as /usr/local. A client in the operating system home folder or Node in /opt can be hidden from its
own restricted view; admission refuses rather than adding broad read permissions.
macOS uses the same client's Seatbelt route. Windows remains unaccepted.

A namespace error mentioning Operation not permitted commonly comes from a
kernel or AppArmor restriction. Ask the machine's administrator to permit this
executable through the user-namespace policy. Relevant controls, where present,
are kernel.unprivileged_userns_clone, user.max_user_namespaces and
kernel.apparmor_restrict_unprivileged_userns. The engine never changes them.
Disabling an AppArmor restriction globally affects every program on that machine;
it is not an installation recommendation for a person's computer. The workflow's
relaxation is explicitly limited to its disposable hosted VM.

Containers add an outer security boundary and must separately allow nested user
and mount namespaces. Docker may require seccomp=unconfined and
apparmor=unconfined on the outer container even when Codex runs as an
unprivileged user. Those options relax the outer container and do not qualify
Codex's sandbox. No native container qualification was performed here; the measured
hosted VM has no Docker boundary to relax.

## What admission proves

Every turn first invokes the pinned native sandbox with owned canaries. The same
probe on both operating systems must allow the required staged reads and writes,
deny outside writes (including owned /tmp and /var/tmp siblings; Linux read-only
may instead prove private-write isolation as above), deny protected
reads directly and through symlinks, child processes and Linux's proc-root alias, and block command loopback networking.
The Host first proves its loopback listener is reachable. Missing or unknown
results fail admission. Read-only turns must deny staged writes as well.
On macOS the proc-root alias does not exist; the other protected-read paths still
run. The fake client's macOS heredoc check uses zsh/TMPPREFIX; Linux checks the
same heredoc with its POSIX shell.

The effective named filesystem and network map is read back exactly. The client
must report the actual host OS and retain the selected staged roots, no network
and no approval escalation. Full allows other readable machine files, subject to credential/configured masks
and the Linux rename/late-creation limits above. Contained, bare and read-only permit
only the stage and the client's minimal runtime paths. System-temp ancestor denies constrain the pinned Mac client's implicit scratch
access and Linux's writable synthetic parent directories for writable stages.
A read-only Linux profile must prove Host immutability and independent-process
isolation; missing or failed proof refuses it. Full's provider web
search is separate from local command networking. The trusted app-server itself remains
outside the command sandbox; this is not confinement of every native capability.

Only captured, validated immutable text can reach the conditional import gateway.
Sources, canonical files, source versions and unknown outcome handling keep their normal
Host checks. A failed probe, missing bubblewrap/runtime, blocked namespace,
seccomp failure or effective-policy mismatch refuses the attempt. There is no
unconfined fallback. Diagnostics identify failed probe properties or the native
Linux prerequisites without exposing raw stderr, paths or credential content.

## Verify without an account or model

From a checkout with dependencies and the pinned client installed:

```sh
node packages/modules/harness-codex/test/sandbox-probe.mjs
pnpm --filter @backbone-next/harness-codex test
```

The first command uses a temporary synthetic HOME/CODEX_HOME. It checks all four
environments, actual policy readback, sandboxed immutable captures and adverse
symlink, hardlink and binary outputs. Its only network endpoint is an owned
loopback positive control. It never signs in or calls a model. The module suite
uses fake native clients; it qualifies protocol, import, Stop and unknown outcome behavior,
not the kernel sandbox. Keep both forms of evidence. Linux qualification must record
which commands actually ran and which hosted failures they cover.

```bash test
test -f packages/modules/harness-codex/test/sandbox-probe.mjs
```
