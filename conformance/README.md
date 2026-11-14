# Conformance jobs

Neutral jobs that any distribution built on Backbone can run on its installed app. Each one states a mechanism Backbone promises, in Backbone's own terms: the invariants in [architecture.md](../docs/architecture.md#3-invariants) (I-n) and the piece contracts in [contracts/](../docs/contracts/). They carry no product requirements, brand or parity bar.

A distribution's own acceptance jobs build on these: each names the conformance job it extends (`"conformance": "[conformance/C-01](C-01)"`) and adds its product requirements, its parity bar and who approves. `scripts/conformance.mjs` checks the shape here.

| Job | What it proves |
| --- | --- |
| [C-01](C-01/job.md) | One thread: attach, an agent's draft, a person's edit, restart, follow-up on the edited version; a kill during Save leaves one version |
| [C-ma](C-ma/job.md) | Parallel work: a parent with children at depth 1 and a read-only reviewer; approvals bind content; no duplicate effects after a kill |
| [C-co](C-co/job.md) | A function run through connectors: map from existing tools, policy-run handling, one decision, continuation, a brief with undo, clean disconnect |
