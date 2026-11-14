# The shape of Backbone

**What this page owns:** what Backbone is as a design: the product responsibilities and package boundaries, the layers, the 21 required properties, the difference between a platform requirement and one company's configuration, and how a result is accepted. All of it is doctrine or target design unless a sentence says otherwise. **What it does not own:** the outcome and completion bar ([GOAL](../GOAL.md)), what is built and tested today and the current plan ([Execution](execution.md)), capability coverage ([scorecard](scorecard.md)) or how a choice is made ([method](method.md)).

Four project terms recur here. A **work plane** is an isolated place where an agent works, under a versioned contract of what it may read, change and reach. A **crossing** is a step out of a plane, into accepted results or to another system; crossings are checked, work inside is free. A **door** is the single checked exit or entrance for one kind of crossing (the egress door for outside effects, the MCP door for other clients). The historical **workshop** names the development arrangement before the one-product consolidation; code, configuration, owners and acceptance now share this product checkout. The **lab** is `backbone-work-planes`, which retains its candidate guarantees, experiments and qualification evidence. Other terms are in the [README](../README.md#words-used-here).

## What Backbone is

Backbone is the complete, open-source AI assistant for personal, team and company work. It combines assistant surfaces, agents and tools, company understanding, editable work, memory and learning, proactivity, collaboration and reliable operation. It chooses feasible solutions using actual access and dated evidence, executes with full autonomy inside a permission, verifies outcomes and preserves continuity and recovery. The capability sets of complete enterprise platforms such as OpenClaw Enterprise inform the destination; Backbone brings its own architecture and properties. Adoption, integration, replication, adaptation and new development are all ways to deliver it. A required capability does not disappear because an upstream product supplies something similar. Current implementation limits remain in execution ([docs/execution.md](execution.md)).

The destination includes AI operating and improving Backbone itself. Design safe capability surfaces that let agents use the tools and initiative the work requires.

The product should also help people understand the business problem and gain judgement, with explanations and sources appropriate to their role and the task, and with ways to correct and steer its work. This is a product outcome, not just documentation for developers. It does not require exposing a model's private reasoning or interrupting authorised work with a tutorial.

The earlier vision applies the same freedom inside real boundaries throughout the working environment: application, interface, backend, working data, integrations and development. The agent can adapt its approach to incomplete data and changing work, while preserving each source's authority, continuity and recovery. Ongoing learning and housekeeping serve both the platform and the user's work; their mechanisms and timing must fit the task rather than becoming an unconditional nightly process. These are target properties, not a claim that the current runtime already provides them.

Decide what belongs in the core by asking what must remain true when the company changes tools, the AI changes its method, or another operator takes over. Keep the guarantees stable at those crossings. Put company-specific bindings and policies with their owners, and give the AI room to choose a method within them. An adapter earns its upkeep when it makes a real company route usable while preserving those guarantees. If a native route already does that, use it directly. For example, a company can keep its own system for renewal terms while the AI changes how it prepares the brief. A temporary calculation can change freely. Changing which terms govern the renewal requires evidence from the company's source of record.md).

## Enable capable work at every level

**Design principle, clarified 5 November 2026.** Design Backbone around completing assignments with capable AI. The product, development method and operating environment should help the agent obtain what it needs, act, observe the result and recover when an approach fails. Give each level a clear contribution to that outcome.

| Level | Design consequence | Evidence that it helps |
| --- | --- | --- |
| Positioning and scope | Describe the complete work people can entrust to the platform, including initiative, adaptation and follow-through. Explain the currently supported scope and how the remaining capability will be delivered. | A reader can distinguish the intended outcome, today's executable route and the next dependency without interpreting a temporary limit as a permanent product restriction. |
| Method and organisation | Delegate an outcome with appropriate context and authority. Let the agent choose tools and sequence, inspect failures and repair what it owns. Give a human or successor a usable decision when their intervention is necessary. | The agent completes unfamiliar work, resolves recoverable obstacles and avoids repeated requests for already granted authority. |
| Structure and ownership | Keep authority, source records, working results and effect recovery with identifiable owners. Make their interfaces and current state discoverable. Isolate concurrent changes where that lets work proceed safely. | An unavailable integration blocks only the work that needs it. A successor can continue from the current result and resolve the actual pending obligation. |
| Technology and working environment | Provide useful native tools, code execution, inspection, search, temporary working data and environment repair in the permitted scope. Choose isolation and deployment for the resources the job actually needs. | A realistic job runs with its necessary dependencies and data. Repair and restart preserve the result and require less operator rescue. |
| Protocols and interfaces | Expose understandable operations, usable schemas, current identity and version, outcome state and actionable errors. Preserve supported native features and access to the relevant source behavior. | A new client can discover and complete the operation. Failure feedback supports a correction, and an interrupted external action can be reconciled through its owner. |
| Abstractions and configuration | Share what consumers actually need to rely on. Allow capability-specific options where providers differ and verify replacements through the real consumer. Make effective configuration observable. | A stronger model or a different tool can take over the supported work without losing useful capability, edits, authority or recovery. Count the setup and maintenance burden the abstraction adds. |
| Security and governance | Establish meaningful delegated scope and enforce the affected data and action boundaries. Make the permitted path practical, provide recourse and carry the permission through ordinary execution. | Legitimate work completes with proportionate interruption. Attempts outside scope are contained and lead to a concrete resolution when an authorised one exists. |
| Evaluation and upkeep | Compare whole-job completion, useful adaptation, correction and human effort. Retire obsolete workarounds, duplicate controls and guidance when their consumers and recovery obligations permit it. | The configuration improves accepted outcomes over time while avoidable setup, approval, retry and maintenance work decreases. |

A narrow common interface can hide a provider's useful features. Keep the shared contract small where that helps replacement and provide a supported route to additional capabilities under the same applicable controls. A deployment that lacks a needed operation should identify how to supply it. A protocol that reports only failure should expose enough outcome and dependency information for the next eligible step. Diagnose these obstacles at the level that creates them so a prompt or human operator does not have to compensate on every task.

This is a design and review criterion across the platform. Apply it to the affected change and consumer through the existing specifications, acceptance jobs and execution queue. The [working method](method.md#remove-obstacles-to-completing-the-work) and [execution proof questions](specs/solution-selection.md#removing-obstacles-during-execution) explain how to use it on an assignment.

## Complete platform and proportionate configurations

**Platform scope, clarified 5 November 2026:** complete the platform and its important components, while keeping each company's deployment proportionate. Smallness applies to the trusted kernel and unnecessary complexity. The Engine and product provide the full capability range. Selection, outcome integrity and continuity are important properties within that range, not a three-feature limit. Studying, replicating and improving references also develops understanding and practical competence; market uniqueness is not required to do that work.

| Level | Meaning for development and adoption |
| --- | --- |
| Platform requirement | A capability the complete solution must provide and qualify, tracked by the product requirements and scorecard. A supported integration can supply it; a link to upstream cannot. |
| Configuration requirement | A capability, control or dependency required for this company's selected job, deployment and authority. A different configuration can meet the same need differently. |
| Optional enhancement | A useful addition that this configuration can omit. Explain the benefit and conditions that make it worth enabling. An optional choice here does not automatically make its capability family optional for the platform. |
| Alternative and selected default | Different implementations or operating arrangements for a capability. State our choice for the concrete case, its reasons, evidence and limits, and how to replace it. |

Use the existing [scorecard](scorecard.md) and workshop product requirements for capability coverage rather than creating another catalogue. They cover execution and orchestration, assistant and artifact surfaces, context/memory/learning, proactive work and channels, company/team operation, connectors, authority, portability and deployment. Preserve meaningful reference capabilities through the composed experience and improve them using Backbone's principles. A missing required capability stays open; implementing it can proceed alongside qualification of the first useful configuration.

A reusable configuration or template should explain the problem and fundamentals, what each part does and why, the required and optional pieces, eligible alternatives and our selection, plus setup, operation, verification, recovery and replacement. Put reusable mechanisms in Engine, guarantees in Kernel, and product defaults and acceptance in Backbone; company-specific bindings remain with the company. The result can expose broad capabilities while presenting only the tools and decisions relevant to the current user.

## Choosing and executing solutions

**Product capability, adopted 27 October 2026:** choosing and executing the best feasible solution for each task is a core product capability. Backbone understands the desired outcome and success criteria, discovers what the person or organisation can actually use, brings in Arena's dated evidence about alternatives, chooses or composes an approach, executes it within current authority, and verifies the outcome. It revises the approach when evidence, access or results change. This applies to unfamiliar tasks as well as named jobs; the initial supported range must be demonstrated, not described as solving every possible task.

Two kinds of knowledge meet here:

- **Private operating context:** tools, accounts, licences, supported access routes, granted scopes, quotas, budgets, data constraints, preferences and relevant prior results. Observed installation or sign-in is not evidence of entitlement or authority. Unknown access, price or quota remains unknown until checked when it matters; credentials stay with their existing holder.
- **External solution evidence:** Arena's records and primary sources on capabilities, limitations, cost, maturity, prior art and measured results, with versions, dates, confidence and revalidation. Evidence supplies candidates and trade-offs; it does not confer access or establish that a general winner fits this task. Arena is a replaceable evidence provider, not a mandatory hosted decision service.

**Arena scope, adopted 27 October 2026:** Arena is a central product capability for staying informed and revising choices across repositories, connectors and integration solutions, security, plugins, startups and complete products, standards, paid resources, databases, architectures, techniques and trends. It supplies evidence for whole approaches and compositions as well as individual components. Its breadth is not a requirement to build every category or measurement system now. Arena remains a separate replaceable evidence provider; its implementation, taxonomy, ranking methods and preferences do not become Kernel guarantees. Backbone's actual task context, access and authority determine fit, and the complete result must still be qualified. Flexibility includes revising methods and working environments while preserving work, permissions and unresolved effects; it is not merely the presence of interchangeable adapters.

Candidates include native app features, existing workflows, software and libraries, models and engines, services and human handoffs. Free, paid and already licensed solutions are compared on outcome quality, probability of success, elapsed time, human effort, incremental spend, setup, maintenance, recovery and exit cost. Backbone distinguishes **usable now**, **usable after a concrete authorised setup**, and **an option requiring a new entitlement or mandate**. It can expose a worthwhile paid or free alternative without purchasing or enabling it outside the user's authority.

Reuse includes adopting unchanged, configuring, composing, integrating and adapting. An approach created or improved from other repositories and industry practice is also a candidate. Record exact sources and licence obligations, the borrowed mechanism, the proposed difference and its hypothesis. Upstream tests and analogous industry evidence inform the design; local conformance, adverse cases and a relevant outcome comparison qualify the resulting implementation. "Ours" does not mean novel, and "improved" names a measured advantage with its limits.

The selected engine may reason and adapt using maintained discovery, tool-calling and workflow mechanisms. Do not require a new universal optimiser, fixed workflow or multi-agent run for every task. Keep the explanation and search effort proportionate to the decision. Act autonomously inside what the person signed. Only two things go to the person: a missing fact that changes the result, and an action outside what they signed, which is held for them while independent work continues and unresolved effects are preserved.

**Ownership:** the Kernel keeps guarantees. The Engine provides neutral mechanisms for capability discovery, evidence access, selection/composition, execution, verification and continuity. Backbone owns user-facing defaults, preferences, jobs and acceptance. Arena owns dated external evidence; private account context and work results stay with their tenant. Build-time component choices and runtime task choices share evidence but have different decisions and tests.

**Supported solution configurations, clarified 2–3 November:** the product combines its operating experience with tested arrangements, adaptable plans and operating documentation for real jobs. Start from the person's or company's applications, infrastructure, local/cloud/VM deployment, eligible AI subscriptions, data scope and constraints. Recommend a suitable arrangement and carry it through setup, useful work, verification, recovery and exit. A maintained native product may be the best answer; selecting an engine/model alone does not satisfy this ambition. The [solution-selection specification](specs/solution-selection.md#supported-solution-configurations) owns the configuration proof questions.

**Open-source and commercial boundary:** the complete task-solving loop, its interfaces, local decision records, recovery and export stay usable and replaceable without a proprietary Backbone subscription or central selection service. Commercial use and revenue are allowed under the applicable licences, including products, hosting, operation and support. Third-party tools may have their own fees. Revenue expectations must not distort the solution, create artificial dependency or bias recommendations. The commercial model can evolve within these conditions. The [dated scope decisions](../GOAL.md) retain the source of this clarification.

This is a target contract. The integrated capability is not yet accepted; the workshop requirements and J-solution acceptance job, linked from execution.md ([docs/execution.md](execution.md)), define the proof. Context-aware selection, dependable execution and reusable learning are candidate innovations to measure against maintained alternatives, not established novelty claims.

## Anti-entropy and the working view

Anti-entropy here means keeping work clear as it accumulates. Work should become easier to understand and continue as Backbone operates. The default view presents useful current state: the outcome, relevant findings and decisions, editable results, unresolved work and the next useful action. Detailed progress, superseded drafts and raw run history are available when needed, rather than competing for attention by default.

Backbone consolidates, corrects, merges, isolates, archives or removes material according to its continuing value and actual retention needs. Temporary artifacts and generated views are not permanently valuable merely because they were created. Recoverable isolation or regenerable output can make deletion unnecessary; neither an archive nor a summary is required for every disposable intermediate.

A brief is a scoped, correctable view of the work. Its sources, freshness and uncertainty remain inspectable. A person's edits, contradictory evidence, revoked access and unresolved effects must survive consolidation appropriately; an unknown outcome cannot disappear into a completed summary. Cleanup preserves the necessary source, authority and recovery state, without retaining every trace forever.

This property applies to development, operational work, data and interfaces. Its mechanisms and timing fit the work; it does not prescribe a nightly batch, another memory service or a universal retention period. The [continuing-work specification](specs/continuing-work.md#consolidation-and-anti-entropy) identifies the product behaviour to demonstrate and [shows what to carry forward](specs/continuing-work.md#decide-what-to-carry-into-the-next-cycle) when sources, access or working practices change. Current implementation evidence belongs in Execution ([docs/execution.md](execution.md)).

<a id="three-repositories"></a>

## One product repository and clear responsibilities

**Decided 10 November 2026.** The runtime's repository (`backbone-next`) becomes Backbone in stages, bringing the app, runtime, product configuration, acceptance jobs and current project documentation into one product checkout. Kernel and Engine remain responsibilities with checked dependency direction, carried by packages. Arena and the work-planes lab remain separate because they supply evidence and research to distinct consumers. Execution ([docs/execution.md](execution.md)) owns the stages and their actual acceptance.

| Responsibility | Owns | Boundary |
| --- | --- | --- |
| Kernel | Reusable guarantees and their executable enforcement and conformance contracts | Independent of engines, vendor choices, product defaults and company vocabulary |
| Engine | Neutral composition, ports, adapters, working environments, surfaces, scheduling, memory and evaluation mechanisms | Uses the guarantees and preserves the supported native capabilities; product preferences stay above it |
| Backbone product | The complete experience, defaults, supported configurations, app behaviour, jobs, company understanding, operating guidance and acceptance | Chooses and qualifies complete arrangements using the neutral mechanisms and Arena's evidence |
| Arena | Dated external evidence, comparisons, source lineage and revisable recommendations | Supplies evidence; holds no tenant credentials or authority to operate a company's systems |
| Work-planes lab | Experiments, qualification of candidate guarantees, adverse cases and their retained evidence | A lab result qualifies its candidate and assumptions; an app earns its own consumer evidence |

The intended dependency direction is Kernel ← Engine ← Backbone product. The current [source map](map.md#dependencies-today) records the actual package graph, including the Core/Kernel edge and platform/module cycles; the structure checker enforces the remaining direction with named exceptions. A layer's name or a separate repository cannot establish that boundary. A company may use the [method](method.md) without installing Backbone, adopt a supported component or use the full platform. The same guarantees apply to each supported arrangement at the boundaries it actually uses.

Qualification follows the real composition. Identify the active authority, record, custody and recovery owner for each consumer. Preserve the accepted v0.8 candidate and conditions; keep the existing core where it qualifies the required behaviour. Replacing a record implementation merely for architectural uniformity is unnecessary. When relocating source, retain a source/commit map and evidence, update consumers and checks, retire displaced active owners and rerun checks affected by changed inputs. A relocation that preserves the content can reuse relevant evidence. Changed security paths receive the independent review they require. The [GOAL](../GOAL.md#completion-bar-for-this-objective) owns the complete release bar.

## Target source layout

Preserve useful native package structure. The target is a maintainable product checkout, with these roles discoverable from its entry map. These roles do not prescribe new directories where the existing structure already supplies them.

| Role | Intended placement and guidance | Kept outside shipped runtime inputs |
| --- | --- | --- |
| Guarantees | Kernel package, protocol/schema, enforcement and conformance tests with source and evidence provenance | Vendor and company preferences, private database data folders and raw qualification logs |
| Neutral mechanisms and surfaces | Existing `packages/platform`, `packages/modules`, `packages/surfaces` and affected contracts/tests, with setup, change and replacement guidance | Product defaults and private account bindings |
| Product | The app experience, distribution/default configuration, acceptance jobs, supported examples and user/contributor documentation in the same checkout | Customer records, credentials, session transcripts and experiments presented as release evidence |
| Arena | Its existing sources, snapshots, synthesis, picks, exports and research roles, with generated indexes owned by their scripts | Tenant authority and private business state |

## Target layers

| Layer | Contribution |
| --- | --- |
| Kernel | Guarantees and the implementations that enforce them for actual consumers, kept small and strict; the retained v0.8 protocol and its SQL implementation (PostgreSQL with forced row-level security) keep their exact qualification scope |
| Platform | Ports and composition for engines, models, connectors, authority, storage, scheduling, memory, evaluation and recovery |
| Pieces | Maintained or implemented adapters and capability modules, with their supported options and relevant conformance checks |
| Surfaces | Desktop app, MCP server, command line and supported channels; additional surfaces retain their own delivery requirements |
| Distribution | Backbone's defaults, jobs, company bindings, brand and acceptance; other distributions can make their own choices |

The Engine stays neutral and replaceable. Every replaceable mechanism is a slot: Engine defines its port and conformance checks, Backbone names its default and why, and alternatives are configuration, never a fork. Policies such as profiles and autonomy are configuration over the guarantees; the guarantees themselves are not configuration. Give each material component its purpose, source, chosen default, useful alternatives and reason to reconsider it. Use a shared interface where changing a component would otherwise force several consumers or business state to change. Preserve the native interface when that is the simpler supported route. Replacements prove the consumer's promised behaviour, including work, permissions and unresolved effects. The Arena evidence service informs these choices without imposing a research process on every helper library.

## Start with one useful working cycle

The smallest useful adoption can be a decision to keep the existing workflow, with the reason and the conditions that would change it. If the company needs a working configuration, start with one complete job. Identify its source, its responsible person and what counts as a useful result. Use the eligible tools the team already has. Leave an inspectable, editable result and a way to continue or stop safely. For actions with outside consequences, make the applicable authority and recovery visible. A read-and-draft job may meet that first need; it is a valid configuration, not a ceiling on what a person may sign.

Expand where repeated work exposes the next gap. A missed handoff can justify better continuity. An avoidable manual wake can justify a trigger. A verified correction can justify testing reusable guidance. Keep these choices conditional so a team can stop at the useful configuration. The full product makes these capabilities available together and lets the team improve them over time. Each supported configuration earns its own evidence. See [what to build first](decisions-and-references.md) and [the delivery objective](../GOAL.md).

## What should survive a better model

Design from how current models process information, because those limits explain most of the structure. A model does not reliably separate instructions from data: text it reads can steer it. Its focus degrades as context fills, and it follows instructions literally, so an unexplained rule over-generalises. Hence: give the model small, fresh, sourced context for the task at hand; keep authority and external effects enforced outside the model; treat everything retrieved as data; and explain the intent behind a constraint rather than stacking rules. ([GOAL](../GOAL.md#what-the-design-must-optimise); [working rules](../AGENTS.md). The source at OSS commit `3598263b` retains the earlier rationale.) Re-test these assumptions with each model generation; where one stops holding, retire the structure that compensated for it.

Build for the next useful job and the next plausible change. A stronger model may need fewer prompts, tool calls or orchestration steps. The company still needs to know who acted, which records governed the decision, what is pending, and what happened. Keep those facts in the systems responsible for them. Keep decisions about permissions and external effects enforceable outside the model. Treat prompts, routing heuristics, workflow steps and model-specific workarounds as candidates for replacement as soon as a simpler route earns the result.

Use a small interface where a replacement would otherwise make the team change several consumers or move business state. Define it around what the consumer needs to observe, such as whether a renewal draft exists, who owns it and whether an interrupted attempt is safe to resume. Use the native interface directly when there is one eligible route and little cost to changing it. Preserve useful native capabilities through a documented route with the same applicable controls. A shared interface that hides a provider's permission limits, completion state or recovery behaviour has made the system harder to change safely.

Keep the work planes tied to observable behaviour. Exploratory work and drafts can move quickly within their authorised environment. Accepting shared facts or making an external change calls for checks at the actual boundary, with a record of the outcome. An existing company system may already supply the relevant boundary. Reuse it when tests show that it enforces the required behaviour. [Authority and effects](specs/authority-and-effects.md) owns the guarantees.

Backbone ships an opinionated, pinned configuration for a stated environment and explains the reasons for each material choice. Engine supports narrower adoption through tested interfaces. Teams can keep their existing workspace, records, identity, workflow or telemetry and add only what closes a gap. Arena holds dated comparisons and reasons to reconsider a choice. The [decision guide](decisions-and-references.md) describes how to choose the first increment and test its replacement.

## Properties

What must always be true. This list defines the properties; their current state (shown, tested or open) is in execution ([docs/execution.md](execution.md)). Value properties say what Backbone is for; safety properties come from the lab and are structural; operation properties keep it running. A safety property that destroys a value property is a design failure, not a trade-off to accept silently.

**Value**
1. **Useful in real work:** choose, execute and verify the best feasible approach for the task using actual access and current evidence, measured against doing the same job without Backbone, scored blind.
2. **Full by default, proactive around the clock:** one permission per capability formation or version; a later pinned version, an expiry extension or a budget reset is a new version, renewed in one screen; an anomaly suspends until re-signed. Stricter profiles (Balanced, Strict, Custom) are a switch away; a lower layer may only tighten. The AI's own maintenance keeps every human and two-party crossing.
3. **Understands the real company:** its map, owners and reasons, with confidence that fades without evidence.
4. **Beside the stack:** nothing to migrate to start, everything exportable to leave.
5. **Built for change:** lean reasoning scaffolding, open interfaces (MCP, Agent Skills, AGENTS.md), portable work and replaceable model/runtime bindings. Scaffolding that compensates for today's models is built to be deleted: when a new model or a native feature passes the same checks without it, remove it. Those checks, not a separate study, are the evidence; the accepted guarantees are never removed this way.
6. **Modular and white-label:** every piece usable alone and swappable by configuration, proven by its conformance suite.
7. **Teaches three readers:** the AI, technical people and people who are not technical, each from the same source of truth. Beyond explaining Backbone, it shows how to judge a choice (what was compared, on what evidence, and what would change it), so people can make the next choice without it.
8. **Kept current:** material choices are sourced and dated, and relevant alternatives are reconsidered when evidence or the task changes. Stale candidate evidence is labelled uncertain and rechecked where material, never presented as current qualification. Our own adaptations and innovations are labelled as ours and tested before improvement claims. A fixed cadence is not a substitute for that judgement.
9. **Independent and proportionate:** commercial incentives must not bias design or recommendations; commercial uses and revenue are allowed. A recommendation can say "keep what you have" or "pay for this" (clarified 5 November 2026). Controls scale with what is at stake for the operation and the company; checks that block useful work without reducing a real risk, such as pre-2026 anti-bot gating, do not belong.
10. **Sustainable to develop and operate:** make upkeep, replacement and learning value explicit when choosing an implementation. Prefer a maintainable route to the complete capability; replication and practice can earn their place through understanding as well as immediate operating savings. A cost comparison improves the design rather than cancelling required scope. This applies to Arena's evidence as much as to code.

**Safety** (structural; a company may tighten them, never switch them off). A summary of the kernel's 18 guarantees (`backbone-kernel/docs/properties.md`), whose specification is the lab's property set until promoted with its property-owner-test matrix:

11. Freedom inside a plane, checks at its edges; authority only narrows.
12. One door out: every effect has an operation class, a receipt and a recovery class.
13. An unknown outcome is never success and is never resent.
14. One door into accepted truth, judged exactly and landed once; whoever proposes never approves.
15. Seeing never authorises.
16. The model never holds a secret.
17. The rules that keep freedom safe cannot weaken themselves.

**Operation**

18. Crash-safe: interrupted work resumes without doing anything twice.
19. Observable without leaking content.
20. Upgrades take a save point and have a way back.
21. The AI operates Backbone itself: it may improve how Backbone works, never widen what it may do.

## Acceptance method

Each rule has its reason.

- **Pass criteria are written before a step starts,** so a result cannot be fitted to the criteria afterwards.
- **Every promoted slot has a conformance suite that every alternative passes,** because "replaceable" is only true when a replacement has been checked against the same suite.
- **Guidance is checked through the path its intended reader needs to complete,** because a correct link or the author's familiarity cannot establish that a successor understands and can use it. Reuse relevant reader evidence; choose a fresh person or agent where comprehension remains uncertain. Sensitive changes retain their independent-review requirement.
- **Real use outweighs test counts:** interruptions per day, time saved, correct work held, wrong work let through, recovery rate. Real use is recorded when it happens; no acceptance condition is a count of days ([GOAL](../GOAL.md)).
- **Another model family reviews any change to authority, secrets or effects,** because models of one family share blind spots; defects in authorisation, binding, detachment or secret exposure always block, since they cannot be undone after an effect has left.
