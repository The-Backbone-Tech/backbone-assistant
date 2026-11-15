# Roadmap and status

Pre-release, version 0.2.0. This page describes supported work and remaining qualification; it does not promise a public binary download. Build instructions are in [README](../README.md).

## What works

The source includes a desktop conversation, CLI and MCP surface; editable documents and versions; engine and model selection; connector discovery and installation; signed connector tools; memory and skills; schedules; audit and data export; managed policy; and deployment manifests.

Supported paths and their limits are in the [guides](how-to/), [source map](map.md), [contracts](contracts/) and [journey scorecard](scorecard.md). Scripted engines, fake providers and local pages prove their bounded test cases. They do not qualify every real account, engine, installation or company deployment. An integrated gate, installed check and human acceptance are distinct evidence.

## Open work

- Qualify everyday personal work across conversations, mail, calendar, files, memory and background work with human feedback.
- Finish installation, updates, signing and notarisation, and validate each downloadable artifact.
- Exercise continuation and recovery through each supported real engine and connector.
- Compare complete jobs when a recommendation depends on being better than an existing arrangement.
- Deliver team and company identity, roles, collaboration and fleet as qualified configurations.
- Complete remaining [reference journeys](journeys.json) at their named evidence level.
- Resolve the distribution obligations in [ADR 0005](adr/0005-lgpl-native-libraries.md) before shipping the affected native payload.

macOS arm64 with a local APFS data folder is the qualified writable profile. Linux writes require explicit experimental opt-in; Windows writable data folders are unsupported. Shared database and fleet examples require operator qualification. See [installation and recovery](how-to/install-and-open-the-app.md).

## How to contribute

Choose a useful user journey, read its contract and named tests, and describe the smallest complete change. Preserve existing work and outside outcomes, add a failing test for behaviour changes, then run focused tests, typechecks and regeneration. Follow [CONTRIBUTING](../CONTRIBUTING.md) and the [development guide](development-map.md).

The [goal](../GOAL.md) sets completion by shipped, used and trustworthy results. Coverage and passing tests support that claim at their stated scope; they do not replace installed checks or human acceptance.
