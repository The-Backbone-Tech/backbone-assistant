# Roadmap and status

Source pre-release 0.2.0, reviewed 14 November 2026. This repository contains a clean source snapshot with fresh Git history. It does not host a previously built private binary. [README](../README.md) and the [source release record](source-release.md) explain installation and evidence.

## Personal and Team

Personal includes the desktop conversation, CLI and MCP surface, editable versioned files, engine/model choice, connectors, memory and skills, scheduled/background work, audit and data export. Team adds people and roles, shared projects, joining from another client, viewer restrictions and removal. The source includes both terminal and app joining paths.

The upstream candidate passed its composed gate and was installed on one macOS arm64/APFS machine. An agent used the installed product for real jobs through an existing signed-in client. An installed test used two app instances on that machine to exercise join, read/send, session restoration, viewer access and removal. This is not a recorded successful journey between two physical computers or human acceptance. [Sharing a project](how-to/share-with-a-team.md) states the network and operator setup.

The public export has its own privacy, source and structural checks, recorded separately from upstream installed evidence. Tests using scripted engines, fake providers and local pages retain those limits. [Contracts](contracts/), [guides](how-to/), [map](map.md) and [coverage](scorecard.md) locate each consumer.

## Open work

- Record human use and feedback on everyday Personal and Team work.
- Exercise Team joining, recovery and access control on two physical computers and the actual network configuration.
- Complete the Company configuration, including identity-provider operation, directory lifecycle, policy, audit and fleet qualification.
- Sign and notarise macOS builds; independently build and inspect public binary artifacts before publishing them.
- Continue platform-specific real-engine, account, upgrade and recovery qualification.
- Compare complete jobs when a claim of being better depends on the result.

macOS arm64/APFS is the qualified writable profile. Linux writes require explicit experimental opt-in; Windows writable data folders remain unsupported. GNU native-library source provenance, rebuild recipe, notices and public-payload checks are implemented under [ADR 0005](adr/0005-lgpl-native-libraries.md); each future shipped binary must pass those checks on its own bytes.

## Contribute

Choose a useful user journey, inspect its actual contract and consumer, preserve unrelated work, run focused tests/typechecks and regeneration, then the relevant integration checks. [CONTRIBUTING](../CONTRIBUTING.md) and the [development guide](development-map.md) own the workflow. Test counts support their declared scope; they do not establish complete Company or human acceptance.
