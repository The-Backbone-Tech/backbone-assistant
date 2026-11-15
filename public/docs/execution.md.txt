# Roadmap and status

15 November 2026. Source pre-release 3, version 0.2.0, equivalent to qualified development pre-release 8. This page separates implemented capabilities, observed use and the complete [goal](../GOAL.md). Build instructions are in [README](../README.md).

## Available in this source cut

The desktop app, CLI and MCP surface share versioned working material and the platform's applicable contracts. Implemented capabilities include conversations; editable documents and CSV working tables; document previews; projects that can be renamed, archived and restored; engine and model selection; native Codex connectors and skills; memory; schedules; audit and export; backup restoration; browser and streaming terminal panes; and managed policy. Preview support for Word, Excel and PowerPoint is not general native editing of those formats.

Team adds people, roles, shared projects, invitations and joining through the app or CLI. Colleagues use a shareable engine chosen by the owner; they do not inherit the owner's native client sign-in and independent tools. The owner can keep their own engine. Company identity, fleet and shared-database examples remain separate qualification work.

PostgreSQL is the current relational and durable operating substrate. The open/composable working environment in the goal is broader than the present assistant app. Source packages and optional configurations are not, by themselves, proof that every part has a complete independent adoption path or that learning improves subsequent work.

## Evidence and distribution

The private development cut equivalent to this source passed its composed gate on one Mac and was installed and exercised by an agent acting as a user. Observed work includes mail and calendar through the signed-in Codex client, project actions, a saved CSV edit followed by an assistant answer from that edit, and terminal work. This is agent use, not a person's acceptance. Scripted and fake-provider tests establish their bounded cases, not every account or engine route.

The public source has separate checks for the cleaned export and its documented substitutions. [Source pre-release 3](https://github.com/The-Backbone-Tech/backbone-assistant/releases/tag/v0.2.0-source.3) identifies immutable source `46876913`. The [public Mac disk image](https://github.com/The-Backbone-Tech/backbone-assistant/releases/tag/v0.2.0-macos-arm64.2) is rebuilt from that source and its exact retained bytes passed all 51 default installed-app checks on a fresh Mac runner, native-library smoke and independent inventory/privacy review. The original packaging job timed out before Chromium readiness; its cancelled result is preserved alongside the separate successful qualification. Release assets include source/build/test provenance, complete runtime notices, checksums and the exact GNU sources with upstream verification files. Earlier releases remain available. Later development builds contain changes outside this public cut.

The public Mac build is unsigned and unnotarised. macOS arm64 with a local APFS data folder is the qualified writable profile. Linux writes require explicit experimental opt-in; Windows writable data folders are unsupported. Native LGPL packaging uses unmodified, dynamically linked libraries rebuilt from pinned GNU sources, with sources and notices supplied as described in [ADR 0005](adr/0005-lgpl-native-libraries.md).

## Known limits and open work

- Use by two real people on two physical computers remains unqualified; complete Company identity, fleet and data-in-place operation remain open.
- A person can edit a CSV working file, but an original they attached remains read-only in this cut. A semicolon CSV can be split differently by its preview and its Table view. Repairs in development are not part of this cut.
- Sending immediately after creating a project can send to another project while the list refreshes. Wait for the new project to appear selected before typing. A later development candidate repairs this; it is not included here. The source3 installed OS-boundary test now waits for project readiness, with every boundary assertion unchanged; this setup correction does not repair the product defect.
- CSV editing is bounded and is not a spreadsheet calculation engine. Other file previews do not establish full editing support.
- Everyday human feedback, cross-engine recovery, learning benefits and complete-job comparisons with existing tools still need evidence at their claimed scope.
- Signing, notarisation, other binary platforms and remaining [reference journeys](journeys.json) remain open. Binary assets must be validated individually.

Supported paths are described in the [guides](how-to/), [source map](map.md), [contracts](contracts/) and [scorecard](scorecard.md). An integrated gate, installed checks, comparative evidence, agent use and human acceptance answer different questions.

## How to contribute

Choose a useful user journey, read its contract and named tests, and describe the smallest complete change. Preserve existing work and outside outcomes, add a failing test for behaviour changes, then run focused tests, typechecks and regeneration. Follow [CONTRIBUTING](../CONTRIBUTING.md) and the [development guide](development-map.md).
