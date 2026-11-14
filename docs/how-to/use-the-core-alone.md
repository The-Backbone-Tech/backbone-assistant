# How to use the core alone

**For:** a person or an agent who wants the core's guarantees (mandates, one effect gateway, receipts, revocation) under their own runtime, with no app and no platform. **Time:** about a minute.

**Before you start:**
- Node 22.18 or newer and pnpm 10, with the repository installed (`pnpm install`; see [install and open the app](install-and-open-the-app.md), steps 1 and 2).
- Local listening and shared memory must be allowed: the example starts an embedded PostgreSQL 18 on `127.0.0.1`. `listen EPERM` or `initdb failed … shmget` means a sandbox blocks it; run outside that sandbox. No network, key or account is needed.

## Steps

Blocks marked `bash test` run in CI through `pnpm guides`, which `pnpm check` calls.

1. Run the example under `scripts/no-leftovers.mjs`, which fails if anything named `backbone-*` or a running database is left behind. The example creates a cluster in a temporary folder (under `TMPDIR`, step 2), talks to it only through the core's `gov.*` crossings, and stops and removes it at the end, even when a step fails.

   ```bash test
   node scripts/no-leftovers.mjs node packages/core/examples/try-core.mjs
   ```

   You see, abbreviated (ids and hashes differ):

   ```text
   1. Workspace created in an embedded PostgreSQL; its owner and its system principal exist.
   2. Mandate issued to a worker: outbox.write only, up to class 3, for one hour.
   3. Run queued under the mandate and claimed by a worker (fence 1).
   4. Effect proposed through the gateway: class 3, allowed.
   5. Receipt <uuid>: outbox.write succeeded, key try-core-1, observation <hash>…
   6. The same idempotency key names the same effect: nothing is sent twice.
   7. Mandate revoked (1 mandate(s)); its run stops.
   8. After the revoke the run's next proposal is refused: not_in_run. No effect was recorded.
   OK: workspace, mandate, run, effect, receipt, revoke and refusal all behaved as documented.
   ```

   Exit code 0 means all of it held. Any mismatch prints `FAILED: …` and exits 1.

2. Keep the run inside a directory you choose. The example makes its cluster with `mkdtempSync(join(tmpdir(), …))`, which follows `TMPDIR`, and removes it at the end. That keeps a sandbox that only writes inside the checkout working, makes any leftover easy to find and lets you delete a run with one `rm -r`:

   ```bash
   mkdir -p .scratch && TMPDIR="$PWD/.scratch" node packages/core/examples/try-core.mjs
   ```

3. Write your own script. Package names resolve only inside the package, so a script at the repository root fails with `ERR_MODULE_NOT_FOUND`. Save it in `packages/core/` (for example a file named my-script.mjs there), or resolve the import by path from anywhere: `const { enter } = await import(createRequire('/path/to/checkout/packages/core/package.json').resolve('@backbone/core/db'))`. The calls in order, with their permissions, and how to read a receipt, are in the [core's API recipe](../../packages/core/README.md#the-api-recipe). Read the example (`packages/core/examples/try-core.mjs`) for who calls each crossing, which is the point. The person issues and revokes the mandate; the worker claims the run and proposes; only the system principal claims, begins and observes a dispatch.

## Telling the failures apart

A crossing refuses by raising an error whose message starts with the reason; `reasonOf` in `packages/core/src/db/session.ts` reads it.

| You see | It means |
| --- | --- |
| `listen EPERM` or `initdb failed` | The database could not start: a sandbox, not a refusal. |
| `not_in_run` | Only the run that acts proposes: the run was never claimed, or a revoke stopped it. |
| `stale` | The run is held at another fence: another worker claimed it since. |
| `reused_key` | The idempotency key was used before for a different change. |
| an effect with status `denied` | Outside the mandate (another operation, tool or class). It is recorded with its reason; nothing was sent. |
| an effect with status `awaiting_checker` | Above the mandate's ceiling: a person decides; nothing was sent yet. |
| an effect with status `unknown` | Its outcome cannot be told. It is never resent; a named person settles it. |

## What you now have

The core's promises seen end to end on a real database: an effect leaves only through the gateway, under a mandate that a revoke ends at once, with a receipt.

## What next

- The core's tests, limits and how to replace it: [packages/core/README.md](../../packages/core/README.md).
- The promise tests any core must pass: [oracle/README.md](../../oracle/README.md).
