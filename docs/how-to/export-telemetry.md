# Send content-free traces to your collector

You need this workspace installed and an existing data folder. Telemetry is optional and off until that data folder's settings name an HTTPS traces URL with an explicit path, usually ending in `/v1/traces`. HTTP is accepted only on localhost, IPv4 127.0.0.0/8 or IPv6 ::1. Host-only URLs are refused; use the full traces route your collector provides. Prompts, answers, document names, tool inputs/results, connector names and error text never leave through telemetry. The complete attribute list and observation limits are in the [module README](../../packages/modules/telemetry-otel/README.md).

## Configure a data folder

In the desktop app, open Settings → Telemetry, enter the endpoint, optionally enter collector headers as a single-line JSON object in the masked field, and Save. Restart the app to apply. Header values are sealed with the data folder's existing credentials and never shown again. While enabled, a blank header field keeps existing values; an empty JSON object clears them. Clear the endpoint to disable export and remove its stored headers and handle index. Other credentials remain available.

For a headless data folder, use the CLI (replace the example data folder and endpoint with your own):

```bash
node packages/surfaces/cli/src/main.ts telemetry endpoint https://collector.example/v1/traces --home /path/to/home
node packages/surfaces/cli/src/main.ts telemetry header --home /path/to/home
```

The header command reads one JSON object on standard input, for example an Authorization header supplied by your secret manager. Keep the value out of shell history and command arguments. The settings file stores only the endpoint; the credential index stores handles, and values are sealed in the existing credential store. Authentication in the endpoint URL, query or fragment is refused. No environment variable enables telemetry or supplies headers. Use the app Settings for an app data folder whose keys the desktop app holds.

Restart the daemon or app after changing settings. Standalone CLI turns also export when configured. In your collector, find the fixed service name `backbone` and operation `invoke_agent`, then correlate the opaque thread, turn and Core run IDs with the data folder's records. Tool and outside-effect spans share the turn trace. Token counts appear only when reported by the engine. An exported trace is operational evidence; it does not replace an effect receipt or turn an unknown outcome into success.

To turn it off:

```bash
node packages/surfaces/cli/src/main.ts telemetry off --home /path/to/home
```

This removes the endpoint, its sealed collector headers and their index. Restart an app or daemon that is already running to stop its existing subscriber.

## Try it locally without a data folder or provider

This example starts a disposable HTTP collector, exports one metadata-only span, verifies receipt, and closes both sides. It needs no database, account or credentials.

```bash test
node packages/modules/telemetry-otel/examples/local-collector.ts
```

Expected result: `received invoke_agent; dropped 0`.

## Failure behavior

Export never waits in a turn. The subscriber coalesces reads and uses bounded volatile state; the transport queues up to 256 spans plus one 32-span batch in flight. It drops under pressure, on failures and after a 500 ms request deadline. There are no retries or redirects. A cumulative drop count accompanies subsequent spans and is also available on the subscriber's local stats. Shutdown gives a healthy collector one bounded opportunity to receive the final spans, then cancels remaining export work. A crash can lose volatile telemetry. Work records and unresolved effects remain with their existing owners.
