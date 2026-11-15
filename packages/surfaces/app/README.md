# Thread app (L3)

A familiar desktop chat app (Electron, React, Tailwind, Radix with shadcn/ui-pattern components, cmdk, Shiki, CodeMirror 6 and Streamdown, with IBM Plex Sans and JetBrains Mono bundled): projects and threads, the real files beside the conversation, versions and receipts, under the name a brand profile gives it.
It talks only to the platform's `api` (projection in, command out, receipt back): the Electron main hosts the platform and carries the `api` over IPC, and a browser reaches the same `api` through the HTTP bridge. Its contract is [CONTRACT.md](CONTRACT.md).

Mail capability giving permission currently proves presence through macOS Touch ID or Authorization Services
only. Other operating systems refuse giving permission; there is no Linux presence backend in this cut.
The Touch ID journey in `e2e/triage.electron.spec.ts` runs on macOS and is counted as skipped with
that reason elsewhere. The journey mocks the native prompt and never uses a real Keychain.

## Build and open

The tested path is [install and open the app](../../../docs/how-to/install-and-open-the-app.md): install, then build (both run in CI), then fetch Electron once and open it with a throwaway profile folder (needs a screen, so a person runs it):

```bash
# Select the brand with the build input described in docs/distributions.md.
pnpm --dir packages/surfaces/app build
pnpm --dir packages/surfaces/app electron:install
BACKBONE_HOME="$(mktemp -d)" pnpm --dir packages/surfaces/app start
```

With no distribution it is called "Assistant"; `BACKBONE_DISTRIBUTION` names a `distribution.json` whose brand profile renames it ([docs/distributions.md](../../../docs/distributions.md#build-your-own-distribution)). Its engine is the installed, signed-in Codex client when no API route is set up; otherwise, and as the control in comparisons, it is Pi (`harness-pi`); answers need a model route, set in Settings (a key the person pastes is sealed and never shown again). Without one, a turn is refused with what to do, and nothing reaches a model.

What is tested, and where:
- `test/sender.test.ts`: main answers only the app's own top-level page (Electron's security checklist, item 17).
- `test/tokens.test.ts`: both themes meet WCAG AA contrast; Light is warm and Dark neutral; no orange accent is left. `test/tree.test.ts`: the file tree's sorting, filtering and ARIA keyboard pattern.
- `e2e/browser.spec.ts` and `e2e/electron.spec.ts` (the J-01 journey, on the stub engine in the browser and the scripted model in Electron, so no key): the browser at 1440, 375 and 320 px in Light and Dark, and the unpacked Electron build with a real quit and cold start; a kill during Save leaves exactly one current version; Stop during a write shows `UNKNOWN` and the exact copy is not resent; a repository change shows as uncommitted and nothing is committed without the person; Settings seals a pasted key and never shows it again.
- `e2e/tools.electron.spec.ts`: Settings › Assistants using this app (formerly Connect your AI tools) on the unpacked Electron build, against fake `claude` and `codex` in a throwaway data folder: a second launch on the same data folder stopping by itself, the renderer's own `tools.connect` refused, Cancel changing nothing, the permission in plain words in main's native window approved with one click, "Change…" narrowing Codex, "Connected", a call through the launcher to the door the app ships with its receipt counted, Disconnect, the settings files back byte for byte, and the door refusing afterwards.
- `e2e/design.spec.ts`: the rebuilt screens at 1440 and 375 px, Light and Dark.
- `test/export-html.test.ts`, `test/export-policy.test.ts` and `e2e/export.electron.spec.ts`: a document's menu exports the version shown as Markdown, HTML or PDF (`brief-v3.pdf`). The renderer names only project, material, version and format; main admits it only for a document of that project that is neither held nor withdrawn, at the current or an existing earlier version, within the stored-size limit (2 MB for PDF, 20 MB otherwise), one export at a time, before reading anything. It asks where with the native save dialog (titled with project, document and version), renders with Streamdown into one page with inline styles, no script and no remote reference (links keep their words, not their target), and writes a fresh file beside the chosen one (exclusive, never through a link) that it renames onto the chosen name: an existing regular file there is replaced, as approved in the dialog; a link, a non-file, or a folder whose real path changed since the dialog is refused. PDF prints in a hidden window with no script, no network (its page's CSP and an in-memory session that refuses every request) and no navigation, on A4 or Letter by the system's region, destroyed after printing or after 30 s. PDF slides (`brief-v3-slides.pdf`) is the same document as a deck: split at a thematic break on its own line after a blank line (never a heading underline, never inside code), or, with none, before each `#`/`##` heading when there are two or more; each slide is one numbered 16:9 page (13.333 by 7.5 inches, no margin), printed the same way and within the PDF limit. A slide longer than its page is cut at the page's edge, not shrunk. Export records nothing: no version, draft or effect, besides whatever recovery a read already does. The e2e stands in for the save dialog; the real dialog and Letter paper were not exercised.
- `e2e:installed`: the installed-capable J-01, Now, triage, goal and scorecard-demo fixtures (`e2e/electron.spec.ts`, `e2e/now.electron.spec.ts`, `e2e/triage.electron.spec.ts`, `e2e/goals.spec.ts`, `e2e/demos.electron.spec.ts`) on the packaged app copied from its DMG into an owned temporary folder. Development-only tool/continuity fixtures remain in the development suite.
- `e2e/demos.electron.spec.ts`: screenshots for scorecard rows 12, 6, 14 and 1 (into the ignored `evidence/installed-demos-<date>/` when installed): a turn's document, its version diff and an answer's link in the side pane; memory kept by itself with Undo and a proposal waiting with the judge's reason, on the scripted model and its scripted judge; Settings › Backup exporting into a folder from main's picker (stood in for), then `backbone restore` of that export into a new data folder from the CLI, rendered as terminal text; and a native Codex turn delegating to a sub-agent on the engine's fake client (`BACKBONE_FAKE_CODEX_MODE=spawn`), not real Codex.

`test/installed-journey.test.ts` checks the runner with inert command callbacks:
explicit installation ownership, no cleanup authority from installer stdout,
symlink escape refusal, retained failure/signal accounting and cleanup errors.
The installed runner fixes Pi and lets each selected fixture supply its own scripted
local route; ambient native/profile/model settings do not activate another route.
Its temporary application copy is removed on normal/exceptional return. Work
profiles and their data remain fixture-owned. A failed cleanup reports its exact
owned root, and cannot turn the run green or hide a nonzero test exit.

These unit checks do not install or launch an app, admit native execution, prove
process-descendant cleanup or replace the coordinator's deadline/resource permission.
Not tested here: the actual installed journey, signed/notarised build or neutral
conformance jobs (`conformance/`) on an installed app.

## What it replicates, from whom, when

- The shell of the October 2026 Codex and Claude desktop apps: both are Electron and React, and their bundles show Tailwind, Radix, cmdk and Shiki; the shared layout (projects and threads in a sidebar, a composer with permission, model and effort, movable Changes, Files and terminal panes) was navigated live in Codex on 23 Oct 2026. Decided by the distribution's radar (`backbone-way:radar/cap-11-06-single-thread-base.json`, evidence dated 23 Oct 2026), with pins Electron 45.0.0 (21 Oct 2026), React 19.3.1 (14 Oct 2026), Tailwind 4.3.3, Radix 1.8.1, cmdk 1.1.1 and Shiki 4.5.0 (1 Oct 2026).
- Keyboard shortcuts follow Codex where the two apps differ ([CONTRACT.md](CONTRACT.md)).

## Why

People already know how these apps work, so the app spends nothing on teaching a new shape. What it adds is under the surface: the work stays on copies with versions the person owns, every agent write goes through the core's gateway with a receipt, and an outcome nobody can tell shows as `UNKNOWN` instead of being sent again.

## Swap it

Any surface over the same `api` (`packages/platform/src/api.ts`): another shell such as Tauri (the radar's weak challenger) or a browser tab over the HTTP bridge (`server/bridge.ts`, `pnpm --dir packages/surfaces/app serve`). Agents can use the MCP door instead. shadcn/ui components are copied into `src/components/ui`, so no upstream can strand them.

## Remove it

Quit it and delete it. Its data folder (one folder named after the app, under the operating system's application data folder, or `BACKBONE_HOME`) holds the core's database, the copies and their versions; keep it, or delete it to remove everything. Settle any `UNKNOWN` effects first if you want their outcome recorded. Your own files are untouched: the app worked on copies.

## Workspace composition (development, 27 October 2026)

The reusable app remains a surface over the platform API. Its name comes from the brand profile; visual values live in shared theme tokens.
Profiles, jobs and product defaults belong to a distribution. This candidate stays
in this repository until the canonical promotion gate accepts the resulting combination.

[Goose desktop](https://github.com/aaif-goose/goose/tree/9949cf926cd42f1d128b9991ed23a496ecace896)
is the React/Electron reference for the conversation shell and retained work.
[OpenCode](https://github.com/anomalyco/opencode/tree/148842ef7cb1bc34192b3fff57d0f9721ab9c801)
and observed Claude Desktop interactions inform file tabs, readers and the adjacent file browser.
OpenCode's Solid components are not drop-in React dependencies. Radix owns accessible tabs and
dialogs; react-resizable-panels owns resizing and keyboard resizing; CodeMirror owns text editing.
Application state and platform commands remain ours. Inspect a complete interaction before porting
it, preserve its state and focus rules together, and rerun the affected journey when updating it.
Recheck these dated reference choices before promotion or by 10 November 2026.

The compact bar follows the observed Claude Desktop composition rather than adding a second title,
summary or document toolbar (owner direction, 27 October 2026). A single chat uses its title as the
details menu; multiple open conversations use familiar tabs. Project context, changes and attached
files remain in that menu. File version, writer, read-only status, download and discard remain in
Document options. Save appears when needed; interrupted-save, stale-draft and error messages remain
beside the document.

On 14 November the side pane's top bar was narrowed to its tabs, New tab, one Pane options menu and
Close pane, after editor tab rows (VS Code) and Chrome's shrinking tabs. A document's own actions
(its version, Edit, Save when needed, Full screen, Browse files and Document options) sit in one
short header inside the document. Both tab rows shrink tabs towards a minimum and then scroll, keep
the active tab and its close button in view, list every tab with a search field when some are out
of view, close a tab on a middle click and go back to the tab used before with Ctrl+Tab. A tab's
help names a document's version and work still running in its view; closing a tab stops nothing. Saved is display wording for a person-saved working document,
not a new authority or accepted-knowledge guarantee.

Conversation tabs are window-local views: closing one does not archive a conversation or stop work.
The selected conversation and durable drafts remain platform-owned. The thread renders its
menu into the shared bar using a React portal; its data and callbacks stay with it.
File views retain editors while switching tools or hiding the pane; inactive views do not contribute
header controls. The same existing Radix menus/tabs and resizable panels own keyboard behavior.
On macOS, Electron's standard hidden-inset title bar keeps real window controls and draggable empty
space; browser and other desktop platforms retain their own chrome.

The regression journey delays a newer draft while an older draft exists, switches readers,
hides/reopens the pane, saves one version and reopens Terminal. Header geometry and active-only
controls are checked with that same real-platform/database journey and a controlled test engine.
This is not live-model usefulness or complete assistant capability parity. The separate native
executor proof remains a frozen development experiment, not an enabled route in this app build.

Expanded turn activity also shows recorded source and output versions, derived on demand from
existing API records (`src/lib/work-evidence.ts`). An exact-version link opens the recorded version;
a later Save, withdrawal/restoration, held document, missing record or failed metadata read is
shown explicitly. A matching current version is not verification of correctness. Missing read
sets remain incomplete and unknown outcomes stay outside the disclosure. No model call or summary store
is added. Metadata failures in Files clear unavailable details and offer a retry.

A document a turn wrote, read or was given opens in the resizable side pane beside the
conversation, which stays in place. An output also opens what that version changed against the
one before it (`changes.get` with `version`, a document of that project only). An answer's
markdown link to a workspace document (`src/lib/workspace-links.ts`) opens it there, at the
version the turn touched: only a relative path, naming a document in the list read for that
answer's own project. Until that list arrives, or while the list on screen is another project's,
nothing opens; the markdown remounts when it changes, since Streamdown keeps a block whose text is
unchanged. An absolute or local `file:` path is resolved by the platform (`files.resolveLink`),
which knows the project's folder: it opens a document only when both its written address and its
real path are inside that project's folder. The app never learns the folder, and data folder paths are
never asked about. Every other local path stays text with no address; web links keep
Streamdown's hardening and its confirmation before leaving the app. `test/workspace-links.test.ts` and `e2e/side-pane.spec.ts`
(`--project=side-pane-light-1440 --project=side-pane-dark-1440`) check this on the real bridge
and controlled engine; the answers' links are added to the transport, as that engine writes none.

`pnpm --dir packages/surfaces/app exec playwright test --project=work-evidence --workers=1`
checks the actual renderer with a synthetic transport, including a delayed refresh, exact-version
navigation, withdrawal/restoration, metadata failure and unknown outcome visibility. This consumer test
uses no model or database and does not establish installed acceptance or human usefulness.

`BACKBONE_KEYS=plaintext node scripts/no-leftovers.mjs node scripts/with-test-cluster.mjs pnpm --dir packages/surfaces/app exec playwright test --project=work-evidence-integration --workers=1`
checks the built renderer through the actual HTTP/SSE bridge, Host, material store and existing
core in an owned test database. It exercises the real Pi engine with a controlled loopback model,
then the stub, a person's v2, exact v1 navigation, withdrawal/restoration and a cold bridge reopen.
The stub's read activity lacks direct turn bindings: the view marks it incomplete and preserves
known attachments/context without inventing a read identity. This is evidence for this composition,
not the installed Electron/native-client route, live-model quality, or human understanding.


## Tool permissions in Settings

Settings › Tool permissions lists active permissions with connection, permission time in
its viewer's locale, description and permission extent. It reads Core's permission
status separately and shows Paused when Core refuses calls under permissions.

Recorded sent, failed and unknown outcome calls are counted once per effect for each tool
across all its permissions. Permission ID, full historical definition and exact
per-signature counts and receipts stay Not available yet until the listing owner
provides those fields. A later permission is a new row.

End permission uses connectors.set with standing: false. A refused or lost result
keeps the row unresolved; a confirmed removal says Ended locally. The desktop end handler and browser bridge carry fixed Host
diagnostics as text without an IPC wrapper. If Core ending fails after local removal, an
End not confirmed row remains with a status check and End again for an idempotent
retry. Retained tool rows
are removed when a newer listing withholds their server or tool. The renderer
supports Ended, Ending pending in Core and Conflict when the reserved listing
fields are present. Without them Core confirmation remains Not available yet.
Calls approved under an ended permission are rechecked just before dispatch and
stopped; a call already sent cannot be undone here. Host still waits for Core
before forwarding an end, so offline ending remains a reserved integration.

How much runs without asking defaults to Full. Full and Custom apply the same
rules today; Custom only shows the per-tool choices. This is a renderer view
choice saved in local storage. The data folder has no stored setting for it, and no
bridge settings endpoint or settings IPC channels. Giving a permission uses the
existing native desktop question. Balanced will ask before an outside write after
an outside read in the same turn; Strict will ask before every outside write.
Both are disabled until those rules are enforced.

`test/signed-tools.test.ts` checks sorting, re-signing, accounting and uncertain
ends. `e2e/signed-tools.electron.spec.ts` runs the real development desktop:
product-created permissions, actual Core pause, end and retry with exact diagnostics,
Host refusal, sender rejection and Custom's existing native giving permission question using
test presence. `e2e/signed-tools.spec.ts` retains browser coverage. The two remaining
[Not yet items](CONTRACT.md) are listing fields and offline ending.
Installed packaging remains a separate qualification.

## Building and testing

### One-time step: Electron's binary

Install scripts are off for the whole workspace (`.npmrc`), so `pnpm install` does not fetch Electron's binary. `pnpm --dir packages/surfaces/app electron:install` fetches it with Electron's own installer, which checks the download against Electron's SHASUMS. The script does nothing when the pinned version is already present. `start`, `e2e`, `e2e:installed` and `package` run it first, and so does CI's slow job. Nothing re-enables install scripts globally.

### Commands

All run from the repository root as `pnpm --dir packages/surfaces/app <script>`.

| Script | What it does |
| --- | --- |
| `build` | Builds the renderer and the Electron main and preload bundles into `dist/`. |
| `start` | Runs the Electron app. Set `BACKBONE_HOME` to a fresh folder; without it the app uses its own profile folder. |
| `test` | Token contrast tests (including no orange accent) and the file tree's logic. |
| `typecheck` | `tsc` over the app, Electron and journeys. |
| `e2e` | Builds, then runs J-01 in the browser (1440, 375 and 320 px, Light and Dark) and on the unpacked Electron build, and the rebuilt screens (`e2e/design.spec.ts`, 1440 and 375 px, Light and Dark), whose screenshots go to the ignored `evidence/design-pass/`. |
| `package` | Builds an **unsigned** macOS app named by the brand profile (`Assistant.app` with no distribution) and its DMG in `dist/package/` (macOS only), with `build.json` holding the DMG's SHA-256. |
| `e2e:installed` | Packages, installs into an explicitly owned temporary folder (never `/Applications`), and runs the installed-capable J-01, Now, triage, goal and scorecard-demo fixtures. |

Screenshots and `result.json` go to the repository's ignored `evidence/J-01/`. `result.json` stays `ok: false` until the core is joined and the maintainer approves the parity comparison.

The unsigned app carries Electron's ad-hoc signature. A copy downloaded through a browser gets quarantined by Gatekeeper; signing and notarisation need an Apple Developer account and are not part of slice 1.

Shortcuts follow the contract: Changes ⌃⇧G, Files ⌘P, Terminal ⌃\`, Side chat ⌥⌘S, and New chat ⇧⌘O.

Replies render as markdown; new work starts with Full access inside the project. Unsupported autonomy choices stay disabled and name the missing enforcement rule, so the control does not claim a policy it cannot apply.

## Manifest

<!-- generated from backbone.module.json by scripts/module-readme.mjs; do not edit -->
| Field | Value |
| --- | --- |
| id | `io.github.albertoangulo/app` (surface) |
| version, licence | 0.0.0, Apache-2.0 |
| publisher | Backbone maintainers, namespace `io.github.albertoangulo` (github, pending) |
| stability | experimental |
| provides | Thread app (Electron, and a browser over the HTTP bridge) 0.x |
| consumes | api (projection in, command out, receipt back) 0.x |
| capabilities | planes: personal; effect classes: 2; operations: workspace.write_document; network: model-route; secrets: surrogate |
| data | owns: per-viewer UI state only: layout, theme, open tabs (through viewer.put); migrations: 0; export: nothing durable of its own: work, versions and receipts belong to the platform's data home and the core |
| depends on | @backbone-next/platform workspace, @codemirror/commands 6.11.1 (MIT), @codemirror/lang-markdown 6.5.2 (MIT), @codemirror/language 6.13.1 (MIT), @codemirror/search 6.7.2 (MIT), @codemirror/state 6.7.6 (MIT), @codemirror/view 6.43.14 (MIT), @fontsource-variable/ibm-plex-sans 5.3.0 (OFL-1.1), @fontsource-variable/jetbrains-mono 5.3.0 (OFL-1.1), @lezer/highlight 1.2.5 (MIT), @office-kit/docx 0.2.1 (MIT), @office-kit/xlsx 0.27.0 (MIT), @shadcn/react 0.3.1 (MIT), @xmldom/xmldom 0.9.12 (MIT), class-variance-authority 0.7.1 (Apache-2.0), clsx 2.1.1 (MIT), cmdk 1.1.1 (MIT), fflate 0.8.3 (MIT), lucide-react 1.61.0 (ISC), pdfjs-dist 6.5.438 (Apache-2.0), radix-ui 1.8.1 (MIT), react 19.3.1 (MIT), react-dom 19.3.1 (MIT), react-resizable-panels 4.15.0 (MIT), shiki 4.5.0 (MIT), streamdown 2.6.0 (Apache-2.0), tailwind-merge 3.7.0 (MIT) |
| conformance | bronze: `packages/surfaces/app/test/tokens.test.ts`, `packages/surfaces/app/test/tree.test.ts`, `packages/surfaces/app/e2e/browser.spec.ts`, `packages/surfaces/app/e2e/electron.spec.ts`, `packages/surfaces/app/e2e/tools.electron.spec.ts`, `packages/surfaces/app/e2e/design.spec.ts`, `packages/surfaces/app/test/installed-journey.test.ts`, `packages/surfaces/app/e2e/now.electron.spec.ts`, `packages/surfaces/app/e2e/workspace.spec.ts`, `packages/surfaces/app/e2e/header.electron.spec.ts`, `packages/surfaces/app/e2e/flows.spec.ts`, `packages/surfaces/app/e2e/primitives.spec.ts`, `packages/surfaces/app/test/export-html.test.ts`, `packages/surfaces/app/test/export-policy.test.ts`, `packages/surfaces/app/e2e/export.electron.spec.ts`, `packages/surfaces/app/test/document-preview.test.ts`, `packages/surfaces/app/test/office-converter.test.ts`, `packages/surfaces/app/e2e/previews.browser.spec.ts`, `packages/surfaces/app/e2e/previews.electron.spec.ts` |
| exemption | signed build: the macOS app and DMG are unsigned and not notarised; that needs an Apple Developer account |
| exemption | conformance on the installed app: e2e:installed runs the Electron journey on a DMG installed into a temporary folder; the neutral conformance jobs in conformance/ have not run on an installed app |
| exemption | secrets: surrogate: a key the person pastes in Settings passes once from the window to the platform, which seals it; the window and the engine keep only a handle |
| exemption | suite in pnpm check: its unit tests and journeys run per package and in CI after pnpm check; they need a browser and an Electron binary |
| removal | quit it and delete it; its data home stays until the person deletes it, and held UNKNOWNs stay with the core's gateway; refused while one of its effects is UNKNOWN |
<!-- end of generated block -->
