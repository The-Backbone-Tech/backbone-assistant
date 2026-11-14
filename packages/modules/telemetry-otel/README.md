# Telemetry: OpenTelemetry

This is an optional adapter over platform Host events, with OpenTelemetry dependencies. The [guide](../../../docs/how-to/export-telemetry.md) uses a fake Host and collector.

Status: the app, daemon and standalone CLI start telemetry only when the data folder names an endpoint.

Content-free turn traces for an operator's own OTLP/HTTP collector. Disabled unless the data folder's settings name an endpoint. The work ledger remains the authority for work and receipts.

## Observation boundary

The Host event stream signals saved thread, goal, schedule and connector projections. Turn start/end times, aggregate engine token counts, outcomes, opaque thread/turn IDs, goal runs and schedule runs can be observed through these public projections. Subscriber reads run outside inherited data folder locks and never block a turn.

Work-step labels contain content and are never inspected. Recorded steps have fixed kinds but no call timings. A small observer around the fixed ToolHost catalogue records accurate tool spans, including errors as a class only. Connector projections expose safe state classes but can coalesce rapid transitions; structured observations at the connector's proposal, dispatch and record boundaries retain transitions. The sent phase marks dispatch and has unknown outcome until a final observation; it does not establish provider success. Public projections have no individual model-call boundaries: this adapter does not invent model calls. Engine usage is recorded on the turn. One context property in the Host supplies the Core run ID to the observer, together with hashed engine and route identity. Goal and schedule run IDs are separate correlation identities.

New turns and turns whose execution is explicitly observed during this session are exported, including resumed turns with older start times; historical turns are not replayed. Goal and schedule runs use their recorded start/end times. Goal spans summarize each observed nonrunning state; a resumed run can produce a later state summary with the same run correlation ID and a cumulative duration. Effect transitions are point spans at observation time. Fixed native_staged and native_subagent events also produce observed tool spans; missing or evicted proposals produce zero-duration completion points. Each turn retains at most 128 active native proposal timings. Other native engine internals and sidechat tool internals have no timing hook; the root still shows their whole-turn timing and reported aggregate usage. A process death can lose volatile spans. The subscriber is bounded to 128 pending threads, 128 threads last observed running (refreshed at close), 512 turn metadata records and 2,048 deduplication records, in addition to the export queue; capacity loss is counted.

## Why this piece

An operator can use their existing collector without giving it conversation or document content. The adapter owns convention names so upstream changes do not change the work record.

## Use the subscriber

For a complete setup path, see [export telemetry](../../../docs/how-to/export-telemetry.md). Run the standalone loopback collector example with `node packages/modules/telemetry-otel/examples/local-collector.ts`.

Install the workspace, then import `createExporter` from this package. Supply an HTTPS traces URL with an explicit path, explicit resolved credential-store headers, and emit only attributes named below. HTTP is accepted only on localhost, IPv4 127.0.0.0/8 or IPv6 ::1. Host-only URLs, URL credentials, queries and fragments are refused. Custom collector paths are supported; `/v1/traces` is conventional. `flush()` is for tests or explicit diagnostics; turns never await it. The subscriber's `close()` drains completed projections and exports for at most one request deadline, then drops remaining queue entries and cancels the active request. The low-level exporter's `close()` drops immediately.

The official OpenTelemetry API 1.10.0, SDK and resources 3.1.1, and OTLP transformer 0.301.1 are pinned exactly; each is Apache-2.0. The official JSON serializer supplies wire encoding. The small HTTP transport avoids the stock exporter's environment-header merge and hidden retries. There is no global provider, automatic instrumentation, resource detection, environment configuration or content capture.

The queue holds at most 256 finished spans plus one batch of 32 in flight. Requests have a 500 ms total deadline, no retries or redirects, and an 8 KiB response limit. Overflow, transport failure, timeout, rejection and shutdown loss increment the local drop counter. A following span carries the cumulative count. No exporter error text is logged or exported.

## What it replicates

OpenTelemetry GenAI agent and tool span conventions, restricted to operational metadata.

## Swap it

Replace the subscriber/exporter; durable work and receipt records stay with the platform.

## Remove it

Disable telemetry in Settings, or use the CLI's telemetry off command, then restart the owner process. Disabling removes its sealed collector headers and their handle index while preserving other credentials. Dropped exports never change work outcomes.

## Exported attributes

The full allowlist, including resource attributes, is:

- `service.name`
- `gen_ai.operation.name`
- `gen_ai.tool.name`
- `gen_ai.usage.input_tokens`
- `gen_ai.usage.output_tokens`
- `backbone.thread.id`
- `backbone.turn.id`
- `backbone.run.id`
- `backbone.effect.id`
- `backbone.engine.id`
- `backbone.route.id`
- `backbone.outcome`
- `backbone.effect.phase`
- `backbone.step.count`
- `backbone.turn.count`
- `backbone.telemetry.dropped`

Only fixed operation/tool/phase/outcome values, nonnegative integer counts and opaque identifiers are emitted. Configured identifiers use unsalted SHA-256; UUID correlation IDs remain readable. A guessable configured model or route identifier can be recovered by comparing candidate hashes, so this hashing is stable correlation rather than a secrecy guarantee. Trace and root span IDs are also derived from SHA-256 of the thread and turn IDs. The exported instrumentation scope is backbone.telemetry, version 0.0.0. Span names are fixed operation names. Span status has no message; spans have no events or links. Prompts, answers, tool arguments/results, file names, titles, connector/server names, statements, endpoint URLs and error text are never exported. There is no content switch.

## Known limits

Changing the endpoint rewrites the data folder's settings file as compact JSON while preserving other settings values. A repeated connector proposal can emit proposed and held observations again under the same effect ID; these observations are not additional provider sends. The root span records the first observed nonrunning turn state. A later recovery can change the durable result without replacing that span, so receipts remain authoritative. Each coalesced thread update reads the full thread projection rather than an incremental snapshot.

Trusted platform composition depends on this module through the recorded layer exception; the module has a development dependency on the platform for its types and tests. This creates a workspace dependency cycle without a module-to-platform runtime import. Collector URL validation is deliberately repeated at configuration and transport boundaries to preserve that separation; their security cases must remain aligned.

<!-- generated from backbone.module.json by scripts/module-readme.mjs; do not edit -->
| Field | Value |
| --- | --- |
| id | `io.github.albertoangulo/telemetry-otel` (module) |
| version, licence | 0.0.0, Apache-2.0 |
| publisher | Backbone maintainers, namespace `io.github.albertoangulo` (github, pending) |
| stability | experimental |
| provides | Telemetry 0.x |
| consumes | api 0.x, TelemetryObservation 0.x |
| capabilities | planes: personal; effect classes: none; operations: none; network: operator-configured-otlp-endpoint; secrets: surrogate |
| data | owns: bounded volatile export queue and drop counters; migrations: 0; export: OTLP/HTTP spans containing operational metadata only |
| depends on | @opentelemetry/api 1.10.0 (Apache-2.0), @opentelemetry/sdk-trace 3.1.1 (Apache-2.0), @opentelemetry/otlp-transformer 0.301.1 (Apache-2.0), @opentelemetry/resources 3.1.1 (Apache-2.0) |
| conformance | bronze: `packages/modules/telemetry-otel/test/exporter.test.ts`, `packages/modules/telemetry-otel/test/subscriber.test.ts`, `packages/platform/test/telemetry.test.ts`, `packages/platform/test/telemetry-observations.test.ts`, `packages/platform/test/telemetry-settings.test.ts`, `packages/modules/telemetry-otel/test/shutdown.test.ts`, `packages/platform/test/telemetry-loading.test.ts` |
| removal | clear endpoint and restart; queued telemetry may be dropped; work receipts remain; refused while one of its effects is UNKNOWN |
<!-- end of generated block -->

## Point it at a collector

Use Settings → Telemetry in the desktop app, or the CLI's telemetry endpoint/header/off commands described in the how-to. The header field masks a single-line JSON object; its saved values are never read back. The data folder settings contain only an endpoint under the telemetry key. Collector header values live individually sealed in the credential store; settings and the credential index never contain them. The app, daemon and standalone CLI compose this subscriber before work starts, and close it before closing their Host. Changes apply after restart. Nothing in the environment alone enables it.

Startup reports off, on, or misconfigured with a fixed settings, credentials, module or startup reason class. The CLI doctor reads settings, validates the header index's shape and count, and checks that the module resolves. It takes no keys, never opens the vault, and never loads the SDK or probes a collector. Its on status reports the number of stored headers; it does not prove the headers can be opened or the collector reached. Doctor's credentials warning means a malformed index; startup's credentials warning means headers could not be opened. Diagnostics use fixed reason classes without content. Subscriber and exporter close methods do not reject, so teardown cannot skip Host shutdown.
