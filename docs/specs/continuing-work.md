# Continuing work and artifact custody

**Target behaviour, updated 2 November 2026.** Execution ([docs/execution.md](../execution.md)) owns the observed implementation and remaining work; this page describes the intended experience and boundaries.

## Outcome

A person can attach originals, ask for useful work, inspect and edit the result, save their own version, stop or close the app, and continue later. A follow-up uses the person's saved version. Changing or restarting an executor must not silently lose the work, widen access or repeat an unresolved effect.

For the first milestone, this behaviour is exercised with the existing installed continuity and triage jobs. It supports the larger assistant; it does not require choosing a new editor, a workflow engine or a universal file store first.

## Ownership and boundaries

| Concern | Intended owner and boundary |
| --- | --- |
| Originals, working material, draft and saved versions | The existing work-material owner. An original is not overwritten; a person's Save is atomic and creates the appropriate version. Client drafts and caches do not become a competing authority. |
| Source and proposal identity | The current work/custody owner retains the exact target, relevant source identities and versions, proposed body and original operation identity needed for recovery. Private recovery content is not put into public receipts or model diagnostics. |
| Execution and native session | The existing engine boundary invokes an eligible executor. Native resume data may be adapter-specific; the user's durable work, current permissions and unresolved effects must not depend on one executor's transcript. |
| Authority and external effects | Current authenticated authority, the existing gateway and qualified enforcers determine whether an action can proceed. A document, skill, imported session or prior success does not confer access. An unknown outcome is held for justified reconciliation, not blindly resent. |
| User experience and acceptance | The product surface shows the actual saved result, pending work and useful recovery information. The owning acceptance job—not this page—defines the final pass bar. |

## Behaviours that matter

1. **A human edit wins over a stale assumption.** If the agent read v1 and a person saved v2, the agent's old write must not silently overwrite or rebase onto v2. Preserve the proposal and present or apply an authorised resolution using the actual current version.
2. **Recovery uses the original operation.** Across an interruption, preserve the original source/target binding and proposal. Continue the original operation only when its state and current authority make that safe. Missing, changed or corrupt custody cannot be turned into a new proposal or a claimed success.
3. **Unknown is visible.** A dispatched write with an unknown outcome stays unresolved until a reliable observation or an authorised resolution. An empty lookup leaves the outcome unknown when the original request can still take effect. Restarting, using another tool or changing the plan does not create permission to repeat it.
4. **A result identifies real material.** A link or success message refers to the verified resulting artifact/version and its appropriate receipt. A preview, generated text or an unrelated newer version alone is not evidence that the original write landed.
5. **Stop, access changes and swaps preserve state.** Stop prevents new work from starting, records in-flight uncertainty honestly and preserves recoverable work. Revocation blocks further protected access. A real replacement must keep the relevant human edits, live permissions and pending outcomes intact.

## Consolidation and anti-entropy

The person returns to a useful current brief and the actual editable result, rather than a flat accumulation of messages, repeated progress cards and intermediate artifacts. The brief explains what changed, useful findings and decisions, what remains uncertain or unfinished, and the next action. Sources and detailed history can be opened when they resolve a question.

Consolidation may merge or retire obsolete notes, isolate superseded material, or remove disposable generated output. Use the existing material, task, brief and recovery owners. Preserve only the detail needed for continuing work, the applicable retention purpose and a justified recovery path; do not create a second authoritative memory store or silently rewrite source records.

Demonstrate that:

- After repeated runs, the current view is smaller and useful while needed source/version details remain reachable. A person can continue without rereading the transcript.
- A person's correction, changed source or access withdrawal invalidates the affected summary instead of leaving a confident stale conclusion.
- Interrupted consolidation leaves recoverable work. An unfinished task or action with an unknown outcome remains visible and cannot be deleted or described as completed by summarisation.

These are product proof questions, not a claim that summarisation or cleanup is already implemented. The broader property lives in [Shape](../shape.md#anti-entropy-and-the-working-view).

Maintained native continuation remains the default; a small brief plus scoped retrieval is a candidate when actual rollover or executor replacement needs it. The [Mainplane pilot](../decisions-and-references.md) recovered exact details unavailable in its summary-only arm, but showed no gain over native resume and reintroduced withdrawn synthetic text through raw retrieval despite correct final answers. A retrieval adapter must use existing material/access and source-lineage qualification, including snippets and derived agent text; an exposed transcript or a model instruction is insufficient. Validate context admitted to the model as well as its final answer. Include late corrections, unknown provenance, untrusted tool text, repeated restarts and pending actions with unknown outcomes; count preparation and retrieval through task completion. This is no installed enforcement claim, additional memory store or replacement engine adoption.

A later loss of access also matters when continuing through the same native session. If that session can still use material supplied before revocation, test its next effective context before treating it as an eligible continuation. Where the runtime cannot exclude the withdrawn material, start a fresh eligible session with a scoped handoff. Preserve the authorised edit, task state and unresolved operation reference through their respective owners. The reference lets the authorised resolver find the operation and confers no access to the withdrawn source. Restoring a permission can permit a fresh read under current policy. It does not establish that older context or derived claims are current.

Test this with a canary admitted before withdrawal, a derived note containing the canary and a separate pending operation. After withdrawal, examine the next context and available tools as well as the final answer. Check that the successor can still advance an independent permitted step and that a matched permitted source remains usable. The retained Mainplane diagnostic checked new tool output and final answers. Its native arm kept the seeded history, so that arm does not qualify exclusion after revocation. Use the actual runtime boundary for that claim.

## Learning from corrections

Keep a person's explicit correction useful in the work they corrected. Automatic learning from activity is a separate, opt-in decision for the relevant person, project or team. A learned candidate can become reusable guidance when its supporting evidence, scope and later-case value warrant acceptance. Permission to learn from activity in one scope does not by itself permit publishing the resulting guidance to another team, and accepted guidance remains subject to the receiving work's current instructions and source access.

To check the difference, give two teams a shared operator and different contract rules. Enable activity learning for one project and leave the other off. Have the operator correct both briefs. Both edits should survive, with a learning candidate only in the enabled scope. Run a later case for the other team and inspect the material supplied to the model as well as the recommendation. A correct answer can still conceal an unintended disclosure. Test an explicit, authorized sharing of the general method as a positive control, with each team still deriving its notice period from its own terms.

For portable guidance, use the maintained Agent Skills format where the receiving client supports it. Describe when the method helps, why the main steps work, and one situation where the agent should choose a different approach. Load detailed examples on demand. Keep company rules and credentials with their owners. The format's experimental `allowed-tools` field varies by implementation. Check permissions at the actual tool boundary even when a skill declares tools and loads successfully. For a receiving team, test discovery on a relevant and an irrelevant task, compare against its current method, and try a step its permission excludes. This separates usefulness, freshness and authority without requiring a new skill format. [Agent Skills specification](https://agentskills.io/specification)

### Decide what to carry into the next cycle

Consider a renewal review with a human-edited brief, a source-derived notice date and an external draft whose creation timed out. The next reviewer needs a useful view of the work and a way to continue. This desk exercise varies what changed between cycles.

| Change before the next cycle | What to carry forward | What to check at the consumer |
| --- | --- | --- |
| The reviewer corrected the order of the brief and activity learning is off. | Keep the saved brief and its edit. Leave the presentation preference local to this work. | A cold reopen presents the human version and produces no new activity-derived guidance. |
| The notice date changes in a source the team can still read. | Mark the affected conclusion out of date and recompute it from the current source. Preserve unrelated edits and the unresolved draft reference. | The next brief distinguishes the new date from the old basis and still shows who can resolve the draft. |
| The incoming reviewer loses access to the contract and an earlier note quotes it. | Keep the permitted portions of the work available. Exclude the restricted passage and affected derived claims from that reviewer's view and model context. Keep an operation reference available under its own access policy. | Inspect the brief, retrieval and effective context after reopening. Check that the authorised resolver can still find the draft and that the reviewer can complete an independent permitted step. |
| The team wants to reuse the correction as a rule for future reviews. | Keep the correction in today's work. If the team chooses to generalize it, state the intended scope and compare it on a later case where it might give the wrong answer. | A later ordinary case benefits, an exception stays visible and another team receives only guidance explicitly authorised for it. |

These cases can occur together. For example, a saved human edit can contain a withdrawn quotation. Preserve the version with its proper owner and retention policy and apply the current audience's access rules to what is shown or supplied to an executor. If the applicable policy requires removal, keep only the permissible provenance or recovery reference. Check continuity from what the next reviewer can do, and check cleanup by what they and the model can actually access. The [Mainplane result](../decisions-and-references.md) illustrates why a correct final answer can coexist with exposure. This exercise specifies expected decisions, with observed implementation evidence recorded separately in Execution ([docs/execution.md](../execution.md)).

## Inspecting the basis of work

On demand, a person can follow a result or turn to its recorded sources and output versions, the request, recorded activity and actual effect outcomes. Start from the existing conversation/work view; choose text, cards or a flow only when useful. A recorded attachment is not automatically a recorded read, and an absent or partial read set is labelled incomplete. Recorded read activity without direct source identities remains incomplete even if an empty array is present or only inherited/told context was bound; preserve that known context without pretending it accounts for new reads. These records explain what is known about the work; they are not private model reasoning or independent verification of correctness. The thread shows no standing sentence saying so, no "Answers do not confirm actions." under an answer and no empty "Recorded sources" list: when there are recorded sources they are listed, and when there are none nothing is shown (removed 13 Nov 2026 after first real use: a sentence shown on every answer informs no one). Messages about this piece of work stay: an unknown outcome, a held action, an unfinished answer, a failed step, a refused write or an incomplete source record.

Bind an explanation to the actual source identity/version and applicable access history. A matching current version means only that the version still matches. A changed source, withdrawal followed by restoration, held or missing material, or a failed current-state read must not leave a confident current claim. Invalidate affected status while replacement data is being fetched, and open the exact recorded version rather than silently substituting the latest. Preserve correction, editing and existing effect-reconciliation controls with their current owners; a historical explanation confers no permission to use withdrawn content or repeat an action with an unknown outcome.

The first bounded implementation may project existing records without generating or storing any semantic summary. Actual human understanding remains a separate product question. Before choosing a richer map over the same information in text, compare held-out matched tasks for correct explanations, affected consumers, false claims, useful steering and delayed transfer, including preparation and maintenance effort. A benign change and behavior-only drift belong beside harmful cases. Human observations must be recorded as actually given; agent answers, source coverage and passing UI fixtures do not stand in for them. This extends the existing working-view proof questions and does not change the frozen triage or Kernel acceptance.

## Where to inspect before changing it

Use the integration worktree named in Execution ([docs/execution.md](../execution.md)). Relevant consumers include the platform's material store, thread custody, document writes, recovered writes and engine turn, plus the app's FileTab, task/brief projection and Save/draft state. Inspect the current consumer and contract together; old draft paths are not instructions to create another service.

Workshop contracts and historical D1 reviews help explain the failure cases. Load their source or evidence when it answers a current question; the current code and execution record determine what remains to implement.

## Evidence for the next implementation

Use the existing tests and fixtures that exercise the actual changed boundary, then the integrated consumer. Useful cases include a normal non-stale write, the v1/v2 conflict, interruption around proposal/claim/dispatch, lost acknowledgement, corrupt custody, Stop, revoked access, cold reopen and exact result identity. Use a genuine executor swap for the replacement claim. Tests should distinguish a plausible broken implementation; add a new one only if an existing check does not cover the consequence.

The installed continuation job, frozen triage criteria and the applicable Kernel/engine qualification remain the controlling acceptance contracts. A focused no-model fixture, a passing source check or upstream tests alone do not prove the installed journey, physical isolation or live provider access.
