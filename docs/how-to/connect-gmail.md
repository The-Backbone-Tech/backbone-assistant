# How to connect Gmail

**For:** a person who wants the assistant to read their personal Gmail and write drafts and optionally permit sends; or an agent building against the fake Gmail server. **Time:** about a minute for the fake; about fifteen minutes, once, for a real account.

**Before you start:**
- Node 22.18 or newer and pnpm 10, with the repository installed (`pnpm install`; see [install and open the app](install-and-open-the-app.md), steps 1 and 2).
- The fake needs no network, key or account. A real account needs your own Google Cloud project and [uv](https://docs.astral.sh/uv/) (`uvx`), and only you can sign in to it. With Homebrew, `brew install uv` puts `uvx` in `/opt/homebrew/bin`, which the app finds even when it is started from the Finder.

## Steps

Blocks marked `bash test` run in CI through `pnpm guides`, which `pnpm check` calls.

### The fake Gmail server

1. Run its tests. They start the fake over stdio from the same server entry the app writes, list its tools with their annotations, page through a search, read a thread, get a scripted 429 and a call that never answers, and check that a send is recorded and never sent.

   ```bash test
   node --test packages/modules/connector-mail/test/gmail-mcp.test.ts
   ```

   Exit code 0 means all of it held.

2. Print the entry for `<home>/connectors/servers.json` (Claude's `mcpServers` shape):

   ```bash test
   node --input-type=module -e "const { fakeGmailPreset, serversJson } = await import('./packages/modules/connector-mail/src/gmail-preset.ts'); console.log(JSON.stringify(serversJson(fakeGmailPreset({ node: 'node' })), null, 2));"
   ```

   You see (the path is your checkout's):

   ```text
   { "mcpServers": { "gmail-fake": { "command": "node", "args": ["<checkout>/packages/modules/connector-mail/src/gmail-mcp-main.ts"] } } }
   ```

   To script faults, add `"env": { "BACKBONE_FAKE_GMAIL_FAULTS": "rate-limit@search_gmail_messages#2,hang@get_gmail_thread_content" }`: `kind@tool#nth`, where a missing tool means every tool and a missing `#nth` means every call. `BACKBONE_FAKE_GMAIL_STATE` names a JSON file where the fake records drafts and send requests; its `sent` list stays empty. Search returns 10 messages a page by default, so the sample mailbox always has more pages.

### Your personal Gmail, read and draft only

The server is [workspace-mcp](https://github.com/taylorwilsdon/google_workspace_mcp) 2.3.0, run on your Mac over stdio with your own OAuth client. It asks Google for two Gmail scopes, `gmail.readonly` (read mail and labels) and `gmail.compose` (drafts), plus Google's basic sign-in identity (`openid`, email and profile), which names the account; no other Workspace service. The consent screen shows those three. Google's own Gmail MCP server is in Developer Preview and asks for a Google Workspace account, so it is not used for a personal address yet. Sign in with your personal address, not a work one.

Do these yourself; nobody signs in or creates anything for you.

1. **Project.** Open [console.cloud.google.com](https://console.cloud.google.com/) signed in with your personal address. Project picker › **New project** › name it `gmail-assistant` › **Create**. No billing account is needed.
2. **API.** **APIs & Services › Library** › search `Gmail API` › **Enable**. Enable nothing else.
3. **Consent screen.** **Google Auth Platform › Branding** › **Get started**. App name `Gmail assistant (personal)`, support email your address › **Audience: External** › contact email your address › agree to the user data policy › **Create**.
4. **Test user.** **Audience** › **Test users** › **Add users** › your own address › **Save**. Leave the publishing status at **Testing**; never click **Publish app**. In Testing, Google ends the sign-in after seven days, so you permit in again weekly.
5. **Scopes.** **Data Access** › **Add or remove scopes** › **Manually add scopes**, paste these two, **Add to table** › **Update** › **Save**:
   - `https://www.googleapis.com/auth/gmail.readonly`
   - `https://www.googleapis.com/auth/gmail.compose`
6. **Client.** **Clients** › **Create client** › Application type **Web application** › name `workspace-mcp` › **Authorized redirect URIs** › **Add URI** › `http://localhost:8000/oauth2callback` › **Create** › **Download JSON**. Leave "Use this client for an AI-powered agent" unticked: workspace-mcp calls the Gmail API, not Google's MCP endpoint. Move the file to a folder of its own under `$HOME/.config`, for example `mkdir -m 700 $HOME/.config/backbone-gmail`, then move it to `$HOME/.config/backbone-gmail/client_secret.json` and run `chmod 600` on it. That folder, and `$HOME/.google_workspace_mcp` where the server keeps your sign-in tokens, are never readable by a chat or a connector call. Never put it in a repository or paste its contents anywhere.
7. **Server entry.** Add it to `<home>/connectors/servers.json`, with your data folder's absolute path and your address. The entry holds a file path, never the secret:

   ```json
   { "mcpServers": { "gmail": {
     "command": "uvx",
     "args": ["workspace-mcp@2.3.0", "--single-user", "--permissions", "gmail:readonly+drafts", "--disabled-tools", "send_gmail_message"],
     "env": { "GOOGLE_CLIENT_SECRET_PATH": "<your home>/.config/backbone-gmail/client_secret.json", "USER_GOOGLE_EMAIL": "<your address>" }
   } } }
   ```

   `gmail:readonly+drafts` permits exactly those two levels: no `organize` (labels and moves, `gmail.modify`) and no `send` (`gmail.send`). The send tool is switched off by name as well. If a different preset offers a send tool, it follows the ordinary per-call and tool permission rules; the effect-name list only prevents it being treated as a read. Do not add `WORKSPACE_MCP_CREDENTIALS_DIR`, `GOOGLE_MCP_CREDENTIALS_DIR` or `HOME` to the entry: a server that moves its token cache is not used. The same entry, built in code: `workspaceMcpGmailPreset` in `packages/modules/connector-mail/src/gmail-preset.ts`.
8. **Enable it.** In the app, **Settings › Connected tools**: **List tools** on the `gmail` server, enable its read tools and the draft tool (`draft_gmail_message`), then **Turn on**, confirming the native questions. Drafting stays an effect: each draft is held under **Held actions** until you answer.
9. **Allow drafts to be written.** On the same server, **Allow sending**, and confirm in the dialog. This opens the egress door for this server only: a draft you permit is then written to your Gmail drafts, once. This preset offers no send tool, so permitting a draft cannot invoke a send tool, and turning the server off, or a change in how it starts or in its configured values, closes the door again. Without this step a released draft is recorded and nothing is written.
10. **Permit a draft.** When a chat drafts a reply, it waits under **Held actions** with its exact words. **Permit** shows them again in a dialog; **Send** there writes the draft. If Gmail does not answer, the draft's outcome is unknown and it is never written again: check your Drafts folder. An unknown effect pauses the permission for that tool on this connection: later calls to the same tool wait for your individual permission. Other tool permissions still work. Reads and other connections still work. Only your explicit inspection of each unknown call can restore automatic sending; ending or giving permission does not. In Connected tools, choose **Resolve outcome** on the unknown call. The native question offers **It did happen**, **It did not happen**, and **I do not know, keep it closed**. Its card shows the exact statement, the permission and retained Core dispatch evidence. The CLI can request the same inspection through the running app’s native question; it cannot resolve without you. See [the connector rule](../contracts/connectors.md#unknown-effects-pause-the-same-tool).
11. **First sign-in.** The first Gmail call answers with a Google sign-in link. Open it, pick your personal address, and on "Google hasn't verified this app" choose **Advanced › Go to Gmail assistant (personal)**: it is your own app. Google lists two permissions, "View your email messages and settings" and "Manage drafts and send emails". Tick those two and **Continue**.

The token is kept by workspace-mcp in `$HOME/.google_workspace_mcp/credentials/` on your Mac, outside every repository and outside `servers.json`. To disconnect: [myaccount.google.com/permissions](https://myaccount.google.com/permissions) › Gmail assistant (personal) › **Remove access**, then delete that folder.

**Do not permit:**
- `gmail.send`, `gmail.modify`, `https://mail.google.com/` (full access, including permanent delete), `gmail.settings.basic` or `gmail.settings.sharing` (forwarding), `gmail.insert`;
- `--permissions gmail:send`, `gmail:full` or `gmail:organize`, `--tool-tier complete` without `--permissions`, or any other Google service;
- **Publish app**, other test users, or a service account.

`gmail.compose` is Google's only scope for drafts, and Google documents that it can also send. No sending tool is offered and drafting is classified as an effect, but if you want no send capability at all, use `--permissions gmail:readonly` and do without drafts.

## Opt in to sending

The default `workspaceMcpGmailPreset` still reads and drafts only. The separate
`workspaceMcpGmailSendPreset` enables the maintained workspace-mcp 2.3.0 send tool.
This manual Gmail connection is separate from the Calendar and Drive catalogue;
it keeps workspace-mcp's existing credential folder and does not use Backbone's vault.

1. Turn off the old `gmail` connection and end its tool permissions. Add
   `https://www.googleapis.com/auth/gmail.send` to the OAuth app's allowed scopes,
   keeping `gmail.readonly` and `gmail.compose`. Replace the old server entry:

   ```json
   { "mcpServers": { "gmail-send": {
     "command": "uvx",
     "args": ["workspace-mcp@2.3.0", "--single-user", "--permissions", "gmail:readonly+drafts+send"],
     "env": { "GOOGLE_CLIENT_SECRET_PATH": "<your home>/.config/backbone-gmail/client_secret.json", "USER_GOOGLE_EMAIL": "<your address>", "WORKSPACE_MCP_DISABLE_LOCAL_FILES": "true" }
   } } }
   ```

2. Re-consent with the same Google account. Changing the entry cannot widen the old
   token: stop the connector, remove this app's old access at
   [Google account permissions](https://myaccount.google.com/permissions), remove
   its old token files from `$HOME/.google_workspace_mcp/credentials/`, keep your
   client JSON, then follow the new connection's sign-in link. The credentials
   stay in the connector's folder. This adds the `gmail.send` scope; `gmail.compose`
   could already send through the Gmail API. Any program that can read those token
   files has the scopes they carry.
3. In **Settings › Connected tools**, list and enable `gmail-send` and
   `send_gmail_message`, confirming the native questions, then **Allow sending**.
   Draft and send remain effects. The preset's overrides are guidance; the Host
   enforces its existing effect floor for sending names.
4. Ask the assistant to compose a new plain-text message. Sending accepts explicit
   `to`, optional `cc` and `bcc`, a nonblank `subject`, `body`, and optional `attachments` only.
   Each attachment must contain a nonempty `filename` and canonical standard-base64
   `content`, with an optional `mime_type`. Its bytes are supplied in the call.
   The required `user_google_email` account-routing field is also visible.
   Before the call is shown or hashed, the Host fixes `include_signature` to `false`
   so workspace-mcp cannot append a saved footer from Gmail settings.
   In **Held actions**, inspect every recipient, subject and body. Attachments show
   their name, type and decoded size; **Open attachment** previews the retained bytes,
   and **Save attachment** saves those same bytes for another viewer. Text and common
   images open locally; other binary formats show hexadecimal bytes. Long text/byte
   previews are labelled partial. HTML and SVG are shown as text. The call hash still
   binds the full content; base64 is replaced with file metadata in this view.
   Choose **Permit**, and confirm. The reviewed arguments leave once through
   the connection; its receipt retains the originating work, your permission and
   Core dispatch evidence across restart. Permitting that receipt again cannot
   dispatch it twice. The next distinct send waits for its own permission.
5. For unattended sends, optionally choose **Let it act without asking** on
   `send_gmail_message`. That permission covers the accepted explicit message
   content and recipients. The same argument restrictions still apply. Mail from
   strangers can influence the assistant: this authorizes messages to any recipient
   it chooses within that boundary. A permission for the draft tool does not permit
   the send tool. End the permission to hold future sends again.

The Host refuses forwarding IDs, reply-all and quote flags, thread IDs, explicit
reply targets, reference chains, aliases/display names, format/direction options,
remote URLs, local attachment paths, mixed attachment sources and unknown fields.
These fields are refused even when false or null. An explicit
`include_signature: true` is refused; the fixed false value is included in the
released statement. Historical held actions with indirect content or without this
fixed control cannot be released under the new rule. A refusal proposes no send
and calls no server tool. Tool permissions cannot bypass this rule.

Keep `WORKSPACE_MCP_DISABLE_LOCAL_FILES=true` as an additional upstream restriction
on local attachment inputs. URL attachments are refused by the Host; only the
inline base64 bytes included in the displayed arguments are accepted.
Only the reviewed workspace-mcp 2.3.0 launch and audited tool set can run on this
send connection. Changing its pin or adding a tool refuses calls until the rule is
reviewed; retaining the `gmail-send` name cannot bypass this with another launch.
The default read-and-draft launch stays unchanged so existing permissions retain
their pins. The adopted connector is MIT licensed. The permission string and
attachment setting come from the recorded 10 November source audit of
[workspace-mcp v2.3.0](https://github.com/taylorwilsdon/google_workspace_mcp/tree/v2.3.0).

An unanswered send keeps an **unknown outcome** and is never resent. Inspect Sent and the
recipient before resolving its outcome. The turn stops and later sends on that
tool wait, including after restart; a separately permitted draft can still run
in a new turn. Use **Resolve outcome** to record what happened. Ending or replacing
a tool permission cannot resolve an unknown outcome. The existing
[same-tool rule](../contracts/connectors.md#unknown-effects-pause-the-same-tool)
also applies here.

The proving tests use a disposable data folder, scripted engines and a local MCP server:
`packages/platform/test/gmail-send-turn.test.ts` checks one exact person permission,
one local stand-in delivery with CC, BCC and an inline attachment, a durable receipt,
tool permissions and no replay;
`packages/platform/test/gmail-send-after-unknown.test.ts` checks the pause.
`packages/platform/test/gmail-send-content.test.ts` checks refusals before any tool
call and compares production classification with the preset guidance.
The stand-in uses the pinned preset arguments and environment and advertises all
send parameters from the pinned source, including the refused ones.
These are test evidence, not a real Gmail delivery or an installed-app qualification.

## Known Gmail follow-ups

- **GMAIL-READ-FULL:** upstream `get_gmail_message_content(full=True)` can write
  local `.eml` and `.html` files while its annotation classifies it as a read.
  This pre-existing default-preset behavior needs a qualified argument restriction
  or classification change. Disabling local attachment inputs does not establish
  that full reads write nothing. This send change does not resolve it.
- **GMAIL-SEND-DUPLICATE-INTENT:** two identical calls on the same tool in one turn
  currently share one receipt and dispatch at most once. That includes two
  deliberately identical sends, omitted/explicit `include_signature: false` controls and JSON
  field-order variants. Historical successful receipts keep their identity.
  Suppression is not separately labelled in the
  receipt yet; a follow-up must show it and distinguish an explicit second intent
  from replay. The current behavior is safe deduplication, not two deliveries.

## Review and end tool permissions

To let the enabled draft tool act without asking, use the desktop app:
**Settings › Connected tools › Tools › Let it act without asking**. The app shows the
tool's description, connection and permission before you permit. This signs only
that tool. It does not turn on the disabled Gmail send tool.

Open **Settings › Tool permissions** to see active permissions together: the tool and connection, when you signed, its description and Core permission ID. Sent, failed and unknown outcome call receipts join that exact identity; missing historical identities stay unavailable. A full historical definition snapshot and dormant permissions are not available yet. Times use your locale. A row shows Paused if Core verification fails or that tool has an unresolved unknown. A failed call stays labelled Not done; an unanswered call stays unknown outcome and is never resent by this screen.

**End permission** takes one click. It removes local authority even if discovery or Core is unavailable after the screen has loaded; the app distinguishes pending Core confirmation and conflicts. No pending local end is not itself a Core ledger receipt. Calls approved on that permission are checked again just before sending and stopped if it has ended. Ending cannot undo a call already sent, or resolve unknown outcome. Cold app startup and listing still need Core. See [the app contract](../../packages/surfaces/app/CONTRACT.md#connector-approval-and-inspection).

The same screen has **How much runs without asking**:

- **Full** is the default view: tool permissions act without asking while Core has verified its permission records; unsigned outside writes wait.
- **Custom** only shows the per-tool choices, **Let it act without asking** and **Ask me every time**. Giving a permission still uses the desktop question; choosing Ask me every time ends it.
- **Balanced** will ask before an outside write after an outside read in the same turn; it is disabled until that rule is enforced.
- **Strict** will ask before every outside write; it is disabled until that rule is enforced.

Full and Custom apply the same rules today. This view choice is saved in the
renderer's local storage on this device. Changing it neither signs a tool nor
permits a call. New permissions cover the tool’s defined arguments; legacy plain permissions retain their earlier argument limits until you permit again.

## What you now have

A fake Gmail server whose tools, pages and faults match a real one. For a real account: your mail readable by the assistant, and drafts written once through the open connection, after your permission or under the permission you gave that draft tool.

One limit stays: the door is sealed to how the server starts and the values it is configured with, not to the account inside workspace-mcp's own token folder. If that folder is switched to another Google account, the door cannot tell, so keep it to your personal account.

## What next

- The fake and its presets: [the mail connector's README](../../packages/modules/connector-mail/README.md).
- Sources, read 2 November 2026: [workspace-mcp docs](https://workspacemcp.com/docs) (v2.3.0, synced 30 Oct 2026); Google's [Gmail MCP reference](https://developers.google.com/workspace/gmail/api/reference/mcp), [MCP configuration guide](https://developers.google.com/workspace/guides/configure-mcp-servers) and [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes).
