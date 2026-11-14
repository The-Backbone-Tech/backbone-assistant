# How to run the checks

**For:** anyone changing this repository, person or agent. **Time:** about a minute for static rules; full suites take longer.

**Before you start:** Node 22.18 or newer and pnpm 10, with the repository installed (see [install and open the app](install-and-open-the-app.md), steps 1 and 2).

## Steps

Blocks marked `bash test` run in CI through `pnpm guides`, which `pnpm check` calls. Other blocks are shown, not run.

1. For documentation, configuration and check-script work, run the static rules (including journey proof references, isolated test state and regeneration) and their self-tests. This does not run package suites.

   ```bash test
   BACKBONE_GUIDE_STEP=1 node scripts/check.mjs
   node --test --test-concurrency=1 scripts/*.test.mjs
   ```

   Script files run one at a time to limit competing builds and native-process fixtures. The flag skips guide execution in the nested checker, so a guide cannot run itself again. You see `ok` beside each rule and the script tests passing. The CLI installation test is opt-in, as described below.

   The vocabulary rule measures added or changed prose lines against the merge-base with `origin/claude/integration` by default, including committed, staged and unstaged edits; untracked files count as new. Untouched prose, code and history remain exempt. It reads eligible file diffs separately without a fixed small output buffer, so a large stack or replacement patch cannot exhaust the child-process stdout limit. CI uses the GitHub push or pull-request range; BACKBONE_VOCABULARY_BASE can select an explicit comparison base.

2. Full development verification also runs the core, MCP and Hermes tests, plus all guide steps. Run it when the change calls for those suites:

   ```bash
   pnpm check
   ```

   A failure names the file and cause. A contamination failure means a package or default build selected a particular distribution, or a shipped string bypassed the brand profile. Fix the dependency or consumer; do not hide the failure.

3. Run only the guide steps, after you change a guide:

   ```bash
   pnpm guides
   ```

## Before hand-over

Run `pnpm regen` after source changes. It regenerates the Core current-definition index and packaged release data, source-derived manifest fields (version, licence, kind and dependency names/versions), module README blocks, final manifest digests, then the Docker context allowlist. New package files must first be added to Git's index because the Docker allowlist names tracked files. The command does not stage or commit anything. Native catalogue pins and captured qualification fixtures are reviewed evidence, not build outputs; their owning qualification procedures still apply.

The same generator registry checks for differences without writing to the working tree:

```bash test
pnpm regen --check
```

The journey plan is [journeys.json](../journeys.json). [Scope and proof](../journeys.md) explains the required kinds, activated configurations and source coverage counts. The inspector exposes counts per family and kind separately from matching gate results; unproved scope is not a release failure. Run `node scripts/journeys.mjs` to read the current head's default gate directory, or pass an evidence directory as its only argument. `BACKBONE_JOURNEY_EVIDENCE` also selects a directory. Each proof names a source file, test title and gate suite. Green requires a clean matching commit, a completed passing suite and the individual passing test in its log. A skipped, missing or failed result proves nothing. Green means that seeded journey passed at that revision, not that the entire scorecard family is complete or qualified in real use. Journeys marked `requiresInstalled` remain **installed evidence pending** until the matching gate records their individual Electron pass in the installed suite with a verified DMG hash. Browser and development passes cannot satisfy them; journeys outside the installed runner's supported fixtures stay pending. Other missing evidence leaves journeys unverified; only a vanished named proof fails the journey check.

The test-state rule inspects test syntax for fixed temporary paths, shared temporary-directory sweeps and hand-made lock files. Use a fresh temporary directory for each test and acquire locks through the product. [The exception list](../../scripts/test-state-exceptions.json) is a burn-down list of known offenders, with a package owner, exact file, expression, occurrence count and reason for each entry. Owners remove or reduce entries when they repair tests. New offenders and stale entries fail; this is not a permanent allowance or a file-wide exemption.

Refresh the integration ref, then run `node scripts/queue-check.mjs <branch>...` with the queued branches. It compares committed snapshots with the local `origin/claude/integration` ref, reports `run: <changed packages>` separately from `gate covers: <dependents>`, plus pairwise merge conflicts, stale generation and hotspot files. It prints author suite commands only for changed packages; the stack gate covers all transitive workspace dependents. `pnpm check` is requested only for scripts, documentation or generator-code changes. Lockfile and workspace configuration changes put all other packages in gate coverage; they do not add author suite commands. A stale base, conflict or regeneration difference fails it. It runs no suites, changes no author worktree and performs no fetch itself. Uncommitted edits are outside a branch snapshot.

Before running an affected package, use `node scripts/test-results.mjs <package-name>`. Exit zero identifies an identical input already passed by a gate, with its source gate directory and key; reuse that evidence instead of running the package again. Exit one means no matching gate pass. An optional command after the package name selects the exact suite invocation. This command never runs tests or writes results. `BACKBONE_TEST_RESULTS` selects the shared index; by default it is `.gate-results` beside the machine's shared heavy lock. A missing, changed or unavailable source record/log is a cache miss.

The gate alone publishes results. Its key covers Git package trees and the full workspace dependency closure (including development, optional and peer dependencies), the lockfile, Node and pnpm versions, exact command, operating system/architecture, shared runners/configuration and a hash of relevant test environment flags. Closures containing Platform also include the whole packages tree and contracts because its source audits, contract checks and dynamic module tests read outside its declared dependencies. Core closures include the legacy fixture read from Platform; Git attributes also participate in source qualification. Dirty gates do not publish. Package passes from a finalized gate may be used even if another suite failed. Reused package logs are copied into the new gate directory, with `reuse: "reused from <gate run>"` and `reusedFrom` in its record. Reuse never promotes an author's run to acceptance. Authors may also look up `node scripts/test-results.mjs --suite check` (or `oracle`, `app-e2e`, or a named native suite followed by its exact command); those use a conservative whole-tree key. The gate itself always executes check, oracle, e2e and native acceptance. The `app-installed` suite is never reusable, including by authors, and never enters the result store.

## Shared Mac heavy slots

Use `scripts/with-heavy-lock "<what>" <command...>` for unit runs. It uses slot B, the machine's .heavy.lock.b directory, with an owner file inside. One unit runs at a time; B ignores .heavy.next and can overlap slot A. Admission requires fewer than 24 System V shared-memory segments in use, measured by `ipcs -m`; missing inspection refuses admission. Like the reference wrapper it polls capacity every ten seconds and waits up to 90 minutes. Set `BACKBONE_HEAVY_WAIT_MINUTES=40` for a 40-minute author qualification limit.

Slot A is .heavy.lock, with its owner file and the integrator's .heavy.next marker. Only the integrator uses A, for gates, native checks, Docker and installation. Use `BACKBONE_HEAVY_ROLE=gate scripts/with-heavy-lock "<what>" pnpm gate` for a measured gate. It takes A, preserves an existing priority marker and removes only a marker it created. The gate borrows the verified wrapper lease; a direct `pnpm gate` still takes A itself. The reference mkdir wrappers exclude the corresponding slot, with no nested A/B directories or trial.json switch.

Every admitted B run appends start and end records to $HOME/backbone/evidence/slot-b-runs.jsonl: event, token, what, cwd, at, wallSeconds, one-minute load, total segments and exit (null at start). These records establish overlap with a gate. Per-run inspection details also remain under .heavy-runs beside the locks. `BACKBONE_HEAVY_LOCK` selects the A base path (B appends .b); `BACKBONE_HEAVY_RECORDS` and `BACKBONE_HEAVY_JOURNAL` select isolated evidence locations. On macOS, after admission and at teardown, the wrapper retains the dead-owner shared-memory sweep; it never sweeps to get below the admission threshold. Unknown ownership or attachments stay.

The integrator started this trial on 10 November 2026 at 22:24Z. On the **first gate failure that is both load-attributed and overlapped by B**, the integrator runs `BACKBONE_HEAVY_ROLE=gate node scripts/heavy-slots.mjs --trial-off`. This refuses new managed B runs immediately, lets the holder drain, then reserves .heavy.lock.b with a disabled owner so reference wrappers also cannot enter. The command waits for that reservation; it never evicts a live owner. The sibling .heavy.lock.b.disabled marker keeps disable intent across teardown. `--trial-on` removes only the disabled reservation and marker, reopening B without touching an active holder. Neither command uses the old trial.json switch. There is no automatic restart. Role selection is an integrator convention on this shared account. A dead wrapper alone does not prove its descendants ended; inspect them before releasing its recorded token.

Each package test script already uses one shared cluster through `scripts/with-test-cluster.mjs` or the Core's global setup. The heavy wrapper preserves that environment and adds no cluster. Use the same cluster helper for focused database tests and run suites sequentially within a slot; do not start parallel package suites inside a wrapper.

## CLI package installation test

The CLI installation test is opt-in because it packs the workspace and installs npm dependencies into a temporary prefix. It tries offline first and reports whether it needed the network. The normal checks report it as skipped. Run it when changing CLI packaging:

```bash
pnpm test:install
```

## Tests share one PostgreSQL

A suite that starts a PostgreSQL server per test file runs out of System V shared memory: each server takes one segment and macOS allows 32 per machine, so `initdb failed … could not create shared memory segment` (and `No space left on device`) appears when runs overlap or killed servers leaked their segments. So a run starts one cluster per package: vitest's `globalSetup` in the core (`packages/core/src/db/global-setup.ts`), `scripts/with-test-cluster.mjs` around the platform, MCP and app suites. Each test file, and each data folder a test makes (`freshDataHome` from `@backbone-next/platform/testing/data-home`), takes its own database cloned from the cluster's template with `CREATE DATABASE … STRATEGY = FILE_COPY`; a data folder's `pg/external.json` points the host, the app or the MCP door at it, so none starts a server.

- The cluster stops with SIGINT when the run ends, fails or gets Ctrl-C. A guard process stops it and removes its folder if the run is killed outright.
- Two journeys still boot personal mode from nothing, because that path is the product's: `packages/platform/test/personal-mode.test.ts` and the Electron journey.
- Clone strategy, measured here (APFS, PostgreSQL 18.4, the 10.9 MB template, 40 to 60 databases per row): the default `WAL_LOG` takes 130 to 160 ms per database alone and 390 to 500 ms with six at once (60 in 4 to 5 s); `FILE_COPY` 64 to 72 ms alone and 171 to 178 ms with six (60 in 2 s); `FILE_COPY` with `file_copy_method = clone` 61 to 73 ms and 162 to 165 ms (60 in 1.7 s). Three runs each. The clone is within noise of the plain copy at this size, so it is used where the filesystem can clone, and `FILE_COPY` does the work either way. The server's log pipe must always be drained: `FILE_COPY` makes two checkpoints per database, and a server whose pipe is full stops in the middle of one.
- Segments leaked by servers killed before this existed stay until reboot. `node scripts/pg-shm-sweep.mjs` lists those that are yours, whose creator is gone and that nothing is attached to; it removes nothing unless run with `--apply`.

```bash
node scripts/pg-shm-sweep.mjs
```

## What you now have

A record of which checks ran. Static checks alone do not establish package or installed-app acceptance. The normal commit requirement is a green `pnpm check`; a task with an explicit narrower verification scope must report that limit. CI runs the same command first, then the slower platform, app and journey suites in `.github/workflows/check.yml`.

## What next

- The rules behind each check: [AGENTS.md](../../AGENTS.md).
- The slower suites for the piece you changed, for example `pnpm --dir packages/platform test` or `pnpm --dir packages/surfaces/app e2e`.

## Qualification gate

Run the full ordered qualification gate with `pnpm gate`. It takes the shared heavy lock, refuses a dirty worktree unless `--allow-dirty` is given, and writes suite logs, `gate-summary.txt` and `gate.json` under `.gate/<short commit>/`. Use `--out <dir>` to choose another directory, `--list` to see every suite and packages with no test script, `--only mcp` (or comma-separated names) to select suites, and `--wait <minutes>` to wait for the lock. Package test suites are discovered from the workspace, with platform first and the rest sorted by package name. Deliberate exclusions are listed with a reason in the gate runner. Suites continue after failures; `--keep-going` also explicitly selects this default. The oracle's exit code remains visible: zero failures with its two unimplemented families is the expected current state.


After `app-e2e`, `app-installed` runs `pnpm --filter @backbone-next/app e2e:installed`. This rebuilds and packages from the gate checkout before installing into a fixture-owned temporary folder. The gate clears previous compilation and packaging receipts first, verifies matching fresh receipts against its exact clean commit and current source identity, then hashes the DMG bytes. Its suite entry in `gate.json` records `packagedApp` with `commit`, `buildId`, `dmg` and `sha256`. Missing, stale or mismatched packaging evidence fails the suite even if its command exited zero. The suite timeout starts before the command, so it covers compilation, packaging, installation and testing. macOS packaging, a desktop session and the existing unsigned-app Keychain behavior remain prerequisites; an unsupported machine fails rather than reusing a build.

The gate writes evidence as it runs: suite output is streamed to its log, and
gate.json plus gate-summary.txt are atomically replaced when each suite starts
and finishes. A running record or an interrupted partial record is not success.
Each suite has a default 45-minute hang limit; --suite-timeout <minutes> changes
that bound. Timeout terminates the suite process group, then escalates if needed,
and is recorded as failure even for the oracle. Reuse requires the identical-input
gate evidence described above. Fixture readiness and
hang diagnostics are owned by scripts/lib/test-child.ts and scripts/lib/test-hang.ts.
No hosted workflow is required by these local commands.
