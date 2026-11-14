# How to use the Pi engine alone

**For:** a person or an agent who wants to see the AI engine run a turn behind the engine port, with no key. **Time:** under a minute.

**Before you start:** Node 22.18 or newer and pnpm 10, with the repository installed (`pnpm install`; see [install and open the app](install-and-open-the-app.md), steps 1 and 2). The scripted model listens on `127.0.0.1`; a sandbox that blocks local listening fails with `listen EPERM`. No network, key or account is needed.

## Steps

Blocks marked `bash test` run in CI through `pnpm guides`, which `pnpm check` calls.

1. Run one turn on the scripted model. The example attaches `note.md`, asks for a brief, and gives the engine a small in-memory ToolHost that records the write it proposes. It closes the model server at the end, even when a step fails.

   ```bash test
   node scripts/no-leftovers.mjs node packages/modules/harness-pi/examples/try-harness.mjs
   ```

   You see, abbreviated (the port and token counts differ):

   ```text
   1. Engine: Pi 1.4.0; model: scripted, at http://127.0.0.1:<port>/v1 (no key).
   2. Tool events: read_file proposed, read_file done, write_file proposed, write_file done.
   3. One write proposed to the ToolHost: brief.md (11 lines, citing note.md).
   4. Answer (done): I drafted brief.md v1 from 1 source(s). It is ready to edit.
   5. 3 model requests, each with the keyless placeholder "Bearer none"; usage <n> in, <n> out.
   OK: one turn on the scripted model, its one write proposed, no key used.
   ```

   Exit code 0 means the turn behaved as described. Any mismatch prints `FAILED: …` and exits 1.

2. Write your own script. Package names resolve only inside a package, so a script at the repository root fails with `ERR_MODULE_NOT_FOUND` on `import … from '@backbone-next/harness-pi'`. Save it in `packages/modules/harness-pi/` (for example a file named my-turn.mjs there), or resolve the import by path from anywhere: `const { createPiHarness } = await import(createRequire('/path/to/checkout/packages/modules/harness-pi/package.json').resolve('@backbone-next/harness-pi'))`. The calls in order, with their types, are in the [engine's API recipe](../../packages/modules/harness-pi/README.md#the-api-recipe).

3. Point it at your own model: give `start` a route with `kind: 'endpoint'` and the `baseUrl` of an OpenAI-compatible server (a local one needs no key), or a provider route whose `credential` is a handle your `credential(handle)` function resolves at request time. This needs a model, so CI does not run it.

## Telling the failures apart

| You see | It means |
| --- | --- |
| `listen EPERM` | The scripted model could not listen on `127.0.0.1`: a sandbox, not the engine. |
| `outcome.status: 'failed'` with an `error` | The model route refused or could not be reached; the error never holds the credential. |
| a `tool` event with phase `refused` | The model asked for a tool the ToolHost does not permit, or the host refused the write. Nothing ran. |
| a `tool` event with phase `unknown` | The write's outcome cannot be told (for example, Stop during it). The engine never retries it. |

## What you now have

The engine running a real turn against a model that needs no key, with its only way out a write proposed to the host.

## What next

- The engine's tests, sources and how to swap it: [packages/modules/harness-pi/README.md](../../packages/modules/harness-pi/README.md).
- The same engine with the real core behind its ToolHost: `pnpm --dir packages/platform test`.
