# thread-app surface contract (DRAFT 0)

**Owner:** surface owner. The composition is specified in this contract.

**Layer:** L3.

**Status:** have, with thin composition.

## Purpose

The familiar whole app:
- conversation, with the real material beside it;
- Home;
- files;
- editor;
- split view;
- settings.

Current Claude Desktop is its visual and interaction reference: components, menus, composer, spacing, type and the right panel. The sidebar and chat keep the earlier Backbone colours (source in `test/tokens.test.ts`); the right panel is a neutral document surface. Anything the reference lacks, such as unknown outcome, Stop, giving permission and person versus agent versions, stays Backbone's and is never hidden to match it.

## Areas and the shared interaction contract (14 November 2026)

**Why this section exists.** The composition below grew one dated entry at a time, each answering one example. The owner's instructions of 19 and 20 October already asked for one coherent whole-app experience with examples as context, and on 14 November he asked again: understand the complete reference experiences, settle what they share and why they differ, and deliver one app by area. This section is that structure. It records choices with their reasons; each is revisable when evidence or the owner's steering changes, and is then changed here once. The dated entries below remain as detail and history; where one disagrees with this section, this section is the current reading.

**Why the app has this shape.** Conversation is where the person directs the work, with the material beside it on demand; closing a panel never stops work. The composition follows Claude Desktop's components, menus, composer, spacing and right panel, with the earlier warm colours kept in the sidebar and conversation and a neutral document surface (31 October). Repeated headings, summary strips and toolbars were consolidated into one row per region, with detail on demand (27 October). The sidebar keeps what every use shares and puts jobs under More (4 November). Settings is searchable and sectioned, each row a title, a short explanation and a control (25 October). Controls for things that did not work yet were removed on 2 November: that removed false promises, not the ambitions behind them. The owner likes the present look, sidebar and most of Settings; that is current steering and evidence the base works, not a rule against a better coherent arrangement.

**What the references are evidence of.** Each reading is dated and scoped; none proves that every reference behaves the same way, or how an installed build behaves for every account.

| Reference | Version and date read | How it was read |
| --- | --- | --- |
| Claude Desktop | 5.1231.2, installed, 14 November 2026 | Its Code view observed in use: separate Terminal, Changes, Browser and Files toggles, a movable side panel, background tasks. Documentation for the rest |
| ChatGPT and Codex desktop | 26.1111.21308, installed, 14 November 2026 | Documentation, and Codex navigated live in October for the shortcut choices |
| Cursor | 3.29.15, installed, 14 November 2026 | Documentation only |
| OpenCode | 2.3.0, 13 November 2026, source `a6b15d33`, MIT | Source and documentation read, not run. Its desktop app is labelled beta and its new session sidebars experimental |
| OpenHands Agent Canvas | 1.40.0, 12 November 2026, source `5095273d`, MIT | Source and documentation read, not run |

The capability comparison across products is in the two reference files ([Claude, OpenClaw, OpenCode](../../../docs/references/2026-11-claude-openclaw-opencode.md); [Codex, Hermes, Paperclip, Gemini](../../../docs/references/2026-11-codex-hermes-paperclip-gemini.md)); its OpenCode reading is of 2.2.6 and is a dated reading.

**Patterns seen across them, taken here as design choices.** These are observations from the readings above, not proven behaviour of each product:

1. One main window: the list of work on one side, the conversation in the middle, the result beside it. OpenCode and OpenHands add execution context (which engine, which backend) where it changes the person's decision.
2. Compose first: the opening view is an input, and a new conversation needs nothing else.
3. Work is visible while it happens and is summarised when it ends, with the detail one step away.
4. Results open beside the conversation: a document, a change, a page, a terminal. The person goes from reading, to inspecting, to editing or reviewing, and back, as one flow.
5. The same action means the same thing wherever it is offered.
6. Settings are named by what the person decides, and what is connected can be found without knowing the architecture.
7. Work goes on when the window is closed, and the same work, draft and result are recognisable on return. Both open-source references shipped fixes in November for drafts lost on switching and interrupted streams, which shows why complete state transitions matter.

**Where this app differs today, and why.** An outcome that cannot be established is shown as not known. Permission is given once and reviewed in one place, in place of a question per action. A person's version and an agent's version of a document are told apart. The owner's engine and the model that answers colleagues are separate. It is built first for documents and everyday assistant work, where Cursor and OpenCode are built first for code. It has no cloud coordination today; that describes the present product, not a limit on it. A reference feature is adopted when a journey here needs it, with its context and reasons, not because a reference has it.

### Choices made once

Every area follows these. They keep the app in one voice; they do not stop a screen from having the layout its job needs. A change to one is made here and applied wherever it bears.

| Subject | Choice and its reason |
| --- | --- |
| Navigation | One sidebar holds projects, conversations and pins; More holds the jobs; Settings is one dialog; the conversation's tab row is the top bar of the middle region. One window is the default. A separate window is right where the system or the journey calls for it: native dialogs, the company sign-in, the joined workspace that opens in its own window, and any later case with a stated reason. |
| Panes | One pane beside the conversation holds tool tabs and document tabs, opened from one launcher. It can be resized, hidden to its launcher and restored; hiding it never stops work. A second conversation beside the first is a split of the middle region, a different thing from a tool tab. |
| Actions and menus | An action has one definition: the same meaning and the same permission wherever it is offered. Where an item has a menu button, a right-click on it offers that item's actions too. Lists may differ by context, role and input (a joined colleague sees fewer; touch has no hover), and only frequent actions need a shortcut. Icon-only controls carry a name and show it, with any shortcut, on hover and on focus. |
| Words | The [glossary](../../../README.md#words-used-here) owns the vocabulary. One word per thing across screens and messages: data folder, project, conversation, engine, model, shared work, permission. |
| Undo and confirmation | A change that can be undone inside the app is done at once and offers Undo; it asks nothing. Undo is a new inverse request with the same permission and outcome checks. Irreversible changes retain their confirmation. |
| State and feedback | A view shows the states that apply to it, in the same way as other views: loading, empty, refused with the reason, not known, saving, saved, failed. What the person typed survives a refusal or a failure. Retry is offered only for an operation known to be safe to repeat. For an effect that may have been dispatched, the app says it is not known and offers to check what happened; it does not repeat it to clear an error. One primary action per view; a destructive action looks destructive and is confirmed where it cannot be undone. |
| Keyboard and focus | Controls are reachable and operable by keyboard. When a menu, dialog or tab closes, focus returns to what opened it, or to the nearest thing that still exists if that was removed or the person's access to it ended. Shortcuts are registered in one file and shown in the control's help. |
| Visual base | The tokens and shared components in `src/styles.css` and `src/components/ui/` are the base the owner likes. A colour, a type size, a button or a menu is changed there, so it changes everywhere. A screen arranges those parts as its job needs. Detail and diagnostics are available on demand. |
| Persistence | Per viewer and restored on reopening: drafts, open tabs, the selected conversation, the pane's size and whether it is hidden, the Settings section last used. Work state is never kept by the interface. |
| Brand | The name, mark and colours come from the distribution. The mark is the original one of four slanted green bars. |

### Areas

Each area is a set of whole journeys with one writer at a time. Areas coordinate responsibility and shared outcomes; they are not a compulsory order of work or an approval step, and a defect is fixed where it is found. The file lists say where an area's work usually lives. Where two areas meet in one file, the writer who holds it hands it over explicitly (one writer at a time, as everywhere in this repository); no further approval is needed. A change to a shared component or to a choice above goes through the integrator, because every area inherits it.

| Area | Journeys it completes | Where its work lives |
| --- | --- | --- |
| Shell and entry | Open the app for the first time; recover a data folder held elsewhere; find, pin, rename, move, archive and search work; start a new conversation from anywhere | `src/App.tsx`, `src/components/Sidebar.tsx`, `Home.tsx`, `ConversationTabs.tsx`, `HeldHome.tsx`, `FullAccessCard.tsx` |
| Conversation | Write, attach, send, queue, steer and stop; follow work as it happens; read the answer, its sources and its effects; resolve what is not known; branch and rewind | `src/components/Composer.tsx`, `Thread.tsx`, `ThreadWork.tsx`, `Rewind.tsx`, `UnknownOutcome.tsx` |
| Workspace pane | Open a result beside the conversation and keep working: read and edit a document, review a change, run a command, look at a page, ask a side question; hide and restore the pane; a second conversation beside the first | `src/components/Pane.tsx`, `tabs/`, `files/` |
| Settings and setup | Choose the engine and the models; connect apps and other assistants and see what each may do; give and end permission; back up and restore; routines, telemetry, notices | `src/components/SettingsDialog.tsx` and `settings/`, except the Team files below |
| Team | Sign in to a company or join another computer; invite; share a project; see who can do what; work in a shared conversation; remove a person | `settings/IdentityEntry.tsx`, `PeopleRoles.tsx`, `PeopleAutomations.tsx`, `SharedListener.tsx`, `ProjectSharing.tsx`, `src/components/SharedConversation.tsx` |
| Foundations and brand | The shared components, tokens, menus, help on hover and focus, the app's mark and name | `src/components/ui/`, `src/styles.css`, `src/lib/keys.ts`, the distribution's assets |

Team's sections open inside the Settings dialog, and the first sign-in or join is part of opening the app: Settings and Shell hand those files to Team when Team's journey changes them, and Team follows the Settings layout and the shell's entry flow.

**Seams between areas.** What one area shows must agree with the others: the selected project, person and workspace are the same in the sidebar, the composer, the pane and Settings, and a late answer is never shown under a newer selection. Draft, sent, confirmed, refused and not known stay distinguishable across sending, creating a project, saving a file, the terminal, the browser, connected tools, automations and restore. A link to a result names its version, and closing a tab cancels nothing. A choice in Settings agrees with what then runs and with the receipts shown. Closing the window, restarting, restoring and losing a remote connection keep the right work, drafts and permissions and never replay an outside effect.

**Looked at together.** Units are composed on one head before release. For the surfaces a head changes, the lead looks at their screenshots beside the neighbouring ones, in the states that apply and in light and dark, for one voice in words, buttons, states and spacing; then the gate; then the installed app is used on a representative job. This is scoped to what changed, not a check of every area in every state. The owner's judgement of the installed app is recorded separately.

## Owns

Only per-viewer UI state: layout, theme, and open tabs as preference. **No durable work state.**

## Provides

The screens, regions, states, flows and keyboard behaviour specified in this contract: the areas and choices above and the dated composition entries below. The reference baseline of 23 October that first mapped them was written in an earlier checkout and is not in this repository; what it settled is carried here. Screenshots are evidence of the composition, not its specification.

## Project actions

Project rows offer Rename and Archive from the same shared item list in the more
menu and the right-click/Shift+F10 menu. Only project owners see these actions;
the platform checks live ownership and returns the reason for a refusal. Rename
edits in place, keeps typed text after a refusal and returns focus to the row.
Archiving hides the project and its conversations without changing their records.
More → Archived restores it. Selection and focus move to surviving work.
The app shows saving, refusal and unknown outcome; an unknown response offers a
read of the current project list and never repeats the change. See the
[platform contract](../../../docs/contracts/project-actions.md) for storage,
permission, schedule and sharing semantics. The renderer journey is
`e2e/project-actions.browser.spec.ts`.

## Memory and learned procedures

More > Memory shows each remembered fact with its origin and lets the person edit or forget it. The next turn recalls the current stored facts. A new task's composer can turn memory off for that task; its draft preserves the choice, its later turns show it, and a new chat defaults to memory on. The platform enforces the setting. The Memory page shows a skill draft's full text and source turns, lets the person edit before accepting or decline, and offers editing, removal and undo for accepted skills. Unsaved skill edits retain their original revision while live views refresh; a stale save keeps the person's typed text and displays the refusal. Rollback and credential/withdrawal checks belong to the platform. The installed-capable journeys are in `e2e/memory-controls.electron.spec.ts`.

## Consumes

- `api` only: current views in, commands out, receipts back (R-ARCH-SURF-01);
- the Presentation port (brand profile data).

## Composition (dated entries)

- **Slice 1:** Home; sidebar (R-UX-SIDEBAR-01); thread with on-demand details (R-UX-THREAD-01); composer (R-UX-COMPOSER-01); right pane with a tab registry (R-UX-PANES-01) holding Changes, Files, Terminal, Browser and the read-only Side chat (R-UX-SIDECHAT-01).
- **Slice 2:** split view (R-UX-SPLIT-01); attention mode (R-UX-INBOX-01); phone (R-UX-PHONE-01); Subagents tab and child rows (R-MA-*).
- **Keyboard (R-UX-KEYS-01):** where the references agree, use the shared shortcut: Terminal ⌃\`. Where they differ, Backbone uses Codex's: Changes ⌃⇧G, Files ⌘P, Side chat ⌥⌘S. The reason is that Codex was navigated live while Claude's shortcuts are from docs. Browser is ⌘⇧B in both (Codex browser split, Claude browser). These choices can be revisited after the second P-03 pass.
- **Personal browser (14 November).** Browser opens from the existing pane launcher or ⌘⇧B (Ctrl+Shift+B elsewhere). Its shared tab displays the page title; its toolbar provides address, Back, Forward, Reload/Stop and Open in my browser, with shared help on hover and keyboard focus. Answer links offer Open beside in the existing link confirmation. Loading, stopped, failed with explicit Retry, blocked and unconfirmed state are visible; page requests are never retried automatically. Bare local/private hosts use HTTP; other bare hosts use HTTPS. The address shows the canonical URL actually opened. Answer links require an explicit HTTP(S) scheme; bare-host completion applies only to typed addresses. For typed addresses and answer links, credentials, backslashes, control characters and addresses over 8,192 characters are refused. Escape or ⌘L/Ctrl+L from a page returns focus to the address; ⌘R/Ctrl+R reloads that page. A page cannot veto navigation or close through beforeunload. Refused links show a toolbar notice and preserve the current page; refusing a subframe does not hide its parent. Closing or hiding the tab retains the view and history until the window closes, with audio muted while hidden. Timers and network activity continue while hidden. Page addresses and history are not written to preferences. The company configuration and non-owner local windows receive an explicit refusal. The joined view has no browser and explains that pages belong to the local device owner.
- **Browser boundary.** Local tests prove a separate in-memory Electron WebContentsView session, absent app cookies/storage and renderer bridge, refused IPC from a foreign page and a non-owner window, denied new windows/downloads, denied permission requests/checks and the configured sandbox, isolation, web security and Node/preload settings. Top-level addresses stay HTTP(S); the request filter also admits WS(S) for live previews and local document resources. Chromium-permitted about:blank, srcdoc, data and blob subframes remain usable; file and custom schemes are refused. A privileged custom subresource control distinguishes session-filter enforcement from Chromium defaults. Invalid server certificates are refused, and the local HTTPS fixture receives no client certificate. Explicit handler refusal is proved separately by an offered-certificate callback test; the fixture does not install an identity in the operating-system store. Electron does not return navigateOnDragDrop in its runtime preferences; the constructor-input test asserts it, without claiming native drag/drop coverage. Device and display-capture denial callbacks and frame/redirect cancellation are exercised with inert ports in controller tests, without claiming physical device or operating-system chooser coverage. Native bounds follow the pane; app menus, dialogs and fixed alerts hide the page. Pages belong to the person; the assistant has no port to read or control them. This is separate from the assistant-driven browser-task journey.
- **Browser and managed policy.** Main rechecks the existing protected policy reader before navigation, every request and once per second while a view exists. Any active policy blocks personal browsing: the current schema describes engine routes but has no complete browser destination rule. A refused policy preserves its reason. Live revocation closes the browsing context, closes session connections and clears page storage; it never merely hides a running page. This intentionally conservative restriction can be relaxed only with an enforceable browser network policy.
- **Browser proof.** `e2e/browser-pane.electron.spec.ts` drives the development Electron app against local HTTP, HTTPS and WebSocket fixtures, including unload cancellation, srcdoc, refused links, native preferences, owner IPC, fixed alerts, page reload and shared help. Its managed-policy test uses production registerBrowserPane with an injected policy reader, checks the retired session storage and an idle session connection, then recreates a clean page. `e2e/browser-feedback.browser.spec.ts` drives the real renderer with synthetic company and joined responses. `test/browser-pane.test.ts` executes the production controller with inert Electron ports, including offered certificates, device/display callbacks, navigation events, disposal, hidden audio and production registration with an upstream policy fixture. `test/browser-address.test.ts` and `test/browser-policy.test.ts` cover address and policy decisions. These are local test evidence, with light/dark and narrow screenshots; they do not establish an installed app, real keychain client identity, physical device, signed system-policy deployment or real-use acceptance. The CLI installation check is packaging regression evidence only.
- **Version and pin fields** of every row are filled by the P-03 second pass.
- **Work while it happens, 4 November.** A running turn shows its steps, the engine's commentary among them, as they happen, the way Codex, Claude and Cursor do; it folds when the turn ends unless the person opened or closed it, and a folded running turn shows its latest step beside "Working…".
- **Task route selection, 5 November (app candidate).** The model/effort menu opens an explicit comparison of available routes against capability, model-connection and spending-category requirements. It displays the selector's reasons, alternatives and exclusions; starting rechecks availability and either starts the chosen route or retains the draft with a concrete reason. Unconfirmed submissions retain their exact task, text, settings and idempotency key across reload, without falling back to ordinary Send. Edits preserve the original pending identity and a newer draft separately; an explicit discard forgets only the local retry record and keeps the draft, without cancelling remote work or resolving unknown outcome. Its warning remains visible through edits until a confirmed send or a chat change. Late confirmations offer Open sent chat; goal-setup errors do not relabel admitted messages as unsent. Late responses from a superseded composer cannot overwrite the active draft. A selected turn records the pinned/execution route and can check its written file versions through the existing API; these checks do not establish content quality or whole-task completion. This is the current route selector, not the complete workflow/Arena selection promise. Goal-run records remain visible on their own turns and do not replace the person's previous chat choice or its prefilled requirements in the composer. The app candidate's attachment and follow-up qualification depends on the owning backend composition; its scoped report records that boundary.
- **Streaming and reading, 5 November.** Answers use Streamdown's incremental blocks, including incomplete Markdown, throughout a turn and after Stop. A workspace-link refresh updates affected React links without remounting the answer or losing selected text. The maintained shadcn MessageScroller owns turn anchoring, following output at the live edge, preserving a reader's position after scrolling away, selecting text or focusing the transcript, loading history and returning to the latest response. The transcript is keyboard focusable; it does not announce every token. Code blocks offer Copy once generation has stopped. Snapshots remain authoritative, including a replacement or shorter answer; presentation never invents or resends text. This is renderer behavior, not a change to turn, effect or file-link authority.
- **Design pass, 25 October.** Alberto simplified the sidebar on 4 November. Projects and chats stay in the main list. More opens Now, Scheduled, Memory and Mail triage. The Needs you bell sits between Settings and the theme controls. A dot marks waiting brief items, goals, or changes a connected tool asked for that are held for the person, and the accessible label gives the count. The bell opens a popover above the footer; a held change opens Settings › Connected tools, where it is permitted or discarded. The app also has sectioned Settings (You, Workspace), a file tree with Files, Activity and Review, CodeMirror for editing, Streamdown for reading, and a collapsible work block. Controls without a backend are disabled and name their stage (`src/lib/stages.ts`).
- **Jobs stay secondary (31 Oct):** primary navigation holds what every use of the app shares. A specific job, such as Mail triage, opens from More.
- **Compact composition (27 Oct, owner delegated UI judgement):** one shared window row per split region, with a title menu for a single chat and tabs for multiple conversations. Chat/project/attachment details and document metadata are available on demand; no permanent duplicate heading, summary strip or document toolbar. Save appears when there are edits; errors, interrupted saves and stale-draft recovery remain visible. Standard native macOS controls remain native. The component arrangement is revisable; it is not an authority or data contract. Current implementation/reference ownership is in README's Workspace composition section.
- **Goals and children (1 Nov, additive):** the chat details menu sets, changes and clears a thread's goal and starts a worker or a reviewer; the goal, an agent's open proposal with Accept and Decline, and each child with its handover show above the transcript. A proposal changes nothing until accepted, and a child's unresolved outcome stays marked. The sidebar forks a chat into a new one. Uses `goals.set`, `goals.clear`, `goals.decide`, `children.start`, `threads.fork`. Asking for a review where none can run says why in the dialog, with nothing to submit. Forking into a worktree and new windows are not built.
- **While a turn runs (1 Nov, additive):** text typed during a turn offers Send when done, and Steer where the engine can confirm delivery; otherwise the composer says it cannot. Waiting messages sit above the composer, editable and removable, and say so when they wait for the person (Send now) rather than the turn. A steered message shows only what the engine confirmed: unconfirmed is never shown as reached. A child row lists each document a worker made: Bring back, or Keep beside yours once the document has moved on, or why it cannot come. Uses `turns.steer`, `queue.add`, `queue.edit`, `queue.remove`, `queue.send`, `children.merge`.
- **Settings (24 Oct, additive):** Settings, from the sidebar, has the model route in its own section (R-MODEL-02): the person's own key first, then Vercel AI Gateway or OpenRouter, each saying who bills it (R-MODEL-01). It uses `settings.model.get` and `settings.model.put`; a pasted key is sealed by the platform at once and never read back.
- **Connected tools (desktop, 10 November).** Turning a server or tool on requires the existing native question and the person's stamped Host path. The renderer can only reduce authority through connectors.set. Single and batch enabling retain their native confirmation, cancellation and changed-question checks; app-owned sentences precede cleaned and clipped server text. The stamped test helper enables fixtures through the same product functions.
- **Tool permissions (desktop, 10 November).** Settings lists active connector-tool permissions with connection, local permission time, description, permission extent and recorded calls for that tool. The sender-checked desktop ending channel accepts only nonempty server/tool strings of at most 1024 characters each and always calls connectors.set with standing: false; it cannot give a permission, open sending or change other tool choices. Host refusals are returned unchanged as receipt data without an IPC rejection prefix; thrown errors map only to the Host's fixed signature-end diagnostic, never arbitrary backend text. A thrown end is unknown outcome and retains End not confirmed with End again for an idempotent retry; a confirmed local removal says Ended locally, with Core confirmation: Not available yet. Refusals keep the row; blocked listings clear old diagnostics and retained tool rows, and failed reloads hide retained rows. Core status reports Paused when permitted calls are refused. Calls approved on an ended permission are checked again before sending; calls already sent cannot be undone here. Permission ID, historical definition and exact per-signature history remain Not available yet. How much runs without asking offers Full and Custom as renderer view choices: both apply the same rules, and Custom only shows per-tool choices. Giving a permission still uses the existing native desktop question. Balanced and Strict stay disabled with their future behavior stated. No data folder setting or settings IPC channel exists for this view choice. `e2e/signed-tools.electron.spec.ts` qualifies the real development Electron/IPC/Host/Core path, native question via test presence, actual Core pause, end failure/retry and refusal; `e2e/signed-tools.spec.ts` retains browser coverage. Installed packaging is a separate qualification. Offline ending and additional listing fields are the two remaining [Not yet](#not-yet) items.
- **Connect your AI tools (26 Oct, additive):** a Settings section lists Claude Code, Codex, Cursor and Claude Desktop as connected, not connected, needs restart or not installed, with each tool's permission and receipts count. Connect asks the main process, which shows the actual permission in a native window ("Claude Code may: write files to …’s outbox · up to medium risk · until …") with the door's own defaults: one click on Connect approves it; "Change…" narrows the ceiling and the expiry and switches on Codex asking before each call. The renderer cannot give permission: connecting is not an api method (`electron/connect-tool.ts` calls `Host.connectTool`), and every IPC handler answers only the app's own top-level page (Electron's security checklist, item 17; `electron/sender.ts`). Entries start the door inside the app (`Contents/Resources/bin/backbone-mcp`, written by `packages/surfaces/app/scripts/build.mjs`). After an update changes the door, the row offers "Approve again": the same window, one click. One app runs per data folder (Electron's single-instance lock): a second launch brings the first forward. Disconnect is one click. It uses `tools.list` and `tools.disconnect`; the main process gives the host the door the app ships (`dist/pieces/mcp`, run by the app's own runtime as Node).

- **Project creation recovery (candidate, 6 November).** Before dispatch, the dialog saves the normalized name, kind and creation identity in the revisioned draft store. An unconfirmed response keeps that attempt visible after reopening; Check again uses the same identity. Discard warns that the earlier project may still exist or finish and does not undo it. The Host reserves that identity before filesystem effects, exposes only completed projects and reports ambiguous interrupted preparation as unknown without repeating it. Legacy no-key callers retain their previous behavior. When the reservation is readable, the unknown outcome detail names its reserved folder for inspection; leaving the attempt hides it from the dialog and keeps its intent and any files on disk. This unknown outcome is not a Core-held gateway effect, and partial folders are not included by project backup. Accepted limits: synchronous Git preparation can outlast the shared lock refresh; path-based checks cannot eliminate a same-user directory-swap race; intent records are retained indefinitely. A symlinked projects root is refused. Disk-full can prevent recording a known failure, leaving unknown outcome; each observed failed Git setup may leave a partial folder. This candidate does not claim automatic recovery of ambiguous partial repositories, cuts inside Git, or power-loss qualification.

## Rules

- **Powerless.** No direct `db` or service import (layer gate).
- **Draft, pending and committed look different** (R-UX-DRAFT-01). Restoring a draft includes its source IDs and retry custody before editing, attaching or sending is enabled. A failed read keeps composing closed and offers a retry; unavailable sources remain visible.
- **View ownership:** changing a diff scope, base, project/thread or document/version hides the prior query result until its replacement arrives. Late reads and syntax highlighting cannot relabel another patch. Read failures show a retry. Side-chat drafts use the existing draft store under their own thread key; refusal or response loss retains the text. A late response cannot clear another view or newer edit, and an in-flight question remains guarded when its tab remounts. These are renderer custody controls, not backend idempotency or proof of a model-backed side assistant.
- **Closing a panel or the window never stops a task** (R-UX-DOCK-01).
- **Home is one centred input with only its own controls below it** (R-UX-HOME-01).
- **Split view works in both meanings:** chat beside tools, and session beside session (R-UX-SPLIT-01). It ships in slice 2.
- **No second API implementation.** The old repository's 6,660-line mock backend is not carried over; offline and demo cases run against embedded PostgreSQL.

## Acceptance

**Continuity composition, 28 October 2026 (development candidate):** reuse the current
platform draft and material APIs. One ordered renderer writer coalesces draft
updates and drains them before an ordinary close. An edit typed after Save/send
starts survives the earlier response; empty edits remain drafts; Save compares
the displayed base and retains saved history. Failed close persistence leaves
the window open with an error. The renderer cannot sign a capability, choose a
new authority or use its draft as a receipt. Existing main-process triage giving permission,
native-route settings and task execution ownership remain applicable. These
changes require the composed browser/Electron checks; adopting the mechanism
does not itself accept the installed product.

Ordinary close joins active draft-affecting Save, send, attachment, restore and
discard continuations before its final drain. Home-to-thread transfer confirms
the destination's current generation before clearing the source or navigating;
transfer failure retains the source draft and names the already-sent message.
A rejected Save returns a retained or reopened draft to a retryable state.
Navigation preferences queued by a pending send are drained after those
continuations, before the window closes.

File links carry their cited version through viewer preferences and downloads.
A historical result opens read only, with an explicit route to the current
editable document; a missing version reports an error rather than opening the
latest. A link that still names the current version remains editable, and a
successful Save moves that view to the current workspace tab. Human saves and
their unsaved drafts remain with the existing material/draft owners.
A delayed Save respects a later tab close or selection. A departed editor does
not clear/rebase another mount's draft or reopen its view; an older-base draft
remains available through the existing explicit Restore action.

- J-01 and J-ma on the installed app, with screenshots in Light and Dark at 375 and 1440 px.
- A side-by-side comparison by navigation with the reference apps, approved by Alberto (R-UX-PARITY-01, O-11).
- **Adverse case:** quit with unsent text and an unsaved edit. A cold start restores both from the server.

## Installed verification scope

The installed runner selects `e2e/electron.spec.ts` and
`e2e/triage.electron.spec.ts` explicitly, retaining both installed-capable suites. A broad
Electron-project match is not evidence that development-only continuity/tool
fixtures used an installed executable. Those fixtures stay in the development
suite and require separate installed-path work before an installed claim.

The runner creates and names its temporary application target before invoking the
installer. Returned stdout must identify the expected executable inside that
owned root; it cannot confer ownership of another cleanup directory. Failure and
signal outcomes stay failures, and cleanup failure is reported separately with
its owned path. Only the temporary app copy belongs to this wrapper; fixture data
data folders, human work, current permissions and pending/unknown outcome effects keep their owners.
The fixture uses Pi plus its scripted route, without inheriting an ambient native
executor selection. Runner unit checks use inert commands. Actual packaged,
process/physical, account and installed acceptance still need their owning run.

## Exit test

Replaceable surface. A second client (the CLI or an MCP client) completes J-01's Save through the same API.

## Change procedure

Inside the surface. An API change goes through `api` and its consumers.

## Connector approval and inspection

Electron main owns native confirmations for one exact held action, one permission, and an unknown call’s three answers. Permit lists short recipient, subject and ID arguments first. Small calls show the complete quoted statement and JSON arguments, with hidden characters escaped rather than silently changed. Calls over 1,500 JSON argument characters, any value over 600, or an oversized statement use an explicitly partial, bounded preview: short fields, argument hash and total JSON length, with the full call in Connected tools. Sending names use the same one-call permission and giving permission paths. Signing shows bounded schema property names and a sending-argument capability warning, plus descriptive name/annotation warnings. Main’s IPC handlers refuse foreign pages, validate identities and re-read the question after confirmation; the Host repeats immutable Core binding checks and preserves ownership, close, read-only and import guards. No renderer, engine, general API method or read-only API line can supply the person’s answer.

Connected tools shows unresolved unknown calls separately from decided calls, retaining exact statements, Core dispatch admission time/receipt and immutable releasing permission identity when available. Missing history remains unavailable. It names the paused tool and distinguishes Waiting from unknown outcome. The native inspection dialog also shows the retained dispatch admission time and releasing permission ID, or Not available when missing; main rechecks that evidence after the click. Resolve outcome asks “It did happen”, “It did not happen”, or “I do not know, keep it closed”; cancellation changes nothing. These are personal observations, never automatic conclusions from connector results. Other tools, reads and individual permissions remain available. The existing asked API line can carry a CLI inspection only through main’s native confirmation and the same Host capability.

Tool permissions uses the Core permission identity and each call’s immutable standingSignatureId for exact history, including failed/unknown outcomes. It never joins by timestamps or substitutes the current permission for a historical one. Legacy projections without identities remain explicitly unavailable. Ending uses an ownership-only Host method that does not wait for Core: its receipt acknowledges local removal and a pending Core end. Queue state distinguishes pending and conflict, and an empty queue is described only as no pending local end, never a fabricated Core ledger receipt. The complete permitted definition snapshot is not yet available; no historical snapshot is invented. Cold startup and listing still require Core, so this does not claim an entirely offline screen.

## Bundled notices

Settings → Licences and notices reads and searches the local build inventory.
The existing trusted-sender check protects its read-only IPC; only indexed notice
identifiers cross the bridge. Composite Chromium HTML runs in an empty sandbox.
[Bundled notices](../../../docs/contracts/bundled-notices.md) owns the resource
contract and its installed proving journey.

Held actions projects canonical inline attachments as filename, MIME type and decoded
byte count, with the immutable call hash. Open attachment previews those retained
bytes locally (text, common images, or a hexadecimal byte view); Save attachment
downloads exactly those bytes. HTML and SVG remain inert text. Previews over 65,536
characters/bytes are explicitly partial; saving retains the complete file. The
projection never rewrites stored statements or release arguments. A malformed
attachment or mismatched statement is not silently repaired for display.

## People and project sharing (11 November 2026)

Settings › People and roles lets an owner or admin issue a one-use invitation,
change the existing workspace roles, remove a person and manage a named-person
project automation. Settings › Sharing grants viewer/editor access to one project.
A separate sign-in window begins without device-owner authority. A viewer sees
only shared projects; its composer and file editor expose read-only state, backed
by Host and Core enforcement. Removing the person ends that live window's access.
Main owns session bearers and the company browser callback; renderer input never
chooses an actor. The installed identity spec proves the two-window journey.

Revocation also retires the layout writer. Pending layout state is retained in
that window's session storage, which Main clears before an account switch. It
is not resent through the ended session. Draft and document drains still refuse
close when their work is unconfirmed; they never borrow the device owner's
identity. This separates cosmetic layout persistence from preserving work.


## Joining another computer

People and roles can opt the owner’s running Host into the existing shared TLS
listener and issue private join links. File › Join a workspace opens the existing
sign-in window. Main binds that window’s typed API to a pinned RemoteClient and
keeps its saved session in the existing vault. The renderer holds no bearer or
certificate-checking capability. Its local window remains separate. Joined
windows expose shared conversations only; viewer composers are read-only, and
unsupported local controls are absent. Temporary connection problems reconnect
and refetch without ending access. Only confirmed access loss ends it. Unknown
sends remain inspectable and cannot be resent, including after restart. A matching
turn or “I checked the conversation” releases submission custody without a send.
The saved remote record belongs to the joining local person; company sign-in must
establish that person before restoration, joining or leaving. Local sign-in keeps
its local projects; the menu or Settings opens a dedicated workspace window bound
to that person and restores their saved workspace there. Main resolves the person
once per remote session and invalidates that binding when local access ends or
changes. Same-Mac member windows cannot join as device owner. Local sign-out ends
their remote window’s access. The one-person case restores as device owner. The
menu-bar menu names active sharing and opens its off control in Settings; the
Sharing settings status also names its active address. Leaving preserves the
session if sign-out cannot be confirmed. The shared app Electron
spec proves two disposable app instances; it does not claim real network use.

## Read-only document previews

A file tab previews PNG, JPEG, GIF, WebP and SVG as image resources; PDF as
scrolling pages with selectable text and keyboard page/zoom controls; DOCX as
headings, paragraphs, lists, tables and embedded raster images; XLSX/CSV as
sheet tabs and cell values; and PPTX as numbered slides with text and embedded
raster images in shape order. Slide layout is explicitly simplified. These
views preserve the existing cited/current version identity, Download and close
focus. Other file types show their type, size and an explicit no-preview message.

A listed material can open by its file-list identity before document details
finish loading; the read still passes through the backend access checks.

The preview boundary accepts at most 20 MB of source bytes. Office archives
expand in a dedicated worker, with 2,000 entries, 16 MB per entry, 48 MB total,
200,000 XML delimiters and a 15-second deadline. DTDs/entities are refused.
Word/slide output also caps 10,000 nodes, 500,000 text characters and 8 MB
of embedded content; decks cap 200 slides.
Rebuilt archives carry verified byte lengths into the maintained Office Kit
readers. Workbook loading additionally caps 100,000 cells and 50,000 rows.
XLSX and CSV share an output budget of 500,000 characters and 20,000 nonempty
cells across all sheets in one conversion; empty coordinates do not spend it. Reaching
either budget stops conversion and keeps the converted cells, including an
incomplete last row. XLSX output keeps only populated rows and cells at their
sparse coordinates; empty grid positions are filled only in the visible window.
Row extents stay within 1,000 rows per sheet, column extents within 100, and the
archive entry ceiling also bounds the sheet count. At most the first 1,000 rows
and 100 columns are converted,
and the page lays out at most 100 rows by 10 columns at a time. A partial preview
says "Showing the first N rows of M" when the workbook model supplies M, or
"Showing the first N rows" when CSV parsing stops before its end. It identifies
an incomplete last row and omitted columns, and keeps Download for the whole file.
CSV stops parsing when its row or output budget is reached; its remaining rows
are not counted or validated. CSV uses the same 20 MB source ceiling and
15-second worker deadline; the archive expansion ceilings apply only to Office
ZIP files. A displayed cell over 10,000 characters refuses preview with its limit stated. Formulas are never evaluated.
PDF previews cap 200 pages and render only nearby pages with bounded canvases.
Image dimensions are checked while detached, before page insertion; PNG headers
are also checked before decoding. Standalone images cap 40 million pixels. Failed conversions
are remembered by material/version and limits version across restart, before any
PDF chunk or worker loads. Changing the limits version invalidates those records.
Only the latest 32 failures are retained, bounding storage when files or versions
are no longer visited. Legacy unversioned entries are removed. Remembered failures
offer Try again, which clears the record and makes one explicit conversion attempt;
the 20 MB source refusal keeps Download alone. A PDF canvas over 16 million pixels
is refused only for its current zoom, is never remembered, and recovers at a lower
zoom. PDF code and scoped text styles load on demand; a failed chunk is contained
in the tab with "This preview could not be loaded", Retry and Download.

Documents never supply live markup, styles, event handlers or URLs to the app.
Word model nodes and slide text become a fixed set of React elements with
escaped text; known Word content controls, insertions, fields, smart tags and custom XML
containers retain their text; block content controls keep separate paragraphs
and contained tables through the maintained reader. Tracked deletions stay out.
Embedded images accept only bounded raster data URLs. SVG is loaded only as an image resource, where
Chromium disables script and external resources. PDF.js receives bytes with no
viewer scripting, annotation, link or form layer, XFA, font fetching or wasm
support. Annotation appearances are painted onto the canvas. Office
workers additionally refuse network primitives. The renderer CSP is unchanged.
A failed or timed-out read keeps Download and offers explicit Retry; a size
refusal explains its ceiling without automatic retry. This is a read-only
preview contract. CSV retains its existing text editor and offers Table alongside
Text while editing an eligible working file. Both edit the same complete text and
use the existing draft, expected-version Save and recovery path. The preview grid
and Download use the displayed saved version, never an unsaved table edit.
Table editing preserves text values, multiline cells and blank records using the
maintained Papa Parse field reader/writer. Untouched records keep their exact
source bytes and individual line endings, including mixed endings; changed
records are re-encoded. It runs no formulas. The detected separator is visible
and can be selected; ambiguous data needs that choice before editing. Text keeps
the existing editor's own line-ending behaviour. Table supports adding rows and columns and pages the editor so
every admitted cell remains reachable. A malformed or oversized file stays usable
in Text; an incomplete preview is never saved as a complete table. Original,
historical, recovery and viewer-only files retain their existing read-only paths.
The model and browser journeys in `test/csv-table.test.ts` and
`e2e/csv-table.browser.spec.ts` own parsing and real version/draft/agent-read proof;
the latter uses a controlled local model, not evidence of live-model quality.
This is separate from the Documents port's future editing codecs.
