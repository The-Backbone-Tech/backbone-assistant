# How to run the daemon

**For:** a person who wants schedules, the heartbeat and goal runs to go on while the app is closed, on this Mac or on a Linux box. **Time:** a few minutes.

**Before you start:** Node 22.18 or newer and pnpm 10, with the repository installed (`pnpm install`). The daemon holds a data folder whose keys it can keep without the app: a new data folder, or one kept in plain files (`BACKBONE_KEYS=plaintext`). It refuses a data folder whose keys the app keeps in the Keychain; for that data folder, keep the app open instead. Protect a plain-files data folder's folder as you would the keys themselves. With BACKBONE_KEYS unset, a fresh data folder uses the system store where usable. Existing plaintext data folders stay plaintext; no unavailable store silently falls back.

## What it is

`backbone daemon run` opens one host for one data folder and keeps it open. It owns the data folder exactly as the app does: one owner per data folder, so a second daemon, or the app, is refused while it runs, and says so. It serves reads, local project creation and file attachment on the data folder’s api line: `backbone projects create` can add a folder or Git project and `backbone files attach <path> --project <name-or-id>` can retain an original while it runs. Attachments are regular files of at most 25 MiB, with the same filename rules and result as the standalone command. No send and no stop crosses it, because no one is there to approve model work. The data folder's permission door runs too, as it does in the app, so an agent you permitted may propose effects through it within that permission. Work starts from schedules, the heartbeat and goal runs.

## Steps

Blocks marked `bash test` run in CI through `pnpm guides`, which `pnpm check` calls.

1. Run it on a test data folder, ask who holds the data folder, read through the line, and stop it.

   ```bash test
   export BACKBONE_HOME="$(mktemp -d)/home" BACKBONE_KEYS=plaintext BACKBONE_HARNESS=stub
   trap 'kill -TERM "$daemon" 2>/dev/null || true; wait "$daemon" 2>/dev/null || true; rm -rf "$(dirname "$BACKBONE_HOME")"' EXIT
   backbone() { node packages/surfaces/cli/src/main.ts "$@"; }

   # Started as node itself, so the stop below reaches the daemon and not a shell around it.
   node packages/surfaces/cli/src/main.ts daemon run & daemon=$!
   for _ in $(seq 1 300); do [ -f "$BACKBONE_HOME/daemon.json" ] && break; sleep 0.2; done
   backbone status | grep "held by: daemon"
   backbone projects list
   kill -TERM "$daemon"; wait "$daemon"
   test ! -f "$BACKBONE_HOME/daemon.json"
   ```

2. On macOS, keep it running for your user with launchd. Installing writes one agent file into the LaunchAgents folder in your own Library and loads it; it starts at login and again if it fails. A key refusal is logged and exits cleanly (0), so launchd does not retry it. Follow the recovery instruction for that kind: an unavailable store needs an unlock or a desktop login; missing items need original-item recovery; a provider mismatch needs the recorded provider, not an unlock. Then start the daemon again. The plist retains KeepAlive only for unsuccessful exits and a 30-second throttle for other failures. It refuses a LaunchAgents or log folder that is a link, someone else's, or writable by others, and a failed load leaves no file behind. The agent is named for the data folder's real path, so a link to the data folder and the data folder itself name the same agent. Installing again first unloads whatever launchd has under that name, with or without its file. Uninstalling unloads the agent, then asks launchd for it: only launchd's "could not find service" answer counts as gone, and only then is the file removed. If launchd still has it, or answers anything else, uninstall says so (an unknown answer is reported as unknown outcome) and leaves the file. The data folder and its logs stay: remove them yourself if you want them gone.

   ```bash
   backbone daemon install --home "$BACKBONE_HOME"
   backbone daemon status --home "$BACKBONE_HOME"
   launchctl list | grep io.github.albertoangulo.daemon
   backbone daemon uninstall --home "$BACKBONE_HOME"
   ```

   Its log is `logs/daemon.log` inside the data folder. A new key-refusal line records its kind and UTC time. `backbone daemon status` adds `last key refusal: <kind> at <time>` only while the daemon is not running and the last 64 KiB of that log contains such a record; `--json` adds `lastRefusal` with `kind` and `at`. Status never displays arbitrary log messages or asks the key store. Old lines without timestamps cannot supply this record, and foreground stderr appears here only if it was redirected to that log. A running daemon omits the refusal in both text and JSON; unreadable, missing or linked logs produce no refusal field.

3. For a local Linux user service, use [systemd](#linux). For a container or VPS, use the image in `deploy/docker`. Nothing is published: you build it from this repository. The build reaches the network to pull the Node base image, for Corepack to fetch the pinned pnpm, and for the package install; nothing else.

   ```bash
   docker compose -f deploy/docker/compose.yaml up -d --build
   docker compose -f deploy/docker/compose.yaml exec daemon node packages/surfaces/cli/src/main.ts status
   ```

   It runs the Pi engine on the model route you give it (`BACKBONE_MODEL_ENDPOINT` and `BACKBONE_MODEL_ID` from your shell, never written in the file), and the stand-ins. Codex and Claude sign in through their own apps, which the image does not carry.

   The image runs as the unprivileged `node` user, because PostgreSQL refuses to run as root; keep it that way if you change it. The data folder lives in a named volume. The image sets `BACKBONE_EXPERIMENTAL_LINUX_HOME_LOCK=1`, the opt-in for the data folder lock on Linux: that lock is an open-file-description lock that is not yet qualified on Linux, and without the variable a Linux daemon refuses to write its data folder. The lock refuses network, overlay and unknown filesystems, so keep `/data` on a local named volume; a data folder left in the container's own layer is refused. If you bind-mount a folder instead, note that Colima on a Mac shares only your operating system home folder, so a mount from `/tmp` arrives empty inside the container.

The image includes the CLI workspace dependency closure, including channels, and the modules it loads. The image carries the telemetry module, loaded only when the data folder names an endpoint. It is deliberately minimal: the Pi engine, the mail connector and the optional telemetry module. The Codex and ACP engines and the MCP door are not in it, so a daemon in this image cannot choose them; an image that carries one of them, with that engine's own program and sign-in, would be a separate variant and does not exist yet. Observed on 10 November 2026 at `cee1bf2`: `bash scripts/docker-smoke.sh` built the image without a cache on linux/arm64 (Docker 29.5.2 in a colima VM on an Apple Silicon Mac, the legacy builder), a project was created in a fresh volume, the daemon started as process 1 with its api line up, `doctor --json` answered ok through it, and `channels bind` returned a one-time code; the image measured 182,908,937 bytes. Not observed: linux/amd64, a model turn (the run uses the stub engine), or a real channel. To repeat it on the committed `HEAD`, run `bash scripts/docker-smoke.sh` with Docker available. It uses a temporary volume, prints the doctor result, a one-time binding code and image size, then removes its container, volume and image. Doctor may warn that optional engines or a model route are absent.

## System key store integration

A fresh daemon data folder uses the system store with BACKBONE_KEYS unset, or requires
it with BACKBONE_KEYS=system. Existing plaintext data folders stay plaintext; existing
Electron data folders still need the app. The plaintext-to-system migration command
is not built. A macOS agent runs in gui/<uid> and records system for a system
data folder; a plaintext data folder retains the old plaintext unit environment. A fresh
explicit plaintext choice is retained too. The Linux foreground daemon inherits
DBUS_SESSION_BUS_ADDRESS/XDG_RUNTIME_DIR; no Linux service-unit installer is built.

The provider requires macOS Keychain or Linux Secret Service with
/usr/bin/secret-tool. A server or container without a store refuses a fresh data folder;
only the explicit BACKBONE_KEYS=plaintext choice writes the data key in plain
text. The Docker trial still makes that explicit choice. A service must run in
the user's session to reach that user's unlocked store; Linux selection forwards
only DBUS_SESSION_BUS_ADDRESS and XDG_RUNTIME_DIR as session locators, together
with fixed PATH and LC_ALL. The provider runs no separate start or unlock command. Unlock in the OS before use; a subprocess timeout cannot prevent or dismiss a system dialog. Locked-keychain behavior is not qualified or tested.

The protection is for keys at rest (a copied or backed-up data folder, another machine
user, or a disk image without the key store's unlock password). It does not
exclude code running as the same user: on macOS it can run /usr/bin/security,
which the item trusts; on Linux it can ask the session's unlocked Secret Service.
The [provider README](../../packages/platform/src/system-keys/README.md) records
the exact backend, limitations and isolated Mac observation.

## When the app meets a held data folder

Opening the app on a data folder the daemon holds shows a page that says so, with the daemon's pid, instead of a half-working window. The app and the daemon do not take turns on one data folder: the daemon uses its system-store wrapper or an existing plaintext vault, and the app uses its own safeStorage wrapper. Neither silently converts the other's data folder. Stopping the daemon (`backbone daemon uninstall`, or Ctrl-C where you ran it) frees the data folder for the command line or another daemon, not for the installed app; give the app a data folder of its own.


## Linux

### User service with systemd

Install the local npm package using [the CLI guide](install-the-cli.md), and create a project in the intended data folder before starting the service. The example uses `$HOME/.local/bin/backbone` and `$HOME/.local/share/backbone`; edit the copied unit if your prefix or data folder differs. Node must be available on the service's PATH (check with `systemctl --user show-environment`).

```sh
mkdir -p "$HOME/.config/systemd/user"
cp deploy/systemd/backbone.service "$HOME/.config/systemd/user/backbone.service"
systemctl --user daemon-reload
systemctl --user enable --now backbone.service
systemctl --user status backbone.service
journalctl --user -u backbone.service
```

The checks below run in CI on every change, without systemd: the unit this page describes exists, starts the daemon the way the page says, carries the three settings named here, restarts only on failure within the stated limits, and holds nothing that looks like a secret.

```bash test
unit=deploy/systemd/backbone.service
test -f "$unit"
grep -qx 'ExecStart=%h/.local/bin/backbone daemon run' "$unit"
grep -qx 'Environment=BACKBONE_HOME=%h/.local/share/backbone' "$unit"
grep -qx 'Environment=BACKBONE_KEYS=plaintext' "$unit"
grep -qx 'Environment=BACKBONE_EXPERIMENTAL_LINUX_HOME_LOCK=1' "$unit"
grep -qx 'Restart=on-failure' "$unit"
grep -qx 'RestartSec=60s' "$unit"
grep -qx 'StartLimitIntervalSec=1h' "$unit"
grep -qx 'StartLimitBurst=5' "$unit"
grep -qx 'WantedBy=default.target' "$unit"
test "$(grep -c '^Environment=' "$unit")" -eq 3
! grep -Eiq 'token|secret|password|api[_-]?key' "$unit"
```

The unit contains no secret. It selects plaintext keys, so protect the data folder as you would the keys themselves. It opts into the experimental Linux OFD data folder lock with `BACKBONE_EXPERIMENTAL_LINUX_HOME_LOCK=1`; as in the Docker image, use a local filesystem. The lock refuses network, overlay and unknown filesystems. Linux locking is not yet qualified.

The unit restarts only on failure, after 60 seconds, at most five starts per hour. A clean stop, including the key-store refusal described by the daemon, is not restarted. Inspect the journal and correct the cause before restarting. To stop and disable it, run `systemctl --user disable --now backbone.service`. For operation after logout, configure user lingering with your system administrator if needed.
