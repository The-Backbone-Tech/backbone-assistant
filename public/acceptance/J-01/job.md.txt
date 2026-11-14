# Acceptance job J-01: single-thread base (slice 1)

**Runs on:** the successor's **installed** app, on a fresh test Home. It never touches the default profile.

**Held out from implementers.**

**Result:** `result.json` in this folder, written when the job runs, with this schema:
- `journey`, `commit`, `app_build`, `model`, `effort`;
- `phases[]`, each `{id, ok, evidence}`;
- `adverse[]`;
- `parity`, which is `{compared_with[], approved_by, date}`;
- `ok`.

## Phases

| # | Step | Observes | R-IDs |
|---|---|---|---|
| 1 | Open the app with no thread selected | One centred input, nothing below it | R-UX-HOME-01 |
| 2 | Create a project and attach a note and an XLSX through "+" | The project appears in the sidebar; the attachment chips show; the original bytes are kept | R-UX-SIDEBAR-01, R-UX-COMPOSER-01, R-FILES-ORIG-01 |
| 3 | Pick a permission mode, model and effort, and "this computer"; ask for an editable brief | A turn block ("worked for N"); the pinned summary shows Changes and Sources | R-UX-THREAD-01, R-BASE-01 |
| 4 | Open Changes (⌃⇧G), then Files (⌘P) | The tab registry; diff scopes from last turn to branch | R-UX-PANES-01, R-UX-KEYS-01 |
| 5 | Edit the brief as a human, then Save | Version 2 is owned by the person; the file list refreshes without a restart | R-BASE-02, R-FILES-REFRESH-01 |
| 6 | Open a side chat and ask it to change the file | It refuses: read-only tools, no effect | R-UX-SIDECHAT-01 |
| 7 | Quit and cold start | Thread, unsent text, open tabs restored; no recovery prompt | R-BASE-03 |
| 8 | Follow up in the same thread | The answer uses version 2 | R-BASE-02 |
| 9 | Repository task: ask for a small code change in a scratch repo, then open Changes on "Uncommitted" | The diff view shows it; nothing is committed without the person | R-WT-01 (slice-1 part), CAP-05 |
| 10 | Every file J-01 created | Classed as original, working or accepted; intermediates hidden | P-anti-entropy, R-MEM-TIER-01 |

## Adverse cases

- **A1:** kill the app during Save. Afterwards exactly one of {v1, v2} exists, and the UI states which.
- **A2:** Stop during an agent's write. The outcome shows UNKNOWN and is not resent; the exact copy is denied (R-BASE-04).
- **A3:** the side chat tries an effect. It is refused with a named reason.

## Parity

- Phases 1–7 are compared side by side with Codex and Claude, by navigation, in Light and Dark at 375 and 1440 px.
- the maintainer approves (R-UX-PARITY-01, O-11).

## Pins

Version and pin fields come from the P-03 second pass.
