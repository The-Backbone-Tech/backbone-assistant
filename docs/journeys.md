# Journey scope and proof

The [catalog](journeys.json) is the machine-readable capability scope for the 19
scorecard families. Reconciled on 11 November 2026 against backbone:GOAL.md,
backbone:docs/shape.md (complete platform and proportionate configurations),
backbone:docs/scorecard.md and the outcomes in backbone:docs/execution.md.
The dated inventory is backbone:evidence/experiments/journeys-reference-breadth.json.
Those external documents are ownership references, not build dependencies.

The inventory's adoption labels and source judgements are not acceptance. The
catalog retains its reference citations for traceability, without making a new
claim that upstream products were tested. No model or account was used for this
reconciliation. The complete GOAL also includes solution selection with Arena,
company data, company understanding and usefulness; this reference-family list
does not replace those separate acceptance jobs.

## Fields and counts

Each journey has a stable ID, a person's sentence, its enclosing family, a kind
and a reason. Kinds are `platform`, `configuration` and `optional`.
Configuration journeys are required platform capability, activated for the
named configurations; they are never optional merely because a personal data folder
omits them. Configuration names are activation tags, not deployable presets.
An optional enhancement may still be required by a particular deployment.

`evidenceRequired` is `test`, `installed`, `real engine` or `real use`.
These are distinct claims: an installed scripted fixture does not establish real
model behaviour, and neither establishes usefulness in a person's work. Native
route and model behaviour require a real engine; live mail, bot, identity,
deployment and actual-work claims retain real-use requirements. Package tests
remain useful evidence about the supported mechanism.

A `provingTest` names an existing test file, exact discovered title, gate suite
and evidence level. `scope: partial` explicitly marks a narrower assertion.
`supportingTests` preserve narrower package controls and development-only
fixtures that cannot currently run through the installed runner. They never turn a journey green. A null proof is
open scope, not a release failure. No editable status is stored in the catalog.

Run `node scripts/journeys.mjs` for family, kind and configuration counts plus
matching gate results. Its exported inspector returns `counts.total`,
`counts.byFamily` (including each family's `byKind`), `counts.byKind` and
`counts.byConfiguration`, for scorecard consumers. Every count has `total`,
`present`, `partial`, `missing` and `green`. Configuration columns overlap when
one journey activates in several configurations; kind and family totals do not.

Source coverage means:

- **Present:** an existing full-scope proving test names the required evidence
  level. This is a source observation, not a claim that it ran on this head.
- **Partial:** an existing proof covers a narrower scope or evidence level, or
  an existing development fixture supports an installed journey.
- **Missing:** no qualifying source proof is linked. This does not assert that
  implementation is absent; adding a real proving test changes the observation.

Green still requires clean matching gate evidence and the individual test pass.
A partial assertion or lower evidence level cannot make a journey green.
Installed app proofs still require `requiresInstalled: true`, inclusion in
`INSTALLED_TEST_ARGS`, and the gate's freshly packaged app, verified hash and
individual Electron result. Browser evidence cannot satisfy them. The runner
and its fixture support are unchanged by this reconciliation. The grader now
recognises its existing goals project only for the goals fixture, which launches
Electron and asserts a packaged app when the installed executable is supplied.
Other project names still cannot satisfy installed evidence. A vanished named
proving test still fails the grader; missing capability and absent run evidence
do not. See [the gate procedure](how-to/run-the-checks.md#qualification-gate).

## Reconciliation decisions

All 127 inventory IDs survive. None is merged or dropped: sharing a family or
test does not make two different user outcomes duplicates. For example, goal
continuation and scheduled work are different jobs; cross-device continuity and
phone pairing prove different boundaries; audit attribution and disclosure of
coverage gaps are separate obligations.

Three mixed entries are split, yielding 130 journeys:

| Inventory entry retained | Added journey | Reason |
| --- | --- | --- |
| `memory-scope-off` | `memory-role-off` | Personal task/project control is platform scope; disabling memory for a role activates with company identity. |
| `os-sandbox` | `os-sandbox-portability` | Preserve the existing macOS journey and its proof; Linux and Windows confinement stay required and unproved. |
| `goal-rubric-gates` | `goal-check-commands` | The existing rubric is required by scorecard family 3; executable check commands are optional in execution outcome 4. |

The optional journeys are saved orchestrations, remote fanout, terminal rule
checking, a private company marketplace, trusted hooks, mined approval
suggestions, ordered provider fallback, agent approval review and executable
goal checks. Execution outcomes 1–4 explicitly distinguish these enhancements.
Team boards, group channels, sharing, service identities, user-owned accounts,
company identity and directory sync, administration, audit and fleet operation
are required activated capabilities. Headless structured output and goal rubrics
are platform scope, as required by the owning scorecard and current plan.
Desktop automation and editable office artifacts are activated requirements.
Cloud routines are required when a configuration promises work with its own
computer off; optional cloud workers are an orchestration implementation choice.

Slack, Telegram and Gmail sentences retain the actual user jobs from the
inventory. Fake-provider limits belong in their proof level, not in the required
capability sentence. CLI installation retains the clean-machine requirement;
its current npm smoke test installs into a fresh prefix on the existing host,
so that proof remains partial until a fresh supported environment is qualified.

The draft browser journey required approval for every new site. Execution
outcome 1 supersedes that mechanism: reuse the existing permission, and apply the
effect door and receipt to outside effects. The curator sentence now describes
its configured policy instead of imposing its current 30-day implementation as
a universal retention requirement. Goal continuation names the background
service; computer-off cloud routines and fanout retain their own journeys.

## Proof corrections at the source boundary

Existing catalog IDs and supported proofs are retained. Thread branching, blocked
goals and goal completion use the stronger existing goals fixtures in the
installed runner; their earlier package proofs remain supporting references. The input brief said
32 catalog entries; the supplied base actually has 34. Inventory placeholders
and stale titles are resolved to exact test titles, including finite engine
pairs and channel cases. The grader reads test syntax without running it.

These draft citations were removed as proving tests, without removing journeys:

| Journey | Reason |
| --- | --- |
| `thread-other-device` | Switching surfaces on one data folder does not prove another device. |
| `channel-team-group` | Refusing group messages proves the opposite of the requested capability. |
| `hook-trust` | The cited test refuses hook activation. |
| `browser-task` | A connector switch is not a browser job. |
| `per-person-vault` | Refusing credential-shaped arguments does not prove requester-bound credentials for several people. |
| `share-one-project` | A database tenant wall is not viewer-only project sharing. |
| `linux-windows-install` | Rejecting installer arguments proves no installation. |
| `phone-browser-access` | Responsive layout proves neither pairing nor remote access. |
| `transcript-retrieval` | A redacted export excluding transcripts proves no authorised retrieval. |

The draft's memory trust and injection citations were replaced by the current
memory trust and admission tests. Managed policy now has its Host/enforcement
and protected-reader tests. Fleet upgrade and rollback name the existing
opt-in isolated-cluster test; it was not run for this documentation change.
Kubernetes rendering is partial evidence, not a completed recovery journey.
Audit attribution stays partial: the current export test explicitly records
that one-time permission versus continuing permission is not structured in Core.

Development-only app proofs are retained as supporting tests for the following
journeys, including previously linked catalog proofs. Their fixtures are outside
the installed runner; preserving them as installed proving tests would conflict
with the installed qualification rule:

- `delegate-child-report`, `thread-restart`, `steer-running-turn`, `goal-steer`;
- `memory-edit`, `memory-import`, `connect-own-tool`, `enable-plugin-part`;
- `sign-tool-once`;
- `review-learned-skill`, `save-while-editing`, `open-result-version`;
- `export-document`, `gmail-signed-send`, `person-receipts-view`.

Their required evidence is unchanged; they are partial rather than silently
qualified by browser results. Adapting those fixtures and extending the installed
runner belongs to their implementation units.

The `schedule-from-words` and `heartbeat-brief` journeys now name the installed-capable
`packages/surfaces/app/e2e/away-work.electron.spec.ts` and are selected by the installed
runner. Their older browser checks remain supporting evidence. Their installed status
waits for a matching clean gate and freshly packaged executable.

## Reconciled source counts

Read at base da0a0968 on 11 November 2026; tests are linked from
source, not rerun to qualify product journeys. Green is separate and requires
matching clean gate evidence.

Kind | Present | Partial | Missing | Total
--- | --- | --- | --- | ---
platform | 17 | 43 | 17 | 77
configuration | 2 | 21 | 21 | 44
optional | 0 | 0 | 9 | 9
All | 19 | 64 | 47 | 130

Configuration | Present | Partial | Missing | Total
--- | --- | --- | --- | ---
assistant-migration | 0 | 1 | 0 | 1
claude | 0 | 0 | 1 | 1
cloud | 0 | 0 | 1 | 1
company | 0 | 9 | 14 | 23
company-server | 0 | 1 | 0 | 1
desktop-automation | 0 | 0 | 1 | 1
distribution | 0 | 1 | 0 | 1
external-client | 0 | 1 | 0 | 1
mail | 0 | 2 | 0 | 2
messaging | 2 | 1 | 1 | 4
multi-team-server | 0 | 1 | 0 | 1
office | 0 | 0 | 1 | 1
own-agent | 0 | 1 | 0 | 1
regulated-company | 0 | 0 | 1 | 1
self-hosting | 0 | 1 | 0 | 1
slack | 0 | 1 | 0 | 1
team | 0 | 2 | 5 | 7
telegram | 0 | 1 | 0 | 1

Activation rows overlap; the distinct configuration total above counts each journey once.

## Source-present changes from the inventory

These are updated source classifications, not new executions or runtime qualification.

Journey | Proving test file | Exact test title | Required evidence
--- | --- | --- | ---
custom-agent-role | [packages/surfaces/app/e2e/agent-roles.electron.spec.ts](../packages/surfaces/app/e2e/agent-roles.electron.spec.ts) | a person saves, edits, restarts and reuses a custom agent role with its model and tool ceiling | installed
thread-search | [packages/surfaces/app/e2e/thread-search.electron.spec.ts](../packages/surfaces/app/e2e/thread-search.electron.spec.ts) | thread search: ranked words, every result, archived titles and channel conversations survive a cold start | installed
goal-token-budget | [packages/surfaces/app/e2e/goals.spec.ts](../packages/surfaces/app/e2e/goals.spec.ts) | a person sets a token budget, sees usage, and the goal stops before another turn | installed
goal-no-progress | [packages/platform/test/goal-runs.test.ts](../packages/platform/test/goal-runs.test.ts) | three unchanged work/check pairs stop for no progress before spending the remaining budget | test
goal-rubric-gates | [packages/surfaces/app/e2e/goals.spec.ts](../packages/surfaces/app/e2e/goals.spec.ts) | a person attaches a rubric and a premature MET waits for every criterion to pass | installed
cli-headless-json | [packages/surfaces/cli/test/exec.test.ts](../packages/surfaces/cli/test/exec.test.ts) | exec streams schema-valid JSON events and a final answer validated against the supplied schema | test
memory-trust-tier | [packages/platform/test/memory-trust.test.ts](../packages/platform/test/memory-trust.test.ts) | recalled memory distinguishes personal, imported and external words without making any instructions | test
memory-injection-scan | [packages/platform/test/memory-scan.test.ts](../packages/platform/test/memory-scan.test.ts) | the public memory command reports unsafe admission and keeps no line | test
os-sandbox | [packages/surfaces/app/e2e/pi-sandbox.electron.spec.ts](../packages/surfaces/app/e2e/pi-sandbox.electron.spec.ts) | Pi shell is confined to its workspace and OS-denied escapes are recorded as refused on macOS | installed
