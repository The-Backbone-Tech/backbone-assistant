# Modules (L2)

Optional and replaceable. Each module is a package with a `backbone.module.json` manifest, valid against [`schemas/backbone.module.schema.json`](../../schemas/backbone.module.schema.json): id and publisher, version and licence, ports provided and consumed with ranges, stability, capabilities, owned data and export, explicit dependencies, conformance and quality level, removal rule and the digest of its whole content. `pnpm check` validates each manifest and recomputes its digest (`node scripts/module-readme.mjs --write`, then `node scripts/manifests.mjs --write`, after a reviewed change). Modules implement platform ports and never import services or each other.

- `harness-pi/`: the AI engine behind the engine port ([README](harness-pi/README.md)).
- `harness-hermes/`: Hermes hosted behind the same port, opt-in and in no default ([README](harness-hermes/README.md)).
- `connector-mail/`: the mail connector port's adapters, the sample mailbox first ([README](connector-mail/README.md)).
- Planned: model routes, sandbox, browser, connectors, channels, office documents, host agent (`docs/map.md`).
