# Core schema sources

`baseline.json` is a frozen historical executable bootstrap. Its explicit ordered files,
roles, raw hashes and assembled checksums reproduce the qualified post-A1c artifact.
Those files remain at their historical paths so the four released installers can extract
their original payloads. They are not always the current definition of an object.

`versions.json` lists the released linear upgrade chain. Each directory under `versions/`
has a closed manifest naming exact prerequisites, source hashes, owning roles, added or
replaced objects and its payload checksum. An object has one whole definition per version.
An appended version does not change the bootstrap or a prior version.

`current.json` is the generated map from exact function signatures and object-family
identities to their active source. Start there when changing a current definition; check
its bootstrap entry when investigating a historical installer. The canonical SQL stays
here. The generated TypeScript release-data module contains exact runtime bytes for
packaged consumers, which must not load a developer schema directory to apply the step.

From the repository root, `node packages/core/scripts/closed-version.mjs` checks the full
inventory, source hashes, chain, current map and packaged release-data reproduction.
`node packages/core/scripts/closed-version.mjs --write` regenerates the current map and each
explicitly mapped version's own runtime-data file from valid closed manifests and the
compiled upgrade registry. A new version requires a separately owned runtime-artifact mapping;
an unmapped version fails before any write and cannot overwrite an earlier version's data. It does not
rewrite pins, change SQL or make an unknown database eligible for an upgrade.

[ADR 0003](../../../docs/adr/0003-source-evolution.md) explains build immutability, historical
receipt admission and the required native controls. A source check is not an installed
catalogue proof. The material closure version does not activate material use.

The foundation version remains immutable. The appended hardening version replaces only
candidate input capture and its manifest encoder to preserve released citation shapes.
It adds no boundary, backfill or material activation. Its complete profile retains the
foundation catalogue and permits only two independently qualified function-body replacements.
