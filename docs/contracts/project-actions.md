# Project names and archive state

**Owner:** platform composition. **Layer:** platform, above Core identity.

`projects.update({id, patch})` accepts a name, an archive boolean, or both. Names
are trimmed, nonempty, and at most 1,000 readable characters, using the same
validation as creation, retaining its display names including joined emoji and
line breaks. A display name never chooses a storage path. The local line also
requires one readable line, allowing emoji joiners but refusing other hidden
characters, for both creation and rename. Unknown patch fields
are refused. Authorization binds the project id and patch before asynchronous
waits; caller mutation cannot substitute a different project or add fields after
validation. The device owner can update projects they own. In an authenticated
workspace only the live project owner can change these properties, including in
a company session or a joined window. Editors and viewers cannot; a refusal
explains that ownership is required for a visible project. Invisible and absent
projects give the same refusal. Workspace administration does not override
project ownership. The platform checks this once under the existing shared
identity admission, which excludes concurrent revocation. Surfaces consume the
project's canUpdate projection to choose which actions to display; the page
does not decide which roles can change project properties.

Projects remain in the existing durable project list. Missing archive state in
an older data folder means active; no Core schema change or folder relocation
is needed. Creation rechecks retain the original creation intent but return the
current name and archive state. The id, kind, directory and creation time still
identify the exact created project; changed creation input still refuses and
preparation is never repeated. The update takes the existing data-folder lock, checks write admission
immediately before the durable write, replaces the in-memory list after
that write or a read of its atomic replacement, and publishes the existing projects event. Core stores sharing
ownership and access; project names and archive state follow the same platform
projection storage as conversation names and archive state.

Archiving changes visibility only. The main sidebar, pins, chat sections, project
picker and default new-chat project selection omit the archived project and its
conversations. More → Archived lists it for restoration. Sidebar search includes archived
projects and chats, labels them Archived, and offers restoration within the
viewer’s existing access. Restoring the
project restores those conversations with their individual archive and pin states
preserved. When the selected project becomes archived, selection moves to a surviving
active project, or to a view offering Restore and New project when none remains.
An explicitly open chat stays open, including one opened from Now or Scheduled,
and explains its archived project with Restore for its owner. Other windows
repair only an active-to-archived transition, never each later refresh. On
startup, a stale archived new-chat selection is initialized to active work;
a saved open chat remains open. A late
archive response preserves a newer selection. Focus repair waits for the row
to disappear and does not take focus from another control.

Archiving does not delete or move files, delete conversations, change sharing,
revoke access, stop running work, pause schedules or change their configuration.
A running turn and a schedule are safe because all project identifiers and
resources remain available to the platform. Schedules and team settings retain
archived projects in their management lists. Listing projects returns archived
entries too, with their state, so terminal and recovery consumers can find them.
Backup exports include all projects, their archive state and their documents.
Exports with archived projects use format version 5; versions 3 and 4 remain
readable and a missing archive field restores as active. Archive visibility is
not an authority boundary.

Archive acts immediately and offers Undo as a new restore request. Its notice
reports visible unpaused schedules, running chats and, only when this viewer
may read the sharing list, the people who retain access. Missing counts are
not invented. The shared notice is polite, dismissible, and stays while hovered
or focused. Return on a focused project row starts rename; Escape cancels and
returns focus. Return on a chat continues to open it. A new-chat send can create
a default project only when no projects exist, not when all are archived.

A pre-write admission loss refuses without mutation. A failure after starting
the durable write reports an unknown outcome and sends no second write. The Host
reads the atomic project list again after a failure. A readable old or new
list replaces the cache and releases the write hold; an unreadable list keeps
it. Further requests during that hold are refused without attempting a write,
not reported as unknown themselves. The app
retains typed names on refusal and failure. After an uncertain response it offers
a read of the project list that refreshes sidebar visibility and selection,
never an automatic retry. A matching read confirms the requested current state;
a readable mismatch says the requested change is not present and releases the
window’s hold. This establishes current state, not a historical receipt or
proof against an intervening edit. Named pre-dispatch refusals do not hold actions.

The private local API line enables updates exactly when it enables creation,
with the same owner-wide budget (10 validated requests per rolling minute and
100 until restart, shared by creation and updates). Company configurations direct
changes to the signed-in app. Other lines refuse before dispatch. Updates accept
only an id and the bounded patch; no file path, permission or role can be supplied.
The terminal exposes projects rename, archive and restore in both standalone and
line modes, preserving refused and unknown exit codes and never resending a lost
call. Creation and property commands do not resume interrupted turns or start
model work. See [API-line authority](../adr/0002-api-line.md).

Proof: platform project-actions and project-update-storage tests, terminal
project-actions and project-actions-parse tests, and the app renderer's
project-actions.browser.spec.ts. These fixtures establish their tested local
composition, not installed-app or real-account acceptance.
