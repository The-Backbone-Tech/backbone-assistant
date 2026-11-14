# Company context and work

**Status, 28 October 2026:** intended company-layer behaviour, not a claim of current enterprise adoption or a mandatory new database. The existing `backbone-way/acceptance/J-co/job.md` owns the first company-function acceptance; its systems and data are fictional. Implementation now follows the resumed milestone and its actual acceptance gates.

## Outcome

Backbone helps a team complete a function using the tools, people and practices it already has. It learns enough about the work to act within authority, show its reasons, preserve exceptions and let another person continue. It should also help the people doing the work understand the business problem and improve their own judgement.

For the first company-function job, the team handles incoming customer requests using simulated email, CRM, chat and a shared drive. Backbone identifies owners, sources and reply rules, handles policy-covered work, involves a person where a decision is actually outside the capability, and leaves a useful brief. A teammate can take over with the context and unresolved work intact. Disconnecting leaves the source systems and their data intact. The job does not establish that real customer systems are integrated or that real writes are authorised.

## What the system needs to understand

Start from the job, permitted sources and actual people involved. Capture relevant responsibilities, terminology, source systems, decisions, exceptions and the reasons behind them. An unknown owner, conflicting policy or old source is a visible gap—not an invitation to invent an answer or demand a complete company map before useful work can begin.

Keep these distinctions clear:

- **Source data and observations** retain their origin, version, scope and freshness. The authoritative source remains the company's system unless an authorised deployment needs a copy.
- **Working notes and proposals** can be useful while still uncertain. A person's correction or an agent's inference does not silently become accepted company truth.
- **Accepted knowledge** follows the existing protected landing and correction/retraction rules. Trace the claims and derived views that need updating when the evidence or access changes.
- **Reusable capability, instructions and tenant configuration** are different: a plugin may package a capability, a skill may describe a method, and tenant configuration binds the company's systems and preferences. Credentials and permissions stay with the trusted runtime; loading a skill or plugin does not confer them.
- **Private and shared work** have their own audiences, retention and export rules. One tenant's context or credentials do not become another's merely because they use the same capability.

Use source-backed retrieval and working views that fit the actual task. A graph, vector store, synchronisation pipeline or complete company mirror is a candidate when it solves a measured need, not a prerequisite. Temporary working data and tools may be useful; identify their owner, authority, cost and recovery, then decide whether to keep, replace or retire them.

Preserve the meaning of a source field when combining it with another team's data. A closed billing case can mean the invoice was settled. A closed support case can mean the customer received an answer. A follow-up view can use both facts and still show which source, definition and revision supports each. Start with the company's terms and map only the distinctions that change the decision. Ask the relevant owner when a term is ambiguous and the answer would change an action. A successor should be able to correct the mapping without rewriting either source. Test a case where only one system says closed, then add a third legitimate meaning. Check that the report changes only where that definition applies and that existing teams can still work in their tools.

When a shared view derives from restricted inputs, apply the audience's policy to the derived result. Check what that audience can learn from the versions, filters and exports available together. For example, two exact totals and the identity of the only changed account can reveal that account's amount. If the policy withholds that amount, provide a useful broader summary where possible and keep the exact breakdown in the authorized view.

## Integration and learning

Prefer an eligible operation in the company's existing application or workflow when it does the job. Otherwise compare a maintained connector/broker or a small typed bridge on the exact operation, account, permissions, completion semantics and exit cost. A connector catalogue or a common protocol does not settle those details. The authority and uncertain-effect boundaries are described in [authority and effects](authority-and-effects.md).

Let people correct a source, an interpretation or a proposed rule, and make the consequence visible to future work. Keep the reason and provenance that explain why a decision was made. Where a source is retracted or access is lost, do not continue presenting a stale or inaccessible claim as current fact. How and when learning or cleanup runs can vary; no fixed nightly process or automatic widening of authority is required.

## Evidence before claiming it works

The J-co job's existing five-request story and adverse cases remain the pass contract. Relevant checks include an injected email, an owner changing a pending question, CRM access revoked before dispatch, a possibly committed update with a lost response, teammate handoff, correction propagation and clean disconnect. The brief must distinguish completed, proposed and denied actions, and actions with unknown outcomes and their actual recovery options.

Later enterprise claims require evidence from an authorised real environment, including the setup and operating burden, useful outcomes, human review, source permissions, recovery and a second relevant environment before claiming repeatability. Documentation, synthetic fixtures, a vendor story or the existence of a company map alone do not prove adoption or safety.
