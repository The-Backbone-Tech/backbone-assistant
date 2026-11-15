# Backbone

Backbone's goal is a complete, open-source and composable working environment for people and capable AI. Use one useful part, combine selected parts with existing tools, or run the whole product. It brings strong current capabilities together for personal, team and company work, preserving editable material, knowledge and useful methods as engines and tools change. The implementation is pre-release.

**Status:** 0.2.0 source pre-release 3, equivalent to the qualified development pre-release 8. The desktop app, CLI and MCP surface are implemented. This cut includes Team roles and shared projects, native document previews, CSV cell editing, project rename and archive, backup restoration, a browser pane and a terminal that streams and can be stopped. The complete platform remains a goal; qualification varies by capability and consumer. See the [roadmap](docs/execution.md) for the exact evidence and remaining work.

**Mac download:** the [current public Apple-silicon download](https://github.com/The-Backbone-Tech/backbone-assistant/releases/tag/v0.2.0-macos-arm64.1) is unsigned and corresponds to the earlier source pre-release 1. It does not include the additions in this source cut. A binary rebuilt and checked from this cut will receive a separate release and provenance record; building source and publishing a binary are distinct steps. Other architectures and platforms have no qualified public binary here.

[GOAL](GOAL.md) owns the outcome and completion bar. [Backbone explained](docs/backbone-explained.md) introduces the idea, [shape](docs/shape.md) describes the design, and [method](docs/method.md) explains how choices are made.

## What works today

Conversations, versioned documents, CSV tables, project actions, engine and model selection, connectors, signed tools, memory, skills, schedules, export and managed policy have implementation and focused test coverage. Team sharing includes invitations, people, roles, shared projects and a separately chosen engine for colleagues. The app also provides previews for PDF, images, Word, Excel and PowerPoint; previews do not imply native editing of every format. Read the [source map](docs/map.md), [scorecard](docs/scorecard.md) and each [guide](docs/how-to/) for evidence and limits. Local tests with fake providers do not qualify every real account or company deployment.

Start with personal work on macOS arm64 and a local APFS data folder. Linux writes are experimental and require explicit opt-in; Windows writable data folders are unsupported. Team has controlled two-process and two-app evidence on one Mac; use by two people on two physical computers is still open. Company identity and fleet need their own qualification. A person can edit CSV working files; an original they attached remains read-only in this cut. CSV preview and Table view can disagree on a semicolon separator, a known issue awaiting a later qualified release. Backbone can also recommend retaining an existing arrangement when it already meets the need.

## Try the CLI and build the app

Use Node 22.18 or newer, pnpm 10 (the exact package manager is in [package.json](package.json)), and git. From the root of a fresh checkout:

```bash
node --version
pnpm --version
pnpm install --frozen-lockfile --prefer-offline
```

This first job writes a brief through the same platform and database as the app. The stub supplies a fixed answer, so it demonstrates the work path without a model or a key. These commands run in one shell and use a disposable data folder. With the stub selected, doctor skips Codex and Claude client probes. Plaintext keys are deliberate here; use a system key store for real work ([CLI guide](docs/how-to/use-the-cli.md#protected-headless-homes)).

```bash
export BACKBONE_HOME="$(mktemp -d)/home" BACKBONE_KEYS=plaintext BACKBONE_HARNESS=stub
trap 'rm -rf "$(dirname "$BACKBONE_HOME")"' EXIT
backbone() { node packages/surfaces/cli/src/main.ts "$@"; }
printf 'region,revenue\nNorth,42\nSouth,7\n' > "$(dirname "$BACKBONE_HOME")/sales.csv"
backbone projects create "Sales review"
backbone engine stub
backbone engine
backbone files attach "$(dirname "$BACKBONE_HOME")/sales.csv"
backbone send "Write a summary document from sales.csv" --attach "$(dirname "$BACKBONE_HOME")/sales.csv"
backbone files
backbone files read brief.md --version 1
backbone files save brief.md --base-version 1
backbone files
backbone models
backbone now
backbone doctor
```

Doctor probes only the selected engine's machine client. For Codex, `login status` reads this machine's own client sign-in, not a sign-in held in the data folder. Claude's existing probe checks only its version and does not establish sign-in. Doctor adds no direct key-store probe; a selected client controls how it reads its own sign-in. Engine, models and doctor now report the selected engine without calling a model.

Expect a `DONE write-working-copy brief.md` receipt, an attached original and a listed document. Read inspects v1; Save accepts that base version as a new version by the person. The stub supplies fixed text rather than calculating the CSV. That is an observed stub result, not an assessment of AI quality. The [CLI guide](docs/how-to/use-the-cli.md) gives the real-engine sequence: `backbone engine codex`, `backbone model codex --model gpt-6.1-sol`, then a send with explicit Full permission. It also covers a local Pi route, editing with `files save --from`, work-record credential redaction and exit codes. Real engines need the client or model route described there; inspect their answers. The [CLI installation guide](docs/how-to/install-the-cli.md) covers the local package and Linux service.

## Build the Backbone app

In another shell at the checkout root (so the disposable CLI settings above do not carry over):

```bash
BACKBONE_DISTRIBUTION=distributions/backbone/distribution.json pnpm --dir packages/surfaces/app build
grep -q '<title>Backbone</title>' packages/surfaces/app/dist/renderer/index.html
node --test scripts/product-entry.test.mjs
```

The test validates the distribution against the repository schema and checks actual builds named **Assistant** (no input) and **Backbone** (explicit input). A plain build keeps its existing Assistant default. [The configuration](distributions/backbone/README.md) records its origin. [Distribution settings](docs/distributions.md) explain what the build reads; listing defaults is not proof that the running host consumes them.

To open the desktop app on a Mac, follow [install and open the app](docs/how-to/install-and-open-the-app.md), steps 4–5. Those steps need a screen and an Electron download; they are separate from the headless first job above. Choose AI and models in Settings before a real turn. A model route can incur provider charges.

## Verify, recover and contribute

Run `pnpm regen` and `BACKBONE_GUIDE_STEP=1 node scripts/check.mjs` for generated artifacts and static rules. `pnpm check` adds repository and package tests. [Run the checks](docs/how-to/run-the-checks.md) explains the complete gate.

An unknown outside outcome must be reconciled before another attempt. Preserve the data-folder lock and use the [recovery guide](docs/how-to/install-and-open-the-app.md#storage-and-upgrades). Export before removing an installation while its key holder can still open the data folder; see [backup and restore](packages/surfaces/cli/README.md#backup-export-and-restore).

Follow [CONTRIBUTING](CONTRIBUTING.md) and [AGENTS](AGENTS.md) to change the product. Code is [Apache-2.0](LICENSE); preserve [NOTICE](NOTICE) and upstream attribution. Written guidance is CC BY 4.0. The [trademark draft](TRADEMARKS.md) is not an adopted policy.

## Words used here

One word per idea, so people and agents search and read the same thing ([why](docs/reports/naming-and-repos-2026-11.md#4-one-vocabulary-for-agents-and-people)). Use the word in the first column; the retired synonyms stay only in code names and history.

| Say | Meaning | Retired in prose (still in some code) |
| --- | --- | --- |
| **Backbone** | The open, composable working environment for people and AI; its current app is an assistant, while the complete platform remains the goal | operating system, OS |
| **permission** | What the person allows once (a tool or a kind of work, within a scope, budget and expiry). Work inside it runs without asking; widening it needs a new permission | signed capability, standing signature, grant, release (code: `signature`) |
| **held action** | An outside action the person has not permitted, waiting for them | held write |
| **unknown outcome** | An outside result nobody can confirm; never treated as success, never resent | UNKNOWN (code keeps the constant) |
| **receipt** | The record of each outside action or accepted result: done, failed, refused or unknown | |
| **engine** | The agent runtime that does a turn of work: Codex, Claude Code, Pi, an ACP agent | harness (code: `harness-*` packages) |
| **data folder** | The folder holding one person's or team's Backbone data. Not the operating system's home folder | home |
| **Core** | The record the app uses (`packages/core`). The stricter **lab candidate v0.8** is a separate experiment with no product consumer | kernel, for the product |
| **journey** | Something a person completes with Backbone, proved by a named test | job (except the acceptance jobs below), package |
| **unit** | One piece of development work, by one author, ending in a branch | work package |
| **gate** / **integrator** | The whole test run on the integrated head, on one machine; the one session that merges and runs it | |
| **Arena** | The dated evidence behind Backbone's choices | |
| **J-triage, J-solution, J-co** | Acceptance jobs: mail triage (one configuration), choosing the route per task, the company map | |
| **Pi** | An engine that runs model/tool turns through the engine interface | |
| **ACP** | Agent Client Protocol, used to connect an installed external agent | |
| **Hermes** | An optional external engine; its adapter is experimental | |
| **MCP door** | The local Model Context Protocol adapter other clients use to reach Backbone | |
| **effect gateway** | The checked path for requesting an outside action and recording its outcome | |
| **key holder** | The process or operating-system store that can open a data folder's protected keys | |
| **legacy lock transition** | Replacing an earlier lock format after all old clients stop | |
| **Assistant** | The neutral app name when no distribution is supplied | |
| **successor adapter** | The test bridge from oracle promises to the current Core | |

**Repositories.** This checkout is the product. The owner-document and Way repositories retain deferred records and material explicitly marked external. Arena is `backbone-arena`; the lab is `work-planes-lab`. Historical repository names identify provenance, not additional build prerequisites.

Code and configuration: Apache-2.0. Written guidance: CC BY 4.0. The name and logo: [TRADEMARKS.md](TRADEMARKS.md) (proposed). [LICENSE](LICENSE), [NOTICE](NOTICE) and [CONTRIBUTING.md](CONTRIBUTING.md) own the local legal and contribution details.
