# work-material service contract (DRAFT 0)

**Owner:** integrator (shared schema); service owner, to be assigned.

**Layer:** L1 service.

**Status:** thin. Drafts have several client-side custodians.

## Purpose

There is one durable owner for the person's material:
- originals (bytes untouched);
- working copies;
- documents and their versions;
- unsent drafts.

## Owns

- original files;
- the working tree;
- document versions;
- drafts (reply, composer, file edits) held server-side.

**Today** [code]: `server/src/original-documents.ts`, `document-save-original.ts`, `native/working-files.ts` (2,335 lines), `native/task-working-material.ts`. On the client side, `web/src/lib/*-custody.ts`, `*-draft-recovery.ts` and `*-journal.ts` are second custodians to retire.

## Provides

- attach;
- read;
- write a working copy;
- Save (a new version owned by the person);
- list (with intermediates hidden);
- offer a cleaned copy (R-FILES-ORIG-01);
- `draft.put/get` (idempotent by client key);
- export.

## Consumes

- work-ledger (versions referenced by receipts);
- the Documents port (codecs);
- identity-tenancy;
- effect-gateway (writes outside the workspace, such as a user's cloud folder).

## Rules

- **Originals are never modified.**
- **Save is atomic.** Either version N+1 exists or nothing changes.
- **A native turn's finished pieces survive a kill.** Imports still land only after a turn completes, when its bytes are final. While it runs, a staged file a later command left unchanged is kept on disk, not in the project. Recovery, or a failed turn, imports those through the same checks as any write, stopping at an unknown outcome. Nothing proves such a file was finished, so each lands marked `unsure` for the person to check, and the turn stays stopped. A source that moved holds the import for the person instead of discarding it. An accepted Stop is on disk before it is acknowledged, and drops them, after a kill too.
- **A draft survives quit and cold start on the server.** A client cache is only a cache.
- **Intermediates are hidden, not deleted** (anti-entropy: hide ≠ delete).
- **A person can withdraw an attached original.** No later turn lists, reads or is attached it, the next turns are told, and every version stays: it ends access and purges nothing. It is not delayed by unresolved work, which stays in view because that view is read from the threads. A turn that read it before it was withdrawn keeps what it writes afterwards as held documents, out of later work's reach until the person permits them, and its answer is not replayed. So is any turn that read a source while that source stays withdrawn. A turn given another as history inherits what that turn read. One test, the turn's recorded reads against the withdrawal record, decides at delivery and, inside the data folder lock, at commit. Withdrawing also moves the file out of the project folder, aside and not deleted, and restoring brings it back. Text already given to a model, or copied by a person or into a finished document, cannot be recalled; output from a turn that read a source before it was withdrawn stays unless it was written after, and git history is not rewritten. A withdrawal counts for a turn that read the source even if the source was restored, or the process died, because each turn's reads are on disk before the text is handed over: a read whose binding cannot be saved is not handed over, on every engine and stand-in. A turn whose sources are not all known (no read set, marked `unknownSources`, or read steps with no direct binding, as turns recorded before reads were bound at read time show) counts as having had every source (`unbound` in `withdrawal.ts`, asked by every path that carries a turn's words on). Once anything in the project has been withdrawn its answer is not replayed, not told to a parent and its documents are not brought back; before that it is told with unknown provenance, which the receiving turn then carries. It seeds no skill. History is decided again as the engine builds the model input (`TurnRequest.recall().history`), after staging, connecting and resolving the credential, so an answer withdrawn while the engine started is not sent, and an inherited source that came only with an answer or memory line left out then is no longer the turn's, so a clean answer stays clean. Words already written into the request cannot be taken out: a child's report or brief, a reviewer's transcript, and the words the host writes into a turn's own text (a goal run's goal and the last check's finding, a schedule's goal, recorded as `Turn.textSources`). So every source behind the request is checked again by the send-time gate (`TurnRequest.stillAllowed()`), with nothing between it and the model request leaving (Codex before `turn/start`, Pi in the fetch of its first request, Hermes before the run is created). If any was withdrawn since the request was built, nothing is sent and the turn ends saying so; the person sends it again. A goal run leaves out a finding whose sources were withdrawn or are not all known, and a goal whose source was withdrawn starts no run or scheduled turn; host-written text leaves history with its sources.

## Acceptance

- R-BASE-02, R-BASE-03, R-FILES-ORIG-01, R-FILES-OS-01, R-FILES-REFRESH-01 and R-MEM-TIER-01.
- **Adverse case:** kill during Save. On restart, there is exactly one of {v1, v2}, and the UI states which.

## Exit test

Not a port. The file *store* may be swapped (local disk or the user's cloud) behind the same API, and must pass J-01.

## Change procedure

- A schema change goes through the integrator.
- Retiring client custody needs an importer that carries every unique unsent text into server drafts first.

## Oracle spec gaps the successor must close (P-04)

- **SG-CORE-02 (documents part).** Creating and saving a document is a **named crossing**, so the oracle binds a name instead of a table.

Source: P-04 `oracle/RESULTS.md` on branch `claude/p04-core-oracle-2d71c1` at `15538047`, 23 Oct; cross-family review pending.
