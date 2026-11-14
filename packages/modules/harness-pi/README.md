# Engine: Pi

The AI engine behind the engine port: Pi (`@earendil-works/pi-agent-core` and `pi-ai` 1.4.0, MIT) runs the turn's loop, and its tools come from the ToolHost: file tools, and optional connectors, children, cards, memory, goal proposals and the offline thread workspace. The standalone guide uses only file tools.
It has no permission system of its own: every write is a proposal the ToolHost carries through the core's effect gateway, and the route's credential is resolved per request and never enters the model's context.
It runs inside the host's process, so it is trusted, pinned code: the platform checks its files against their registration before loading them, which detects tampering at rest, but nothing in that process contains it at runtime. Its own code could reach the host's database connection and the data folder's credentials; the core's limits bind the model's actions through the ToolHost, not this package ([architecture](../../../docs/architecture.md#pieces-in-the-hosts-process-the-trust-boundary)).

File listings and reads label originals as `original source` and other documents as `recorded version`. The ToolHost does not expose whether a version was restored, so these labels do not identify who authored or saved it; they imply no trust or permission.

## Use it alone

You need this repository installed (`pnpm install`). No key, no network and no core: the example drives the engine against the scripted model, an OpenAI-compatible server on `127.0.0.1` that decides each step from the request alone (`packages/platform/src/testing/scripted-model.ts`).

Fastest check: `node packages/modules/harness-pi/examples/try-harness.mjs` runs one turn ("Write an editable brief from these", with `note.md` attached), shows the tool events, the one write it proposed and the answer, and exits non-zero on any mismatch. Its expected output is in [use the Pi engine alone](../../../docs/how-to/use-the-pi-harness-alone.md), which CI runs.

### Where your script lives

Package names resolve only from inside a package. A script at the repository root fails with `ERR_MODULE_NOT_FOUND` on `import … from '@backbone-next/harness-pi'`. Put the script in `packages/modules/harness-pi/` (for example a file named my-turn.mjs there; it runs from any working directory), or resolve the import by path from anywhere:

```js
const { createPiHarness } = await import(createRequire('/path/to/checkout/packages/modules/harness-pi/package.json').resolve('@backbone-next/harness-pi')); // import { createRequire } from 'node:module'
```

The scripted model (`import { startScriptedModel } from '@backbone-next/platform/testing'`) resolves the same way, from the engine package.

### The API recipe

Types are in `packages/platform/src/ports/harness.ts`; nothing here needs the core.

1. `const harness = createPiHarness()` (no arguments) returns a `HarnessV1`: `harness.label` is `Pi 1.4.0`.
2. Build the `TurnContext`, `{ tools, route, credential }`:
   - `tools` is a `ToolHost`: `list(): Promise<ToolFile[]>` (`{ name, version, by: 'person'|'agent', class: 'original'|'working'|'accepted', mediaType }`), `read(name): Promise<(ToolFile & { text }) | null>` and `write(name, body, signal): Promise<{ outcome: 'DONE', name, version } | { outcome: 'REFUSED', detail } | { outcome: 'unknown outcome', detail }>`. The write is the only way out.
   - `route` is a `ModelRoute`, all fields required: `{ kind: 'own'|'gateway'|'endpoint', provider: 'anthropic'|'openai'|'vercel'|'openrouter'|'openai-compatible', baseUrl, model, label, credential: string|null }`. A keyless local server is `kind: 'endpoint'`, `credential: null`.
   - `credential(handle: string): Promise<string>` resolves a route's handle at request time; a keyless route never calls it.
3. `const turn = harness.start({ threadId, turnId, text, history: [], attachments: ['note.md'], effort: 3, resumed: false }, context)`. All `TurnRequest` fields are required (`effort` is 1 to 5); `attachments` names files the `ToolHost` lists.
4. `for await (const event of turn.events)` yields `{ type: 'text', delta }`, `{ type: 'tool', phase: 'proposed'|'done'|'refused'|'unknown', tool, label }` and `{ type: 'usage', input, output }`.
5. `const outcome = await turn.outcome` is `{ status: 'done'|'failed'|'interrupted', answer, error?, usage: { input, output } }`. `turn.steer(text)` adds words to a running turn and `turn.stop()` stops it (a dispatched write becomes `UNKNOWN`).

The smallest version, from the example:

```js
import { createPiHarness } from '@backbone-next/harness-pi';
const turn = createPiHarness().start(
  { threadId: 't', turnId: 'u', text: 'Write an editable brief from these', history: [], attachments: ['note.md'], effort: 3, resumed: false },
  { tools /* a ToolHost: list, read, write */, route /* a ModelRoute */, credential: async (handle) => '' },
);
for await (const event of turn.events) console.log(event);
console.log(await turn.outcome); // { status: 'done', answer, usage }
```

A `ModelRoute` names an OpenAI-compatible endpoint, a gateway or Anthropic's own API, and a credential handle (or `null` for a keyless local endpoint, which sends the placeholder `Bearer none`).

What is tested, and where:
- `packages/modules/harness-pi/test/harness.test.ts` (scripted model, a fake ToolHost): reads the attachments and proposes its one write; a question lists and reads the drafted files; a tool the thread does not permit is refused by name and nothing runs; Stop during a write leaves it `UNKNOWN`, proposed once and never retried; an `UNKNOWN` write ends the turn; a canary credential reaches only the request header, never the model, the events or an error; vendor keys in the environment are never sent.
- `packages/platform/test/harness-pi.test.ts` (the platform's ToolHost and the real core): Pi drafts through the gateway; a follow-up reads the person's saved version; Stop and a kill during dispatch leave the write `UNKNOWN` and not resent; no route means a refused turn and no model call; the person's own key comes before a gateway, with no silent fallback.
- `packages/platform/test/pieces.test.ts`: the platform recomputes this package's digest and imports this folder's module only after the check, refusing changed files, another piece's name, or content the person never registered and permitted; every Pi run is bound to its registration, so the core refuses an operation it does not declare or a class above 2, whatever the person's mandate allows.
- `packages/modules/harness-pi/examples/try-harness.mjs`, run by `pnpm guides`: one keyless turn.

Not tested: a live provider (Anthropic, OpenAI, a gateway) with a real key. The port has no shared conformance suite yet (see the manifest's exemption).

## What it replicates, from whom, when

- Pi as the engine behind a plug shaped like the AI SDK's `HarnessV1` (`@ai-sdk/harness`, experimental). The distribution's radar decided it (`backbone-way:radar/cap-04-parallel-work.json`, evidence dated 25 Oct 2026): Pi 1.4.0 published 21 Oct 2026 under `earendil-works`, MIT; a third-party cost study (Arena, "HarnessTax", 16 Sep 2026) put Pi on the cost frontier with the same models across engines; none of the radar's own validation tests has run yet.
- Pi ships no permission system and does not ask before tool calls (its security notes, read 23 Oct 2026), so safety lives outside it: in the ToolHost and the core's gateway.

## Why

An engine Backbone can configure and rebrand, with no authority of its own: whatever the model asks, the only way out is a write the gateway decides, with a receipt, and an outcome nobody can tell stays `UNKNOWN`. Keeping the engine behind a port means it can change without changing any guarantee.

## Swap it

Any engine behind the same engine port (`packages/platform/src/ports/harness.ts`). The challenger is goose (`aaif-goose/goose` v1.56.0, 23 Oct 2026, in the same radar entry), to switch to if Pi's licence or governance changes, its durable runs fail their tests, or goose wins on success at equal cost. The platform names engines in `packages/platform/src/composition/host.ts`; tests default to the labelled stub, which calls no model.

## Remove it

Settle any `UNKNOWN` writes it left (they stay with the core's gateway; the core refuses to unregister it, `unregisterPieceIn` in the platform, until they are settled), set the engine to another engine or the stub (`harness` in a distribution's defaults, or `BACKBONE_HARNESS`), remove it from the distribution's modules, and remove this package and its entries in `packages/platform/src/composition/host.ts` (`HARNESSES`) and `pieces.ts` (`PIECES`). The platform depends on it today and imports it only by path, after checking it, an exception recorded in `scripts/structure-exceptions.json`.

## Manifest

<!-- generated from backbone.module.json by scripts/module-readme.mjs; do not edit -->
| Field | Value |
| --- | --- |
| id | `io.github.albertoangulo/harness-pi` (module) |
| version, licence | 0.0.0, Apache-2.0 |
| publisher | Backbone maintainers, namespace `io.github.albertoangulo` (github, pending) |
| stability | experimental |
| provides | Harness 0.x |
| consumes | ToolHost 0.x, ModelRoute 0.x |
| capabilities | planes: personal; effect classes: 2; operations: workspace.write_document; network: model-route; secrets: none |
| data | owns: none; migrations: 0; export: nothing durable: threads, effects and documents belong to the core |
| depends on | @earendil-works/pi-agent-core 1.4.0 (MIT), @earendil-works/pi-ai 1.4.0 (MIT), @earendil-works/pi-coding-agent 1.4.0 (MIT), typebox 1.3.27 (MIT) |
| conformance | bronze: `packages/modules/harness-pi/test/harness.test.ts`, `packages/platform/test/harness-pi.test.ts` |
| exemption | shared harness port conformance suite: the Harness port has no shared suite yet; these tests and J-01 on the installed app with the scripted model stand in |
| removal | allowed when no turn on this harness is running; held UNKNOWNs stay with the core's gateway; refused while one of its effects is UNKNOWN |
<!-- end of generated block -->
