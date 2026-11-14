# Thread workspace contract

A completed conversation rewind retires this thread's command workspace before
new work can start, including derived files with no material source. Its journal
intent remains pending if retirement fails, so a resume retries cleanup rather
than reusing discarded scratch. Other projects remain available.

**Owner:** platform Engine composition. **Status:** local implementations on macOS and Linux; qualification is platform-specific.

The engine prepares the working environment as well as the agent loop. The engine chooses
how to solve an immediate problem: scripts, SQL tables, views and documents are ordinary
files here. Useful results go through the existing document proposal or connector door;
the rest expires. Workspace files are never project material by themselves.

## What the engine gets

The Host offers one optional tool, `workspace_run`: a shell command in this thread's private
working directory. Command Line Tools Python 3 and system SQLite are available on qualified Macs. An optional
attachment name copies that exact permitted original into a read-only inputs directory. The
response names the relative input file and reports bounded stdout, stderr and exit status.
The engine can use Python's standard CSV, ZIP and XML libraries to read CSV and XLSX into
SQLite, then query and calculate. No package download or new npm dependency is needed.

One general command tool keeps the method with the engine. Separate SQL and spreadsheet
tools would duplicate ordinary tools and prescribe a data model. Node's built-in SQLite
would avoid a child process for SQL alone, but would still need a separate restricted process
for scripts. SQLite is a local file, needs no service or connection string and survives the
next turn. Postgres adds a server and credentials without a need in this unit. There are no
agent-shaped collections, per-thread product database schemas, git worktree operations,
package installer, notebook service or automatic promotion of scratch into the product.

## Boundaries

On macOS, execution uses Seatbelt through sandbox-exec, sharing the existing ACP base policy.
It adds an explicit denial of inspection of other processes, permits reads only to system tools and this
workspace, and permits writes only inside the working directory. All network operations,
including loopback and Unix sockets, remain denied. A data folder inside the runtime read permissions is refused. System services that could reach keys
or start background jobs are not permitted. Two empty Host-owned nonce files expose metadata
only, so the supervisor can identify the inherited Seatbelt policy of its descendants. The shell receives a fresh small environment:
no inherited keys, provider settings, product database address or data-home path.

The engine cannot read the data folder, key store, another thread or arbitrary personal
files, including through a symlink. Inputs are copies, never references into the data folder;
their directory is read-only even though output files are writable. The Host validates
input identity and records the read through the existing gateway before copying bytes.
Before each command the Host retains every material source the turn has read so far, including
read_file text and retained connector results, even if the engine copied the text through a
script rather than the attachment option. A source that changed, is missing or was withdrawn
retires the workspace before its derived files can be used. Reads already recorded in this
turn are not fetched again; a later turn records the retained sources again.
Nothing here permits a wider read, document write or connector permission.

A command is local work, with no permission or per-call approval. Output that is to become
project material must still be proposed through write_file under its existing rules.
A read-only review turn and a bare turn receive no workspace tool. Command failures are
reported, never automatically retried. Stop, timeout and output overflow end the command;
a killed command may have partly changed scratch, so the engine must inspect before reuse.

The shared engine bridges distinguish a confirmed zero exit (done), a confirmed non-zero
exit (failed), and a stop, missing/malformed reply or unconfirmed output/cleanup (unknown).
An exit status or stderr containing a denial does not establish that the Host refused
execution: the command may have changed scratch before failing. Unknown scratch work does
not itself interrupt a turn as an unknown canonical effect would. Work notes retain fixed
status evidence, not stdout, stderr or arbitrary Host reasons; the original reply still
reaches the engine for inspection. Refused remains the word for a policy or authority denial.
Known Host policy checks before command dispatch reject with a typed refusal, preserving their
original diagnostic. Engine bridges project its certified marker as fixed refusal status text.
Source invalidation after execution remains unknown. The trusted shell wrapper reports limit
setup over a separate pipe, closed before user code starts, so setup failure is distinct from
a user's command exiting 125. Missing setup evidence or unconfirmed cleanup remains unknown. On macOS, the optional
`cleanupStage` reports only `stop`, `drain`, `detach` or `unlink` when that stage cannot be
confirmed; it never includes an OS error, path or command. A cleanup failure still retires
scratch, and an unconfirmed output drain retains its existing unknown outcome.
Linux preflight policy checks use the same typed refusal before command dispatch. Linux
shell failures retain their exit status; interrupted or unconfirmed replies remain unknown.

## Lifetime and size

A workspace belongs to one data folder and thread, but lives outside the data folder. At creation
it gets a fixed expiry 24 hours later, not renewed by use. On macOS it holds a fixed 32 MiB disk image;
the filesystem enforces the capacity even during a running command. A polling size check
alone was rejected because a script could exhaust the host disk between polls. Inputs
consume that same capacity. Host source metadata is separately capped at 256 KiB and 128 sources; on macOS, empty mount directories are removed after every command. Command wall time is limited to 30 seconds and returned output to 64 KiB. The shell sets
inherited soft and hard ulimit values: 10 CPU seconds and a per-user process ceiling equal
to the current count plus 32, bounded by the inherited hard ceiling. The process ceiling
is shared by the user, not an exact per-command child count. CPU accounting is also checked
every 200 ms through libproc, since macOS delivers SIGXCPU but lets a command ignore
it even at the hard value. The supervisor stops a process after observing 10 CPU seconds.
The same poll sums physical footprint across all live processes carrying this command's
Seatbelt policy, including reparented children. The default budget is 1 GiB (1,073,741,824 bytes).
It reads ri_phys_footprint from proc_pid_rusage, RUSAGE_INFO_V0: macOS's per-process memory
charge, including compressed memory, rather than resident pages alone. The sum is of kernel
charges, not unique physical pages across the whole machine. Above the budget it stops the
command with “stopped: the workspace's programs used more than 1 GiB of memory”, then kills
all its sandboxed descendants before detaching. Failed accounting also stops the command.
For a memory stop, the result includes monotonic supervisor timestamps in memoryStop: the
first over-budget sample delivered to the supervisor, confirmed process stop and successful
detachment. A missing later timestamp does not confirm that cleanup stage. Tests measure
these differences, not allocation speed, volume setup or Host result delivery. Their response
guard allows one 200 ms poll, the descendant killer's 5-second deadline and a 10-second margin
for scheduling, helper startup and forced detachment under load. The overall three-minute
test timeout is only a hang detector, not a memory-budget response promise.
The requested 512 MiB address-space/resident ulimit values still return EINVAL on the qualified
Mac. This polled budget is not a hard allocation cap: a fast burst can exceed 1 GiB by whatever
it allocates between observations, potentially many GiB up to available RAM and swap. Helper
execution, scheduling and cleanup can extend that window beyond 200 ms; polls never overlap.
These limits do not claim a total CPU budget across children. On macOS the Host mounts at a fresh path for each command and detaches before returning. The
supervisor enumerates processes bearing the inherited policy, freezes and kills them, and
confirms no live member remains before detaching. setsid, double-forking, changed argv and
a cleared environment do not bypass that check. If policy identification is unavailable,
no engine code runs. The supervisor is in its own process group, so a Host group kill leaves
its timeout and cleanup alive. Desktop builds stage these same
supervisors beside the bundled Host; source and CLI runs use their original files.

Host-owned metadata and retirement records live outside the writable volume. Cleanup records retirement,
detaches its mounts, then atomically renames and removes it. An interrupted creation
or deletion is never reused. Cleanup retries retired and expired records when the Host next
uses its workspace service. One sweep runs after the Host acquires its existing live-home
ownership and on a timer while it runs; shutdown drains the sweep before releasing ownership.
No process is kept per idle workspace. Expiry is always checked on the next use. A corrupt
record retires only that workspace, and empty folders used for workspace records are removed. A folder whose
inspection or cleanup throws is reported and left pending; the sweep continues to the next
folder and retries the failed one at a later sweep.
After a machine crash, the next Host recovers cleanup from disk. Thread deletion retires its
workspace; replay of the durable deletion retries cleanup after a crash. Cleanup never follows
an engine-created symlink. Workspace storage never writes into the data folder. Source snapshots use the existing data folder
lock for bounded file reads only, never for a Core open or crossing. The keychain is not used.
A running record includes the supervisor pid, kernel start time and random policy token.
Reused pids neither block the workspace nor get killed. The one live-home owner and the
per-home workspace queue serialize Host operations; the existing owner socket is canonical
across data folder aliases, while workspace folder names remain compatible with the original unit; atomic running admission and ownership
checks also prevent a losing worker from detaching the winner’s mount.

## Engines and qualification

Pi gains the tool through ToolHost. Codex already has a sandboxed shell and a per-turn text
copy that is deleted; ACP already has thread scratch and its own process environment, but
neither supplies this persistent, size-bounded, offline data workspace. Where cheap their
Host tool bridges expose this same tool, retaining their existing native environments.
That does not turn either native environment into the offline workspace described here.

The Host offers the tool on macOS with /usr/bin/sandbox-exec present, or an unprivileged Linux user with
/usr/bin/bwrap, /usr/bin/python3, /usr/bin/unshare and libseccomp.so.2. It is absent from other platforms’ tool lists;
missing prerequisites are refused before creating workspace state. Linux discovery runs
a shared asynchronous probe of the same namespace, bounded-volume and seccomp launch chain,
using only an owned directory under the system temporary parent, removed even after a
five-second probe timeout. Ambient TMPDIR is ignored; a data folder containing that parent
is refused before probing, including when a successful probe is cached. Root is refused without creating workspace state.
The cache lasts 30 seconds; actual Linux namespace setup is also
checked before any engine command is admitted; failure never runs the command on the host.
Tests use owned fake files, local endpoints and a scripted model; no live model, provider
account, keychain or production data folder is part of qualification. The how-to and focused tests
record the exact observed coverage. This contract replaces the unimplemented scratch-collection
draft; no Core migration or change to the document acceptance rules is involved.

Design references checked 10 November 2026: OpenAI's
[Code Interpreter](https://developers.openai.com/api/docs/guides/tools-code-interpreter)
uses an expiring container; Anthropic's
[code execution](https://platform.claude.com/docs/en/agents-and-tools/tool-use/code-execution-tool)
provides shell commands and files with outbound networking disabled. These inform the shape,
not a claim of product equivalence.

Observed qualification and exact commands are in [use a thread workspace](../how-to/use-a-thread-workspace.md).

## Linux implementation

The Linux supervisor adopts the installed bubblewrap executable as a separate system
component (LGPL-2.0-or-later) and util-linux unshare (GPL-2.0-or-later); neither is bundled or linked. Its policy follows the namespace
and scoped runtime mounts in [Codex's pinned source](https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/linux-sandbox/src/bwrap.rs).
No Codex implementation is copied. This is an offline workspace, with a narrower read
view than a coding client's ordinary repository sandbox, and does not qualify Codex itself.

Only arm64 is qualified. An unprivileged user is required. User, mount, PID, network, IPC and UTS namespaces are
separate; capabilities are dropped and further user namespaces are disabled. The root,
system tools, private procfs, minimal devices and copied inputs are read-only. Only the
thread's tmpfs work directory is writable. The inherited environment and host sockets are
absent. System binaries/libraries under /usr/bin, /usr/sbin, /usr/lib, /usr/lib64,
/bin, /sbin, /lib and /lib64, plus loader
configuration, are readable; a home overlapping these paths is refused.

The tmpfs file capacity is rounded down to the kernel's page size from 32 MiB minus inputs and a 256 KiB
symlink reserve. A trusted setup uses unshare to create an outer private user/mount namespace
and mounts tmpfs with both the byte capacity and 4096 inodes minus retained input files. A
size below one page is refused both before launch and inside the trusted mount setup;
size=0 is never passed to tmpfs. It then execs bubblewrap,
which drops all capabilities and disables further user namespaces before the admission
shell starts. No mount is made in the host namespace. Checkpoints allow at most 4096 entries,
64 directory levels and 256 KiB of symlink targets. A checkpoint counts regular bytes and
symlink targets against 32 MiB. Empty files and directories consume the same hard inode bound.
Host-owned metadata and one pending checkpoint live outside that volume. No live engine
can reach them. A trusted directory descriptor keeps tmpfs available for checkpointing
after all its processes stop. Copying never follows engine links; special or unreadable
files, excessive depth and sparse/hard-link expansion beyond checkpoint limits retire
scratch with a failure. Nothing is promoted from that failed checkpoint. Each retained
generation has one empty mount directory in the host view. An atomic generation pointer
publishes the complete checkpoint. Interrupted
publication retains the previous generation; unused generations are removed on reuse.
No namespace or process remains for an idle workspace.

A new input that would leave insufficient pages or inodes for retained work is refused
before admission. Inputs are capped at 128 files. The previous checkpoint remains current;
no command runs and no retirement is recorded. Input capacity never discards retained SQLite.

An installed libseccomp (LGPL-2.1-or-later) compiles the network filter for the native
architecture; no library is bundled. A sealed memfd supplies it to bubblewrap. Every
socket family, including local Unix and VM sockets, is refused with EPERM. io_uring
syscalls are denied too: they could otherwise create a socket without socket().
This follows [Codex's network-filter rationale](https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/linux-sandbox/src/seccomp.rs).
Compilation or enforcement failure refuses admission; no engine code runs unfiltered.
keyctl, add_key, request_key, perf_event_open, ptrace, process_vm_readv and process_vm_writev
are unconditionally refused by the filter.
Inherited key APIs are unreachable; setup neither reads nor changes a session keyring.

Linux requires an existing delegated cgroup v2 ancestor with memory and pids controllers
enabled. The app neither enables controllers nor moves the Host. Before exec, the child
joins a fresh command cgroup with memory.max=1 GiB, memory.swap.max=0, memory.oom.group=1
and pids.max=32. Limits and namespace membership are read back before admission. Missing
delegation or failed enforcement refuses the command. These are kernel bounds across all
command descendants, rather than a same-UID headroom estimate or a memory poll. The
[kernel interface](https://docs.kernel.org/admin-guide/cgroup-v2.html) owns their semantics.
The 30-second wall and 64 KiB output bounds still apply, with 512 MiB address-space and
10 CPU seconds per process. There is no aggregate CPU budget. A cgroup OOM is reported as
a hard memory-limit stop; macOS's polled memoryStop timestamps are not claimed on Linux.
Empty resource groups are reclaimed after namespace shutdown; recovery never kills an
unverified process through a cgroup. The engine cannot evade the bounds with setsid, double-fork or
disabled dumpability. Killing namespace PID 1 makes Linux kill every member, including
reparented children. Pid/start-time checks prevent targeting a reused pid. The supervisor
also binds its lifetime to its IPC bridge with PR_SET_PDEATHSIG; bubblewrap binds its own
and the namespace's lifetime to that supervisor. Unconfirmed cleanup retires scratch.

Deletion and expiry run independently of execution availability. If an old worker cannot
be stopped, its retirement stays pending for a later sweep instead of being silently skipped.

On Linux arm64, tests run only when binaries, namespace support and cgroup delegation are available; elsewhere
they report the precise missing prerequisite as a skip. A skip is not Linux qualification.
The [journey grader](../../scripts/journeys.mjs) excludes skipped TAP results and requires
an individually passing proof in a completed passing suite from a clean matching gate.
The Linux Host journey additionally names the experimental home-write prerequisite; this
unit does not qualify Linux home writing as a production default. Installed app journeys
retain their separate packaged-app proof requirement.

## Local visibility

The command text and Seatbelt profile can be visible in ps to other local processes.
This unit does not hide command arguments from the person’s other programs. Never put
credentials in commands; the workspace does not receive product credentials.
