# How to install and open the app from source

**For:** someone who wants the app running from this repository. **Time:** about ten minutes.

**Before you start:** a Mac for steps 4 and 5 (steps 1 to 3 also work on Linux), Node 22.18 or newer, pnpm 10, and git. No key or account is needed until you send a message. Run everything as an ordinary user, never as root: the bundled PostgreSQL refuses to start as root, so the checks and the app fail there. In a container that means `USER node` or an equivalent.

Blocks marked `bash test` run in CI through `pnpm guides`. The others need a screen, a download or macOS, so CI does not run them.

## Steps

1. Check your tools.

   ```bash test
   node -e "const [a, b] = process.versions.node.split('.').map(Number); if (a < 22 || (a === 22 && b < 18)) { console.error('Node 22.18 or newer is needed'); process.exit(1); }"
   pnpm --version
   ```

2. Install, from the repository root. Install scripts stay off (`.npmrc`), so nothing runs code at install time.

   ```bash test
   pnpm install --frozen-lockfile --prefer-offline
   ```

3. Build Backbone from the local configuration. This is the last step that needs no screen.

   ```bash test
   BACKBONE_DISTRIBUTION=distributions/backbone/distribution.json pnpm --dir packages/surfaces/app build
   grep -q '<title>Backbone</title>' packages/surfaces/app/dist/renderer/index.html
   test -f packages/surfaces/app/dist/electron/main.cjs
   ```

4. Fetch Electron once, then open the app with a fresh, throwaway profile folder, so your normal profile is untouched.

   ```bash
   pnpm --dir packages/surfaces/app electron:install
   BACKBONE_HOME="$(mktemp -d)" pnpm --dir packages/surfaces/app start
   ```

   A window opens with the sidebar, Home and the message box.

5. Optional, macOS only: build the installable app.

   ```bash
   BACKBONE_DISTRIBUTION=distributions/backbone/distribution.json pnpm --dir packages/surfaces/app package
   ```

   The disk image lands in `packages/surfaces/app/dist/package/`. The app is unsigned: the first time, right-click it and choose Open.

## What you now have

The app open on your machine, with no key yet. It can show projects, files and Settings. Real answers need a supported installed, signed-in Codex client or a Pi model route, chosen in Settings › AI and models. A route may use your key, a gateway or a local endpoint. Start with a disposable project, attach a short note and ask for a brief. Check its file version and receipt; this is a manual trial, not a test result. For a keyless first job without a screen, use the [CLI stub example](use-the-cli.md).

## Storage and upgrades

A packaged app update accepts its bundled engine automatically when its declared
capabilities stay within the permission already given. The registration history
keeps each content version. If an engine adds capabilities, the app explains what
it can now do and asks once: **Allow** or **Don't allow**. Native Codex account
reach means connectors, plugins and MCP servers from your own Codex app (mail,
calendar, files), available when a chat has Full access. Declining opens no engine
and changes none of its permissions. To return to the previous version, quit the
app and reinstall the previous app version with the same data folder. Configured
or development engine paths still confirm content updates. A CLI or daemon never
prompts: open the app once to allow the update, then use it again. Old work keeps
its original engine binding.

The Team update first makes a verified export in the data folder's `backups/`
folder and records its location in `logs/identity-upgrade.jsonl`. If export fails,
the update does not start. The identity versions install together; an installation
failure rolls them all back and leaves the original work usable. The app names
the copy and reuses it after a failed attempt while the source work is unchanged.
Only the app starts this update; a CLI or daemon asks you to open the app once.
A data folder missing its device core record refuses the update. Reinstalling an older app does not undo a committed database update.
To recover the portable export separately, run `backbone restore <copy-folder>
--home <new-empty-folder> --dry-run`, inspect the preview, then repeat without
`--dry-run`. All document versions and memory are included; chats return as
history, and schedules, credentials and permissions are excluded. Keep the
original data folder until recovery is verified. The device-owner window also
has **Restore my access on this Mac** when workspace access fails, including a
folder that previously had a second person. It restores your local owner membership only when no other active owner exists,
records the repair in People and roles and reopens the app. Another active owner
must restore your access themselves. Team checks can stay paused after membership
repair. Current sole-device work remains available; otherwise the failure page
explains the pause and offers Settings › Backup.

If the device person is demoted to member, they cannot use the Codex engine on
that device. They can choose Pi in Settings › AI and models, or ask a workspace
owner to restore their owner role.

Writable data folders need a supported local filesystem and the bundled native lock backend. The admission policy recognizes macOS APFS and Linux ext-family, XFS, Btrfs and tmpfs; it refuses unknown, network, FUSE and overlay filesystems, unsupported operating systems and worker-thread ownership. macOS arm64/APFS is the runtime-qualified profile. Linux writing additionally requires the explicit experimental opt-in `BACKBONE_EXPERIMENTAL_LINUX_HOME_LOCK=1`: its OFD architecture/libc controls are not yet qualified. An image that deliberately sets this variable remains experimental; use a supported data volume, rather than the container's overlay. Other architecture/libc combinations remain unqualified until actual runtime controls pass. Recognition or opt-in is not qualification. Windows writing fails closed. A read-only Host refuses incomplete data folders and initializes no local stores. It still needs the supported native ownership backend and starts the existing PostgreSQL cluster; the [read-only data folder contract](../contracts/readonly-home.md) defines the physical-runtime exception.

The private regular `.lock` file (and the vault's `keys/.lock`) persists when a client stops. Its existence does not mean another process owns it. Never delete it to recover a paused client, include it in a restore, or replace it when taking a backup. The operating system holds ownership until the descriptor closes or the owning process dies. A client that was merely paused keeps ownership without a timeout.

An older client used a lock directory. The new client names the refused path and never converts that directory automatically. Before upgrading an existing data folder, stop every app, daemon, CLI/MCP host and independent helper using it; confirm that none remains paused or running. A normal old-client close removes its own directory. Legacy locations include the data folder's `.lock`, `keys/.lock`, `pg/.lock`, `cli/.lock`, `triage/authority/.lock`, `triage/usage/.lock`, `channels/authority/.lock`, `channels/service/.lock` and `credentials/channel-settings/.lock`. Each operation-specific refusal names its exact path. A file-backed fake mail provider also has a separate `<stateFile>.provider/.lock` beside its fixture state. After every relevant client has stopped, the person must explicitly confirm the transition before removing only a remaining empty legacy directory with `rmdir`. Never remove a regular lock file. Then start only new clients on that data folder. Do not downgrade or mix protocol versions: new regular files prevent old acquisition, but cannot revoke an old callback already in flight. Lock-file contents, mtimes and a closed Host in one process do not prove global quiescence.

For a refused regular lock's permissions, first stop every relevant client. Inspect the exact reported file and folder: an ordinary, single-link file owned by this user needs mode 0600 (`chmod 600`); its owning folder must prevent group/other writes (`chmod go-w`). Do not apply these repairs through a symlink, to another user's resource, or as a way to hide extra hard links. Inspect those layout/ownership problems offline and retain recovery evidence; use a new private data folder with a verified export when available. Restart clients after repair. A process that observed integrity loss refuses later local admissions for that canonical path key until restart. Firmlink and bind-mount spellings that native realpath does not unify are separate keys; the refusal map does not unify directory identities across those spellings. This stops new local work; it cannot fence a callback already running or another process using an illegally recreated inode.

Darwin's filesystem numbers come from VFS registration, not a portable filesystem magic. The qualified APFS boot-volume profile must still match before a target's observed type is admitted; a changed boot profile refuses until re-observed. Chrooted Darwin and other boot profiles are not qualified. App packaging here remains unsigned. Native loading in an ad-hoc test artifact does not qualify Developer ID signing, hardened-runtime library validation or notarisation; those checks precede a signed distribution.

## What next

- The build input and its current limits: [distribution settings](../distributions.md).
- Where tests end and real-engine evidence begins: [README.md](../../README.md).
- Run the checks: [run the checks](run-the-checks.md).
