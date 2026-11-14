# System keys

The standalone CLI, daemon and MCP host use systemKeys through
`@backbone-next/platform/system-keys`. The implementation
maintains the caller admission boundary. This provider has holder
keychain and wrap os-keyring-v1; it implements HomeKeys without changing vault
format 1. Implementation and observations are dated 10 November 2026.

A random UUID in the data folder's keys/system-id file names its account under service
`io.github.albertoangulo.backbone.home-keys`. It is independent of the path, so a
data folder can move. Copying the whole data folder retains that identity; independently
created data folders receive different accounts. A random 32-byte wrapping key lives only in the store. AES-256-GCM
wraps the data key with the account as authenticated data. The wrapped envelope
also names the account; unwrap validates its UUID and authenticates it through
GCM additional data. The sidecar is used for creation and downgrade detection,
not as a prerequisite for opening: deleting it does not lose the keys. Creation happens inside the
vault's existing lock. Opening never makes a missing item or identity again.

Selection reads format, holder and wrap from keys/vault.json, tolerating absence.
This duplicates one small read until the vault exports its provider metadata.
A missing vault beside existing data folder data is refused before probing or creating
keys; an empty first-run threads folder alone is not treated as existing data.

This table describes chooseKeys, used by the MCP host today and by the composed
Host tests for the future CLI and daemon integration. Unknown keychain wrappers
are refused without printing their untrusted metadata.

| Choice | Fresh unpinned (host only) | Plaintext unpinned | Plaintext pinned | System vault | Electron | Legacy keys, no vault |
| --- | --- | --- | --- | --- | --- | --- |
| unset | system required | plaintext | refused | system required | app required | refused; explicit choice needed |
| plaintext | explicit plaintext | plaintext | refused | refused | app required | migrate as plaintext |
| system | system required | refused | refused | system required | app required | refused; no silent conversion |

A plaintext vault beside keys/system-id or keys/system-protected is refused in
all three choices, before probing a store, even if the sidecar is invalid. New
creation writes the account identity before accessing the store. The first
authenticated reopen attempts to publish the nonsecret system-protected marker
under the vault lock, only after verifying the store item and the matching
committed vault envelope; it survives deletion of system-id. HomeKeys has no
post-commit callback, so the initial wrap cannot publish that second marker
safely. An interrupted protected creation can retry system keys, but cannot switch to plaintext. Older data folders
have only system-id until marker publication succeeds; if every protection
trace is removed, selection cannot infer the lost history. BACKBONE_KEYS=system is an independent
pin even then. Both markers move with a copied data folder. They are evidence, not a
boundary against same-user code that rewrites all the files.

No reverse migration is offered, even with explicit BACKBONE_KEYS=plaintext:
selection cannot validate an arbitrary replacement vault or safely detach the
original encrypted entries. There is currently no command to deliberately move
a protected data folder back to plaintext. A refused downgrade says which protection
record was found and that nothing was changed; it never suggests deleting it.

Where the table requires the system store, no usable store means refusal. A
store failure names `BACKBONE_KEYS=plaintext` with its plain-text warning. A
refusal caused by BACKBONE_SYSTEM_STORE_UNAVAILABLE=1 names that switch and
suggests removing it from the real command environment, never plaintext. There is no silent fallback. A missing
item for an existing system vault says its keys are gone from the key store and
nothing was changed; it never offers to recreate them. A mismatched provider is
refused before unwrapping, by the unchanged vault's dataKey function.

## Backend decision and sources

Read on 10 November 2026: Apple's [security command implementation](https://github.com/apple-oss-distributions/Security/blob/main/SecurityTool/macOS/security.c)
(interactive input, default creator access, verbose command echo), GNOME's
[secret-tool implementation](https://github.com/GNOME/libsecret/blob/main/tool/secret-tool.c)
(stdin storage and lookup exit codes), and the binding's
[README](https://github.com/Brooooooklyn/keyring-node#readme),
[package](https://github.com/Brooooooklyn/keyring-node/blob/main/package.json) and
[npm permission metadata](https://registry.npmjs.org/@napi-rs/keyring).

Chosen: installed platform tools, absolute /usr/bin/security and
/usr/bin/secret-tool, pipes rather than a shell, bounded runtime and a small
allowlist environment. macOS writes one command to `security -q -i` over stdin,
without verbose mode. Linux writes the secret to `secret-tool store` over stdin.
No wrapping secret goes in argv, environment, logs, errors or temporary files.
Tool output is captured privately; failures become fixed messages.

Recorded alternative: @napi-rs/keyring 2.1.2, released 19 October 2026, MIT wrapper,
prebuilt macOS x64/arm64, Linux GNU/musl and Windows binaries; supported binaries
need no install-time compiler and its package has no install script. Its Linux
binaries bundle libdbus under AFL-2.1 OR GPL-2.0-or-later (upstream README), outside
this repository's shipped licence list. It also defaults to a volatile kernel
keyring fallback unless Secret Service is explicitly required. Tools avoid a new
binary supply chain and let the Mac test address a temporary keychain directly.
Reconsider the binding if its bundled licences meet policy and it supports the
same isolated test. Windows is not implemented: selection refuses plainly.

## Protection boundary

This protects keys at rest in a copied or backed-up data folder, from another unprivileged machine
user, and in a stolen disk image whose key store cannot be unlocked without the
login password. This depends on the store's own encryption and password policy;
the provider does not inspect that policy, and a passwordless store does not
give that disk-image protection. It does not protect against code running as the same user that
can ask the key store. On macOS the item trusts /usr/bin/security, which creates
it; any same-user code can run that program. On Linux Secret Service typically
shares an unlocked collection across that user's session, without per-program
isolation. Locked-store behavior is not observed. The subprocess deadline is
not a guarantee against a system unlock dialog or a bound on its agent's
lifetime. Old plaintext backups retain their keys.

## Needs from the vault

The unchanged Vault.open creation path calls wrapKey under keys/.lock, and
its dataKey path checks the recorded wrap before unwrapKey. Both already work
with this provider; fake-store tests exercise both without the login store.
At the specified base these are Vault.open lines 182–190 and dataKey line 263.

No method exports a rewrap under a different provider. Consequently this unit
cannot offer the plaintext-to-system command without violating the vault's
ownership. Needed: a static Vault.rewrap(data folder, sourceKeys, destinationKeys) beside
Vault.open, under the same vaultLock, reading and validating the current vault,
unwrapping the existing data key, staging the destination identity without any
live protection pin, storing and verifying the destination wrapping key through
a commit-aware preparation API (not today's wrapKey), then replacing only
holder/wrap/key with writeVault's durable atomic rename and finalizing pins.
A failure before rename must leave the plaintext vault readable; after rename it
must be readable through the destination. Never delete the store item on an
ambiguous write. Test interruption before and after rename and concurrent opens.
Migration also needs a commit-aware destination preparation: calling today's
system wrapKey directly while a plaintext vault remains would publish its
identity/protection pin before the atomic replacement and strand selection if
interrupted. The vault owner must coordinate staged provider records with the
vault commit (or a validated recovery record), so the original plaintext vault
remains selectable before commit and the protected vault opens after commit.
HomeKeys currently exposes no such prepare/commit lifecycle. Do not implement
the command by simply calling this provider before replacing the vault.
The CLI command would be `backbone keys secure --home <home>`; no reverse command
is proposed because it would deliberately expose the data key on disk.

The initial Vault.open test-database guard also refuses system keys on a borrowed
test cluster. Keep it: system-home integration tests need a disposable database
of their own. The admission lane owns any changes before first wrap or migration.

The candidate now uses OS-held data folder locks on persistent private inodes, with
write admission before initialization. A paused owner does not lose its lock;
tests never create or remove a live lock file. Same-user code that replaces
inodes outside the protocol is outside this advisory exclusion. Linux data folder
writing remains experimental and needs its explicit qualification opt-in.

## Isolated macOS observation

Set the opt-in variable for this one command only; never export it or put it in
a shell profile. An exported opt-in lifts raw Node-test protection for every
test file without a wrapper. The wrappers still deny it until the isolated
case clears the denial locally.

On 10 November 2026 (equivalent command from the repository root):

```sh
BACKBONE_TEST_SYSTEM_KEYCHAIN=1 node scripts/no-leftovers.mjs node scripts/with-test-cluster.mjs node --test packages/platform/test/system-key-real.test.ts
```

Observed: 2/2 passed; the temporary-keychain case completed in 1.44 seconds
without an unlock interaction. It created a password-protected temporary
keychain with a random password sent over stdin, created My project through a
Host with selected system keys and no key-choice variable, forgot cached keys,
reopened and listed My project, then deleted the temporary keychain and data folder.
Every item lookup and write explicitly named that keychain; none used the login
keychain. This observes the platform tool path and Host composition on macOS,
not the leased standalone CLI or daemon. Linux is tested with a scripted runner;
a live Linux Secret Service has not been observed in this run.

## Evidence by claim

- [Provider tests](../../test/system-keys.test.ts): create/reopen, wrong provider,
  missing item, tampering, two accounts, moving a data folder, interrupted creation and
  fixed errors even when a store exception carries a value.
- [Selection tests](../../test/system-key-selection.test.ts): all twelve rows,
  unavailable stores, preserving plaintext, malformed metadata and Windows refusal.
- [Tool tests](../../test/system-key-tools.test.ts): stdin versus argv/environment,
  absolute tools, fixed environment, non-echo mode, timeout and redacted errors.
- [Process test](../../test/system-key-process.test.ts): two independent processes
  share an IPC fake, create a single account and keep both encrypted entries.
- [Host test](../../test/system-key-host.test.ts): the actual MCP main selects keys,
  creates and reopens a data folder using an injected IPC fake; a session-style Host
  creates My project. No test hook is shipped in a production entry point.
- [Mac opt-in](../../test/system-key-real.test.ts): real OS store in a generated
  temporary keychain only. Without the opt-in it accesses no real store.
- [Doctor tests](../../../surfaces/cli/test/key-provider.test.ts): recorded system,
  Electron and plaintext providers; plaintext remains plaintext with no choice.


## Test-store denial (review B1 and medium 6)

All shared test wrappers set BACKBONE_SYSTEM_STORE_UNAVAILABLE=1. Root scripts'
tests, executable guides and app unit tests use this environment too; Playwright
sets it for development runs even with a direct invocation. It is an
unconditional denial, not a way to choose keys: the real tool store refuses as unavailable before spawning, so
it cannot weaken a real run or enable a plaintext fallback. The actual tool
runner also denies raw Node test processes unless explicitly opted in. Fake
runners can simulate responses, but any attempt to delegate to the real tool
runner is still denied. Only the opt-in temporary-keychain case clears the
denial in its own process; it restores the value afterwards. Installed-app
journeys use the app's own safeStorage item and are outside this guard.
Development journeys use plaintext or the existing fake safeStorage fixture.

The spawn-recorder regression runs the MCP closing fixture and system Host
fixture with an inherited preload that records and refuses platform tools
before the OS starts them. It clears NODE_TEST_CONTEXT in the inner environment,
requires all three fixture tests to pass with no skips, and asserts zero recorded
attempts. Separate child checks assert that each of no-leftovers,
with-test-cluster and guide-steps supplies the refusal without an inherited
denial or recorder. These checks fail if the respective wrapper stops setting it. The recorder
only intercepts spawn, spawnSync, execFile and execFileSync in descendants that
inherit NODE_OPTIONS; it misses shell exec and children that replace their
environment. It is bounded regression evidence, not a sandbox or complete
process-tree monitor (second review finding 2).


## Missing versus inaccessible items (review medium 1)

Read again on 10 November 2026: GNOME secret-tool's lookup returns exit 1 without
an error for both absence and a dismissed unlock. A null lookup is therefore
followed by search --all, without --unlock. Any match, error or output means
unavailable, never lost keys; only a successful empty search means missing.
Search output is captured and discarded because it can contain a secret.
The executable fake covers missing, locked, dismissed and error cases; no Linux
host is claimed. Source: the GNOME implementation linked above, lookup, search
and store actions.

secret-tool store replaces an item with matching attributes. The preceding
lookup/search refuses any observed existing or locked item, but these operations
are not an atomic create-if-absent. Creation is serialized by the vault's data folder
lock for cooperating callers; same-user writers bypassing that lock, and the
same-user violations of the persistent-inode protocol remain outside that guarantee.

macOS availability probes read only the default-keychain path preference (or
use the explicitly scoped test path) and check that it is a readable regular
file. They never look up a credential or ask for keychain settings. Linux probes
use search without --unlock, not lookup. A probe can report a locked store as
present; actually opening or creating keys may still refuse until it is unlocked.

Locked-keychain behavior is not observed by a safe, supported test. No test or
script locks a keychain and then queries it, including opt-in tests; do not add
such a case. The earlier ad hoc probe was unsafe: its subprocess timeout did
not prevent a SecurityAgent process from remaining. It is not evidence of
bounded or promptless locked-store behavior. Apple's
[settings implementation](https://github.com/apple-oss-distributions/Security/blob/main/SecurityTool/macOS/keychain_show_info.c)
calls SecKeychainCopySettings; this provider does not call it.

After an item lookup returns exit 44, only filesystem readability of that same
scoped file is checked: a missing or unreadable file is unavailable. A readable
file cannot prove it is unlocked, uncorrupted or accepted by Security. An access
or lock failure reported as 44 is therefore still ambiguous with missing item,
and a file can change between checks. An existing vault never recreates an item
on that result. A new creation's write must still succeed and verify readable.



## Existing-data folder admission (review medium 5)

Only MCP host may create a data folder. permission and revoke require a vault or the legacy
key material of a data folder that already exists; neither a missing folder nor an
empty folder qualifies. They never create a system store item. chooseKeys accepts
a fourth argument, { create: false }, for non-creating callers. As at the base,
serve starts before a data folder or vault exists, never selects or probes keys, creates
nothing and answers NOT_AVAILABLE until the host runs.

A legacy data folder with keys/master.key or pg/secrets.json and explicit
BACKBONE_KEYS=plaintext uses the base vault/core migration, retaining the same
master key and database passwords. With the choice unset (or system), it is
refused before probing the store, with the explicit plaintext choice and its
warning named. Legacy plaintext files are not silently converted to system
storage. The existing-home exception never bypasses a protection pin.

The inventory was derived by reading Host/Core, credentials/store and channels,
composition/gateway and doors, connectors, models/route, memory/skills, tools,
and the durable-file helper. credentials/, doors/, projects/, material/, drafts/,
checkpoints/, outbox/, channels/, connectors/, memory/, skills/, tools/, intent
records and every other unrecognised root entry count as existing data. Only
known lock/transport/log directories, an empty threads directory, and keys'
nonsecret identity/protection records or recognised interrupted-write temporary
files can be a fresh retry. Unknown keys files count as data too. This
conservative rule covers new data owners without another positive marker list.

## Unlocking, retiring a data folder and process memory

Locked-keychain behavior has not been safely observed. The three-second
subprocess limit is not an interactive unlock workflow and cannot prevent a
system dialog or stop its agent. Unlock the intended keychain in Keychain Access
before using the provider; on Linux, unlock the collection in the desktop
keyring manager. Tests must never issue commands against a locked keychain.

Removing a data folder does not remove its store item. Copies of the same data folder share
that item, so automatic deletion could strand a backup or moved copy. Before
retiring every copy, retain its nonsecret account UUID from system-id or the
wrapped envelope in vault.json. To print only that account from a data folder:

```sh
node --input-type=module -e 'import {readFileSync} from "node:fs"; import {join} from "node:path"; const v=JSON.parse(readFileSync(join(process.argv[1],"keys","vault.json"),"utf8")); if(v.wrap!=="os-keyring-v1") throw new Error("This is not a system vault"); const e=JSON.parse(Buffer.from(v.key,"base64").toString()); console.log(e.account);' "/path/to/retired-home"
```

After all copies have been retired, remove exactly that item by hand, naming
the actual keychain file explicitly on macOS:

```sh
/usr/bin/security delete-generic-password -s io.github.albertoangulo.backbone.home-keys -a "<account UUID>" "/absolute/path/to/keychain-db"
```

On Linux:

```sh
/usr/bin/secret-tool clear service io.github.albertoangulo.backbone.home-keys account "<account UUID>"
```

These are retirement commands, not repair steps for a missing-key or downgrade
refusal. Removing the item makes every remaining copy unopenable. This unit
never runs them against the person's key store.

Wrapping-key and mutable write-input buffers are wiped when their operations
finish, including a failed write. No persistent base64 key string is retained
by the writer. Encoding still creates transient immutable JavaScript strings
and pipe/runtime copies that cannot be reliably zeroed; this is a recorded
in-process memory limit, consistent with the same-user boundary above.


## Retrying interrupted creation

No recovery command or deletion is needed: retry the same system-key command
(with the same data folder, unset choice or BACKBONE_KEYS=system). Before the identity
write, a retry chooses a new random account. After the identity write but before
the store item, it uses that account to create the item. After an ambiguous store
write, verified read, or envelope preparation but before the durable vault write,
it reads and reuses the same item; it never replaces it. No usable data key was
committed at these earlier points. The identity pins the unfinished creation
against switching to plaintext; that refusal says nothing was changed.

After the durable vault write, retry opens the same data key. On the first
uncached authenticated reopen it attempts to publish system-protected;
interruption before or after that marker write repeats or observes the marker
on a later writable, uncontended open. A failed creation can report store unavailability; after the store is available, the same
command resumes. Missing items for an already committed vault still refuse as
keys gone, never recreate. The standalone callers use the same retry/pin contract.

[Crash tests](../../test/system-key-crash.test.ts) terminate a process before and
after identity, after store creation, verification and envelope preparation,
after the durable vault write, and before/after the marker write. The fake store
survives those exits; retry uses one account/item, preserves any committed data
key and can read/write entries. No test failure hook is part of production code.


Directory metadata .DS_Store (Finder), Thumbs.db (Windows thumbnail cache) and
desktop.ini (Windows folder display settings) alone do not make a folder an
existing data folder. They are ignored by admission and preserved. No broad
wildcard exemption is used: unknown dotfiles and subdirectories still count as
data, so adding this exception cannot conceal another owner's vaultless data folder.


## Read-only opens and optional marker publication

When system-protected exists, unwrap only checks its presence: it takes no
filesystem lock and reads no additional file. When it is absent, publication is
best effort: no cross-process lock retries and a 100 ms admission timer for an
in-process queue. Read-only folders, busy locks, or metadata/publication errors
do not fail an authenticated open; the marker remains for a later writable open.
The referenced timer is cleared afterwards. The filesystem operation itself
still depends on local filesystem responsiveness.

The vault key is compared with the wrapped envelope by decoded bytes, accepting
equivalent base64 without padding. Authentication and store failures keep their
own refusals; a marker error is never called an authentication failure. A missing
marker remains a weaker downgrade trace if system-id is also removed; keep the
explicit system choice where that pin is needed.

[Read-only tests](../../test/system-key-readonly.test.ts) use the memory store and
disposable chmod read-only folders, check no changes, publish on a later writable
open, bound a busy in-process lock, reject tampering without writes, and accept
an unpadded envelope. The existing-marker test also intercepts provider file
reads and lock-directory creation and requires zero calls.


Read-only selection (including doctor) disables marker publication explicitly,
even when the data folder is writable. It also refuses a data folder without existing keys.
Wrapping, item creation and marker writes independently admit home/keys storage;
selection metadata and availability probes do not write. Host read-only mode
still follows the candidate's local storage/admission contract.


Legacy plaintext migration requires a write-capable command with an explicit
plaintext choice. Read-only selection refuses it without writing a new vault.
The [CLI opt-in test](../../test/system-key-cli-real.test.ts) exercises the actual
standalone entry point against a created, unlocked scratch keychain, using
projects create, projects list and doctor. Its one-command opt-in follows the
same isolation and no-locked-query rule as the Host test above.

The opt-in CLI proof also installs a separate spawn preload before the selector
hook: an absent hook fails the child, and unscoped tool invocations are refused
before spawning. Interactive creation requires independently validated scratch
input. Preference, settings and lock queries are refused by that child. The guard
is tested with a fake launch function; those tests cannot reach a real keychain.

Standalone selection and unwrap refusals carry a typed `SystemKeysRefused.reason`
through the existing `KeysRefused` shape. The existing code and human message are
preserved. CLI recovery uses that discriminant (including the required provider
and the test-guard source), never fragments of a human sentence. Vault's own
errors retain their existing typed codes; Vault itself is unchanged.
