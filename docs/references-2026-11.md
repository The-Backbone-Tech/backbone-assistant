# How the references reach each capability, November 2026

Owner: the integrator. Read and written on 9 November 2026 at the maintainer’s request ("make sure to check how the references reach their solutions as of November 2026"). It replaces the bar document of the same name that the [scorecard](scorecard.md) cited and that was lost in the 9 November cleanup.

This page is the short form: for each capability family, the strongest behaviour found, how it is built, and what Backbone takes from it. The evidence is in two research files, each with a URL and read date per claim and a label (read in source, documented, vendor claim, observed limit):

- [Codex and ChatGPT, Hermes Agent, Paperclip, Gemini CLI](references/2026-11-codex-hermes-paperclip-gemini.md), researched by a Claude model.
- [Claude Code, Cowork, the Agent SDK, Managed Agents and Anthropic's administration; OpenClaw and OpenClaw Enterprise; OpenCode](references/2026-11-claude-openclaw-opencode.md), researched by a GPT-family model through Codex.

Each family's products were assigned to a model from the other vendor where possible, so that neither wrote up its own maker's products. **Limits (fact):** both are reconstructions from public sources. Nothing was installed, signed in to or run, so "strongest" is a reading of documentation and source, not a measurement. Pages read in part are marked in the files. The "Backbone takes" column is Backbone's opinion, written on 9 November from those files and from the [component review of the same day](decisions-and-references.md); a package ID points to the plan ([docs/execution.md](execution.md)).

Versions read: Codex CLI 0.167.0 (6 Nov, Apache-2.0), Hermes Agent 0.23.0 (5 Nov, MIT), Paperclip 2026.1106.0 (6 Nov, MIT), Gemini CLI 0.67.0 (4 Nov, Apache-2.0; since 18 June 2026 its README points individuals to Antigravity CLI). The second file gives the versions and commits it read for Claude Code, OpenClaw, OpenClaw Enterprise and OpenCode.

## The bar and what Backbone takes

| Family | Strongest behaviour found, and how it is built | Backbone takes | Package |
| --- | --- | --- | --- |
| 1 Parallel work | Hermes: cheap in-process children plus a durable multi-process board with atomic claims and leases. Claude Code: separate-context helpers, peer teams and orchestration scripts that can be rerun. Codex: one virtual machine per cloud task | Keep the board; replicate the split between cheap children and durable claimed cards; scripts that can be rerun are a later addition | E5 |
| 2 Sessions | Codex: one thread protocol for every client (resume, fork, search, compact, revert, move between hosts). OpenClaw: history linked to its parent, with search the agent can use | Keep our thread journal; treat the Codex app-server thread model as the compatibility target; replace the substring scan with real full-text search | S5 |
| 3 Goals | Codex (open source): goal state with a token budget, a no-progress check and a completion audit that asks for evidence. Managed Agents: a grader in a separate context scores the result against a rubric, with a budget admitted up front | Add a budget and a no-progress check to goals, and keep the judge separate from the worker, which Backbone already does | S5, P3 |
| 4 Command line | Codex and Claude Code: a scriptable headless mode with structured events and schema-shaped final output | Replicate the event and output conventions | S6 |
| 5 Messaging | Hermes: 25 or more channels in one gateway (MIT, Python). OpenClaw: the broadest native channel gateway in its set (MIT) | Integrate Chat SDK now, because it is TypeScript like the workshop and the work is under way; OpenClaw's adapters are the alternative if Chat SDK's coverage or delivery behaviour falls short. Backbone owns durable intake, identity and the delivery receipt either way | S1 |
| 6 Memory | Hermes: a small memory the person can read, with staged writes. OpenClaw: every memory carries its origin and a trust tier, with hybrid retrieval. Codex: extraction then consolidation while idle | Keep the Markdown memory and its sources; add trust tiers by origin; consolidation by a model already exists | A2 |
| 7 Skills, plugins, MCP | Claude Code: packaged skills, agents, hooks and MCP with a company marketplace. Hermes: deep MCP support and scanning at install. Paperclip: governed tool access with permissions and a call log | Keep the open formats (Agent Skills, MCP); replicate install scanning and hook trust bound to a hash; a catalogue waits | S4 |
| 8 Proactivity | Hermes: cron with a gate that skips the model when nothing changed, and jobs that are only a script. Claude Code: cloud sessions started by a schedule, an API call or a GitHub event. Paperclip: signed webhook triggers that are safe to repeat | Replicate the wake gate and script-only jobs; triggers from outside arrive through channels and signed webhooks | S1, P1 |
| 9 Learning | Hermes and OpenClaw: skills the agent writes, reviewed against evidence, proposed first and reversible. None measures whether a learned skill improves later work | Keep proposals with Undo; **build the measurement nobody has** (with and without the skill on the same jobs) | A2, P3 |
| 10 Model freedom | OpenCode: provider packages, custom endpoints, local services, a model per agent. Hermes: many providers behind one resolver. Paperclip: freedom at the level of whole agents | Engines through one port plus one ACP module; any model through Pi; a local model exercised for real | E1, E3 |
| 11 Permissions and autonomy | Codex: a native sandbox on macOS, Linux and Windows, a rule language, a reviewer agent that fails closed, and a class of company rules that always need a fresh human answer. Claude Code: permission modes, a classifier that approves automatically, rules, and shell containment by the operating system. **Paperclip: an outside call whose answer was lost is recorded as an unknown outcome and never sent again** | Keep one permission per capability with a receipt per effect. Use a maintained sandbox for engines that run their own tools (the Codex sandbox crates or Anthropic's sandbox-runtime, both Apache-2.0) instead of profiles written by hand. Narrow permissions by rule, with a class only the person can satisfy. Backbone is not alone in handling a lost answer honestly: Paperclip does it too | A1, A3, A4, E1 |
| 12 Workspace | Codex and Cowork: documents, browser and computer use across surfaces | Integrate existing browser and computer-use tooling once the door covers that class of effect | later |
| 13 Connectors | Managed Agents: MCP with a credential vault bound to each user. Paperclip: a catalogue with a vault, permissions and an audit log | Keep MCP with pinned definitions; credentials bound to the person; the model with a vault and permissions is the pattern for C1 | S2, C1 |
| 14 Deployment | Claude Code and Codex: local, remote, cloud and control from a phone. Hermes: the gateway serves the workspace to any browser | Signed builds first; phone access through channels and then through a browser served from the person's own data folder | C4, S1 |
| 15 Licence | Hermes, Paperclip, OpenClaw, OpenClaw Enterprise and OpenCode are MIT for the whole product | Matches: Apache-2.0, the complete solving loop open | — |
| 16 Identity and roles | ChatGPT and Anthropic enterprise: directory groups, custom roles, provisioning, several identity providers. No open product has group roles or provisioning; OpenClaw Enterprise has explicit principal and resource authority | Build on OpenID Connect; adapt OpenClaw Enterprise's principal and resource model (MIT) | C1 |
| 17 Audit | Paperclip: an append-only record per call in the open product. ChatGPT and Anthropic enterprise: export APIs, with a stated list of what the record does not cover | Receipts already exist per effect; add the export, and say what it does not cover | C2 |
| 18 Central administration | Codex: defaults against requirements, from layered sources, with a signed cache that fails closed at start. Anthropic: parent and child organisations with endpoint policy | Replicate defaults against requirements with a signed policy file; it is the company form of the capability profiles | A3, C8 |
| 19 Fleet | ChatGPT and Anthropic: packages and policy through device management. OpenClaw Enterprise: agent revisions reconciled on Kubernetes (MIT, before 1.0) | After identity and managed policy; OpenClaw Enterprise is the open design to adapt or to run Backbone data folders under | C4 |
| 20 Observability | Gemini CLI and Claude Code: OpenTelemetry signals with content off by default | Adopt OpenTelemetry with the GenAI conventions, no content by default | C3 |
| 21 Evaluation | Paperclip: independent oracles, calibrated graders, failure classes, unknown reported as unknown. Managed Agents: outcomes and rubrics as events | Keep our acceptance jobs; replicate that discipline in them; one maintained runner for the baseline arms | P1, P2 |

## What this changes in the plan

- **The lost-answer rule is not ours alone (fact, Paperclip documentation read 9 Nov).** The plan's second aim is narrowed to what no reference combines: one permission per capability, a receipt per effect, and the same record and recovery under every engine.
- **Do not write sandbox profiles by hand (opinion).** Two maintained, permissively licensed sandboxes exist. E1's first scaffold generates its own `sandbox-exec` profile; before it is integrated, compare it with the Codex sandbox crates and sandbox-runtime and adopt one unless the comparison shows a reason not to.
- **A place to lead (hypothesis).** No reference measures whether a skill it learned improves later work. Backbone's scorecard row 9 already names that comparison; it becomes part of P3.
- **A new package, C8 (opinion):** company policy as defaults against requirements in a signed file that fails closed, replicating Codex's managed configuration. It was missing from the plan.
- **Channels (opinion):** Chat SDK stays the first route; OpenClaw's adapters are recorded as the alternative, to be tried if the first real channel shows a gap.

## Scorecard rows against this bar

This table sets each scorecard row 1 to 19 against the bar above, which has 21 families; families 20 and 21 have no scorecard row. Haiku 5.5 wrote it on 10 November 2026 from this page and the two research files, without running anything. It is a reading for the scorecard's owner to confirm, not a re-marking of any row.

| Row | Family | State in the scorecard | What the bar adds that the row's evidence does not mention | Reading |
| --- | --- | --- | --- | --- |
| 1 Parallel work and subagents | 1 | behind | Claude Code's rerunnable workflow scripts own branching and results; the row does not mention them. | consistent: row admits no cloud fan-out and does not mention rerunnable scripts |
| 2 Threads and sessions | 2 | behind | Codex compacts and reverts threads, and OpenClaw lets the agent search past transcripts by anchored ID; the row names neither. | consistent: row admits no cross-device continuation, so the gap stands |
| 3 Goals and long-running work | 3 | matches | Codex's goal runtime has a no-progress check and a completion audit that asks for evidence; the row mentions neither. | likely too generous: matches, yet no-progress check is never mentioned |
| 4 CLI | 4 | behind | Codex exec and Claude Code print structured events and a schema-shaped final output; the row mentions piped input but not structured events. | consistent: no structured events or schema output shown, so behind holds |
| 5 Messaging channels | 5 | missing in current composition | Hermes runs 25 or more channels from one gateway, with allowlists and pairing codes; the row names only a reuse candidate. | consistent: nothing delivered, so the missing state holds |
| 6 Memory | 6 | behind | OpenClaw gives each memory a trust tier by origin, and Hermes scans entries for injection; the row mentions neither. | likely too harsh: row shows origin, hybrid recall and model consolidation, most of the bar |
| 7 Skills, plugins and MCP | 7 | behind | Hermes scans every skill hub install in quarantine before use; the row does not mention install scanning. | consistent: no install scan or hook trust is shown, so behind holds |
| 8 Proactivity | 8 | behind | Hermes runs script-only jobs, and a script can skip the model when nothing has changed; the row names neither. | consistent: row names no cloud triggers and no script-only jobs |
| 9 Self-improvement and learning | 9 | matches | Hermes keeps an append-only ledger of skill edits with rollback; the row mentions only restorable archives. | likely too generous: matches, yet no rollback of applied skill edits is mentioned |
| 10 Model and provider freedom | 10 | behind | Hermes falls back along an ordered chain of providers when one fails; the row mentions no fallback for the main model. | consistent: only two engines are registered, so behind holds |
| 11 Permissions and sandboxing | 11 | behind, parts beat | Claude Code and Codex contain shell commands with the operating system, which the row does not name for its Pi engine. Paperclip also records a lost outside answer as unknown, so the row's "ahead" claim is parity. | consistent: no OS sandbox shown for Pi; automatic review is not built |
| 12 File and workspace UI | 12 | behind | Codex and Hermes each ship a browser tool for the agent; the row does not say whether Backbone has one. | consistent: live screen, computer use and mobile control are named missing |
| 13 Connectors | 13 | behind | Managed Agents binds each user's credentials in a vault the session references; Paperclip keeps them in an instance vault with per-person permissions. | consistent: row shows OAuth caches denied, not a per-person vault |
| 14 Deployment | 14 | behind | Hermes serves its workspace to any browser, including a phone; OpenCode pairs a phone with a one-use link. | consistent: row shows an unsigned DMG and no Windows or Android build |
| 15 Licence | 15 | matches | nothing found | consistent: the row already covers the bar's licence points |
| 16 Identity and roles | 16 | missing | OpenClaw Enterprise assigns roles on exact resources to a principal keyed by immutable user ID; the row mentions only schema roles. | consistent: no sign-in or provisioning code is shown, as the row says |
| 17 Audit export | 17 | behind | Codex and Anthropic exports state what their record leaves out; Paperclip logs each call's matched policies and redaction plan. | consistent: no company export, and the personal receipts report falls short |
| 18 Central administration and tenancy | 18 | missing | Codex layers defaults under requirements and refuses to start on an invalid cached policy; the row names no fail-closed start. | consistent: no policy file or requirements reader is shown |
| 19 Fleet deployment | 19 | missing | OpenClaw Enterprise reconciles agent revisions on Kubernetes; Managed Agents monitors self-hosted worker queues; the row names neither. | consistent: no Kubernetes, Helm or device-management package is shown |

Counts: consistent 16; likely too generous 2 (rows 3 and 9); likely too harsh 1 (row 6); cannot tell from the documents 0.

## Rows to look at first

- Row 3 Goals and long-running work (likely too generous): read `backbone-next/packages/platform/src/composition/goal-runs.ts` for a rule that ends a goal after turns with no progress.
- Row 6 Memory (likely too harsh): read the line format under `backbone-next/packages/platform/src/memory/` for a trust or origin tier stored on each line.
- Row 9 Self-improvement and learning (likely too generous): in the installed app, accept a skill edit, undo it, and check that the earlier text returns.
