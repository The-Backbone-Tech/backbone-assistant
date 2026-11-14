# Run script checks and signed triggers

For a developer or operator using the [headless platform](use-the-platform-headless.md).
Install the workspace first. The host must stay running for schedules and HTTP deliveries.
The Host API supports both options. Settings › Heartbeat and brief can add, change or remove
a script check on an existing schedule. Each change goes through main's native confirmation
showing the exact program, argument boundaries and schedule. Direct renderer IPC, browser
bridge and API-line mutations are refused; MCP offers no mutation.

## Try both without accounts

This disposable example uses the stub engine, local HTTP and fake signing material. It creates
no real provider request and removes its data folder. The `bash test` step runs with the guides.

```bash test
node scripts/no-leftovers.mjs node packages/platform/examples/try-proactivity.mjs
```

Expect a line confirming that the quiet check made no turn, a changed check made a turn,
and one signed delivery was accepted while its repeat was refused.

## Schedule a script check

Pass `wakeGate: { command, args, timeoutMs }` to `schedules.create`, with an absolute command
path and explicit argument array. The command runs without a shell in the data folder, with
only a fixed PATH environment, discarded output and no standard input. The default deadline
is five seconds; an explicit deadline must be between 100 and 30,000 milliseconds, including
waiting for one of four process slots. Slow checks do not block other slots or the daily brief.
The result settles at the deadline without waiting for an OS exit event. A surviving process
keeps its slot and an unreferenced reaper retries termination; shutdown does not await it.

The script decides: exit 0 means unchanged; exit 10 means changed; other exits, signals,
launch failures and timeouts fail the check and pause its schedule for inspection. An unchanged check records a quiet run with no
turn or model call. A changed check admits the schedule's normal turn with its saved settings.
Script output never becomes model instructions.

Use a trusted read-only program. It runs with the person's OS rights, so it needs Full
permission, local execution and chat mode; managed policy forbidding person rights refuses it.
This is permission to run the configured program each time, not an operating-system sandbox.
Pausing or deleting a schedule while its check runs prevents subsequent model admission.
After a host interruption during a check, the schedule pauses for inspection; it does not
execute that uncertain check again automatically. Resume only after checking what it left.
To replace the command, create a replacement schedule and remove the old one.
Alternatively use the desktop form for a confirmed replacement. Keep credentials out of
arguments. API-line and MCP schedule reads omit the program configuration.

## Receive a signed delivery

Pass `webhook: { authentication: 'standard', publicOrigin: 'https://hooks.example.com' }`
to `triggers.create`. Keep the returned one-time secret in the sender's protected credential
store. The platform keeps it sealed and returns no secret on a retried create or in reads.
Standard Webhooks 1.1.1 is MIT licensed; its verifier checks the signature and a five-minute
timestamp tolerance. Delivery-ID storage belongs to the platform.

Signed-trigger turns are capped at the existing middle turn tier, `auto-review`, even if
saved/requested settings say Full. Set `webhook.permission` to `ask` for the lower cap;
an already lower requested permission is preserved. Admission reapplies the cap to old
stored triggers and resumed runs. This does not enable the separate, currently unavailable
global Balanced connector preset. A signature authenticates a sender key, not the authority
of its payload. The receiving origin accompanies the quoted untrusted data; neither the body
nor its claimed identity gives the engine permission.
The admitted turn also carries trusted provenance. Because permission labels alone do not
restrict every engine, signed work currently uses the stricter read-only engine/tool boundary;
an adapter that cannot enforce it refuses the work. Automatic signed work can inspect/report,
but cannot run workspace commands, delegate or perform writes. A person can continue the work
in a separate ordinary turn. Unfinished older signed turns are restricted before recovery.

An operator must configure an HTTPS reverse proxy or tunnel to the returned `trigger.localUrl`.
The advertised `trigger.url` uses the public origin. Forward only this signed trigger's exact
path and preserve the public Host where possible. A tunnel exposing the whole listener while
rewriting Host to loopback would also expose legacy bearer endpoints; do not configure it
that way. Forward POST requests and exact body bytes with `webhook-id`, `webhook-timestamp`
and `webhook-signature`. Signed work must carry a JSON object or array;
empty bodies, plain text and JSON primitives are refused. This prevents interpreting the same
signed prefix as a different delivery ID and body. Do not add an Origin header. The listener
stays on loopback; a preserved public Host does not enable the legacy bearer-token path.

The sender must speak Standard Webhooks; a provider with a different signing format needs
an adapter that verifies that provider before signing this delivery. Native GitHub signatures
are not Standard Webhooks signatures.

Success is HTTP 202. HTTP 401 refuses invalid, missing, altered, expired or future signatures;
409 refuses an already accepted delivery ID or a paused trigger. Delivery IDs remain claimed
across restarts, even if a sender signs the same ID again. Each trigger retains at most 10,000
IDs for its lifetime. The formatted ledger also has a shared 1 MiB write budget across all
triggers. New claims beyond either limit receive 429; existing claims are never evicted.
An older oversized ledger disables trigger admission for inspection instead of rewriting it.
The listener allows 32 connections, one request per socket and 600 requests per fixed minute
across all IDs. Configure additional sender-specific limits at the relay for company use.
Existing body-size and deadline limits still apply. A persistence failure returns 503 and
stops trigger admission in that Host: inspect the data folder before retrying an uncertain delivery.

Package tests prove local signature and repeat handling. Internet reachability, TLS, sender
configuration and a real company-system delivery still require real-use qualification.
