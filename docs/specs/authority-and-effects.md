# Authority, effects and recovery

**Status, 28 October 2026:** cross-repository integration guidance for the target design, not a replacement for the Kernel or lab specification and not evidence of a qualified runtime. The existing simulated triage job is the first product acceptance slice. Real mailbox writes remain closed until the applicable effect door qualifies.

## Outcome

A person can give an agent a clear, bounded capability to do useful work without being interrupted for ordinary actions inside that scope. The system checks actual current authority at the appropriate structural crossings, prevents access beyond it and reports what happened. People can stop work, revoke authority and understand unresolved outcomes.

The Full profile is the product default inside a permission; stricter profiles may choose more interaction. The person forms or widens permission once; a tool, document or model cannot give itself more authority. The current read-and-draft milestone can show proposals and unsent drafts while its real-write boundary remains closed; this is not evidence that later source writes are admitted.

For the native Codex adapter, the setting named `full` enables selected native capabilities inside the host's environment contract. At workshop integration `6bb6d82`, command network, personal MCP servers, apps, plugins, hooks, browsers and computer use remain disabled in that native environment. Live provider web search is enabled. The internal `bare` path is for turns that request no tools. A job that excludes external processing must qualify the effective route, including provider search, separately from shell network. This differs from the unrestricted Codex client used for a local development experiment. A successful tool-discovery or repair experiment in that client therefore leaves native-adapter support for the same job to qualify. If a supported job needs one of these operations, provide and test an appropriate host-mediated route or qualify the corresponding environment capability. Make the effective tools and missing dependency visible to the operator and agent. The adapter source at `packages/modules/harness-codex/src/native.ts` owns these settings; use the current implementation and actual request when verifying them.

## Responsibilities

| Owner | Responsibility in the intended combination |
| --- | --- |
| Kernel | The accepted rules for planes, contracts, snapshots, verdicts, receipts and protected crossings, including current authority, isolation and admission requirements. |
| Engine and the actual enforcers | Bind the trusted person/session, route, tool and account to the relevant operation; protect credentials; enforce the actual process, data and egress boundaries; preserve effect identity and recovery. A policy declaration or callback is not physical enforcement. |
| Backbone product | Explain the scope and consequences in the interface; provide Stop, revocation and recourse; make the result and remaining uncertainty understandable. |
| Source and provider | Continue to own their data, access rules and operation semantics. A provider's idempotency or rollback support applies only as documented for that operation. |

The `backbone-kernel/docs/properties.md` summary and `backbone-work-planes/docs/PROPERTIES.md` plus accepted lab decisions own the full guarantee set. `backbone-way/acceptance/J-triage/job.md` owns its frozen product tests. Paths are relative to the named repositories; inspect their current versions and actual consumers before changing the integration.

## Behaviour across the boundary

1. **Bind the real person and scope.** Formation binds the relevant identity, tenant, purpose, resources, operations and limits through a trusted route. A renderer, agent, source document or retrieved instruction cannot impersonate the person or widen the permission. A sign-in or an installed app does not itself establish an eligible API or licence.
2. **Check current authority where it matters.** Revocation, expiry, suspension or a changed provider permission must take effect at the relevant operation; an old approval, cached result or imported session cannot revive it. Permissions and source labels follow derived content.
3. **Keep secrets and controls outside the model's reach.** Credentials are held and injected by the appropriate holder and effect boundary. The actual sandbox, database role, process privileges, network routes and logs must be checked as a combination; labels such as “sandboxed” or “RLS enabled” do not establish their effective scope.
4. **Bind a concrete effect and its result.** Preserve operation identity, actual account, arguments and relevant input versions through proposal, dispatch, observation and receipt. Approval to form a capability is not proof the provider applied an action, and a successful local write is not necessarily proof of a completed external effect.
5. **Handle uncertainty without duplication.** If an effect may have happened but cannot be confirmed, record an unknown outcome and use an appropriate provider observation or authorised resolution. A restart, alternative connector or new request key cannot automatically turn that uncertainty into a safe retry. Show the available cancellation, compensation or irreversible limit honestly.
6. **Keep accepted knowledge distinct from working material.** An agent's draft or observation can be useful without becoming accepted organisational truth. The existing protected landing and independent-verdict rules govern the latter; users can correct or retract supported knowledge through the appropriate owner.

### Preserve useful autonomy when a condition changes

Consider an IT team reviewing backup failures. The company permits unattended collection of job status into its internal environment and triage against an agreed rule. An operator owns destructive recovery actions. An unclear failure goes to that operator while other failed jobs can still be classified. This is a desk check of the authority model.

- **An approved status endpoint becomes available.** Verify the acting account, job scope, destination and failure signal through the actual route. If the existing permission covers this operation and the installed route meets the required checks, switch collection without adding a review to every ordinary read. The operator still owns destructive recovery.
- **An outage becomes urgent.** Bring the exception to the responsible operator with the available evidence and deadline. Continue independent permitted work. Urgency can change priority and the cost of waiting. It supplies no authority to overwrite a backup or restore over a live system.
- **The status permission is revoked after a run starts.** Check the next protected read at the source boundary. Continue only with material and operations still permitted, including a scoped handoff to the operator. If the revocation also changes who may see previously collected data, apply that policy to derived views and later model context. [Continuity after withdrawal](continuing-work.md#consolidation-and-anti-entropy)

The useful autonomy check is two-sided. Observe that routine permitted work completes without an avoidable interruption and that an operation outside scope cannot proceed. A system that asks for every read fails the first test. A system that treats an urgent request as recovery authority fails the second. The scenario describes expected decisions. The installed environment must establish its own enforcement and completion evidence.

## Cases to verify on the actual combination

Use the owning conformance and acceptance cases for wrong tenant/account, forged person or session, unformed or revoked capability, expired access, stale source versions, prompt-injected content, credential exposure, Stop during an effect, and a provider applying an effect while its response is lost. Verify both an allowed normal operation and the corresponding denial or uncertain state; do not infer the full boundary from a synthetic callback alone.

For recurring work, exercise authenticated wake, deliberate activation, dependency readiness and current operation authority as separate conditions. Test an authenticated wake on an inactive installation, an active route with an incompatible dependency, and a ready route whose operation permission is withdrawn before use. Confirm a permitted run through the same path. Include any incumbent scheduler that can start the work independently in the observed boundary.

The candidate SQL transport exposes only part of the older consumer and effect lifecycle. Completing an outbound lease is not dispatch, provider authorisation or settlement. The trusted personal-session owner is an interface until the real app/installation binding is implemented and qualified. Record the exact candidate and failure evidence at the actual owners before running a resumed task.

Current documentation illustrates why deployment details matter: [PostgreSQL](https://www.postgresql.org/docs/current/ddl-rowsecurity.html) documents roles that bypass row security; [OpenClaw](https://docs.openclaw.ai/gateway/security/trust-model) defines one trust boundary per gateway; and [Stripe](https://docs.stripe.com/api/idempotent_requests) documents provider-specific idempotency behaviour. These are relevant references to evaluate, not proof of a Backbone vulnerability or a universal exactly-once guarantee.
