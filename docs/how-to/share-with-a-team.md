# Share a workspace with a team

## In the app

On the owner's computer, open **Settings › People and roles**. Choose this
computer’s address on the network your colleague can reach, and a port (8443 is
the default). Turn on **Let people on other computers connect**. People on that
network who have an invitation can connect while the app runs. The page shows
the workspace address and certificate SHA-256 fingerprint. macOS may ask once
whether the app may accept incoming connections.

Select **Create invitation**, then **Copy join link**, and send it privately to
the colleague. Member is the usual role; Guest can only view, and Admin remains
available here. Links are private, single-use invitations that expire in 24 hours.
While sharing is off, local invitation codes still open another window on the
same computer. Turning sharing off closes its listener and open streams. Quitting
the app also closes it. The choice persists across restarts; if its saved address
is unavailable, sharing stays off and the page explains how to choose another.

On the colleague’s computer, choose **File › Join a workspace…** (or open a
sign-in window from **Settings › People and roles**). Select **Join a workspace…**,
paste the link, give your name and select **Join workspace**. This opens the joined
workspace in its own window. The normal window and its local projects stay yours.
The joined window names its workspace address and says it runs on the owner’s
computer. Its bearer session and certificate check stay in Main, using the
app’s existing encrypted vault and key provider; the page receives neither.

After the colleague joins, the owner opens **Settings › Sharing**, chooses the
project and person, selects Editor or Viewer and saves. Only shared projects
appear in the colleague’s window. Editors start conversations and continue their
own; other people’s conversations remain readable. Viewers have a read-only
composer. Local file panes, schedules, memory, engine controls and settings for
the owner’s computer are unavailable in joined windows. Colleagues use Pi with
an explicit model route under **Settings › AI and models › Shared work**. Choose
a local model or add a provider key there; keys stay sealed and are never shown
again. Choosing a shared local model keeps the stored shared provider key;
clearing the local selection uses that stored shared provider route again. The
owner's own engine and model stay selected on the owner's computer. Colleagues cannot use the
owner's native account tools or personal model route. If the workspace already
uses Pi and no shared route is configured, colleagues keep using that workspace
route as before.

Shared work is used for colleagues and for your own sessions from other computers,
and for named automations. A signed-in owner on another computer also uses this
narrower shared carrier. To keep personal context from crossing to a different
model route, an owner's conversation that already used a personal route refuses
continuation from that other computer when the shared route differs. The message
says: "This conversation was started on the owner's computer with its own model.
Continue it there, or start a new conversation here." Start a new conversation
there to use shared work, or continue the original on the owner's computer.
Older personal conversations without a recorded route identity also require this.
This protects conversation history only. If you start a new conversation from
another computer and attach or ask about a file in one of your projects, that
file's content goes to the shared model, because you asked for it there.
A colleague's own conversations are unaffected. When the workspace uses Pi and no
shared route is set, sessions keep the workspace route as before.

Settings › People and roles shows a notice when the owner's engine brings its
own tools and no shared model is configured. Colleagues can join and read what
is shared with them, but their messages are refused until the owner configures
Shared work. The terminal prints the same guidance after the shared service
starts and after `backbone team invite`. A colleague whose message is refused is
told it was not sent and what the owner has to configure. In the app, choose
**Settings › AI and models › Shared work**. For the background service, stop it,
run `backbone model shared local --endpoint <loopback-url> --model <id>`, then start
it again with the same sharing address. A running app also holds the data folder:
use its settings, or close the app before the command and open it again afterward.
Model settings are never writable through the command line's connection to a
running holder. If the shared engine fails to load, settings and the owner's
notices show its last load error. The personal engine remains selected.

Reopening the colleague’s app restores the joined workspace from its saved
session in the one-person setup. With company sign-in configured, sign in locally
as the person who joined first; only that person can restore, join or leave the
workspace. After local company sign-in, use **File › Join a workspace…** or
**Settings › People and roles › Join a workspace on another computer** to open
your saved workspace or join in a dedicated window. Your local window keeps its
projects throughout. On a Mac without company sign-in, open this entry from the
device owner’s window; invited local members cannot join as the device owner.
Local sign-out ends access in that remote window and keeps the saved session for the same person. **Leave workspace** signs out; an unconfirmed sign-out keeps the session
and says so. Temporary connection problems reconnect automatically and keep the
session. A slow refresh also keeps the open conversation current. Confirmed
removal or session expiry shows that access ended and offers joining again.
A send with an unknown outcome stays unknown: inspect Chats and its answer before
starting new work. The app keeps that submission and never resends it, including
after restart. When the conversation shows the turn carrying that submission, the
composer becomes available again. You can also select **I checked the
conversation** beside the unknown notice. Neither path resends the submission.

When sharing resumes at start, the menu-bar menu says **Sharing with other
computers is on: <address>**. **Turn sharing off in Settings…** opens People and
roles, where you can turn off **Let people on other computers connect**.

## In the terminal

The CLI can connect a second computer to the owner's running daemon. Both
computers need the `backbone` command. The owner's computer needs a working OpenSSL or macOS system LibreSSL for the
first certificate; Backbone checks known system locations before the executable path. Use an address the colleague can
reach, such as the owner's LAN address. The two computers need a network route
to each other; no certificate authority or reverse proxy is required.

On the **owner's computer**, set `BACKBONE_HOME` to the data folder you want to
share. For a new folder, create the first project before configuring the engine.
Close the app before starting the daemon: one process holds the folder. Keep
your own engine selected and configure a shared model route. The example below
uses a model already running locally; use its actual address and model id. A
provider route is configured under Settings › AI and models › Shared work before
closing the app. A colleague cannot use the owner's native Codex or ACP account
tools. `backbone models` shows the personal route and shared route separately.

```bash
export BACKBONE_HOME="$HOME/.local/share/backbone"
backbone projects create "Launch plan"
backbone model shared local --runtime ollama --endpoint http://127.0.0.1:11434/v1 --model qwen3.5:4b
backbone models
backbone daemon run --share 192.168.1.10:8443
```

To try the owner's side safely first, this starts a shared service on this computer only, with a throwaway data folder, checks its address, creates a project while it runs and creates one join link:

```bash test
export BACKBONE_HOME="$(mktemp -d)/home" BACKBONE_KEYS=plaintext BACKBONE_HARNESS=stub
trap 'kill -TERM "$daemon" 2>/dev/null || true; wait "$daemon" 2>/dev/null || true; rm -rf "$(dirname "$BACKBONE_HOME")"' EXIT
backbone() { node packages/surfaces/cli/src/main.ts "$@"; }

node packages/surfaces/cli/src/main.ts daemon run --share 127.0.0.1:0 & daemon=$!
for _ in $(seq 1 300); do backbone daemon status 2>/dev/null | grep -q "Shared workspace: https://127.0.0.1:" && break; sleep 0.2; done
backbone daemon status | grep "Certificate SHA-256: "
backbone projects create "Launch plan"
backbone projects list | grep "Launch plan (folder)"
test -n "$(backbone team invite)"
kill -TERM "$daemon"; wait "$daemon"
test ! -f "$BACKBONE_HOME/daemon.json"
```

Leave that terminal running. In another terminal with the same `BACKBONE_HOME`:

```bash
backbone daemon status
backbone team invite
```

Send the printed join link to the colleague through a private channel. It carries
one invitation, the service address and its certificate fingerprint. The invitation
expires after one day and can be used once. `--role guest` creates a viewer-only
workspace member; the default is `member`.

On the **colleague's computer**:

```bash
backbone join
```

Paste the link at the hidden terminal prompt, then give your name. This keeps the
invitation out of process arguments and shell history. A link is single-use and
expires after one day. `--name` supplies a name without that second prompt; passing
a link as an argument remains supported for controlled automation. The client stores its session in the
existing encrypted vault, using the system key store by default. `--home` or
`BACKBONE_HOME` selects the colleague's own data folder; otherwise remote commands
use `.local/share/backbone` under that person's user folder. Never copy the owner's
data folder. A certificate mismatch stops the request before any invitation or
session is sent: ask the owner for the current link.

After the colleague joins, the **owner** lists people and shares a project.
You can create more projects while the daemon or app holds the folder; the
command uses that running process. `--kind git` creates a Git project.
An unknown creation stays unknown: inspect `projects list` before deciding what
to do next; the command never sends that attempt again.

```bash
backbone team people
backbone projects create "Team notes"
backbone projects list
backbone team share <project-id> --person <person-id> --access editor
```

Use `--access viewer` for read access. The colleague can now run:

```bash
backbone remote projects
backbone remote threads --project <project-id>
backbone remote read <thread-id>
backbone remote send 'Please help with this project' --project <project-id>
backbone remote send 'A follow-up' --thread <own-thread-id>
backbone remote events
backbone remote leave
```

Send waits and prints the answer. Viewers can read shared conversations and cannot
send; editors start their own conversations and continue their own threads.
Sessions expire after 12 hours. After expiry or removal, request a new invitation
and join again. Leaving signs out that session.

The owner withdraws a share with `backbone team share <project-id> --person
<person-id> --access none`, or removes a person with `backbone team remove
<person-id>`. Their next protected request is refused, running work is stopped,
and an open event stream ends with “Access ended”. Ctrl-C in the daemon terminal
stops sharing. Starting the daemon without `--share` opens no shared listener.
The daemon generates and retains its certificate and sealed private key in the
owner's data folder. Keep that folder and its system key-store access for a stable
fingerprint across restarts.

The shared TLS listener exposes only these routes:

| Route | Authentication |
| --- | --- |
| `POST /identity/accept` | Single-use, expiring invitation; eight attempts per socket address per minute. Company-configured workspaces refuse invitation-only acceptance. |
| `POST /identity/sign-out` | Workspace session bearer in Authorization; ends only that session. |
| `POST /api` | Workspace session bearer and live method/project permissions; never device authority. |
| `GET /api/events` | Workspace session bearer and live project access; at most two streams per session and 32 in total. |
| `/scim/v2/*` | Configured directory bearer, bound to its workspace and issuer; unavailable without directory configuration. |

Company sign-in (`POST /identity/company/begin` and
`POST /identity/company/complete`) stays on the local composition HTTP listener;
it is not exposed by `--share`. It uses OIDC provider proof with a one-use browser
attempt, PKCE, state and nonce. No other route is exposed by the shared listener.

Temporary connection problems keep the local session and do not mean access ended.
If a send's outcome is unknown, inspect the conversation before sending again;
the client does not resend it. An unconfirmed sign-out keeps the local session and
says so. Stream access checks run once per session every five seconds and on
identity changes. A temporary check failure pauses project events and reports a
temporary problem; a confirmed loss of access ends the stream.

Known limits: there is no certificate rotation command yet. Invitation acceptance
is throttled per socket address; rotating source addresses can evade that budget.
