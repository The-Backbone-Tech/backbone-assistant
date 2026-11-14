# Public source variants

`pnpm public:tree <output-dir>` exports the committed HEAD to a new directory outside this checkout. It never copies dirty files, staged additions, untracked files, ignored files or Git history. Commit changes before exporting them.

The policy in [scripts/public-tree.json](../scripts/public-tree.json) lists exclusions with reasons, replacement targets and forbidden patterns. Files ending in .txt here supply public bytes for their corresponding target paths; this suffix keeps template-relative links out of documentation checks until they are at their destination.

The exporter checks the result before publishing the output directory. Run `node scripts/public-tree.mjs --check <output-dir>` again after any edits. Hits name the file, line and rule without printing potentially sensitive values. Only test or fixture lines explicitly marked `public-tree: synthetic` can contain the allowed synthetic credential, path or private-reference samples; production files and documentation cannot use that exception.

The export includes a source inventory for archive builds without Git and recomputes module digests using the product's existing algorithm. After initializing a fresh repository, build checks use its index normally. No repository is created or published by the exporter.

Validate the exported tree with the package manager fixed in package.json:

```bash
pnpm install --frozen-lockfile --offline
BACKBONE_GUIDE_STEP=1 node scripts/check.mjs
pnpm regen
```

The privacy check finds defined patterns; it cannot classify arbitrary prose, all credential formats, binary meaning or a future repository's metadata. Review the public documentation, retained attribution and actual release artifacts before publication. Native payload obligations remain governed by [ADR 0005](../docs/adr/0005-lgpl-native-libraries.md).
