# Development guide

Start with [README](../README.md), [AGENTS](../AGENTS.md), the [goal](../GOAL.md) and [roadmap](execution.md). Load the affected contract and source owner; links do not load their targets.

## Take a task and hand it off

Inspect the actual repository, branch, commit and dirty files before acting:

```bash
git status --short
git branch --show-current
git rev-parse HEAD
git diff --stat
```

Write a brief naming the user outcome, ground truth, affected contracts, files, consumers, non-goals and proving checks. Preserve unrelated work, use an isolated branch and coordinate one writer per shared file. Choose tools and effort for the task. Report an unavailable input precisely and continue independent work.

Search the whole repository before changing text, filenames or exported functions. Add a failing test for a behaviour change. Prefer maintained native capabilities and the smallest coherent implementation. Keep authority, source identity, human corrections and unknown outcomes intact.

## Verify

Use the exact pnpm version in package.json. Install dependencies with `pnpm install --frozen-lockfile --offline` when cached. See [run the checks](how-to/run-the-checks.md) for environment and shared-resource limits.

Run touched packages' typechecks and focused tests, `pnpm regen`, and `BACKBONE_GUIDE_STEP=1 node scripts/check.mjs`. Packaging, dependency or CLI-start changes also need `pnpm test:install`. The integration gate runs the complete affected flow. Use disposable data folders, scripted engines and fake providers; never real credentials or customer records in fixtures.

Changes to authority, secrets, migrations and outside effects need independent diff review of the affected contracts. Review findings by consequence. Preserve product checks; a test deletion needs the reviewed allowance required by `scripts/test-edit.mjs`.

## Report and integrate

State the exact branch, base and head; user outcome; changed files and consumers; tests and their evidence level; adopted components and licences; limits and unfinished work. Distinguish source inspection, tests, local runs, installed runs and real use. Follow [CONTRIBUTING](../CONTRIBUTING.md) for DCO and trailers.

One integrated candidate carries the composed checks and acceptance record. A passing author branch does not establish installed or real-use evidence. Useful releases are installed and exercised; their findings guide the next change.
