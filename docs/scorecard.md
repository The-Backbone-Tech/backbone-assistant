# Capability coverage against the November references

This page explains how to read coverage and what evidence remains due. The [journey catalogue](journeys.json) owns the individual capabilities and their proving tests; [Execution](execution.md) owns qualified candidates and the queue; [GOAL](../GOAL.md#completion-bar-for-this-objective) owns acceptance. The [reference bar](references-2026-11.md) supplies the dated comparison scope. A smaller personal configuration does not remove team or company requirements from the complete platform.

## Read current coverage from the catalogue

Run from the product checkout:

```bash
node scripts/journeys.mjs
```

The command reads all 19 families and their journeys from the catalogue. It prints separate platform, configuration and optional coverage, rather than maintaining a second status table here. A source review on 13 November at `00721c3c` found 135 journeys; subsequent counts come from the command, not this dated observation.

- **Present** means an existing full-scope proving test is identified at the required evidence level. It is a source-coverage classification, not a fresh test pass.
- **Partial** means supporting tests, incomplete scope or a lower evidence level. A scripted model cannot prove live-model behaviour or a person's work.
- **Missing** means the catalogue has no qualifying proving or supporting test. This identifies a coverage gap; inspect the implementation before claiming the capability is absent.
- **Green** additionally needs matching execution evidence for the inspected commit. Pass the evidence directory as the command's optional argument. A record-only commit above a gated runtime is a different SHA; do not rewrite the gate record to make it match. Missing logs or a mismatched SHA establish no pass, and do not mean the product failed every journey.

An installed proof must identify the freshly packaged app and actual installed run. A live account, real engine, complete-job usefulness and owner acceptance each require their own observation. Counts and green states are not a completion percentage or a claim of matching or beating a reference.

## What the integrated evidence now covers

**Reviewed 13 November 2026:** the integrator qualifies runtime `cdaeeada` (12 November); `00721c3c` adds its record. The gate summary and native acceptance record were inspected at their original owner, not rerun for this page. Later failed candidate `5a85cd67` is not a promotion. [Execution](execution.md) records that distinction and the next diagnosis.

The following groups connect the catalogue's families to the existing owners; their entries are evidence leads, not complete family acceptance.

| Families | Integrated work to inspect | Evidence still needed |
| --- | --- | --- |
| 1 Parallel work; 2 threads; 3 goals | Task board, saved roles, restart/branch/search, bounded goals and native compaction integration | Complete delegated work and real-model goals; context-limit continuation per engine; rewind remains outside the qualified head |
| 4 CLI; 5 messaging | Headless structured execution, selection, installed CLI checks and additional channel adapters | Published distribution and real bots; per-sender identity for group work |
| 6 memory; 9 learning | Source withdrawal, injection scans, trust marks, proposed skills and correction paths | Complete user control and reversal journeys; held-out evidence that learned guidance improves later work |
| 7 skills/plugins/MCP; 10 engine choice | Pinned local tools, connector catalogue, solution tools, ACP adapters and local-model selection | Each actual engine/account combination; catalogue and route usefulness against eligible native alternatives |
| 8 proactivity | Scheduled/triggered work; installed preview, edit, pause and heartbeat/brief journeys | Personal work while the app is closed and actual findings from that use; scripted tests retain their limited scope |
| 11 permissions; 17 audit | Per-tool permissions, receipts, explicit unknown outcomes, audit export and read-only diagnostics | Consumer-specific adverse cases and complete audit coverage; lab v0.8 acceptance does not establish ordinary app enforcement |
| 12 files/UI; 13 connectors | Versioned editable work, browser connection and Gmail signed send | Calendar/Drive and complete real-account jobs; general desktop automation and editable office artifacts remain separate configurations |
| 14 deployment; 15 licence | Local install/restore, Linux packaging, Docker, bundled notices and licence checks | Signed/notarised Mac installation, safe upgrades and rollback; ADR 0005's native LGPL enforcement follow-up |
| 16 identity; 18 administration; 19 fleet | Workspace separation, managed policy and Helm/Compose manifests | Integrated second-person roles, identity-provider setup and full shared/fleet operation; manifests alone are not an operated deployment |

Use [the source map](map.md), each package contract and the catalogue's named tests for the actual consumer.

## Whole-job acceptance remains separate

The [acceptance jobs](../acceptance/README.md) cover J-01 (editable work), J-triage (mail), J-solution (route choice), J-co (company work) and J-ma (parallel work). Moving those contracts into this repository did not create passing results.

- **J-triage:** historical comparisons remain dated evidence. The current supported route needs the applicable frozen checks, actual-account use and owner acceptance as observed; no fixed number of days applies.
- **J-solution:** selection APIs and the repaired destination/version diagnostics have tests, but the comparative method remains a draft pending review and freeze. No blind whole-task winner is established.
- **J-co:** company requests, fixture and rubric still need qualification; the work is parked under the personal-first order. Source connectors or a schema do not establish a working company function.
- **J-01 and J-ma:** use their existing contracts and exact consumer evidence. A family-level source count cannot substitute for the complete editable-work or collaboration job.

No real use by a person is recorded in the inspected current owners. The 10 November agent-run terminal trial is controlled evidence with real engines on disposable data folders, not owner acceptance. Real use is recorded when it happens. Claimed advantages require the same complete job against an eligible alternative, including where Backbone loses, setup, correction, recovery and upkeep.
