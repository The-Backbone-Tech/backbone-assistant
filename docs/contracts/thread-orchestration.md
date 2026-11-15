# thread-orchestration service contract (DRAFT 2, slice 2)

**Owner:** service owner, to be assigned.

**Layer:** L1 service.

**Status:** built in part, inside `packages/platform` (`src/composition/parallel-work.ts`); see [Built](#built).

## Purpose

One thread runs several agents and tools at once, as Threadlines does:
- child agents;
- read-only reviewers and side runtimes;
- the person steering any of them.

Each one's authority, progress and output stay visible.

## Owns

No tables of its own. It writes orchestration events and command receipts through the work-ledger.

## Provides

- start, steer, stop and merge for child threads, at **depth 1** (a child cannot start children; DR B2, kept 23 Oct);
- start for a read-only side runtime;
- a projection of the thread tree.

## Consumes

- the work-ledger (events, leases);
- mandates-decisions (child mandate = request ∩ parent; mode ceiling);
- the engine port;
- effect-gateway (children's effects only, never a reviewer's).

## Rules

- **Every command is an event with a receipt.** Goals, the child tree, turn lifecycle and tell records are append-only events in the data folder's journal (`src/composition/thread-journal.ts`), flushed before they are acted on. Thread files are a cache: the fields the journal owns are rebuilt by replay at open, and which turns are interrupted comes from the journal alone (R-MA-02). The one thing a cache may add is a stop, which only narrows.
- **Thread files stay authoritative for what the journal does not own.** A turn's steps, summary edits such as a title, side chats and the private write custody are not journal events. Replay does not rebuild them: the thread file is their only record, and a lost file loses them. A pending write whose custody is lost is not replayed.
- **A child's mode is at most its parent's** (`withinModeCeiling`, R-MA-03).
- **Reviewers and side runtimes are read-only** and have no effect capability (R-MA-04).
- **A restart resumes each child or marks it interrupted,** with no duplicate effect (R-MA-05).

- **A goal belongs to the person.** Only a person sets, changes or clears it. An agent's change is a proposal: on the thread's record, shown in `work.now`, changing nothing until the person accepts it. A stale view changes nothing.
- **One effect path.** A child is a thread carried by the host's run path, writing through the document gateway. Its mandate is delegated from its parent's, so the core intersects its terms, charges its budget up the tree and revokes it with its parent.
- **Stopping a parent stops its children.** Each child's stop is on disk before the parent's stop is acknowledged, and a child still being admitted is refused.
- **An unknown outcome crosses threads.** It reaches the parent's report and `work.now`, and a report with any unknown outcome is never `done`. The core refuses an exact copy only within one task, so the host refuses an exact copy of an unknown outcome from any other thread, and any write of that document from a thread joined to it by a child link or a fork, recovery's own dispatch included. A fork keeps the tasks it came from, so deleting a thread between them lifts nothing.
- **One tell chokepoint.** Everything a turn is told from outside (goal, an agent's brief, a child's report or result, a reviewer's transcript) goes through `tell`, which decides, appends a `turn.told` record (exact text digest, each source by version) and returns the words in one synchronous step. No other path adds text to a turn; a resumed turn tells again and is recorded again. A report's receipts always travel; they are the host's own words.
- **Withdrawal is decided from the record, by source version.** A source version is the document version plus its withdrawal count. A restore starts a new source version, so it never revives a record: a read made after the restore cites the new one. This holds for every read, direct and told, in `replay`: a withdrawn source version stays dead after a restore, so restored content is read afresh by a new turn and only pre-withdrawal words stay withheld. An inherited read keeps the count it was read at. This is stricter than before: `packages/platform/test/withdrawal.test.ts`, "a turn that finished before the withdrawal is not replayed either", now expects `['user']` after the restore, where it expected `['user', 'assistant']`. The document's own version number does not move, because `material.lifecycle` compares it. What a turn was told enters its reads, so an answer built on it leaves history the same way.
- **A person's later turn on a child** runs under the child's mandate and ceiling, never the standing mandate.
- **A child may run on its own model, chosen once, at admission.** The person (`children.start` `settings.model`, `fallback`) or the parent agent (`start_child` `model`, `effort`, `fallback`) names it; left out, it is the parent's and nothing is asked of the engine. A named model is checked against what is served: the native Codex catalog (model and effort), or for Pi the configured route's own model list, reached with the same route and credential, so who pays does not change. An unknown model is refused with the reason, and nothing is started; it is never silently replaced. With a fallback list, the first model served at the child's effort runs, and `ChildLink.model` records what was asked, each one passed over and why, and which ran (`ChildView.model` shows it). Nothing falls back after a turn has begun: a model refused mid-turn fails that turn, since a retry elsewhere could hide an unknown outcome. Every later turn of the child runs on that model, whatever the composer names. Effort stays at most the parent's.
- **A queued message is the person's until it is a turn.** It lives on the journal. `turn.reserved` names it, so one line takes it off the queue and makes the turn: after a kill it is one or the other, never both and never neither. Its id follows from its client key, and a sent or removed id stays recorded, so a retry adds nothing. Only opening's sibling, `resumeInterrupted`, sends what was left waiting: opening calls no model. Its line in the core's conversation follows the reservation, so it is there at most once; a kill between them leaves the turn without that line.
- **Only a clean end sends the next message.** A Stop, a stopped or refused turn, an interrupted turn, or an unknown outcome in the thread or a child holds the queue and says why in `Thread.queueHeld`. Stop is on the journal before it is acknowledged, and binds a message being admitted. `queue.send` is the person's answer: it names one message and its version, so a retry finds the turn it made and never sends the one behind it; it spends itself only on an admitted turn, and settles nothing; a Stop's hold ends with the last message. A queued message is released only by a clean finish or that act; nothing about it outlives a restart as permission. Words given after Stop are not queued: they stay a draft in the composer and go as an ordinary send once the turn has ended, so a quit leaves a draft and starts nothing. A parent's Stop holds its children's queues, and a Stop reaches a send still being admitted. A message that cannot start keeps its place, shows `problem` and holds the queue for the person, as does one whose attachment changed while it waited.
- **Steered words are told, and claimed only as far as the engine confirms.** They are recorded (`turn.steered`), told through `tell` as kind `steer` with no sources, and handed over in one synchronous step with no lock, so neither Stop nor a turn's end falls between. `delivered` needs the engine's answer: Pi's model replying to a conversation holding them, Codex's `turn/steer` answering for this turn, or an advertised ACP `_session/steering` answering `injected`. ACP requests `promptRequired` idle behavior so it never starts a detached fallback turn; `promptRequired/noRunningTurn` returns to the existing queue. Unsupported ACP agents confirm non-delivery without a request. `not-delivered` is as firm: the words return to the queue in the line that says so. Anything else is `unknown`: never delivered, never requeued, never resent, in a resumed turn or in later history; the person may send them as a message. A turn ending with no answer leaves `unknown`, and so does a kill. A resumed turn hears only its confirmed words again, because the engine that took them is gone. An engine without `HarnessV1.steers` is refused by name, and `Thread.steering` says so first.
- **Bringing a worker's document back is a turn of the parent that calls no model.** One document, one person's act, on `baseVersion`. Children share the parent's project, so a version that is still current is adopted: no version is made, `by` stays the agent's. A document that moved on keeps its version, and the worker's exact version lands beside it as a new agent document (`name (revision of vN).ext`), through the one gateway, with its own receipt, as a stale native revision does. A version that is not exact text is refused rather than copied. The turn keeps the worker's receipts and reads, each by source version, so its answer leaves history with a withdrawn source. Adoption is decided under the lock, at the moment it happens: a Stop or a Save that got there first means nothing was brought back, and it says so. A worker running, not finished, with any unknown outcome or withheld, a worker turn whose sources are not all known (`unbound` in `withdrawal.ts`: a document carries no record of its own sources, so no later withdrawal could reach it), and a document held, unsure or set aside, are refused; a landing with an unknown outcome is not tried again. Nothing here settles an unknown outcome: no settling path exists yet, so such a worker stays unmergeable.

## Built

### Rewind conversation and files

`threads.rewindPreview` shows the turns after a selected ended turn (including a stopped or failed turn) and the
exact material versions they changed. `threads.rewind` keeps that selected turn,
restores earlier bytes through the existing immutable material version store, and
retires files created by the later turns. It adds no snapshot store. Restores are
person versions; all previous versions remain inspectable in Changes and Versions.
Later turns and their receipts remain in `Thread.rewinds`, outside future model
history. Outside actions are never reversed or replayed: sent mail stays sent.

A preview revision binds the conversation, document versions, lifecycle and folder
bytes. Every version after the restore point must be this branch's confirmed agent
write; an intervening person Save or another conversation's agent version is named
as a conflict, even if this branch wrote again afterwards. Direct folder edits also
conflict and become inspectable person versions before explicit replacement.
Every conflict needs an explicit keep-or-restore choice before any file
changes. Stale previews refuse. Linked or unsafe folder paths refuse. Work still
running in the project, queued messages, children, recovery and unknown effects
hold rewind so their records cannot become detached from pending work.
Native or connector uncertainty also holds rewind when no document receipt exists.
Durable connector calls in waiting or unknown state hold Restart and Rewind even
when a killed dispatch left no turn uncertainty marker; both controls name the
unknown outcome for inspection instead of admitting more work. A connector-only
uncertainty is no longer unresolved once every exact effect has the person’s verified Core
reconciliation receipt; native, unattributed and older uncertainty without provenance remain held.

The thread journal records the decision before file changes and completion after
them. A material operation identity makes retries once-only. An interrupted rewind
holds new messages; reopening its preview offers the saved operation again, with
new edits shown as conflicts. The existing projection intent preserves a direct
edit racing a folder move; such a conflict is kept for inspection. As with other
folder projections, an uncooperative filesystem writer can race the last check;
this is not a filesystem compare-and-swap guarantee.

Before completion, restored text follows the existing person Save path into Core.
That crossing runs outside the data folder lock. The pending decision holds writes
to its conversation and files; unrelated files and projects remain usable. Admission
holds new turns in the affected project, including schedules, triggers and goal runs,
because those turns could write the same files. Reads, drafts, Stop and permission
controls remain available.
A version inspection makes an interrupted Core response retryable without adding
the same person revision again. File observations are rechecked after the crossing.
A failed Core confirmation is recorded for that file and shown in the pending
rewind. The public thread view exposes its target turn, outcomes and Resume control.
`threads.rewindFinish` explicitly ends the conversation rewind without restoring
remaining files; its journal outcome names restored, kept and un-restored files,
including failed Core confirmations. It does not require an accessible project path
or a successful Core synchronization. Missing folders, held files and version drift
therefore have a recorded way out. It does not reverse file work already recorded.

Completion first retires the existing thread command workspace, outside the data folder
lock, even when no material source changed. A kill leaves the same pending intent
for cleanup on resume. Journal replay removes only archived turn ids, retaining
later turns' cached work steps and their aligned retry keys. File restore currently
refuses linked folders and project paths outside the data folder; the app and
catalogue state this product limit.

Controls: `packages/platform/test/thread-rewind.test.ts` and
`packages/surfaces/app/e2e/rewind.electron.spec.ts`. The latter is selected by the
installed-app suite; a development run establishes test evidence only.

The api port: `goals.set`, `goals.clear`, `goals.decide`, `children.start`, `children.merge`, `threads.fork`, `turns.steer`, `queue.add`, `queue.edit`, `queue.remove`, `queue.send`; `Thread.goal`, `child`, `children`, `queue`, `queueHeld`, `steering`, `reviewer`; `ChildView.documents`; `Turn.steers`, `merge`; `ThreadCard.subagents`; refusals `DEPTH_LIMIT` and `WIDER_THAN_PARENT`. The engine port's optional `startChild`, `awaitChild`, `proposeGoal` and `TurnRequest.readOnly`: Pi offers them; a native engine does not. `HarnessV1.steers` and `HarnessTurn.deliver`: Pi, Codex and ACP offer them (ACP confirms non-delivery when its agent lacks the extension); the stub and the scripted runner do not. `ChildLink.model`, `ChildView.model` and `children.start` `fallback`; `ChildRequest.model`, `effort`, `fallback`. Tests: `packages/platform/test/parallel-work.test.ts`, `packages/platform/test/steer-and-merge.test.ts`, `packages/platform/test/child-model.test.ts`.

| Rule above | State |
| --- | --- |
| Depth 1 | Built: refused by the host, and again when the mandate delegated from is itself delegated |
| Child model | Built: chosen at admission against the native catalog or Pi's route model list, with a recorded fallback; refused by name when unknown. Not yet run against a live provider's list or a live Codex catalog in this lane |
| Child authority | Built: the core's delegated mandate. Mandate terms bind. `permission`, `mode` and `effort` are compared at start and on each later turn, but no engine except the native one acts on `permission` yet, so that ceiling is a recorded limit, not an enforced one. Shown to the person as `ChildView.notEnforced` and `ChildLink.notEnforced` |
| Reviewers read-only | Built: no operation or tool in the mandate, no write proposed by the gateway guard, no write tool offered. A native engine cannot be held to it, so a reviewer or a narrowed child is refused there |
| Restart | Built: a child resumes as any turn does, under its own run; a parent turn's same brief finds the same child; a mandate whose thread never reached the disk is revoked at start |
| Budgets | The core counts effects across the tree. Host mandates set no budget yet, and the host reports no token use to the core, so token budgets do not bind. Shown to the person as `notEnforced` |
| Replaying events rebuilds the tree | Built on the data folder's journal. It rebuilds goals, the tree, turn lifecycle, stops and tells, and a thread file lost entirely. Steps, summary edits, side chats and the private write custody (thread-custody.ts) remain authoritative in thread files, so replay does not rebuild them. It is not the core's ledger: no ledger event is written, because that needs a core crossing |
| Goal runs | Built (`src/composition/goal-runs.ts`): `goals.run` runs a chat's goal until a judge turn on the same route answers MET; NOT MET starts the next turn of work, told what is missing, within the person's turn budget; BLOCKED waits in Needs you; the judge waits for the goal's children. A person's Stop pauses the run, an action with an unknown outcome blocks it. Across a crash: opening a data folder starts no turn of a run; once the host resumes work (`resumeInterrupted`) the turn a kill cut short is carried on, and a run whose turn then did not finish is `interrupted` (never "stopped by you"), with Resume; Resume goes on past that turn (`GoalRun.past`), though an unknown outcome in it still blocks, and nothing is resent. The judge's turn is read-only where the engine can be held to that (not Codex native); its words are an assessment, never remembered and never authority. `goals.pause`, `goals.resume`, `goals.runs`, `Thread.goalRun`, `Turn.judge`, `Turn.interrupted`. The desktop app holds the machine awake while a goal runs. Tests: `packages/platform/test/goal-runs.test.ts`, `packages/platform/test/restart-runs.test.ts` |
| Task board and worker pool | Built (`src/composition/task-board.ts`): a chat's board of cards, each a brief with the cards it depends on; ready once those are done, blocked when one fails or is held. A pool of N workers (`board.pool`, 2 by default, at most 16, as many as a chat may have children running) takes ready cards, each worker a child of the chat started through the one child path, so its mandate, held actions, unknown outcome, withdrawal and its own model (`Card.model`, `effort`) hold unchanged. A worker's turn decides its card: done; an action with an unknown outcome or a Stop holds it, never retried; so does a failure after the worker had any effect (done, refused, unknown, or a write in custody), since running it again could repeat it. Only a turn with no effect at all is requeued or retried: a 429 or 5xx from the route (`Turn.failure`, the status the route gave first) puts it back on the board with a doubling backoff, at most 3 times, and a new worker takes it; any other failure retries once in place as a further turn of the same worker, then fails with the reason. A Stop of the chat holds its pool until the person resumes it, on disk whether or not the chat has a board yet. The board is on disk (`task-board.json`); a card's start is recorded under its key before the worker is asked for, and at restart a card whose worker a kill interrupted is held as unknown outcome if its turn may have written (a receipt, or custody before a proposal), otherwise the card is ready again; either way its turn is stopped before the host resumes it, so its writes settle through the unknown outcome path and nothing of the task runs again. Nothing starts until the host resumes work. The parent agent adds cards with `add_card` (engine port `addCard`, offered to a thread that is no child; Pi offers it): a brief told through the chokepoint with the sources its turn had, never authority, the same card once per turn and words. It is admitted only while its turn runs and the chat is not stopped, decided in the same step as its commit. The card keeps its turn's settings and the mandate its run was delegated: its worker runs under the narrower of that ceiling and the chat's current one, delegated from that mandate, and fails closed if it was revoked or expired. A brief whose turn's sources are not all known is withheld once any source of the project was withdrawn, replay's fallback. Workers and the chat message each other with `message_card` (engine port `messageCard`, offered to the board's chat and its workers; Pi offers it): words to another card of the same board while a worker runs it, steered into that turn through the chokepoint as a peer's data, quoted and framed as never the person's word and never authority, with the sending turn's reads as their sources, once per sending card (or the chat's turn), target attempt and words. A message that did not arrive is said so to the sender and never sent again. A card waiting, starting, done, held or failed, a card of another board, and the sender's own card are refused; so is a sender whose reads are not all known or include a withdrawn source. The message is on the record of the turn it reached (`Turn.steers`, told kind `peer`). `board.get`, `board.add`, `board.update`, `board.remove`, `board.pool`; event topic `board`. A board belongs to a chat, not to a project without one: its workers are that chat's children. Tests: `packages/platform/test/task-board.test.ts` |
| Branches and search | Built: `threads.fork` takes a `turnId`, keeping the history up to and including it; `threads.search` finds every word of a query across titles, the person's words and answers, best matches first |
| Queue, steer, merge | Built, for the person: see the rules above. An agent cannot queue, steer or merge. Children share the parent's project, with no worktree, so a merge takes a version into the parent's record rather than across a branch |
| Reviewer on the native engine | Refused (`NOT_AVAILABLE`); `Thread.reviewer` says so before the person asks. A fix looks feasible but is not built: the engine's staging cannot reach canonical material except through the host's import, which the guard already refuses for a reviewer, so the adapter would need to honour `readOnly` by discarding staged files rather than failing the turn |

`threads.fork` copies a thread's finished turns as a new chat of the person's: new ids and task, no effects, children or run, and each read kept as it was (direct, inherited or told), so a forked answer is judged against withdrawal exactly as its original is. Only the person can fork; no agent tool does.

## Acceptance

- J-ma; O-12.
- **Adverse case:** a child requests a wider mode and is refused with a named reason; a kill mid-run leaves no duplicate effects.

## Exit test

The Engine under any child can be swapped, and the thread tree, pending effects and held unknown outcome survive.

## Change procedure

An event-schema change goes through the integrator. The [app contract](../../packages/surfaces/app/CONTRACT.md) owns how the app presents the tree.


## Conversation restart

`src/composition/thread-control.ts` carries a person-requested continuation through
Stop and ordinary turn admission. `threads.restart` names the exact original
turn. Stop's optional `turnId` and Send's optional `afterTurnId` bind that view at
the Host boundary. A successful retry in the same rewind generation keeps the same admission key and `Turn.restartOf` marker; it never
replays the original request. Rewinding away that continuation starts a new generation,
so Restart can admit a new visible continuation while retaining the archived receipt. The controller joins the original worker outside
the data-folder lock, preserves history and refuses unresolved recovery, unknown effects
or an uncertain native/connector action in this thread or its children (`Turn.unknownOutcome`, retained in
`turn.closed`). A person’s conclusive connector reconciliation lifts that particular hold only
when the exact Core receipt is verified; unrelated unknown actions and older markers without
provenance remain held until the local owner explicitly checks those without a verification path. An arbitrary ACP agent cannot attest all its native effects, so
its manual restart must be refused rather than declared safe from missing receipts.
Goal runs retain their own Resume control.

The Host wires this controller to ordinary API admission and tracks each actual
carrier until its pending writes and queue decision have settled. A stale Stop
or continuation cannot affect a newer turn. `packages/platform/test/thread-control.test.ts`
checks the controller; `packages/platform/test/thread-control-host.test.ts` checks
the composed consumer, person edits, queued messages, cold-start retries and an
unknown dispatched write. The manual-restart and crash/reopen journeys in
`packages/surfaces/app/e2e/thread-control.electron.spec.ts` exercise the app controls.
Execution records which candidate has actually passed those checks, separately
from installed qualification and real use.


## Person-checked unknown outcomes

The desktop conversation offers “I checked this myself” for an ended native account
turn or a legacy/unattributed unknown marker without a reconciliation path. It shows
the retained steps and their observation times. Possible-write native steps and unknown
outcome notes retain an ISO observation time; other and older steps use the turn start.
Missing server/tool provenance is labelled unattributed, never invented. Connector
unknowns, held connector custody and document writes with an unknown outcome keep
their existing verification controls. A mixed turn offers checking its remaining
unattributed uncertainty only after every named connector effect has reconciled.
Connector-only unknowns never offer the check.

Trusted desktop main asks once: “Mark as checked? Backbone will not repeat this
action; continuing may ask the assistant to try again.” It binds the answer to the
exact turn revision. The person-only Host capability is absent from Host.call,
model tools, automations and remote sessions. In a shared workspace, only the
conversation's own person on the device can check it; a colleague, viewer,
signed-in non-device window and automation are refused. Automated conversations
never offer this acknowledgement. Live identity admission spans the audit write,
and thread ownership is checked again under its data-folder lock. Changing accounts,
closing the bound window or quitting also withdraws a pending native check, with
the cancellation checked immediately before its audit write. The local CLI command
`backbone threads checked <thread> --turn <turn>` requests that same native question
through the existing asked API line; without the app it refuses. Neither the CLI
nor the renderer supplies the identity or confirmation answer to the general API.

The fsynced `turn.unknown.checked` event in the append-only thread journal is the
local inspection audit log and owns `Turn.unknownChecked`: the Core owner's ID,
time, revision and retained steps, plus the person’s name when known. This is a
local inspection record, not a Core effect reconciliation or a Core audit-export ledger entry. Replay restores it even
if the app dies before saving its thread or board projection. Restart, Rewind and
goal Resume can then continue; a board's uncertainty hold becomes a failed card
that the person can release through its existing control. Checking itself starts
no work and changes no engine permission. The original unknown remains visible as
“unknown, checked by <person> on <date>”, including exported history, and never
becomes a successful action. A changed turn invalidates the acknowledgement. The
app and CLI label it as an earlier check that no longer applies; exported JSON includes its `current` flag
and readable history carries the same label. The name is shown where known, with
the ID retained in inspection detail. Reading a conversation computes the offer
from local turn and connector records, without marking the host used, acquiring
extra data folder locks or verifying Core receipts. The actual check still verifies
every named connector receipt afresh. A person's board hold is durable independently of
the worker's result text and survives both checking and recovery. Checking does not
add Restart to turns that ended done or refused; send a new message for more work.
