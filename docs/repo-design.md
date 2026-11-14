# Manifests and loading

The [source map](map.md) owns the package layout. [Distribution settings](distributions.md)
owns build configuration. This page describes how code declares itself and is loaded.
Source read on 10 November 2026; declarations are not proof of enforcement.

## Manifests

Each package has a backbone.module.json. The [schema](../schemas/backbone.module.schema.json)
and [manifest check](../scripts/manifests.mjs) validate identity, kind, version,
licence, publisher, provided and consumed ports, dependencies, capabilities, data,
conformance paths and removal rules. The kind must match the package's layer.
The generated block in each package README follows that manifest; the
[README check](../scripts/module-readme.mjs) keeps it current.

Run `pnpm regen` to rebuild the package-derived version, licence, kind and dependency
names/versions, then the README blocks and content digests. Dependency order follows
package.json. Reviewed dependency-licence annotations are retained for matching names
and versions; new versions need a new review. Identity, ports, capabilities, data,
conformance and removal declarations remain authored metadata.

The content digest is computed by [one implementation](../packages/platform/src/pieces/digest.ts).
It covers tracked package content rather than a branch name. Regenerate after
changing package documentation too; otherwise the loader can refuse the package.
The manifest is not a permission from a verified publisher. Publisher verification
is still pending in the checked-in manifests.

## Registration and execution

The implementation is in [piece composition](../packages/platform/src/composition/pieces.ts)
and [core piece tests](../packages/core/test/pieces.test.ts).

- An owner/admin registers a piece's identity, digest and declared capabilities.
  The platform performs that registration in the person's session. A worker or
  system run cannot register itself.
- The loader checks identity, digest, registration and the import snapshot before
  importing a built-in piece. It refuses symbolic links and unchecked imports.
- A piece's run is bound to its registration. The gateway intersects the run's
  mandate with the declared operations and effect classes. Direct work, including
  the stub and test adapters, is explicitly marked direct and answers to its mandate.
- Removal is refused while carried effects are unknown or unsettled. New code or
  a new digest needs a new registration and permission; old runs keep their old binding.

These are database and loader mechanisms. They do not contain hostile code running
inside the Host. [Trust limits](architecture.md#pieces-in-the-hosts-process-the-trust-boundary)
explain that distinction. Network and secret declarations are not a general OS
egress policy. A declared dependency's manifest does not automatically give that
dependency its own gateway identity.

## Ownership of documentation

[README.md](../README.md) is the only start page; [map.md](map.md) is the only source
map. A package README owns its local recipe, tests and removal details. Contracts
own interfaces; how-to guides own executable procedures; ADRs own dated decisions.
[AGENTS.md](../AGENTS.md) holds contributor rules, rather than another product overview.

Backbone's configuration lives beside the packages. Optional legacy reference
markers still name acceptance jobs and historical evidence outside this checkout.
They are references, not build inputs; checks do not require those repositories.
The [goal](../GOAL.md), [specifications](specs/README.md), [acceptance jobs](../acceptance/README.md) share this repository. The integrator maintains the [plan and execution records](execution.md) in this checkout after the coordinated record hand-over. There are no installable team or company
presets implied by this document.
