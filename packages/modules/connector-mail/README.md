# Connector: mail

The mail connector port's adapters (`packages/platform/src/ports/mail.ts`). An internal module used by platform triage, not a standalone mail host. The **sample mailbox** is a fake provider seeded with a realistic, labelled inbox of 47 requests to a small studio, in English and Spanish. A Gmail MCP adapter and preset also exist; tests use a fake Gmail server, not a qualified live mailbox. The app connects it, the mail triage job reads it, and the tests and the measurement drive it.
Every request is classified here, from the request itself, never from a string a caller chose: its operation, its effect class and its recovery class. Writes to the mailbox are **gated**: until the lab's door conformance is accepted, `apply` refuses every write, and the triage job only proposes label and move changes.
It runs inside the host's process, so it is trusted, pinned code: the platform checks its files against their registration before loading them, and the triage job's permission is bound to that registration, so the core refuses any operation this manifest does not declare, such as sending, forwarding or deleting ([architecture](../../../docs/architecture.md#pieces-in-the-hosts-process-the-trust-boundary)).

## Use the adapter

You need this repository installed (`pnpm install`). No key, no network, no core.

```js
import { FakeMailbox } from '@backbone-next/connector-mail';
const box = new FakeMailbox();                 // the bundled fixture; writes gated
const { messages } = await box.list();         // the inbox, oldest first, with versions
const m = await box.read(messages[0].id);      // one message, body as plain text
const c = box.classify({ op: 'modify', id: m.id, version: m.version, add: ['Label_billing'], remove: [] }, await box.labels());
// c.value: { operation: 'mail.label', effectClass: 3, recovery: 'exact-undo', undo: null, summary: 'Label: add Billing' }
await box.apply(c.value);                      // throws: writes to this mailbox are gated
```

Put the script in this package's folder so the package name resolves. The fixture is `fixture/mailbox.json` (the provider's truth), `fixture/task.json` (the categories, urgency rubric and moves the triage job and its baseline are both given) and `fixture/labels.json` (the ground truth, read only by the scorer; the job, the model and the baseline never see it).

For an uncertain write, the trusted service adds the Core receipt ID as the
optional `ClassifiedOperation.operationKey` metadata at both apply and probe. It
is outside the normalized request arguments and gives no authority. The service
must still compare the receipt's provider, account and registration with the
actual loaded connector and its pinned version/digest before calling it.

The fake's durable provider record binds that key to the exact normalized request
and expected input version in its account. A probe can confirm that record after
a lost reply or restart without writing again. Matching current labels alone do
not establish which operation landed: another actor may have made the same change.
A missing key, a different request/version or an old uncorrelated record remains
unknown outcome when ambiguous. Asynchronous calls sharing a provider state file reload
and serialize observations/changes through the platform's existing data folder lock,
including an active call's simulated delay. The synchronous `deliver` control is
fixture injection, not a concurrently qualified provider API. A provider file
owned by a different account is refused. The key establishes correlation only; it promises no
idempotency or guarantee for another provider. Real writes remain gated.

The measured run of the whole job on this fixture is [measure mail triage](../../../docs/how-to/measure-mail-triage.md).

## The fake Gmail MCP server

`src/gmail-mcp.ts` serves the same fixture as a stdio MCP server, so the platform's MCP client can be built and tested before a real mailbox is connected. Run it with `node packages/modules/connector-mail/src/gmail-mcp-main.ts` (bin `backbone-fake-gmail-mcp`). Its tools carry the real server's names, arguments and annotations: `search_gmail_messages` (paged, with `page_token`), `get_gmail_message_content`, `get_gmail_thread_content` and `list_gmail_labels` are read-only; `draft_gmail_message` is a write that is not destructive; `send_gmail_message` is destructive. It answers in plain text, as the real one does, and errors are `isError` results carrying Google's `HttpError <status>`.

It never sends: a draft or a send is recorded in its state file (`--state` or `BACKBONE_FAKE_GMAIL_STATE`), whose `sent` list stays empty, and a send answers with an error that says nothing was sent. Faults are scripted with `--fault` or `BACKBONE_FAKE_GMAIL_FAULTS`, as `kind@tool#nth`: `rate-limit` (a 429 `rateLimitExceeded`) and `hang` (a call that never answers). A search of the sample mailbox always has further pages at the default 10 per page.

`src/gmail-preset.ts` holds the server entries Backbone writes to `<home>/connectors/servers.json` (Claude's `mcpServers` shape), with suggested per-tool classifications (the Host enforces its own effect rules): `fakeGmailPreset`, `workspaceMcpGmailPreset` (a personal Gmail account, read and draft only) `workspaceMcpGmailSendPreset` (opt-in sending through the same pinned MIT connector, with local attachments disabled) and `GOOGLE_GMAIL_MCP_PRESET` (Google's remote server, the swap target). Connecting either: [connect Gmail](../../../docs/how-to/connect-gmail.md).

What is tested, and where:
- `test/classify.test.ts`: reads are class 1 with no recovery class; a user label is `mail.label`, class 3, exact undo; taking a message out of the inbox is `mail.move`; adding TRASH is `mail.trash`, class 4, a bounded cancellation; the same change in another order hashes the same; an unknown operation (send, forward, delete), argument or label is refused.
- `test/identity.test.ts`: an independent identical change cannot settle the original unknown outcome; keyed after-commit proof survives restart, rejects another key/request/version and leaves legacy ambiguity unknown outcome.
- `test/fake.test.ts`: the fixture is complete and consistent; versions move with every change; new mail arrives and wakes watchers; writes are gated by default; an open write applies once and a stale version is refused; a timeout before or after the provider commits, and a 5xx after it, each leave the provider's truth apart from what the caller was told, and the probe proves what happened or says it cannot tell; the state survives a restart; the entitlement check fails closed; nothing sends.
- `test/gmail-mcp.test.ts`: the official MCP client starts the fake Gmail server over stdio from its preset; the tools' names and annotations; search pages with a next page token until the mailbox is covered once, and a token from another query is refused; a thread reads whole; a scripted 429 and a hang (the client times out) hit only the call they name; a draft is recorded, a send is recorded and never sent; another account is refused; the personal Gmail preset gives no send, modify or full scope and holds no secret.
- `test/gmail-send-preset.test.ts`: the separate send preset enables the send permission level and disables local file attachments while preserving the default launch and credential locations.
- `packages/platform/test/gmail-send-turn.test.ts`: Pi and Codex each release one exact plain-text send with CC, BCC and inline base64 bytes against a local MCP stand-in launched with the real preset arguments and environment. The full pinned send schema includes refused indirect fields; the test compares release JSON, raw tool arguments and a delivery projection, retains the receipt across restart and never replays UNKNOWN. The related `packages/platform/test/gmail-send-after-unknown.test.ts` covers later sends and separately signed drafts.
- `packages/platform/test/triage.test.ts`: the whole job on the real core (below, in the platform's README).

`packages/platform/test/gmail-send-content.test.ts` checks that every server-resolved
argument is refused before proposal or a tool call. Production annotations classify
the fixture tools; a drift assertion compares the preset guidance without applying it.
The Host also fixes the upstream signature default to false before display and rejects
historical proposals that lack that control. The
[Gmail guide](../../../docs/how-to/connect-gmail.md#known-gmail-follow-ups) names the
remaining full-read local-file and same-turn duplicate-intent work.

Not tested: any real provider.

## What it replicates, from whom, when

- **Gmail's shape.** `users.messages.modify` with label ids, moves as label changes on INBOX, SPAM and TRASH, `historyId` as the version; Microsoft Graph's moves and categories map onto it. Trash is restorable until the provider empties it (Gmail: 30 days), so it is a bounded cancellation, not an exact undo.
- **The lab's destination fakes** (`work-planes-lab:prototype/packages/fakes`, read 26 Oct 2026; nothing imported): the provider's truth kept apart from what the caller is told, scripted faults before and after commit (Gmail's "you can't assume a 200 means sent", a 5xx is never a denial), deterministic versions, and a probe that reads the provider rather than the caller's memory.
- **Classes from the effect** (`work-planes-lab:decisions/0007-scope-freeze-core-boundary-and-adoption-by-layers.md`, point 4, 26 Oct 2026): the adapter assigns every operation's class from the effect, as MongoDB's `$out` makes an aggregation a write, and refuses an unknown operation or argument.
- **An entitlement check at onboarding that fails closed** (`backbone-way:docs/reviews/2026-10-26-clusters-product-method.md`, section 5): vendor MCP servers now act as the signed-in user, writes included, but access costs licence tiers, scopes and admin consent, so the check comes before anything is read.

- **Gmail MCP servers, November 2026** (read 2 Nov 2026). Google's own remote server (`gmailmcp.googleapis.com`, [reference](https://developers.google.com/workspace/gmail/api/reference/mcp), [setup](https://developers.google.com/workspace/guides/configure-mcp-servers)) is a Developer Preview for Google Workspace accounts: `search_threads`, `get_thread`, `get_message`, `list_labels`, `list_drafts`, `create_draft` and four label tools, with no send tool, under `gmail.readonly` and `gmail.compose`. The most used community server, taylorwilsdon/google_workspace_mcp (`workspace-mcp` 2.3.0, [docs](https://workspacemcp.com/docs) synced 30 Oct 2026), works with a personal account and permissions Gmail scopes by level (`--permissions gmail:readonly+drafts`). The fake mirrors the second, from its source (`gmail/gmail_tools.py`): tool names, arguments, annotations, text answers and the pagination hint. GongRzhe's Gmail-MCP-Server was archived in March 2026 and asks for `gmail.modify`. Google documents that `gmail.compose` can also send ([scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)), so a draft is an effect.

**What is ours:** one classifier that gives every mailbox change its recovery class (exact undo, bounded cancellation, compensation, irreversible) for a brief that lists actions with their undo, which the October 2026 references do not (Google's Daily Brief and Claude Duet summarise and suggest; same review, section 7); and a fixture with blind labels and a shared task text, so the job is measured against a baseline on the same words.

## Why

Triage is the first job measured end to end (historical ordering; see the [product goal](../../../GOAL.md) and [acceptance job](../../../acceptance/J-triage/job.md)). A fake provider makes every adverse case reproducible (a timeout after commit, a probe that cannot tell, a lost entitlement) before any real mailbox is touched, and keeps real writes off until the door that would carry them is accepted.

## The real adapters (design note)

Nothing below is built: each needs an OAuth client and an account, which only the owner creates.

- **The choice is the entitlement check's.** At onboarding the check asks the provider what the account holds and refuses, naming what is missing, before anything is read. The connector is the vendor's official remote MCP server where it is generally available, else a direct API adapter (intended route; not a completed live-provider trial).
- **Gmail over MCP, read and draft only.** A personal account connects through `workspace-mcp` with the person's own OAuth client ([connect Gmail](../../../docs/how-to/connect-gmail.md)); the platform's MCP client reads it and holds drafts as effects. The API adapter below remains the design for label and move.
- **Gmail.** Google Workspace's MCP server was still a developer preview in October 2026 (same review, section 5), so the adapter is the Gmail API: `users.messages.list` and `get` (`format=full`, bodies decoded), `users.labels.list`, `users.messages.modify` and `users.history.list` for new mail (or `users.watch` with Pub/Sub when the app has a cloud side). Scopes, asked for incrementally: `gmail.readonly` to read and classify; `gmail.modify` only when a capability that includes label and move is signed. Gmail's read and modify scopes are restricted scopes: an app used beyond its own developer's test users needs Google's verification, and a client in testing has its refresh tokens expire after seven days. Check both against Google's current policy when the client is made. Gmail's modify has no precondition, so the adapter reads the message's `historyId` first and refuses a change whose version moved; a labels-only probe cannot attribute an uncertain write, so it must retain unknown outcome without stronger provider evidence.
- **Outlook and Microsoft 365.** Microsoft called its per-workload Mail MCP server legacy and not for production in October 2026; its replacement is Work IQ MCP under Agent 365 (same review, section 5), which needs the tenant's licences and admin registration. Without them, the adapter is Microsoft Graph: `GET /me/mailFolders/inbox/messages`, `POST /me/messages/{id}/move`, categories as labels, delta queries or change notifications for new mail; `Mail.Read` delegated, then `Mail.ReadWrite` for moves, with the tenant's admin consent where its policy asks for it. Graph's `changeKey` is the version.
- **Entitlement, in each:** the permitted scopes, the account type (a Workspace or tenant policy can block third-party clients), the licence tier an MCP server needs, and the admin consent. Any of them missing, or the check failing to run, is "not entitled".
- **Writes stay gated** in every adapter until the lab's door conformance is accepted: the adapter ships with `writes: 'gated'`, and only a reviewed change opens it.

## Swap it

Any adapter behind the same port: the composition names the module in `packages/platform/src/composition/pieces.ts` (`PIECES`) and loads it by path after checking its digest. A second adapter shares this one's characterisation tests.

## Remove it

Revoke the triage capability and disconnect the mailbox (the app's Mail triage view, or `triage.disconnect`), settle any mailbox change still unknown outcome (the core refuses to unregister the piece until then), then remove this package and its entries in `packages/platform/src/composition/pieces.ts` (`PIECES`) and `scripts/structure-exceptions.json`. The sample mailbox's state is one file in the data folder; drafts and receipts stay with the core.

## Manifest

<!-- generated from backbone.module.json by scripts/module-readme.mjs; do not edit -->
| Field | Value |
| --- | --- |
| id | `io.github.albertoangulo/connector-mail` (module) |
| version, licence | 0.0.0, Apache-2.0 |
| publisher | Backbone maintainers, namespace `io.github.albertoangulo` (github, pending) |
| stability | experimental |
| provides | MailConnector 0.x |
| consumes | none |
| capabilities | planes: personal; effect classes: 1, 2, 3; operations: mail.list, mail.read, mail.labels, mail.label, mail.move, workspace.write_document; network: none; secrets: none |
| data | owns: the sample mailbox's provider state (<data home>/mailbox/sample.json); migrations: 0; export: the sample mailbox's state is a JSON file; drafts, receipts and notes belong to the core and the platform |
| depends on | @modelcontextprotocol/server 2.4.0 (Apache-2.0), zod 4.6.7 (MIT) |
| conformance | bronze: `packages/modules/connector-mail/test/classify.test.ts`, `packages/modules/connector-mail/test/fake.test.ts`, `packages/modules/connector-mail/test/gmail-mcp.test.ts`, `packages/platform/test/triage.test.ts` |
| exemption | a real provider adapter: only the sample mailbox is built; a real mailbox needs an OAuth client and an account the owner creates (README, The real adapters) |
| exemption | shared connector port conformance suite: the MailConnector port has one adapter; its characterisation tests stand in until a second adapter shares them |
| removal | allowed once the triage capability is revoked and no mailbox change it carried is UNKNOWN; drafts and receipts stay with the core; refused while one of its effects is UNKNOWN |
<!-- end of generated block -->
