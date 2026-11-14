# Install the command line from a local package

This is a local prototype, not a registry permission. Obtain the generated npm tarball from someone who built it; the installation machine does not need a repository checkout. It needs Node.js 22.18 or later, npm and network access to install the pinned third-party dependencies. The package uses Node’s experimental TypeScript stripping API; The launcher keeps the one warning about that API off your terminal; other Node warnings still show. The launcher refuses older Node versions and asks you to upgrade Node. A writable npm global prefix lets PostgreSQL restore its library links on first use.

```sh
npm install -g --prefix "$HOME/.local" /path/to/backbone-cli-local-0.2.0.tgz
export PATH="$HOME/.local/bin:$PATH"
backbone --version
```

`--version` prints the product version the app shows and the source revision the archive was packed from, for example `0.2.0 (67401177f5de)`; it adds `uncommitted changes` when the checkout had any. Run from a source checkout it prints `source checkout` and the current revision instead.

Use a prefix already in your PATH or add the line to your shell configuration. The command and its dependencies go under the prefix's `lib/node_modules`; the `backbone` link goes under its `bin`. The tarball includes the workspace runtime and SQL; npm installs the pinned external packages, including the PostgreSQL binary for the machine. It carries the Pi, Codex and ACP engines; Codex and ACP each need their own programs installed and signed in as applicable. It does not include a model or a model credential. See [use the CLI](use-the-cli.md) for the data folder and commands. `backbone doctor` checks the machine and an existing data folder. On a fresh data folder it reports that there is no data folder and exits 1; it never creates one merely to diagnose it.

Create a protected standalone data folder with `backbone projects create "My project"`, using `--home` or `BACKBONE_HOME` for the intended folder. With BACKBONE_KEYS unset, the CLI uses macOS Keychain or Linux Secret Service with /usr/bin/secret-tool where usable; BACKBONE_KEYS=system requires it explicitly. An unavailable store refuses without falling back. Existing plaintext data folders stay plaintext; no command converts an existing data folder. The store protects keys at rest in a copied or backed-up data folder, but same-user code can ask the store too.

For an app-kept data folder, create the project in the app, keep the app running and point the CLI at that data folder. Electron safeStorage and the standalone provider use different wrappers; each opens only its own data folders. Unlock the intended store in the operating system before use; do not use commands to test a locked keychain.

The candidate's write admission remains in force: Linux writing is experimental and requires BACKBONE_EXPERIMENTAL_LINUX_HOME_LOCK=1 on supported local storage; network, overlay and unrecognized storage refuse. See [the lock guidance](run-the-checks.md). Windows writable data folders are not supported.
For a server or container, with `BACKBONE_HOME` set to the intended data folder, run `BACKBONE_KEYS=plaintext backbone projects create "My project"`. The keys are stored in plain text; protect the folder as you would the keys. If you named the data folder with `--home` instead of `BACKBONE_HOME`, pass the same `--home` to this command.

To upgrade, obtain a newer tarball and repeat the npm install command with its path. Existing data folders and their piece registrations remain separate. The packaged modules have different digests from checkout modules. When opening a checkout-created data folder, the CLI can refuse with `not a registered piece` or `has no grant`; it does not offer a permission prompt. Keep using the checkout for that data folder, or create a separate new data folder with the installed CLI. The platform provides registration and permission APIs for an operator who has reviewed the new piece, but this CLI has no command for that yet. A data folder created by this installed package can be reopened by the same package without a new permission. To remove the command, run `npm uninstall -g --prefix "$HOME/.local" backbone-cli-local`. This removes the package, not your data folder. Back up or remove that separately when you intend to.

## Linux

Install Node.js 22.18 or later and npm, then use the prefix commands above. A fresh data folder on Linux requires the experimental OFD data folder lock opt-in: set `BACKBONE_EXPERIMENTAL_LINUX_HOME_LOCK=1` for each command that opens it. Keep the data folder on a local filesystem; network, overlay and unknown filesystems are refused. For example:

```sh
export BACKBONE_HOME="$HOME/.local/share/backbone"
export BACKBONE_EXPERIMENTAL_LINUX_HOME_LOCK=1
backbone doctor
BACKBONE_KEYS=plaintext backbone projects create "My project"
BACKBONE_KEYS=plaintext backbone projects list
BACKBONE_KEYS=plaintext backbone doctor --json
```

The first doctor reports the absent data folder and exits 1. Plaintext keys require protecting the data folder directory. For a persistent user daemon, see [run the daemon with systemd](run-the-daemon.md#linux). The Linux package container smoke test passed at 15809747 in [hosted run 42810539435](https://github.com/The-Backbone-Tech/backbone-next/actions/runs/42810539435); with Docker available, run `bash scripts/linux-install-smoke.sh` from a checkout with its dependencies installed. It packages committed HEAD, installs in a clean container, prints installed size and removes its temporary volume and files. It needs network access for the image and npm dependencies.

The native Codex route has separate [runtime requirements and qualification
limits](use-native-codex.md), including the Linux read-only private-write isolation
contract.
Its native confinement check must pass before a turn starts.

## Windows (experimental)

The npm package and diagnosis of a fresh data folder are prepared for a Windows CI runner but have not been verified on Windows. A working Windows data folder, daemon service and key storage are not established. The experimental CI job is non-blocking; inspect its individual result before drawing conclusions.

## Homebrew and observed results

A Homebrew formula is provided for local experiments. Build the tarball, update the formula’s SHA-256 if it changed, and set BACKBONE_CLI_TARBALL to its absolute path when installing the formula locally. The formula keeps a pinned checksum and declares Node as its dependency. Its test creates a disposable stub data folder, runs a headless job and checks doctor. It has not been submitted to a tap or registry. Its syntax has been checked, but its installation has not been tested.

On 10 November 2026 the npm install and the CLI's version, project creation and doctor were tested on macOS 26.6.2 (Apple Silicon), Node 22.23.3 and npm 10.9.9. Homebrew 7.0.10 was used only to establish that Homebrew was present; Ruby checked the formula's syntax. Nothing was published to any registry.

```bash test
test -f scripts/pack-cli.mjs
```
