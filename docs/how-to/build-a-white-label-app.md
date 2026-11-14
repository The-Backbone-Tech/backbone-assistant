# How to build the app under another name

**For:** a person or a company shipping the app as their own. **Time:** about five minutes for the build.

**Before you start:** macOS, Node 22.18 or newer and pnpm 10, with the repository installed (`pnpm install`). The result is an unsigned app: signing and notarising need an Apple Developer account and are not covered here.

The [distribution settings](../distributions.md) reference owns the fields, input rules and current limits. This guide owns the packaging steps.

## One file

A distribution file names the app, its bundle id, its look and its icon, without changing package code: package code is never patched (`schemas/distribution.schema.json`). The example is `examples/white-label/distribution.json`, which builds the app as **Harbor** with the icon beside it.

```json
{ "name": "harbor", "brand": { "name": "Harbor", "appId": "org.example.harbor", "icon": "icon.png", "light": "neutral", "dark": "neutral" }, "modules": ["harness-pi"], "defaults": { "harness": "harness-pi", "learning": "off" } }
```

The icon is a square PNG of at least 512 px beside the file. A build with a brand that fails the schema, or whose icon is missing, stops: a brand is never guessed.

## Steps

Blocks marked `bash test` run in CI through `pnpm guides`, which `pnpm check` calls.

1. Check the brand a build would use.

   ```bash test
   BACKBONE_DISTRIBUTION=examples/white-label/distribution.json node -e "import('./scripts/lib/brand.mjs').then((m) => { const b = m.loadBrand(); console.log(b.name, b.appId); })" | grep "Harbor org.example.harbor"
   ```

2. Build and package it. The window, the menu, the bundle and the disk image all carry the name, and the bundle carries the icon.

   ```bash
   BACKBONE_DISTRIBUTION=examples/white-label/distribution.json pnpm --dir packages/surfaces/app run package
   ```

   The app is in `packages/surfaces/app/dist/package`, named `Harbor.app`, with its disk image beside it.
