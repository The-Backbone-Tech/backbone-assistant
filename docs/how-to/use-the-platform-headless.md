# How to use the platform headless

**For:** someone building their own surface, or testing a change, who wants the `api` the app calls without the app. **Time:** about a minute.

**Before you start:** Node 22.18 or newer and pnpm 10, with the repository installed (`pnpm install`; see [install and open the app](install-and-open-the-app.md), steps 1 and 2). The data folder's embedded PostgreSQL listens on `127.0.0.1`: `listen EPERM` or `initdb failed … shmget` means a sandbox blocks it. No network, key or account is needed.

## Steps

Blocks marked `bash test` run in CI through `pnpm guides`, which `pnpm check` calls.

1. Run the example under `scripts/no-leftovers.mjs`, which fails if a `backbone-*` data folder or a database is left behind. It uses the stub engine, which calls no model.

   ```bash test
   node scripts/no-leftovers.mjs node packages/platform/examples/try-platform.mjs
   ```

   You see, abbreviated (the thread id differs):

   ```text
   1. Project "Q4 review" created in a fresh data home.
   2. Attached note.md as an original and sent a turn (thread <id>…).
   3. Turn done on "Stub harness (no model called)", 2 work steps.
   4. Its write went through the core's gateway: write-working-copy brief.md, outcome DONE.
   5. brief.md was a working copy (v1); the person's Save made it accepted (v2).
   6. A save against the old version is refused (STALE_BASE); nothing is overwritten.
   OK: project, attachment, turn, gateway write, Save and refusal all behaved as documented.
   ```

   Exit code 0 means all of it held. Any mismatch prints `FAILED: …` and exits 1.

2. Run the platform's own tests, which cover the same `api`, the door's Gateway and the Pi engine against the real core:

   ```bash
   pnpm --dir packages/platform test
   ```

## What you now have

The `api` working headless on a real core: a turn whose write went through the gateway, and the person's Save as a new version.

## What next

- The method map, the ports and their tests: [packages/platform/README.md](../../packages/platform/README.md).
- A surface on top of it: [install and open the app](install-and-open-the-app.md).
