# Messaging channels (experimental)

This is an internal surface: it requires the platform Host, channel adapters and bot credentials for real service use. Tests use fake endpoints.

Slack, Telegram, Discord and Microsoft Teams direct messages are surfaces over the same Host as ordinary app and CLI threads. A bound person's message starts a normal turn without another confirmation. Effects inside that turn keep the Host's existing rules. Replies and Host work labels return to the conversation, including replies to turns started by a second caller of that Host.

## Compose with a Host

The public entry point is `startChannels(host, options)` from `@backbone-next/channels`. Pass the data folder, project ID, turn settings and the enabled providers’ adapter options. It returns authenticated `webhook(provider, request)`, `idle()` for verification, and asynchronous `close()`. The daemon composes it when channel configuration is present. An app main process can compose the same function later; the desktop app is not wired here. The package's `test/host.test.ts` is a complete disposable-home example with a scripted model and both local provider endpoints.

`serveChannels(service, port)` serves webhooks at `/channels/slack`, `/channels/telegram`, `/channels/discord` and `/channels/teams` on loopback only. The daemon writes the chosen port into the data folder's `channels/listener.json` while running. A real provider needs an HTTPS reverse proxy to that listener. Provider signatures or secret headers are still checked by the SDK behind the proxy.

## Connect a real bot later — not tried

All qualification uses fake loopback endpoints and synthetic credentials. No real bot, account or workspace has been connected.

For Slack, create and install a Slack app in the workspace you control, with a bot user. Give it `chat:write`, `im:history` and `users:read`; enable the `message.im` bot event subscription. Retain its bot OAuth token and signing secret. Point the Events request URL to your HTTPS proxy's `/channels/slack` route; the SDK answers URL verification challenges. This service uses webhooks, not Socket Mode. Slack channel/group events are refused before intake and receive no public reply. Bindings include both the Slack team ID and user ID. Requests carrying the socket-forwarding header are always refused; Socket Mode forwarding is not a supported intake route.

For Telegram, create a bot with BotFather and retain its bot token. Choose a separate webhook secret. Configure its webhook with Telegram's `setWebhook`, pointing to the HTTPS proxy's `/channels/telegram` route and supplying that same `secret_token`. Webhook registration is a manual provider operation outside this package. Only private-chat messages, including messages tagged as bot commands, are accepted. Groups, supergroups and channel posts receive no reply and are not journaled. Polling is not composed by the daemon.

From a checkout with dependencies installed, first create or select an ordinary project and configure its model route. Pipe exactly two newline-terminated lines from your secret manager into the connect command: the bot token first, then the Slack signing secret or Telegram webhook secret. End standard input after the second line. The token is never a command argument. For example, the receiving end of that pipe is:

```sh
node packages/surfaces/cli/src/main.ts channels connect slack --home "$BACKBONE_HOME" --project PROJECT_ID
```

Use `telegram` instead of `slack` for Telegram. The ordinary `--model`, `--effort`, `--permission` and `--plan` options set how channel turns run. `--port` selects the loopback listener (3038 by default; 0 requests a free port). Configuration is in the data folder's channel journal. Tokens are sealed by the existing platform credential store, with only handles in `credentials/channels.json`; they are never stored in repository configuration. Reconnecting a provider revokes its existing bindings, but credential replacement and revocation are separate commits. For a real connection change, stop the daemon and run `channels unbind` before connecting; restart it afterwards. The project and turn settings are currently shared across providers: use the same project when adding a second provider.

Start the daemon, then request a binding code from the trusted CLI:

```sh
node packages/surfaces/cli/src/main.ts daemon run --home "$BACKBONE_HOME"
node packages/surfaces/cli/src/main.ts channels bind --home "$BACKBONE_HOME"
```

Run the binding command in another terminal while the daemon runs. Send the printed code to the bot from the account you want to bind. It is a 192-bit hexadecimal code, works once, and expires after ten minutes. Hexadecimal survives Slack text rendering. An unbound identity receives one plain refusal and starts no turn. `channels unbind` ends all bindings and invalidates outstanding codes; it works while the daemon runs. Pending messages recheck the binding and its generation before admission. The running turn remains the Host's work; unbinding prevents the queued successor from starting. Unbind followed by rebind cannot revive old queued messages or pending output. A fresh message after rebinding starts a fresh channel thread; the old thread remains in the platform.

On first open after upgrading, old Slack bindings that contain only a user ID are ended and recorded as unbound. Bind that account again so its team ID is included. Existing team-scoped bindings stay active. Legacy intake without a direct-message attestation is finished silently; pending delivery without a recorded sender and binding generation is blocked without sending.

## Discord and Microsoft Teams

The published MIT adapters were verified on npm at 4.44.0 on 10 November 2026:
[Discord](https://www.npmjs.com/package/@chat-adapter/discord/v/4.44.0) and
[Teams](https://www.npmjs.com/package/@chat-adapter/teams/v/4.44.0).
These providers use the same disposable-home Host journey as the existing channels;
`test/breadth.test.ts` proves authenticated intake, binding, a completed Host turn,
reply delivery and restart deduplication against local endpoints. Teams inbound auth
in that test uses a signed synthetic relay through the SDK’s custom verifier. Native
Microsoft JWT validation is exercised with locally signed tokens and local JWKS and token endpoints, without a test verifier. Real Gateway connectivity and real provider use are unqualified.

For Discord, the first stdin line is the bot token. The second is JSON containing
`applicationId` and the application’s 64-digit hexadecimal `publicKey`. Use
`channels connect discord`. Enable Message Content Intent for this bot in its developer
configuration before running it. The daemon renews the SDK Gateway listener every three
minutes and forwards events to its own loopback listener. Only individual DMs are
accepted: raw Gateway packets omit channel type, so the adapter resolves it through
Discord’s channel API before intake. Guild messages and group DMs are rejected before
posting or starting work. Gateway forwarding uses the bot token; do not expose it through
request logging. The proxy must not log request headers for `/channels/discord`: its forwarding header carries the bot token over loopback. Backbone compares fixed-size token digests in constant time. Signed Discord interaction pings are supported; slash-command work intake
is not composed. Give work as ordinary DM text.

For Teams, the first stdin line is the app’s client secret. The second is JSON containing
`appId` and `tenantId`. Use `channels connect teams`. Configure a single-tenant Azure Bot
and a Teams app with personal scope; its messaging endpoint is the HTTPS proxy’s
`/channels/teams` route. Production composition retains the SDK’s native Microsoft JWT
verification. Only explicitly personal conversations in the configured tenant are accepted.
The direct composition API also accepts the SDK’s custom verifier and token factory for
an authenticated relay; daemon configuration cannot supply those functions.

Both connect commands keep the existing two-line stdin custody, sealed credential store,
CLI binding codes and daemon restart requirement. The CLI test `test/channel-breadth.test.ts`
in the sibling CLI package verifies custody and configuration for each provider. A delivery
timeout is UNKNOWN and answer content is never automatically resent. Teams HTTP client
requests and Discord REST requests use the configured delivery deadline.

WhatsApp and email are not implemented in this unit. Signal and iMessage are deferred:
no maintained adapter was selected or qualified here. No real account or bot was used,
so the channel-breadth journey is not claimed at its required real-use evidence level.
The real Host channel e2e `test/decision-chat.test.ts` proves the in-chat discard decision;
`test/decision-durability.test.ts` covers uncertain acknowledgement, reconciliation routing
and revocation. Installed desktop composition remains separate and unqualified.

## What it replicates and why

Chat SDK `chat` 4.44.0 and its Slack, Telegram, Discord and Teams adapters 4.44.0 (MIT) own protocol parsing, authentication and platform posting. The SDK uses its `queue` strategy. That strategy coalesces overlap: earlier items arrive in `context.skipped`. Every accepted direct message is persisted before SDK queue dispatch, and handlers also persist every skipped item. A webhook is acknowledged only after those intake writes complete. Provider message IDs are scoped by provider and conversation (and Slack team), and remain deduplicated after restart.

Backbone owns the intake journal, one-use codes, binding/unbinding history, conversation-to-thread mapping and per-attempt reply receipts. Each send uses a stable Host client key. If admission happened but its acknowledgement was lost, restart reconciles that same key rather than creating another turn. Pending intake stays ordered while a turn runs. Each conversation keeps its own ordered worker. Transient NOT_AVAILABLE refusals and transport errors retain the message and retry with exponential backoff capped at two seconds; a lasting problem is reported through the daemon output, while other conversations continue. A NOT_FOUND or INVALID receipt from a known mapping drops it, and the same queued message retries admission without that mapping using its original client key. INVALID with no mapping is final on the first attempt and is not retried. Other definitive permanent refusals stop after three attempts, counted durably across restart. Terminal intake, the Host's reason and a pending plain notice commit together; the notice says the message could not be taken and gives that reason. The following message stays behind it until the notice is dispatched or its outcome recorded. Refused or failed turns show their Host answer text before progress and generic diagnostics; an intermediate done checkpoint is not a completed answer. Replies recheck their recorded binding generation before every dispatch, including replay at startup. Old journal rows without a direct-message attestation or delivery authority fail closed.

SQLite WAL with FULL synchronous commits stays local to the data folder, with one service owner and transactional CLI access. The tests exercise independent processes contending for the same code and provider IDs, as well as service restart with queued intake and a lost Host acknowledgement. SQLite avoids giving an L3 surface a Core database connection or adding SDK-owned DDL to the embedded Core. The SDK PostgreSQL state adapter was inspected but is not needed for authoritative state here.

Deterministic thrown invalid-input errors are final immediately and preserve any known conversation mapping, because the error concerns the message rather than proving the thread unusable. The core's message crossing raises an `invalid:` prefix, and the platform's CoreRefusal preserves its `reason` as `invalid`. The surface recognizes that exact reason, or the leading `invalid:` when no structured reason exists. It does not infer permanence from a diagnostic containing that word, from a paused/stale reason, or from an arbitrary transport exception. This is based on `packages/core/schema/gov/post_message.sql` and `packages/platform/src/composition/core.ts`; no private Core object is imported by the surface.

An admission acknowledgement can be lost after the message ran. If the person then moves its thread to another project before the retry, the Host can find the original client key but refuse the project mismatch before returning the original admission. The channel can show the completed answer and later say “This message could not be taken: Use the active chat project.” If this happens on the first message, no mapping was recorded and the answer never reaches the channel. The refusal describes the unreconciled intake attempt; it does not prove that the original message never ran. The stable key prevents a second turn in this case. Check the ordinary thread in the app before giving the work again. Fresh-thread replacement only succeeds when the Host can admit that key in the configured project.

Terminal refusal state and its pending notice are committed under the admission authority lock. Network delivery starts after that lock is released, so a silent endpoint does not hold up binding or unbinding. Delivery checks the binding generation again before dispatch.

The terminal transaction regression fails a real SQLite notice insertion and verifies through a second connection and reopen that the intake stays pending at its previous count: zero for an immediate INVALID and two for another permanent refusal. A successful terminal commit then recovers its pending notice and queued successor exactly once after service restart. Moving notice creation outside that transaction makes this test fail.

After three NOT_AVAILABLE receipts or non-invalid errors thrown by admission for a pending message, the channel also posts one waiting notice with the Host's own detail for receipts: “This message is kept and will run when the cause clears: …”. For thrown errors it instead says “This message is kept and will run when the cause clears.” without the error text. Three matches the daemon's existing problem-report threshold and filters a single admission race without waiting indefinitely for a recovery problem to clear. The count and notice are durable across service restarts. A streak is that message's pending lifetime: later refusals and restarts do not repeat its notice. Retries continue with the same client key; a successful admission ends the streak. Busy-thread checks do not count; receipt refusals and thrown admission errors share the same cumulative counter. The waiting notice uses the same delivery receipts, binding checks and dispatch outside the authority lock as terminal notices.

SDK coordination state is in memory. Its locks, caches, subscriptions and coalescing queue disappear on restart. They give no permission and are not recovery evidence: the durable Backbone intake is replayed independently, with the binding checked again. Reply attempts persist as delivered, failed or unknown. An explicit refusal is retried once and both attempts are recorded. A timeout, transport ambiguity or interrupted attempt is unknown. Terminal and waiting intake notices alone can be retried after an unknown outcome: at most three total dispatch attempts, with a one-second wait before each retry after an unknown. Each retry is queued after the delay so other deliveries can proceed, uses a fixed content-free sentence, checks the binding and generation again, and can duplicate the initial notice. Shutdown cancels retry timers; a restart recovers eligible notices from the journal. Answers, progress and other turn content are never resent after an unknown outcome. The production deadline is twenty seconds, explicitly supplied by the daemon; tests can request a short deadline. A pending delivery blocked by revocation is recorded failed with no fabricated endpoint attempt; a blocked unknown delivery retains its unknown outcome. Mutable commentary is posted only after completion; oversized progress is omitted so a progress post is a whole message. Stopped notices use their own IDs, leaving the real answer ID for subsequent recovery. An unknown reply does not mean the person's job failed; read the ordinary thread for its result.

A channel job can leave a connector read unresolved, including an unknown outcome call with no verified result. The channel checks that conversation's thread is no longer running, then reads Needs you again before posting: “A connector read needs your decision. Open the app and go to Needs you in this project.” An in-flight read does not get this notice, and a successful read that finishes between projections does not leave a stale notice. It uses a durable delivery ID for that observation and the same binding-generation checks as replies. Other threads' decisions are not forwarded to the chat. The same notice now includes an exact `/decision` command for the bound person to discard the retained read, or reconcile it when the Host permits that choice. The command is handled before model admission and never resends the connector call. Its random code is scoped to the provider, conversation, sender and binding generation. An answered or uncertain attempt is not replayed after restart. Needs you is read again before a choice; decisions taken in the app become stale in chat. Effect permission still requires the existing native confirmation. These public projections are separate reads, not an atomic snapshot.

## Qualified cases

The focused suite uses local fake Slack Web API/Events and Telegram Bot API endpoints, scripted models and disposable data folders. It covers failed-intake Slack retry headers, Telegram command entities, duplicate and overlapping intake, thread deletion, a real Host admission race, independent conversation progress during a lasting refusal, service restart with a lost acknowledgement, delivery retries and unknown outcomes, direct-message-only routing, team-scoped identity, bad/stale Slack permissions, bot filtering, HTTP pairing, binding generations, and the admission lock. Removing the lock makes its consumer test fail. Model output/progress and continuation from a second Host caller are exercised. Stopped/recovered output and mutable progress are exercised with snapshots of an actual Host thread through its public surface interface. A local HTTP MCP endpoint produces a real unresolved connector read from each provider's channel job; the tests check the app guidance, no duplicate notice after service restart, no automatic decision or resend, and isolation from a second caller's thread.

The service and Host both reject empty text with the same trim check, so there is no provider bypass for that input. A direct-consumer regression reaches the real Host empty-message refusal, delivers its exact sentence through the Telegram adapter to a local fake endpoint, and verifies one attempt, one notice and no chat.

Delta regressions also cover moved-thread mapping replacement, durable permanent refusal limits and ordered successors, successful connector reads during another caller's turn, Host refusal/failure reasons and completion checkpoints, legacy Slack bindings and intake/output rows, detached listener lock scopes, and captionless Telegram photos. Removing the running-thread guard makes the successful-read notice test fail.

The credential test also uses the platform's memory-held Keychain stand-in with plaintext mode unset. It scans the entire disposable data folder for token, verification secret and master-key bytes, hex and base64 forms. The CLI suite covers stdin custody, daemon composition and a due schedule continuing after either a busy channel port or a bad channel credential. The channel directory is created and repaired to mode 0700 before lock creation.

Adapter signing, forwarding and API-route configuration are explicit; the SDK environment variables cannot replace them. The production URL test intercepts the SDK transports and blocks outside HTTP. An earlier engine version intercepted the wrong Slack client and received `invalid_auth` for a synthetic token from Slack; it delivered no message. The final tests make no outside request.

## Swap it

Another transport can replace these adapters while preserving the Host boundary, binding generation, stable intake IDs, ordered admission and delivery finality. The SDK state adapter can also change independently; it must not become the authority for intake or recovery.

## Remove it

Stop the daemon before removing the package. Preserve the data folder's channel journal, especially unresolved unknown deliveries. Ordinary threads remain platform threads. The surface's identity, configuration and delivery history are not included in Host export or restore; moving them requires retaining the closed data folder, not replaying an export as authority.

## Remaining limits

This is a personal-home integration with one configured bot per provider. Groups and public/shared conversations are rejected; multi-person tenancy, rich messages, attachments, provider quotas, real bots and installed desktop journeys remain unqualified. There is no UI to resolve unknown deliveries, no automatic resend of unknown replies, no polling or Socket Mode composition, and no programmatic uninstall guard. Preserve unresolved receipts manually when removing files. Surface receipts are separate from Core effect receipts.

Slack direct-message thread replies and Telegram private-chat topics become separate conversations and separate Host threads. An edit of a Telegram message that was never journaled is taken as a new message; edits of a recorded message deduplicate. Slack edits are ignored. A forwarded message's text is taken as the bound person's instruction. Slack shared-message attachments are not included as text. Slack setup is qualified only for bot direct-message subscriptions, not user-token subscriptions that could expose conversations with other people. Enterprise Grid envelope-team variations are unqualified and can cause a plain not-bound refusal.

An empty or whitespace-only direct message from either provider, including a Slack file upload or a Telegram photo without a caption, is journaled but starts no turn; the channel asks for text describing the work. Shutdown drains the serial delivery queue and can wait up to twenty seconds per pending post against a silent provider. Projection failures can report repeatedly on Host events. After an interrupted turn resumes, its progress indices restart at zero, so earlier delivery IDs can suppress its first progress posts.

Telegram may truncate an answer beyond 4096 characters while its receipt says delivered; full answer fidelity and long-message splitting are not qualified. The retry after an explicit refusal is immediate and does not honor Retry-After. Progress is length-checked and omitted if it would exceed the supported whole-message bound.

Pairing and finishing the intake row are separate commits. A message sent before its pairing code has drained has the old generation and is refused; a crash between pairing and intake completion can likewise produce a false refusal. Wait for the binding confirmation before giving work. Credentials are replaced before the connect command revokes old bindings, so a crash in that interval is not an atomic bot switch. Adding a provider also changes the shared project and settings. Unbind before reconnecting and keep a consistent project until those configuration cases are qualified.

The SDK can call Slack users.info and Telegram sendChatAction before Backbone checks the binding. Those reads/typing notifications are not delivery receipts. Journals retain intake and full answer text indefinitely; there is no pruning policy. Pending heads use a single-row query per conversation, but discovery still scans pending lanes, and thread events still walk historical turns with synchronous SQLite on the Host event loop. Event volume and long-term storage/cost are not benchmarked. Ordering is by arrival within a conversation; a late provider retry follows newer messages.

Node's SQLite interface is experimental on Node 22 and can print an ExperimentalWarning for channel commands and configured daemons. The cross-process tests cover SQLite contention; restart tests restart the service, not a full process killed during Host recovery. The ordering of initial channel drain and Host resumeInterrupted has not been separately qualified.

A channel startup failure is reported without stopping schedules or goals. It is not retried automatically: fix the channel configuration/credential/port and restart the daemon. Transient Host admission problems retry with bounded backoff and retain intake while they wait; thrown INVALID is final without dropping a mapping, while an INVALID receipt is final after mapping recovery, and other definitive permanent refusals use the three-attempt limit described above.
The daemon retains its existing vault restriction: it can open only a data folder whose keys it can hold headlessly; this does not add a way to open an app's Keychain-held data folder. Configuration changes require a daemon restart. Credentials remain in the trusted process for SDK dispatch; they do not cross the Host API line or enter model requests. The service's app composition entry point is exported but not wired into the desktop app.

## Security boundaries and follow-ups

The pinned MIT Teams adapter has a small local patch under `patches/` that forwards an `appLogger` into its internal Microsoft App. The surface supplies a silent logger, including child loggers, so authentication errors, activity bodies and SDK startup diagnostics do not reach the daemon log even with debug logging enabled. Remove the patch when an adopted release provides the same logger option. The Docker context includes the patch so its frozen install uses the same code.

Earlier archive and native-verification fixtures allowed Microsoft's public JWKS lookup and a token request containing a synthetic app ID and secret. No real account credential or message was involved. The final fixtures serve keys and token responses locally. Both channels and CLI package test entry points explicitly preload a local-only network guard. It passes explicit preload arguments to Node test subprocesses and never rewrites NODE_OPTIONS. Shared fixture imports install no guard, so app and Electron test workers remain unaffected. Direct single-file qualification must use the same preload as the package command. A refused outside fetch, HTTP, HTTPS, socket or DNS attempt fails the suite even when a library catches it or the parent expects its child to fail. The guard records only the transport name, never a credential-bearing URL.

Production Teams requests pass the SDK's native RS256 signature, audience, issuer, expiry and service URL checks before intake. Afterwards, the surface accepts only the Bot Framework issuer and requires any signed tenant claim to match the configured tenant. Agent 365/Entra tokens are rejected. Classic Bot Framework tokens normally carry no tenant claim; for those, tenant scoping also relies on Microsoft's authenticated activity body. A matching body cannot override a foreign signed tenant claim. Trusted in-process relay composition has its own exact-byte verifier and is separate from daemon configuration.

Discord listener exceptions and early completions use abortable exponential backoff from one second to a sixty-second cap. The daemon reports the first failure, an aggregate summary at most once per five minutes, and renewal after a full listener period. A revoked token cannot create a tight login loop or a line for every retry. Gateway intake is best effort until its SQLite receive transaction commits: the SDK forwarder does not retry a failed loopback post, Discord does not redeliver these events, and listener renewal has no session resume. A failed DM lookup, failed intake write, interruption or renewal gap can lose an event. A durable forward queue and resumable Gateway session remain follow-ups; this is not an end-to-end at-least-once transport. Recorded messages retain restart deduplication and ordered admission.

Decision cards are pruned when a fresh Needs you snapshot confirms their read is gone, their thread is gone, the conversation has moved to another thread, or their binding is revoked. Uncertain attempts stay retained while the read still needs a decision, so housekeeping cannot mint a fresh code and repeat the crossing.

The daemon log still needs descriptor-aware size limiting or rotation. launchd owns its open stdout/stderr descriptors; renaming or truncating that file in the channel surface would not reliably bound the writer. This follow-up belongs to daemon logging. Native JWKS cache misses for novel key IDs can still make outbound requests; ingress rate limiting and a bounded negative-key cache are also follow-ups. No raw SDK authentication error is logged.

## Manifest

<!-- generated from backbone.module.json by scripts/module-readme.mjs; do not edit -->
| Field | Value |
| --- | --- |
| id | `io.github.albertoangulo/channels` (surface) |
| version, licence | 0.0.0, Apache-2.0 |
| publisher | Backbone maintainers, namespace `io.github.albertoangulo` (github, pending) |
| stability | experimental |
| provides | Direct messaging channels over the shared Host 0.x |
| consumes | api (projection in, command out, receipt back) 0.x |
| capabilities | planes: personal; effect classes: 3; operations: channels.reply; network: slack-api, telegram-api, discord-api, teams-api; secrets: surrogate |
| data | owns: <home>/channels: identity, intake and delivery journal; migrations: 4; export: The journal stays in the home; Host export does not include channel identities, configuration or delivery history. |
| depends on | @backbone-next/platform workspace, @chat-adapter/discord 4.44.0 (MIT), @chat-adapter/slack 4.44.0, @chat-adapter/state-memory 4.44.0, @chat-adapter/teams 4.44.0 (MIT), @chat-adapter/telegram 4.44.0, chat 4.44.0 |
| conformance | bronze: `packages/surfaces/channels/test/authority.test.ts`, `packages/surfaces/channels/test/concurrency.test.ts`, `packages/surfaces/channels/test/connector-decision.test.ts`, `packages/surfaces/channels/test/deadline.test.ts`, `packages/surfaces/channels/test/delivery.test.ts`, `packages/surfaces/channels/test/direct-messages.test.ts`, `packages/surfaces/channels/test/endpoints.test.ts`, `packages/surfaces/channels/test/empty-errors.test.ts`, `packages/surfaces/channels/test/environment.test.ts`, `packages/surfaces/channels/test/host-recovery.test.ts`, `packages/surfaces/channels/test/host.test.ts`, `packages/surfaces/channels/test/identity.test.ts`, `packages/surfaces/channels/test/intake-recovery.test.ts`, `packages/surfaces/channels/test/intake.test.ts`, `packages/surfaces/channels/test/invalid-final.test.ts`, `packages/surfaces/channels/test/ledger.test.ts`, `packages/surfaces/channels/test/legacy-listener-media.test.ts`, `packages/surfaces/channels/test/limits.test.ts`, `packages/surfaces/channels/test/notice-authority.test.ts`, `packages/surfaces/channels/test/permanent-refusal.test.ts`, `packages/surfaces/channels/test/protections.test.ts`, `packages/surfaces/channels/test/restart.test.ts`, `packages/surfaces/channels/test/sealed-credentials.test.ts`, `packages/surfaces/channels/test/terminal-transaction.test.ts`, `packages/surfaces/channels/test/turn-notices.test.ts`, `packages/surfaces/channels/test/waiting-notice.test.ts`, `packages/surfaces/channels/test/breadth.test.ts`, `packages/surfaces/channels/test/decision-chat.test.ts`, `packages/surfaces/channels/test/decision-durability.test.ts`, `packages/surfaces/channels/test/breadth-boundaries.test.ts` |
| exemption | suite in pnpm check: The focused package suite uses fake loopback endpoints and disposable homes; it runs per package. |
| exemption | removal guard: No programmatic uninstall guard exists for this experimental surface. Preserve unresolved delivery records manually. |
| removal | Preserve unresolved delivery records.; no programmatic UNKNOWN removal guard |
<!-- end of generated block -->
