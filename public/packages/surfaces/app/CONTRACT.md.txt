# thread-app surface contract (DRAFT 0)

**Owner:** surface owner (memo 02 confirms the composition).

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

## Owns

Only per-viewer UI state: layout, theme, and open tabs as preference. **No durable work state.**

## Provides

The screens, regions, states, flows and keyboard behaviour specified in the composition section of `reference-baseline.md` (Phase P3, memo 02). The map is the specification; screenshots are its evidence.

## Memory and learned procedures

More > Memory shows each remembered fact with its origin and lets the person edit or forget it. The next turn recalls the current stored facts. A new task's composer can turn memory off for that task; its draft preserves the choice, its later turns show it, and a new chat defaults to memory on. The platform enforces the setting. The Memory page shows a skill draft's full text and source turns, lets the person edit before accepting or decline, and offers editing, removal and undo for accepted skills. Unsaved skill edits retain their original revision while live views refresh; a stale save keeps the person's typed text and displays the refusal. Rollback and credential/withdrawal checks belong to the platform. The installed-capable journeys are in `e2e/memory-controls.electron.spec.ts`.

## Consumes

- `api` only: current views in, commands out, receipts back (R-ARCH-SURF-01);
- the Presentation port (brand profile data).

## Composition (slices 1–2, from `reference-baseline.md` §2)

- **Slice 1:** Home; sidebar (R-UX-SIDEBAR-01); thread with on-demand details (R-UX-THREAD-01); composer (R-UX-COMPOSER-01); right pane with a tab registry (R-UX-PANES-01) holding Changes, Files, Terminal and the read-only Side chat (R-UX-SIDECHAT-01).
- **Slice 2:** split view (R-UX-SPLIT-01); attention mode (R-UX-INBOX-01); phone (R-UX-PHONE-01); Subagents tab and child rows (R-MA-*).
- **Keyboard (R-UX-KEYS-01):** where the references agree, use the shared shortcut: Terminal ⌃\`. Where they differ, Backbone uses Codex's: Changes ⌃⇧G, Files ⌘P, Side chat ⌥⌘S. The reason is that Codex was navigated live while Claude's shortcuts are from docs. Browser is ⌘⇧B in both (Codex browser split, Claude browser). These choices can be revisited after the second P-03 pass.
- **Version and pin fields** of every row are filled by the P-03 second pass.
- **Work while it happens, 4 November.** A running turn shows its steps, the engine's commentary among them, as they happen, the way Codex, Claude and Cursor do; it folds when the turn ends unless the person opened or closed it, and a folded running turn shows its latest step beside "Working…".
- **Task route selection, 5 November (app candidate).** The model/effort menu opens an explicit comparison of available routes against capability, model-connection and spending-category requirements. It displays the selector's reasons, alternatives and exclusions; starting rechecks availability and either starts the chosen route or retains the draft with a concrete reason. Unconfirmed submissions retain their exact task, text, settings and idempotency key across reload, without falling back to ordinary Send. Edits preserve the original pending identity and a newer draft separately; an explicit discard forgets only the local retry record and keeps the draft, without cancelling remote work or resolving unknown outcome. Its warning remains visible through edits until a confirmed send or a chat change. Late confirmations offer Open sent chat; goal-setup errors do not relabel admitted messages as unsent. Late responses from a superseded composer cannot overwrite the active draft. A selected turn records the pinned/execution route and can check its written file versions through the existing API; these checks do not establish content quality or whole-task completion. This is the current route selector, not the complete workflow/Arena selection promise. Goal-run records remain visible on their own turns and do not replace the person's previous chat choice or its prefilled requirements in the composer. The app candidate's attachment and follow-up qualification depends on the owning backend composition; its scoped report records that boundary.
- **Streaming and reading, 5 November.** Answers use Streamdown's incremental blocks, including incomplete Markdown, throughout a turn and after Stop. A workspace-link refresh updates affected React links without remounting the answer or losing selected text. The maintained shadcn MessageScroller owns turn anchoring, following output at the live edge, preserving a reader's position after scrolling away, selecting text or focusing the transcript, loading history and returning to the latest response. The transcript is keyboard focusable; it does not announce every token. Code blocks offer Copy once generation has stopped. Snapshots remain authoritative, including a replacement or shorter answer; presentation never invents or resends text. This is renderer behavior, not a change to turn, effect or file-link authority.
- **Design pass, 25 October.** the maintainer simplified the sidebar on 4 November. Projects and chats stay in the main list. More opens Now, Scheduled, Memory and Mail triage. The Needs you bell sits between Settings and the theme controls. A dot marks waiting brief items, goals, or changes a connected tool asked for that are held for the person, and the accessible label gives the count. The bell opens a popover above the footer; a held change opens Settings › Connected tools, where it is permitted or discarded. The app also has sectioned Settings (You, Workspace), a file tree with Files, Activity and Review, CodeMirror for editing, Streamdown for reading, and a collapsible work block. Controls without a backend are disabled and name their stage (`src/lib/stages.ts`).
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
- A side-by-side comparison by navigation with the reference apps, approved by the maintainer (R-UX-PARITY-01, O-11).
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
