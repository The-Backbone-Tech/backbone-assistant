# Use a thread workspace

**For:** someone calculating from attached files, or checking the local engine environment.
**Before starting:** a checkout installed with pnpm, Node 22.18 or newer, and a Mac with
sandbox-exec, hdiutil, sqlite3 and the Command Line Tools Python 3. This unit does not install
tools. On Linux, install bubblewrap, Python 3, util-linux and libseccomp (ABI 2), with the
executables at /usr/bin/bwrap, /usr/bin/python3 and /usr/bin/unshare,
and run as an unprivileged user on qualified arm64 with user namespaces and an existing
cgroup v2 delegation whose memory and pids controllers are enabled. The app creates bounded
child cgroups; it never changes the Host's cgroup or enables controllers. The tool is absent
on Windows and systems without the respective binaries. A refused namespace setup never
runs a command on the host. Containers must permit these namespaces; no unconfined fallback exists.

## Calculate from attachments

1. Open a project thread using Pi. Attach a CSV or XLSX original and ask, for example:
   “Load these files into a local SQLite table, calculate the total and explain the result.”
   The engine receives the optional workspace_run tool. Copying an attachment first can use:

   ```json
   {"attachment":"sales.csv","command":"ls ../inputs"}
   ```

   The tool returns relative paths for the read-only copies, the command's stdout, stderr,
   exit code and the fixed expiry. The engine chooses its scripts and SQL. CSV can be loaded
   with Python's csv and sqlite3 modules; XLSX can be read with zipfile and XML libraries.
   The product's existing [workbook text projection](../../packages/platform/src/stub/scripted.ts)
   flattens cells for read_file; the workspace instead receives the exact original ZIP bytes,
   preserving the structure for the engine's own parser. No formulas, macros or arbitrary
   workbook conversion are promised by the example test.

2. Ask another question in the same thread. The files and SQLite database remain until expiry.
   The Host records every retained source again before reuse: read_file text and connector
   results as well as copied attachments. A source that changed, is missing or was withdrawn
   retires the previous workspace; its derived table cannot be used by a later command.

3. Ask to keep a result as a project document. The engine reads its result through command
   output and proposes its text through write_file. The existing document rules decide what
   lands. Scratch scripts, tables and files are never imported automatically. Consolidation
   means choosing a useful result to propose; there is no automatic scratch archive or new
   product data layer.

The workspace holds at most a 32 MiB filesystem, including input copies and SQLite journals.
Host source metadata is capped at 256 KiB and 128 sources. On macOS, empty mount directories
are removed after each call; Linux retains one empty mount directory per checkpoint generation.
A command has at most 30 seconds of wall time and 64 KiB of returned output. It inherits
a per-user process ceiling with 32 slots of headroom and a 10-second CPU setting. The
process ceiling is enforced by macOS, and fork failures are reported. SIGXCPU can be ignored
on this Mac, so the supervisor also checks per-process CPU every 200 ms and stops a
member after observing 10 seconds. There is no aggregate CPU budget across all children.
On macOS, the same poll sums all sandboxed processes' physical footprint, including compressed memory,
and stops the command above 1 GiB. macOS rejects both 512 MiB address-space and resident-memory
ulimit values with EINVAL. The polled budget is not a hard allocation cap: a burst can allocate
many GiB between observations, and scheduling/helper delays can extend the 200 ms window.
Linux instead requires a hard 1 GiB cgroup memory cap with no swap, group OOM killing and
a 32-task cap across the whole command, plus a 512 MiB address-space ceiling per process.
It refuses when delegation is unavailable. Its filesystem has hard byte and inode bounds.
Touched Python allocation loops test memory enforcement for one process and several descendants;
the CPU/fork probes and a modest 64 MiB allocation test the remaining limits. Code runs without permission
or per-call approval because it can only change scratch. Network, loopback, Unix sockets,
other threads, the data folder and key services are outside its permissions. The Host refuses a
data folder placed inside the runtime's read permissions. A failed or interrupted command may leave
partial scratch; binary stdout must be encoded as base64. Inspect it before using it again. A read-only reviewer or bare turn gets
no workspace tool. Standalone Pi gets one only if its ToolHost supplies it.

## Reproduce the observed result

From the repository root, run the focused tests. This block is safe headless, uses a local
scripted model and fake data, and needs no key, account or outside service:

```bash test
node scripts/no-leftovers.mjs node scripts/with-test-cluster.mjs node --test packages/platform/test/workspace.test.ts packages/platform/test/workspace-turn.test.ts
```

On the qualified Mac, the turn test loads CSV values 2 and 3 plus workbook values 7 and 11,
queries their table and computes **46**. A second turn reads **23|4** (sum and count). Only
the two original project files exist until a third turn proposes result.md through the
normal write path. Deleting the thread removes its workspace. The mechanism tests exercise
real OS denials, full-volume failure, command limits, expiry and Host-kill recovery.
Linux has its own focused test, using only fake private files and local listeners:

```bash test
node scripts/no-leftovers.mjs node --test packages/platform/test/workspace-linux.test.ts
```

It checks persistent Python/SQLite, read-only inputs, host-file and socket denials, symlink
escape refusal, byte/inode exhaustion, dropped capabilities and cancellation. Unsupported hosts report a stated
skip, which is not Linux qualification. The Linux [implementation limits](../contracts/workspace.md#linux-implementation)
distinguish its accounting and checkpoint storage from the macOS disk image.

The Host/Pi journey also checks calculation from an attached CSV, source rebinding on the
next turn and document publication through the existing gateway. Linux home writing remains
an explicit experimental evaluation; this command creates only disposable private test homes:

```bash test
(
  umask 077
  BACKBONE_EXPERIMENTAL_LINUX_HOME_LOCK=1 node scripts/no-leftovers.mjs node scripts/with-test-cluster.mjs node --test packages/platform/test/workspace-linux-turn.test.ts
)
```

## Lifetime and removal

The Host stores scratch outside the data folder, in a private per-user temporary parent, under
hashed data folder and thread identities. It fixes an expiry 24 hours after creation. On macOS, each command
mounts the same bounded disk image at a fresh private path, then detaches it before returning.
The supervisor identifies all processes with this call’s inherited Seatbelt policy, including
setsid double-forks, freezes and kills them, confirms their exit and then detaches. It runs
outside the Host’s process group; killing that group leaves cleanup alive. On Linux, each
command gets a private bounded tmpfs and namespace. Killing its PID 1 removes all descendants;
only then does the supervisor checkpoint ordinary files and publish the retained generation.
Inputs and Host metadata are outside the engine's writable directory.

The admitted Host sweeps at open and every minute while running; there is no per-workspace
guard process. Expiry is checked again on use. Shutdown drains its sweep before giving up
the existing data folder ownership socket, so another Host cannot race its cleanup. Corrupt
records retire individually and empty folders used for workspace records are removed. A folder that throws is
reported and left pending while the sweep continues to later folders. Running records use kernel
process start times as well as pids to handle pid reuse safely. Deletion is recorded in the existing
thread journal before asynchronous cleanup; reopening the Host replays deletion and retries
retirement. Cleanup records retirement before detaching, then atomically renames and removes
only Host-owned storage. It never traverses engine-created symlinks or writes workspace files into a data folder. Bounded source reads use the existing data folder lock,
without a Core wait; the keychain is not used. After a machine crash, the next Host recovers incomplete allocation, expired
workspaces and unfinished retirement. Failed cleanup stays pending and is reported; it is
never treated as successful removal or silently reused.

## What is qualified

The original macOS mechanism observations used **macOS 26.6.2, arm64, 10 November 2026**;
the linked installed Pi journey names the later app proof. Linux was
exercised on **Ubuntu 24.04.4, arm64, Linux 6.8, 11 November 2026**, with bubblewrap
0.9.0, util-linux 2.39.3, Python 3.12.3 and libseccomp 2.5.5. Linux Host writing used
the explicit experimental flag above and disposable private homes.

| Consumer | Observed | Still outside this qualification |
| --- | --- | --- |
| Pi through Host | CSV and XLSX originals, SQLite and Python calculation, next-turn table, existing document proposal and thread deletion | Live provider/model behavior, large/complex workbook coverage |
| Codex | Fake-client dynamic-tool bridge forwards this same declaration, request and cancellation | Live Codex choosing or using it; its native per-turn text staging still has its own rules |
| ACP | MCP bridge forwards this same declaration and request, refuses invalid/ungranted/read-only calls | Live ACP agent using it; its native scratch still has network and the documented process-visibility limit |
| Desktop on macOS | A CommonJS bundle retains SQLite; the [installed Pi journey](../../packages/surfaces/app/e2e/pi-sandbox.electron.spec.ts) exercises commands through the app | Code signing and live model/provider behavior |
| Pi through Linux Host | Attached CSV calculation, retained SQLite, document proposal, filesystem/socket denials, hard storage limits and interrupted-process cleanup | Other distributions/architectures, production Linux data folder writing and installed Linux UI |
| Linux desktop build closure | A CommonJS bundle executes the staged confined supervisor and retains SQLite | Packaged Linux Electron app and code signing |
| Windows or unavailable confinement prerequisites | Tool absent from the Host catalogue; lower-level refusal before workspace creation | Execution, persistence and confinement on that host |

The native Codex and restricted ACP profiles also exclude the shared workspace parent,
so their ordinary file tools do not bypass its Host door. ACP person-rights remains the
person's wider native environment. The offline tool does not narrow those engines' other
capabilities. Hermes is unchanged: its plane keeps memory, skills and todo tools, while terminal, files
and code execution remain off; it does not offer this optional tool. Integrating its separate
plane admission and signed plugin gate is outside these cheap Host bridges.

The focused commands establish only their declared coverage. Package, installed-app and
repository checks run separately through the shared qualification gate; an explicit platform
skip supplies no qualification for that platform. The independent Claude-family review of the original unit found no high issue and accepted
containment with fixes. The follow-up tests cover text and connector withdrawal, setsid
survivors, modest fork exhaustion, ignored CPU signals, Host group kill, unavailable tool
catalogues, corrupt records, empty folders, pid reuse, competing workers and oversized input.

Command text and the profile remain visible to other local processes through ps (review L5).
Do not put credentials in commands. This unit does not conceal arguments from local peers.

The [workspace contract](../contracts/workspace.md) owns the boundaries and the choices.
