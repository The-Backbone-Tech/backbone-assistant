# Connectors: the person's MCP servers behind one crossing

The person's own MCP servers serve every engine through the host, never by being switched on inside one engine. Code: `packages/platform/src/connectors/` (discovery, the MCP client, the service), the ToolHost's `connectors()` and `callConnector()` (`packages/platform/src/ports/harness.ts`), and the api methods `connectors.list`, `connectors.refresh`, `connectors.set`, `connectors.decide` and the person-only `connectors.resolveRead`.

## Where servers come from

- **Configs:** Claude Code (`.claude.json` in the person's home folder), Claude Desktop, Codex (its `config.toml`), Cursor, and the app's own list, `<home>/connectors/servers.json` in Claude's `mcpServers` shape. Also the servers of the Claude Code plugins the person enabled: `.mcp.json` at each install folder (an `mcpServers` map or the bare map) and `mcpServers` in its `.claude-plugin/plugin.json`, with `${CLAUDE_PLUGIN_ROOT}` filled in as the install folder, read only inside `$HOME/.claude/plugins/cache` (the same anchored lookup as plugin skills), named `<plugin id>/<server>`. And the servers of the Codex plugins the person enabled (the installs `docs/contracts/skills.md` names, under `$HOME/.codex/plugins/cache`): root `mcp.json` (Codex's portable format, in `mcpServers`) and `.mcp.json` (its compatibility format), the portable one first when both name a server, with `${PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_ROOT}` filled in as the install folder (Codex documents both for a plugin's commands), named `<plugin id>/<server>` (with the version folder when several are present) and known by a hash of that name. A server Codex's own plugin policy turns off (`[plugins."<plugin>".mcp_servers.<server>] enabled = false`) is not read. They are off until enabled, like any other.
- **Plugin servers and credentials.** A plugin's config is third-party text. A plugin server is blocked (`ConnectorServer.blocked`) when a credential, stored or by its shape, is in what its plugin wrote or where it lies: its name as shown (with the version folder when there are several), its key, its install folder and config file paths, every key of its config entry and its plugin's manifests, all as written, and every value of its entry (command, arguments, variables, address). In a value, a `${VAR}` reference is taken out before the shape check, so `--api-key=${API_KEY}` is not a credential, but the referenced name is checked too, and every value is also matched as written against the stored credentials. A blocked server can only be turned off or have its door closed, is never offered, has no door to show (by either id), shows none of its own fields and no refusal names it (including old held actions, whose names, arguments, statement and detail are withheld), and its id is a hash (`<source>:withheld-…`), by which it can still be found; an unblocked server keeps its id, so existing permissions stay. It is checked against the stored credentials read again before each listing, change, call, permission and turn; until they are read, or when they cannot be, every plugin server is blocked.
- **A plugin's server starts nothing until the person enables it.** Not even to list its tools: Settings says "Enable to list its tools", and enabling it is the person's consent to run that plugin's command. Enabling, and any start after it, first makes every check an offer makes: a credential in it, a cache-moving or home-moving variable, and a command, argument or variable value that is or leads into a credential place (each percent-decoded and `file:` resolved before it is checked). A server failing one cannot be enabled and is never started. A plugin server may name its own install folder (though `.codex` and `.claude` are credential places) as a bare path, `--flag=<path>` or `file://<path>`, in an argument or a variable, only where the string reads the same percent-decoded, holds no list or second-path characters and, links followed, stays inside the install folder; a link out of it is a credential place like any other. The person's own configs' servers keep their exception: they may be started to list their tools, under the trust the person gave their own configs, and are never offered when a check fails.
- **A plugin server's permission ends for good.** Once its launch is seen to differ from the one the person enabled (checked before any other reason to skip it), or it is no longer found, the permission and its egress door are removed from the record; the old launch coming back leaves it off until the person enables it again. If that removal cannot be written, the permission stays off for the life of the process.
- **Who reads them:** the host, never an engine. The app's own MCP door entries are left out.
- **Variables:** a server's variables are read again from its config each time it starts. Their values are never stored, shown or logged; the person sees their names.
- **What a started server gets:** the MCP SDK's short list of safe variables, plus the ones its own config names. The app's environment and secrets stay out.

## What the person chooses

### Native connector catalogue

Settings offers Calendar and Drive through workspace-mcp **2.4.1** (MIT), GitHub through the local official github-mcp-server **2.1.0** package release (MIT), and Slack's remote MCP service as a **needs a Slack app** configuration dependency. The catalogue adds no engine or transport API. Its native `Host.connectorCatalogue` methods are supplied by connector-person; its credential boundary requires `ConnectorServiceOptions.keys` to be the Host's own key provider. Missing keys refuse before OAuth, writes or a server start. No ambient plaintext fallback is used.

Main selects an OAuth app JSON through a native picker (`clientId`, `clientSecret`, Google `email`, optional registered loopback `redirectPort`), then asks before sign-in. GitHub's local server accepts the OAuth token as `GITHUB_PERSONAL_ACCESS_TOKEN`; it does not provide a browser OAuth client identity itself. Backbone uses the maintained MCP SDK's authorization-code and PKCE primitives, a random state, an exact single-use loopback callback, bounded token exchange and no code retry. Slack needs an eligible registered app with confidential credentials; no live Slack capability is claimed by fake-server evidence. The browser handles provider consent. App secrets and GitHub/Slack tokens are separately sealed credential handles in the existing vault. Configurations and public views contain no credential value. Expired tokens require reconnecting; there is no silent token refresh or account replacement.

Google retains workspace-mcp's native OAuth bootstrap but uses `WORKSPACE_MCP_CREDENTIALS_DIR` in a separate `connectors/google/<installation>` folder under this data folder. The folder is 0700; workspace-mcp writes its 0600 plain JSON credentials there, including access token, refresh token and a client-secret copy. The native consent text states this plaintext exception directly. The cache path is part of the sealed launch, is denied to connector arguments, and cannot point through a symlink. No shared Google cache or default Gmail cache is read or deleted. Its one fixed setup tool and one fixed verification read are available only to native setup. The validated Google authorization URL goes directly to main's browser handoff; raw bootstrap prose and URLs enter no model or receipt. Google sign-in finishes in the browser, then the person chooses **Finish sign-in** in the app. This setup boundary gives no work-tool permission and opens no egress door.

After sign-in, a native question lists the exact tools and their effective classes. A stamped preset enables read tools or reads plus held effects in one admitted data folder write. Presets never create a read override: they preserve a person's effect narrowing, missing/conflicting annotations, the existing name floor and a dated per-provider read ceiling. Unreviewed names are effects; `start_google_auth` remains unavailable to engines under either preset. Definition changes invalidate the stamp and existing pins. Egress stays closed and no ongoing tool permission is added; subsequent effects use the existing rules for one-call and tool permissions, receipts and unknown outcomes unchanged.

The GitHub installer verifies the platform-specific archive against its pinned SHA-256, retains only the executable and MIT notice, and seals the digest of the verified archive member in the credential bundle only after checking the on-disk executable still matches it. GitHub requires that pin; removing its public mirror cannot bypass verification. The MCP client checks the sealed digest again inside the transport start, immediately before the SDK starts the process. Google is installed into a dedicated venv from the complete exact/hash-pinned wheel set in `packages/platform/src/connectors/catalogue-google-lock.ts`. Its installer requires a native uv in an explicit installation location, CPython 3.13, `--no-config`, `--no-python-downloads`, `--require-hashes` and `--only-binary :all:`; it never resolves uv through PATH or builds source distributions. Google's sealed digest covers only the venv's `bin/workspace-mcp` entry script. It does not cover the installed site-packages or the CPython interpreter; wheel hashes are enforced during installation, not rechecked as an installed tree at launch.

The chosen preset determines requested OAuth scopes and local server mode before consent. Read installations run Google and GitHub with `--read-only`; Slack read scopes exclude `chat:write`. GitHub OAuth apps cannot express private-repository read without write, so this read preset requests only `read:user` and supports public repositories; fine-grained private read needs a GitHub App. Requested scopes are shown and sealed; unconfirmed or broader GitHub/Slack token scopes are refused and the issued token is revoked. Google cache token scopes are checked against the sealed preset before credentials reach the server and again after the sign-in verification read; unconfirmed or broader scopes refuse finishing and trigger disconnect and revocation. Changing the preset requires disconnecting and reconnecting, rather than reusing broader credentials.

Existing connector configuration, unrelated entries and JSONC comments survive installation. A separate content-free installation index locates an installation even when the public server entry is deleted or malformed. Index envelopes are validated and must match their provider key. Neither an index nor a public handle proves ownership: disconnect requires the resolved sealed bundle to match the requested provider and installation before reading tokens, removing folders or revoking any handle. Cache paths reject invalid installation IDs before joining any path. Disconnect unconditionally stops the cached server and disables its stored choice, attempts one provider revocation (Google refresh token, GitHub application token endpoint, Slack `auth.revoke`), deletes the isolated Google cache and its installation venv, and locally revokes that bundle's vault handles. Local removal continues if the provider answer is lost. The returned receipt and retained local setup record distinguish `revoked`, `unknown` and `not-needed`; unknown outcome is never retried automatically. Google may revoke other tokens for the same account and OAuth app. Failed later install steps also attempt provider revocation. Only an unchanged public config entry is removed; person edits are retained. Disconnect leaves previously recorded sources alone; withdrawing them still uses the existing material lifecycle and derivative-withdrawal rules.

The 11 November 2026 probe read Calendar/Drive's annotated source definitions (7/16 service tools) and the pinned local GitHub executable's live default list (46 tools: 27 read hints, 19 effect hints), without a real account. Calendar has 3 read hints and Drive 7; Drive's `get_drive_shareable_link` is explicitly in the effect ceiling and is also caught by the released name floor. Slack's anonymous tool list returned 401, so its actual annotations remain unverified. Source owners: [workspace-mcp package release](https://github.com/taylorwilsdon/google_workspace_mcp/tree/v2.4.1), [GitHub package release](https://github.com/github/github-mcp-server/releases/tag/v2.1.0), [Slack MCP requirements](https://docs.slack.dev/ai/slack-mcp-server/). Fake OAuth/server tests establish local composition only; the catalogue journey retains its real-use requirement and partial evidence.

- **Giving authority is the person's choice, confirmed in a native dialog of the desktop app.** This covers turning on a server or tool (`Host.enableConnector`), opening sending, permitting an action, treating a tool as a read (including resetting an effect override back to an annotated read), and permitting it to act without asking. The dialog names the server as the person knows it; for a tool it also shows its name, description and whether it reads or changes things. Cancellation gives no permission. Over the api only what takes authority away is accepted: turning off a server or tool, closing sending, ending a permission, counting a tool as an effect or discarding a call. Enabling is refused in fixed words without looking up or naming a blocked server. The api line, local gateway door and MCP door do not expose connector settings, including disabling; this rule does not add a route to them. The CLI has no connector-enable command or person-presence exception for one. Existing enabled choices remain enabled on upgrade; there is no revocation migration. A server from the person's own config is listed before enabling; a plugin server is enabled before listing, because listing starts its command.
- **Enabling registers the server in the core** as the person's own connection (`gov.register_connection`, scope `person`), which the core treats as private material. Each listing is recorded with `gov.record_connection_tools`.
- **Pinning.** Enabling a server pins how it starts: transport, command, arguments, address and variable names. Enabling a tool pins the complete definition returned by the MCP client, before credential redaction: name, title, description, input and output schemas, annotations and retained metadata. The raw text is not stored; its digest distinguishes definitions even when they look the same after redaction. If either pin changes, the tool is off until the person enables it again. One live listing that finds a changed or missing definition ends its permission and any read override immediately, even if a later refresh restores the old definition. Duplicate tool names are ambiguous and cannot retain authority or pass call validation.
- **Read or effect.** The effect-name list is the classification floor because connector annotations are untrusted. It retains substring matching on the joined, lowercased name and the released word-edge stems. A non-ASCII letter in the original name, or a character outside `[A-Za-z0-9_.-]` after NFKC normalization, also makes the tool an effect. Neither server hints nor a stored override can lower that floor, apart from the narrow annotated-read exemption below. Tools whose names begin with webmcp_ always count as effects, including with a read override: their page-provided annotations cannot confer read authority. This floor applies on every server, so relaying a page tool through another launch cannot remove it. An unannotated tool still defaults to effect. Titles and descriptions do not replace the name for classification or routing.
- **One annotated-read exemption.** The server must say `readOnlyHint: true` without `destructiveHint: true`; the name must split by separators or camel/acronym case; its first word must be a known leading read verb; its only released blocklist hits must belong to one noun-list word that is the last word; and no connective word may occur anywhere. A person override to effect still wins. Joined names, inflections outside the noun list, digits attached to a read verb or noun, a noun in the middle, repeated hits and a stem spanning into the noun do not qualify. This exemption affects classification only. The name list has no consequence for permissions.

The lists are explicit:

- Released joined-name stems: send, reply, forward, delete, remove, trash, destroy, purge, wipe, erase, payment, purchase, transfer, refund, withdraw, publish, tweet, invite, broadcast, submit, deploy.
- Released word-edge stems: pay, buy, order, charge, post, share.
- Nouns allowed only in the final word of the exemption: post, posts, order, orders, share, shares, reply, replies, forward, forwards, payment, payments, purchase, purchases, refund, refunds, tweet, tweets, invite, invites, broadcast, broadcasts, charge, charges, trash.
- Known leading read verbs: get, list, search, read, fetch, find, count, describe, show, view, lookup.
- Connectives that prevent the exemption: and, then, to, with, or, plus.

The examples assume a read-only annotation and no person override. The final column
is name-list membership, not a send prohibition. The list has exactly one policy
job: it prevents untrusted server hints from making a named effect a read, subject
to the narrow leading-read/final-noun exception above. Names, titles, annotations
and argument flags cannot give authority. An effect is dispatched only on a person's
exact permission or its tool's ordinary permission. Keys such as `send`, `publish`,
`notify` or `broadcast`, even nested, are data and do not add another permission
class or veto. Independent credential-path checks and exact argument binding remain.

| Tool name | Classification | Name on effect list |
| --- | --- | --- |
| `send_email` | `effect` | `true` |
| `post_message` | `effect` | `true` |
| `order_item` | `effect` | `true` |
| `email_send` | `effect` | `true` |
| `get_post` | `read` | `true` |
| `list_orders` | `read` | `true` |
| `postpone` | `effect` | `true` |
| `get_and_send` | `effect` | `true` |
| `list_then_delete` | `effect` | `true` |
| `read_post_and_publish` | `effect` | `true` |
| `get_share` | `read` | `true` |
| `search_payments` | `read` | `true` |
| `describe_charge` | `read` | `true` |
| `read_invites` | `read` | `true` |
| `fetch_replies` | `read` | `false` |
| `find_purchases` | `read` | `true` |
| `count_refunds` | `read` | `true` |
| `show_tweets` | `read` | `true` |
| `view_broadcasts` | `read` | `true` |
| `lookup_forwards` | `read` | `true` |
| `email_post` | `effect` | `true` |
| `posts` | `effect` | `true` |
| `charge_card` | `effect` | `true` |
| `reply_all` | `effect` | `true` |
| `get_delete` | `effect` | `true` |
| `get_transfer` | `effect` | `true` |
| `getPost` | `read` | `true` |
| `listOrders` | `read` | `true` |
| `email.send` | `effect` | `true` |
| `SEND_email` | `effect` | `true` |
| `remove-item` | `effect` | `true` |
| `payment_status` | `effect` | `true` |
| `sendemail` | `effect` | `true` |
| `postmessage` | `effect` | `true` |
| `reorder` | `effect` | `true` |
| `buynow` | `effect` | `true` |
| `chargecard` | `effect` | `true` |
| `search_replies` | `read` | `false` |
| `getPayments` | `read` | `true` |
| `show_share` | `read` | `true` |
| `get_refund` | `read` | `true` |
| `fetch_and_forward` | `effect` | `true` |
| `read_and_reply` | `effect` | `true` |
| `list_then_post` | `effect` | `true` |
| `show_share_now` | `effect` | `true` |
| `lookup_charge_card` | `effect` | `true` |
| `get_refund_and_pay` | `effect` | `true` |
| `getPost2Send` | `effect` | `true` |
| `get_publi_share` | `effect` | `true` |
| `get_post_post` | `effect` | `true` |
| `get2_post` | `effect` | `true` |
| `get_post2` | `effect` | `true` |
| `resend_invoice` | `effect` | `true` |
| `autosend` | `effect` | `true` |
| `sends` | `effect` | `true` |
| `sending` | `effect` | `true` |
| `deleteall` | `effect` | `true` |
| `bulkdelete` | `effect` | `true` |
| `deletes` | `effect` | `true` |
| `removeall` | `effect` | `true` |
| `unpublish` | `effect` | `true` |
| `redeploy` | `effect` | `true` |
| `resubmit` | `effect` | `true` |
| `payinvoice` | `effect` | `true` |
| `repay` | `effect` | `true` |
| `wipeout` | `effect` | `true` |
| `withdrawal` | `effect` | `true` |
| `get_and_post` | `effect` | `true` |
| `get_then_post` | `effect` | `true` |
| `get_to_post` | `effect` | `true` |
| `get_with_post` | `effect` | `true` |
| `get_or_post` | `effect` | `true` |
| `get_plus_post` | `effect` | `true` |


The full-definition digest recursively sorts object keys before hashing. Array order and every JSON value remain significant. A record without a full digest is upgraded only when the live tool's legacy hash (name, title, description, input schema and annotations, with the old redaction and ordering) matches its stored pin. The Host re-pins that same local choice, permission and retained held approvals under the data folder lock, with write admission. The permission UUID, seal, data folder, override and revision stay unchanged. This representation upgrade records nothing in Core; a refresh containing only compatible re-pins also skips the redundant catalogue write. Core's original permission history retains the digest recorded when it was given. If the legacy hash differs, the tool is disabled and its permission ends with `definition_changed`. A pre-canonical full pin can likewise upgrade only when the complete previous digest matches; it never falls back to the narrower legacy comparison. When the legacy hash matches, the first listing after upgrade adopts `outputSchema`, `_meta` and text hidden by redaction once, because the legacy hash did not cover them.

The pin checks the definition the server advertises, not its implementation. MCP listing and calling are separate operations: the server can change behavior after the last listing or lie under an unchanged, harmless-looking name. Closing that boundary requires a Host-owned read allowlist or a protocol that binds execution to an immutable reviewed revision; hints alone cannot prove that a tool only reads.

- **One question for a server’s tools.** The server row’s **Turn on its tools** offers the first eight off tools, sorted by name, in one native **Turn on these N tools** question. It lists each tool’s server annotation and effective read/change behavior; the server must already be enabled and listed. One required stamp binds the exact names, full definitions (including text beyond the preview), launch and choice revisions. A mismatch before the one synchronous write under the data folder lock turns on none of the set. Other tools remain off; repeating the action reviews the next group. This gives no sending permission, override or permission. Single switches retain the single-tool question.
- **Native text is bounded.** The app’s decisive sentence comes first in every connector question. Server-controlled names and titles are clipped to 120 characters, descriptions to 600; batch descriptions use 120. Small calls show the complete quoted statement and JSON arguments, with hidden characters represented by reversible JSON escape sequences. Short recipient, subject and ID fields come first. Above 1,500 JSON characters of arguments, any value over 600 characters, or an oversized statement, the native permission question is explicitly a bounded preview: it shows short fields, the argument hash and JSON length, and directs the person to the full call in Connected tools. It does not claim that this preview is complete. Controls and directional formatting are removed, with a visible ellipsis when clipped. Raw identifiers and full definitions still identify the permission, and permission questions put the app’s own decisive sentence before the exact small-call display or the clearly labelled large-call preview. Only the exact fixed cancellation receipt for that action is hidden; every other refusal is shown.

## Person-choice stamps and permission identity

The service accepts an optional top-level enableStamp on set(), obtained from
its read-only enableStamp(serverId, tool?) helper. Inside change(), before changing
a choice, it checks the complete launch, catalogue definitions, classifications and
choice revisions. Its opaque stamp uses an ephemeral per-service HMAC key, so it
exposes no guessable credential digest and writes no home key. A new Host needs a
new question. Trusted direct service callers may omit this optional stamp. The desktop composition requires its native question stamp and passes a synchronous validation callback into set(), which checks it again inside change() before any enabling mutation; it does not wait on Core under that lock.
All tool lookups require an own property, including a real tool named __proto__;
prototype properties cannot stand in for tools or be changed through a choice.

A tool's standing view optionally exposes its Core id. Each held action exposes
standingSignatureId from its immutable approval, never the current tool permission
or a timestamp guess. Historical calls retain that identity after replacement or
ending, including failed and unknown outcome results. Listings expose optional
signatureEndings.pending and signatureEndings.conflicts as local Core UUID queues;
malformed identifiers withhold that projection. Empty arrays show drained local
queues, not proof of a Core end. No seal, data folder, claim token or internal approval is
published. Credential-blocked fields remain withheld and listing queries no Core.

The stored-only endStoredSignature helper removes local authority and retains its
pending Core end under the admitted data folder lock, even if Core or discovery is
unavailable. Its receipt says only ended locally. The native Host wrapper waits for ownership rather than Core, preserves closing/read-only/import guards and renders local ending separately from pending Core ends or conflicts. This does not make cold app startup or listing independent of Core.

## A call

- **A read** uses an exact native invocation identity. Pi reserves the assistant message's connector call IDs in a private durable batch before execution. Codex supplies the acknowledged native thread/turn tuple and native call ID. Arguments, names and display counters never identify an observation: two legitimate calls with identical arguments remain distinct.
  - The private journal retains the observation, material ID and registration key before dispatch, then marks dispatch before the single SDK call. Reopening or reconstructing a transcript never resends a dispatched call. Missing legacy protocol history does not prove that no call happened. Resuming a turn with connector dispatch history does not restart its producer.
  - Only an SDK call that resolves with a tool result supplies an observed answer, including `isError` and empty results. A rejected exception, its class, code or wording is no proof of a remote result; SDK protocol errors can also arise locally. A dispatched call without a verified retained result stays unknown outcome, creates no fabricated server source and stops automatic continuation. No catch path repeats it.
  - Before an observed result can be handed over, its exact response is retained locally, then kept once as a managed original with `MaterialEntry.fromServer` and a pending observation marker. Pending originals are withheld from ordinary lists, projections and explicit agent reads. Replays verify their exact ID, provenance, metadata and immutable bytes; they never overwrite a conflicting or partial original or reset later lifecycle decisions.
  - The trusted Host records the episode and preparation binding atomically with `gov.record_material_source_read`. Its transaction verifies the actual run holder, fence, mandate standing and receiving audience before using the system recorder. Core's deferred ALWAYS trigger rejects all raw MCP episodes and reserved `material:` file episodes without their own typed live binding. This is **live at validation**, including explicit early constraint validation; it is not a universal live-at-COMMIT guarantee or a continuing permission.
  - The retained original and episode use a versioned JSON envelope; the prepared value is the versioned JSON projection of the Host's structured result. Their hashes describe those distinct renderings, not raw wire bytes or proof that an adapter/model received them. JSON escaping preserves control characters without putting an unsupported NUL into PostgreSQL text. File readers separately verify original bytes and their selected rendering; callers cannot supply arbitrary prepared text or authorship.
  - Tentative episode/receipt IDs are synchronously flushed to the private journal before Core COMMIT. A lost reply stays unknown outcome. A positive tenant-scoped ledger witness can confirm only those retained historical IDs; its absence is not proof of rollback. Registration-only recovery preserves the original key and payload and never calls the provider. Every actual handover still checks current authority and source state.
  - Registered MCP originals remain managed documents in the app; registration does not automatically project them into the project folder. This continues the existing `fromServer` managed-original behavior in base `70c6d0e`, rather than removing an earlier folder projection.
  - A registered original remains untrusted server data and as private as its connection when later read, never the person's words. Withdrawing it retains its history and queues the exact immutable withdrawal for Core. A receipt or outbox acknowledgement never restores access. Knowledge promotion/recall continues to withhold material while the separate decision/use closure is completed.
  - Export does not yet preserve native connection lineage. Restore imports unauthored material under fresh file checks, without native run, connection, observation or receipt permissions. Archive checksums do not authenticate that missing lineage.
  - An observed result has status `complete`, `partial`, `rate-limited` or `failed`. Only `complete` may support “nothing there”. A timeout or transport failure without a verified retained result stays unknown outcome; a local preparation/listing failure is a refusal, not a server answer.
- **A pending read needs the person's choice.** Stop and resume never register it automatically. The original run remains open while an observed response needs a decision; its source stays withheld. A response-less unknown outcome can already have a finished native run: it still has a discard-only card and is never resent. Person-side run closure is more conservative and refuses to close while any neighboring unresolved observation remains.
  - **Reconcile** records only the already retained historical response under the same original run and its current native holder, with verified enforcement and a fresh home-lock/close signal. A dead claim may be reclaimed only for that exact run and carrier. Another active carrier, stale authority, changed source or uncertain outcome leaves it pending. It starts no producer, replacement run or provider call. An unknown outcome also conservatively covers an unconfirmed native lease, claim or admission: it does not assert that registration or a provider call took place, or that no native effect occurred.
  - **Discard from agent use** preserves responses, IDs, tentative and confirmed receipts. Existing retained material is withdrawn locally and its outbox preserves the withdrawal. A lost COMMIT may have registered the episode, so Core history remains confirmed or unknown outcome: discard never claims that registration did not happen. Inert retention without an original or Core attempt stays private. No source is published and no history or tombstone is erased.
  - These actions appear in Needs you and use the person-only `connectors.resolveRead` API. They are absent from ToolHost/model tools and the agent API line. Closing the original run is a separate confirmed outcome: other pending observations, effects, custody or checkpoints prevent it, and a lost finish reply is not success.
  - A user Stop can still retain a response already observed. Host shutdown cancels response-retention lock admission so a closing lock holder cannot wait on its own worker; every response arriving after Host close starts stays unretained/unknown outcome, even when the data folder lock is free. This does not prove no remote response existed. No late response is handed over or resent. A zero physical-lock wait is not an alternative: the in-process data folder lock queue can still wait, so shutdown cancels admission instead.
- **An effect** is sent only through the egress door below. By default it is held for the person and sent on their permission for that one call. For a tool the person has signed (the permission below), it is sent at once and nobody is asked per call.
  - It is proposed in the core as `mcp.<connection>.<tool>` at class 5, which always waits for a person (`sec.route_effect`). It goes under a short run of the host's own direct permission, because an engine's run may carry only the operations its piece declares.
  - The same call from the same turn is the same held action.
  - The person answers on the exact statement, which names the tool, the server and the arguments verbatim, checked by its args hash.
  - A permission is recorded (`gov.answer_decision`). Discard denies it.
  - **The permission** (the maintainer’s owner direction, 9 November 2026: autonomy inside a permission is the default he asked for; every effect waiting for the person was never his request). The person permits one tool once (Settings › Connected tools › Without asking; `electron/connector-confirm.ts` `confirmStanding`, host method `signConnectorTool`). From then on a call to that tool is proposed in the core exactly as before, the host records the person's approval through `gov.answer_decision_with_basis`, whose structured basis names the Core-generated permission UUID, and the call goes out through the same door, once, with the same checks and the same DONE, FAILED or unknown outcome. The engine is told what happened (`ConnectorResult` `SENT`), the held-calls record marks it (`HeldCall.standing`) and no per-call permission decision is added to Needs you. A call the person released by hand is never reported as the permission's.
    - Its life is now in the Core too: `gov.give_connector_signature` records the person, connection UUID, registered tool digest and opaque definition digest before the connectors file can contain usable authority. Ending removes local authority and durably queues its Core end before `gov.end_connector_signature`. Lost replies are retried idempotently for ends; a lost give reply leaves an unused Core grant, never local authority without a ledger row. File-only signatures from older homes are removed and must be signed again. See [the signature ledger contract](standing-signature-ledger.md) for exact checks, old-answer interpretation and the pending owned-open integration.
    - What one signature covers: one tool, as defined when signed, on the server as it started when signed (the door's seal, which includes the account and settings in its configuration), in the data home it was given in (its real path), while the tool and the server are on and the door is open. Whether it applies is decided from the record and the server as it is at that moment, every time; nothing is cached.
    - While any of that differs, the signature does not apply: it is not shown as signed and each call waits for the person. If what is there becomes exactly what was signed again, it applies again, because that is what the person signed. A different launch or account temporarily suspends the signature. Reconciliation permanently retires a signature whose server is absent from discovery, or whose home moved; an absent server includes a configuration that could not be read. Reopening then requires a new signature. Merely viewing the settings does not reconcile the file.
    - What ends a signature for good, in the record: the person ending it; turning the tool or the server off; closing the door (opening it again brings none back); a listing that finds the tool's definition changed; changing what the tool counts as; a plugin server's grant ending; removal from discovery; moving the home; or replacing the signature. Each Core signature ends with one enumerated reason.
    - The click signs what was shown. Main reads the server, the tool's description, the seal and a stamp in one reading (`Host.connectorToolView`, a method of the Host object that the api, the MCP door and the renderer cannot reach). The signing view also exposes up to twenty unique input-schema property names (nested and alternative schemas included), cleaned, credential-redacted and clipped to 120 characters, plus the number of remaining names. A property matching the released sending-argument rule adds the plain warning “This tool can also send, publish, post, share, deliver, notify or broadcast, depending on its arguments.” Matching is checked across all names, including ones beyond the visible twenty. These are information for the native dialog, never a veto or a claim that the server is safe. The stamp covers the seal, the tool's definition and kind, and the revision of the tool's and the server's choices. Revisions come from one counter per home that only grows, so no change of choice, and no tool or server removed and found again, reproduces an earlier stamp. Under the lock the signature is refused unless seal and stamp still match.
    - Whose word releases a call is written down first. The host reads the Core's state outside the home lock, then takes the lock to settle and persist the immutable word (the person's own release of this call, or one named signature standing at that moment). It releases the lock before answering the Core. The Core checks that signature's current life when answering, and the Host checks local authority again before every send; an intervening end never sends a call on the ended signature. Once the core has been answered, the written word is the one the call goes out on, whoever asks later: an automatically released call approved on a signature needs that same signature at every check of the send (the last with nothing awaited before the call), and a later signature for the same tool does not stand in for it; one the person released by hand goes out as theirs. A word once written for a call is never replaced or erased, whatever the core shows at that moment: an answer whose reply was lost can still commit, so the call goes out on the written word or is cancelled. Automatic continuation of a call written on an ended signature is cancelled in Core and the engine is told to ask again; it is never sent on a later signature. A call is never shown as ended while the core still holds it open: a discard cancels it in the core first (also when it was already claimed for dispatch) and is recorded as discarded only when the core says rejected or cancelled; if another process had begun to send it, the core's own outcome is recorded instead, and a send that could not go out and whose cancel the core did not take leaves the call waiting, to be released or discarded again.
    - A listing overtaken by a later listing of the same server, or by a change in how the server starts, is not applied to the person's choices, which is what decides what may be sent. That holds within one process; two processes listing the same server under the same launch are ordered only by the home lock, so the older listing can land last, turn a changed tool off and end its signature, which costs the person a click and sends nothing. Known limit: the core's catalogue of the server's tools is written before that check under the lock, so an overtaken listing can still overwrite the catalogue with an older one until the next listing; it grants nothing.
    - Saved changes carry a version. Local choices are read under the home lock. Core verification, signature give/end and decision crossings never wait under that lock. After any wait, a candidate change takes the lock again and is saved only if the file version is still current; otherwise it is recomputed. An overtaken Core give can leave an unused ledger row, but cannot overwrite a later local end. The Kernel lock retains exclusion even when its process pauses, and every synchronous save checks home write admission immediately before writing.
    - Two ordering windows fail closed. First, a re-sign can commit in Core and supersede the old signature, then lose its local version check to another change and have its retry refused. The old signature can remain in the local record, but Core rejects it as revoked; it cannot dispatch. A fresh person-side signature is needed to restore usable authority. Second, a standing approval can reach Core after the signature ended locally but before the queued Core end arrives. Core can record the approval, but the send checks local authority and cancels without dispatch. That cancellation carries the fixed reason “The standing signature ended before sending. Nothing was sent.” Core keeps those readable words in the effect's cancel reason; the released ledger format retains their keyed digest, linked by the effect ID. A standing approval followed by that cancellation is an unsent call, not a successful dispatch.
    - Accepted limits. A whole data home copied with its seal key to the same path on another machine, with the same server configuration, keeps its doors and signatures; `backbone` export and restore carry neither. An account the server switches to through its own sign-in, with no change in its configuration, is not detected, as for the door. A change in the instant after the last check of a send is not seen. A trusted caller inside the Host process can read a stamp; the boundary is the process, as for every other person-only method.
    - The signature uses the seal the person was shown in the app's main process. The api's `connectors.set` accepts `standing: false` to end it.
    - A read-only turn (a reviewer, a judge) is still refused. A call that cannot be released (the core unreachable, a decision already running) stays waiting; it is never sent twice.
    - New signatures have one meaning for every effect tool: all its defined arguments, including sending flags. Each carries coverageVersion 1 and its original signedDefinition locally. The existing Core give crossing has no metadata parameter, so its opaque definition digest binds the version together with that original definition (without a schema change); the service verifies that binding before using expanded argument coverage. A local marker alone cannot upgrade an old plain grant. Existing UUIDs, pins, seals and history remain unchanged. An unversioned plain signature keeps the released sending-argument rule, including nested flags, false-like values and its depth bound: calls outside that reach are held with an explanation that the signature predates sending-argument coverage and signing again covers it. The person can release one such call or sign again knowingly. Unversioned blockedToo signatures retain the argument reach already given to them; the field gives no additional authority to new signatures. The former product function refused plain listed-name grants before giving them, so none legitimately exists to widen. Unsigned tools, changed definitions, closed doors and credential paths gain no authority.
    - Cost, stated plainly: text an engine reads in the same run can lead it to call a signed tool, and nobody sees that call before it goes out. The receipt, the record and the tool-by-tool signature are the controls; the core's class-5 decision is still recorded, with the person's standing word as its answer. A general person-selected policy that narrows a new signature by arguments or by what the run has read is not built (see Not yet).
  - **The displayed statement binds the dispatch.** Before answering Core, the service compares the retained argument hash, complete JSON arguments and statement with Core's immutable proposal. Dispatch retains an isolated copy and checks the current local statement and arguments again after every wait, including immediately before the SDK call. A changed statement or arguments refuses dispatch; an argument flag cannot bypass these checks. A caller mutating its own object or a displayed view cannot change the retained copy.
  - **Gmail sends contain only displayed message content.** The platform rule for
    the reviewed workspace-mcp 2.3.0 Gmail launch accepts only its audited tool set.
    The stable `gmail-send` server identity also refuses a changed launch or transport;
    a pin bump or an added tool needs a new review before it can run. Other servers
    do not inherit a Gmail rule merely by reusing a tool name. On this connection,
    `send_gmail_message` accepts a new plain-text message: explicit `to`, nonblank `subject`
    and `body`, optional `cc`, `bcc` and inline base64 `attachments`. Each attachment
    has only `filename`, `content` and optional `mime_type`; malformed encodings,
    header newlines, URL/path sources, mixed sources and unknown fields refuse.
    The required upstream `user_google_email` routing identity stays visible.
    The Host sets `include_signature: false` before proposal, argument hashing and display;
    a caller cannot request true. New replay keys use normalized arguments with
    canonical field order, so omitted and explicit false controls share one send.
    Original keys and normalized historical content are consulted only to find
    existing receipts, never to grant a fresh dispatch identity. Every other upstream content-control field is
    refused, including forward/reply/thread/reference, sender/format/direction
    fields, even when false or null. This prevents server-side resolution of
    unseen content. The rule runs before proposal and again before release and
    dispatch, including historical held statements; an older statement lacking
    the fixed false control is not rewritten or released. Known Core outcomes
    are returned before inspecting a historical waiting record, preserving honest
    unknown outcomes and no replay. Tool permissions do not bypass the rule.
    The implementation is `packages/platform/src/connectors/gmail-send-arguments.ts`;
    [Gmail setup and named follow-ups](../how-to/connect-gmail.md#known-gmail-follow-ups)
    retain the separate full-read local-write and duplicate-intent limits.
  - **A fresh one-time permission is one call.** It can permit a listed send and can permit an unsent call previously approved on a permission while that tool is paused. For the latter the service first cancels the original Core effect with the fixed reason `Replaced by the person’s release of this exact call. Nothing was sent on the standing approval.` It then proposes the exact same statement and arguments as a new effect, answered with checked basis person. The original standing answer remains immutable history, and the returned receipt identifies the new effect. There is no transient dispatch bypass. If dispatch already began, cancellation cannot succeed and no replacement is permitted. Before proposing, a stable replacement ticket is durably retained on the original. Core assigns the effect UUID during the proposal; the ticket lets the next call find and cancel an interrupted orphan before proposing identical work. Recovery never dispatches that orphan. A crash or lost reply during replacement fails closed and can require a fresh call; local hints never authorize continuation. Audit export projects the checked approval method, so an auditor can distinguish both acts. The original call with an unknown outcome itself is never resent or automatically resolved.
  - **Only the person** opens a door or permits a call: the desktop app's main process shows them the server, or the exact statement, in a native dialog and takes the click (`electron/connector-confirm.ts`, host methods `openConnectorDoor` and `releaseConnectorCall`). Over the api, the MCP door and the line, `connectors.set` refuses `egress: true` and saying a tool only reads when its own annotations do not (`markConnectorToolRead`, asked in main too), and `connectors.decide` refuses `release`; only taking authority away (closing, turning off, discarding) goes there. A released blocklisted name is an effect unless its server-annotated read meets the narrow final-noun exemption above. The door opens only on the seal the person was shown: a server whose start or account changed while they were asked is not opened.
  - **The egress door** (D2) is opened per server (Settings › Connected tools › Allow sending), only on a server that is on as it starts now, and sealed with a keyed hash of everything it starts with, its variables' and headers' values included (the key stays in the data folder). Turning it off, a change in how it starts, or another account under the same names (the seal no longer holds) closes it. With the door closed, a permitted call is cancelled with those words and nothing is sent.
  - With the door open, a permitted call is carried out once as the core's dispatcher (`gov.claim_effect`, `begin_dispatch`, the call, `observe`), only to the tool definition and server start it was held against, and only while the door and its seal hold. All of that is checked again after every wait: after the claim, and after the begin with nothing awaited before the call (a change there is observed as not done). A verified success makes it `DONE`. Only a Host check that establishes nothing was sent can record a known non-delivery. After invoking the server, every error reply makes the effect `UNKNOWN`, including a refusal, input-validation message, missing snapshot reference, rate limit, timeout, destroyed execution context, closed target or connection reset. MCP error prose cannot prove that no partial effect ran; the Host does not infer `FAILED` from it. The observed-result flag, redacted text and read status remain intact. A timeout on a disabled button also stays `UNKNOWN` even when the local fixture establishes zero submissions: the generic connector has no verified pre-action delivery signal. This deliberately pauses that tool on that connection until the person resolves the outcome, an availability cost accepted to prevent duplicate effects. Without a verified result, the effect is `UNKNOWN` and is never sent again. One decision runs at a time per call, and a call found past its decision (after a crash, or carried out by another process sharing the data folder) is reported from the core's status, read again after any claim, begin or cancel that did not go through, never as unsent.
  - The name list retains its joined-name substring matching and word-edge stems for classification. A listed name does not veto the person’s permission for one call. A person's one-time permission or the tool's continuing permission lets an effect out through its open door. The first real use is a Gmail draft (`draft_gmail_message`); the Gmail server is started with its send tool off, so no permission can send mail in that configuration.
  - What is shown and recorded of a server hides credentials in its address (user, password, query values, credential-shaped path segments) and arguments (the value of any flag naming a token, key, secret, password or auth, and credential-shaped values), and every session hides those same values from all the server says.
  - **Credential places stay out of reach of a call.** An MCP server reads with the person's own rights, outside the engine's sandbox, so a call whose arguments name or lead to a place in `CREDENTIAL_PATHS` (the person's keys, sessions, keychains and MCP servers' OAuth caches) is refused at the call and again at permission (`connectors/credential-args.ts`). The check covers absolute, `~`, `file://` and percent-encoded paths, relative segments, any case, and links followed to the nearest folder that exists. A stdio server's relative paths are resolved in its own folder; for an HTTP server, whose folder is unknown, a relative path with a folder in it is refused. A server started in, or with an argument naming, a credential place is never offered. A cache moved by `WORKSPACE_MCP_CREDENTIALS_DIR`, `GOOGLE_MCP_CREDENTIALS_DIR` or `MCP_REMOTE_CONFIG_DIR` in the app's environment is denied too; a value that cannot be denied exactly stops the full engine. A server whose own config sets one of those, or its own `HOME` or config folders, is never offered.
  - Accepted limit of that check: a bare name (`user.json`) is passed as it is, so a file-reading server that serves files from a root it chose by other means (an HTTP server's own folder or setting, or a stdio server's root set by a variable) can read a file by that name if that root is, or links into, a credential place. Nothing here can see such a root. Enable a file-reading server only with a root outside credential places. The Gmail server reads no files by name.
  - Accepted limits: the seal binds what the server is started with, not credentials it keeps itself (an OAuth cache, a credential file): a server that switches accounts through its own store is not detected, so a door is opened only for a server the person trusts with that account. And a server can echo a secret it holds that is in none of its config.
  - Automatic review by a model or a rule set in place of the person's permission (D2) is not built. What is built is the person's own permission per tool, above; a tool they have not signed still waits for them on every call.
- **Engines.**
  - Pi offers each enabled tool as a model tool.
  - Codex gets them as app-server client-side tools (`thread/start` `dynamicTools`). A `item/tool/call` for anything not offered at thread start fails the turn closed.
  - In both engines, `SENT` with state `sent` is a successful tool result. State `failed` is an observed error result the model may read and continue from. State `unknown` ends the turn's autonomous work through the same stop mechanism as a read's `UNKNOWN`: Pi aborts the remaining batch and prevents model continuation; Codex interrupts its native turn and prevents further connector dispatch and draft import.
  - The Host marks that turn stopped and shows its connector detail in the answer, including the instruction to check an unknown effect at the provider. The unknown effect stays in the held-call record and is never resent. It creates no read observation, `connectors.resolveRead` action or pending producer run. Needs you can show the ordinary stopped-work notice, cleared by archiving the thread; it creates no connector decision. A read's unresolved observation retains its separate reconciliation/discard behavior above.
  - A read-only turn (a reviewer, a judge) is offered reads only.

## Private retention and paused readers

The raw private thread journal is not copied by portable backup export. It retains connector request/response history locally, including full retained response renderings, and is parsed at open and during person decisions. SDK text rendering is bounded per response; the journal's accumulated size is not bounded by that limit. Growth bounds or compaction remain follow-up work and must preserve original invocation IDs, uncertainty, receipts and terminal discard history. This is private retained rendering, not a wire transcript or a model-delivery receipt.

The sql-v08 document door deliberately refuses typed source reads until its receipt path is qualified. Consequently `children.merge` historical reads and stub/scripted turns with sources also pause through that door. It supplies no raw-text fallback or fabricated receipt; its existing writes and recovery remain separate.

## Tests

`packages/platform/test/connectors-signature-ledger.test.ts` (Core ids, end paths and interrupted writes), `signature-ledger-host.test.ts` (ledger-only reconstruction), `signature-ledger-upgrade.test.ts` (released histories and old answers), `packages/core/test/signature-ledger.test.ts` (basis spoofing), `packages/platform/test/connectors.test.ts` (including "a permission"), `connectors-turn.test.ts`, `connectors-standing-turn.test.ts` (a whole Pi turn under a permission), `connectors-plugins.test.ts`, `codex-plugins.test.ts` and `connectors-gmail.test.ts`, and `packages/modules/harness-codex/test/harness.test.ts` ("client-side tools"). Typed preparation and private observation controls also live in `packages/platform/test/material-file-read.test.ts`, `connector-material-read.test.ts`, `connector-observations.test.ts` and `connector-read-decisions.test.ts`; native enforcement and timing are graded by `packages/platform/test/material-enforcement-native.test.ts`. Offline protocol tests do not establish native SQL authority, physical power-loss durability or model receipt. HTTP response-loss and actual `Last-Event-ID` replay are covered by `packages/platform/test/connectors-http-loss.test.ts`: the destination count is observed independently of the receipt.

`packages/platform/test/connectors-engine-unknown.test.ts` drives both engines through the real connector service and local fake MCP server for signed `sent`, `failed` and `unknown` effects. `packages/platform/test/connectors-unknown-host.test.ts` checks whole-Host Pi closure, the visible detail, the closed producer run and the distinct, clearable Needs you states for an unanswered read and effect. Each engine's `test/connector-effect.test.ts` also checks its connector result boundary without Core.

## Client retry and resumption profile, 5 November 2026

The current single-call configuration explicitly selects the compatibility handshake and disables
automatic input fulfilment. This preserves its supported wire behavior while making the SDK policy
deliberate: an approved effect must not become additional `tools/call` requests through an interactive
round or automatic tool-version recovery. The SDK's documented defaults and modern retry paths are
implementation details to recheck on dependency changes, not authority to execute again.

Reading a replayed response through a `Last-Event-ID` GET does not reissue the tool. A recovered
terminal result can establish success; an unrecoverable response remains unknown outcome. The tests distinguish
those cases and an untrusted nonterminal input request. They do not prove exactly-once execution
inside an arbitrary remote server. [SDK protocol modes](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/protocol-versions.md) and [interactive request behavior](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md) explain the library mechanisms; the retained runtime tests establish this configuration's behavior.

The host checks raw response markers before compatibility parsing can discard them. A response with
`task`, `requestState`, `inputRequests` or an unsupported `resultType` is not completion, even when it includes
empty or textual content. It leaves an effect unknown outcome without another tool call. This guard applies
to stdio and HTTP; it does not implement the requested next phase.
A task record's status alone does not supply this invocation's terminal tool result. Deferred tasks
need explicit result retrieval and reconciliation through the gateway before they can be qualified.

HTTP requests refuse redirects. A method-preserving redirect can repeat an effectful POST after the
first endpoint has already applied it: the retained regression reproduces two destination writes
under the SDK's default redirect behavior. Configure the server's canonical endpoint instead. A
redirect encountered after dispatch leaves the outcome unknown outcome and is not followed or resent;
response replay at the configured endpoint remains supported. Supporting endpoint migration needs
an explicit review of destination identity and authority before dispatch.

## Not yet

- Modern interactive/versioned MCP workflows are not qualified by this single-call configuration. Supporting them needs explicit phase ownership, authority and recovery through the gateway; automatic client retries do not supply those properties. This remains capability work, not a permanent exclusion from the platform.
- OAuth sign-in to an HTTP server from inside the app; a server's own sign-in is used instead (see `docs/how-to/connect-gmail.md`).
- Several named accounts per server.
- A policy that narrows a permission by arguments, by amount or by what the run has read (a rule set evaluated at the door, as Cedar does for agents), and a permission given from the command line on a machine without the desktop app. Today a permission covers every call to its tool and is given only in the app.

## Unknown effects pause the same tool

After an effect ends unknown outcome, a permission permits nothing more for the
same tool on that connection until the person resolves it. Different arguments,
a new turn, restarting the Host or replacing the permission do not settle the
uncertainty. The original call is never resent. Other tools on that connection,
reads and other connections remain available: a draft or label change does not
repeat a send. The scope is the immutable connection ID and the complete operation
including the tool name (even a tool name containing dots). A future preset could
explicitly declare two tools to be the same outside action and widen that scope;
name similarity alone is not such a declaration.

A subsequent signed call to that tool becomes an ordinary held action, with the fixed
reason: “An earlier call to this tool on this connection has an unknown outcome.
Its permission is paused until you resolve it. This call waits for you;
nothing was sent.” Every unknown for that tool must be resolved conclusively.
Giving or ending a permission is separate from inspecting an unknown outcome.

Core's existing effect rows own the pause. The service checks before standing
approval and again under the database advisory lock at dispatch, using a fresh
snapshot. A call still dispatching has no unknown outcome yet. A parallel signed
call to that tool is held with its own truthful in-progress message. After the
first settles the person can permit the held action or the engine can retry its
same retained identity; the original dispatch is never replayed. A dispatch claim
retained privately after admission was deferred can be reused while valid or
reclaimed through Core after expiry. It is not a receipt or clearance authority.
No Core open or crossing waits under the data folder lock. Core's answer basis prevents
an editable local hint from relabelling a standing approval as a person's permission.
A person approval saved before a crash needs a fresh person action if Core has no
confirmed answer; recovery does not turn a file-only hint into a new answer.

Only the person may inspect the exact call and choose:

- **It did happen:** reconcile the original effect as succeeded.
- **It did not happen:** reconcile it as failed. This does not resend it.
- **I do not know, keep it closed:** retain unknown outcome and keep permissions paused.
  The person may later give a conclusive answer.

The first two answers use the existing person-side `gov.reconcile_effect` crossing
and its `effect.reconciled` ledger receipt. Once every unknown for that tool on that connection is
resolved conclusively, subsequent effects can use their still-valid permissions again.
The inconclusive answer does not invent a Core outcome: its receipt stays in the
existing connector record with the held actions and permissions. That editable receipt
cannot clear Core's pause. The service saves an inspection intent under the admitted
data folder lock before reconciling, then retains the matching Core ledger sequence and hash.
A lost reply is confirmed against that exact person's reconciliation and note witness;
it never triggers a connector call. No schema change or new journal is needed.

The person-only service methods are `unknownQuestion` and `resolveUnknown`. They are
absent from ToolHost, model tools and Host.call. The API line has a separate asked
write, `connectors.resolveEffect`, with a dedicated trusted composition binding and a
native confirmation of the exact statement and answer. It is absent from the line's
read methods and refused by read-only or unbound servers. The CLI command is
`backbone connectors resolve <effect> --args-hash <hash> --answer happened|did_not_happen|keep_closed`.
It requires the running app and has no standalone or engine-side resolution fallback.
Electron main binds the same person-only Host capability for the card and the CLI. The app card opens a native three-answer question; the CLI uses the API line’s existing native person-presence route for comparable asked writes. Main validates identities, refuses foreign pages and rechecks the exact question after confirmation. Neither the renderer nor API-line reads can supply an approval basis or resolve automatically.

Rejected alternatives: a separate journal for each connector duplicates the effect
ledger, makes recovery connector-specific and leaves other connectors unprotected.
Blocking the entire connection would also block the reads the person needs to inspect
what happened. This rule holds only automatic effect permission, using existing records.


## What the person can inspect about an unknown call

The held-call view retains the exact statement, its immutable standingSignatureId
when there was a standing approval, and personReleasedAt when a fresh individual
permission was used. The latter is an informational local receipt, never a reusable
permission. A cancelled original retains its standing basis; its fresh person-release replacement has its own effect and person receipt, with no automatic standing attribution.

When retained, dispatchedAt and dispatchReceipt (Core ledger sequence and hash)
identify the positive effect.dispatched witness. That time is Core's admission to
dispatch, not proof that the provider received or completed the request. Missing
historical timestamps or receipts remain unavailable; listing never queries Core,
backfills them or guesses. Credentials, internal approvals and claim tokens stay
withheld. The resolver verifies the retained statement and full arguments against
Core again before accepting the person's answer.

No provider search, tool result or engine answer settles the call. A future trusted
preset may declare a separate read for the person's inspection, but the present
implementation displays only retained Host/Core facts. The three native person
answers remain the only resolution path. Connected tools shows unresolved unknowns separately from decided calls, names the paused tool, exposes retained dispatch evidence and offers Resolve outcome. Deferred calls are Waiting, including while another call is still dispatching.
