# Oracle

A black-box conformance suite. It states Backbone's promises through public crossings, roles and observable effects. Any implementation must pass it.

**Origin.** The suite was built and frozen against the old repository on branch `claude/p04-core-oracle-2d71c1` of `backbone-oss`, frozen at `1d3a809f` (23 Oct 2026: 404 passed, 6 expected legacy failures, 93 files). `RESULTS.md` is that frozen run, kept as it was. It covers the core promises (isolation, mandates, effects, ledger, promotion, rule of two) and the behaviour areas (attack scenes, CLI lifecycle, J-01).

**Imported here (S1-02, 24 Oct 2026).** Everything under `oracle/` except the legacy adapter, which binds the old repository's schema and stays on its branch. Three cases are amended as `AMENDMENTS.md` records; no other case is edited. A-3 (9 November 2026) strengthens the shared-task write expectation to match the qualified Core audience check. What changed to fit this repository:
- `core/reference.ts` points at the successor's own kernel twin (`packages/core/src/kernel`), and fast-check is a root devDependency.
- The two legacy inventories (`core/coverage.ts`, `behaviour/scenes/inventory.test.ts`) read the legacy case names and scenario ids from `core/legacy-cases.json` and `behaviour/scenes/legacy-scenarios.json`, read from the legacy syntax trees at the frozen head.
- `adapters/index.ts` and `vitest.config.ts` name `successor` as the target; `report.ts` writes `RESULTS.successor.md` for it.
- Three comments name the legacy home directory as `$HOME/.backbone`, and one lab pointer uses the `work-planes-lab:` marker.

**Expected failures.** The suite records known gaps in the old implementation as expected failures, run with `it.fails` only when the target is `legacy`: L7b, L9, FA3, J-01 A2, L17 and routine import. Against the successor they are ordinary cases that must pass.

**Run:** `pnpm oracle` (`node oracle/runner.mjs --adapter successor`) runs every promise the adapter lists in `adapters/successor/supports.json` and writes `results/successor.json`. A distribution's status page reads it (for Backbone's, `backbone-way:scripts/status.mjs`). A promise not listed is reported as not implemented. `--promise <name>` runs a subset into `results/partial.json`.

## What it holds

- **Core** (`core/`): the six core promises. The 213 legacy database cases are restated through crossings, views and roles; `core/<promise>/coverage.ts` says how each one arrived (ported, narrowed, adversary, gap, deferred).
- **Behaviour** (`behaviour/`): all 75 attack scenarios (`scenes/`), the CLI lifecycle on scratch Homes (`lifecycle/`) and J-01 through the HTTP API (`journey/`).
- **Lessons** (`lessons/`, plus each behaviour area's own): each lesson case passes on a correct stub and fails on an assertion with its flaw switched on, then runs against the target. `lessons/register.ts` says where each of the 22 lessons is enforced.

Cases reach a target only through its adapter (`core/imports.test.ts` checks this). Each case's binding use is recorded in `results/usage/`: crossing, governed write, view, operator or adversary.

## Plugging in a target

1. **Core port.** Implement `Target` (`target.ts`): `setWorkspace` and the sessions it returns (`asPrincipal`, `asRun`, `call(crossing, args)`, `observe(view, args)`, `hold`), `race`, `drainUsage`, and the `operator` and `adversary` ports. Bind the oracle's crossing, view and attack names, and map the target's refusals onto `REASONS`.
2. **Behaviour ports.** Implement `ScenePort` (`behaviour/scenes/port.ts`), `HomePort` (`behaviour/lifecycle/port.ts`) and `JourneyPort` (`behaviour/journey/port.ts`), and return them from `behaviour/harness.ts` `openBehaviourTarget()`.
3. **Setup.** Add the target's global setup to the `setups` map in `vitest.config.ts`.

The spec gaps in `RESULTS.md` (and each `coverage.ts`) name what the successor's contracts must provide for a case to become fully black-box; `docs/contracts/` records which are closed.
