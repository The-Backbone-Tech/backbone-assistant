# Run the automated merge queue

The queue replaces mechanical stacking. It defaults to one ready unit per gate;
explicit disjoint mode permits at most three units touching separate packages.
It never batch-bisects a failed candidate. The 11 November research recommends
serial qualification while first-pass reliability is low.

Use a clean driver checkout, distinct from the integration checkout. Fetch unit
branches first. Inclusion attests the author's light checks; it never grants a
security ACCEPT. Keep queue inputs, review bindings and evidence under .gate.
The one-repo unit owns the real execution record: this queue never creates it.

```json
{
  "qualifiedHead": "1111111111111111111111111111111111111111",
  "units": [{
    "name": "codex/example-unit",
    "head": "0123456789abcdef0123456789abcdef01234567",
    "session": "example-author-session",
    "authorFamily": "openai",
    "note": "Light checks and regeneration passed.",
    "review": ".gate/reviews/example.binding.json"
  }],
  "policy": {"mode": "serial"},
  "out": ".gate/merge-queue/example",
  "stackBranch": "claude/stack-queue-example",
  "runtime": {
    "integrationWorktree": "../integration-checkout",
    "maxLoad": 2,
    "nativeCollector": ["node", "<reviewed-collector>", "--root", "{root}", "--out", "{out}"],
    "restoredNative": ["node", "<reviewed-restored-native>", "--root", "{root}", "--out", "{out}"],
    "authorRelay": ["<session-relay>", "{session}", "{failure}"]
  }
}
```

The native proof drivers remain at their existing evidence owner. Configure their
reviewed argv; missing commands refuse before a gate. The relay receives the exact
session name, a durable failure JSON path and the same JSON on stdin. It must use
the maintained client for that named authoring session. A relay failure is an
unknown delivery: retain its envelope and reconcile, never blindly resend.
These are operator inputs, not product account or service settings. Use explicit
argv; do not configure a shell or sh -c for these commands.

qualifiedHead is the required exact SHA of the last qualified code commit, supplied
by the integrator from its gate evidence. The remote integration tip may have newer
documentation and is a separate value; the queue never guesses qualification from
Now, prose or a branch name. It inspects every commit above qualifiedHead before
building: only text Markdown with mode 100644 under docs/ and root GOAL.md,
README.md, AGENTS.md and CLAUDE.md is eligible, including docs/execution.md.
Markdown executed or graded by the oracle is excluded: everything under docs/how-to/,
docs/distributions.md (guide-steps) and docs/architecture.md (conformance).
Those changes need ordinary qualification. Binary blobs, executable modes, a code
change followed by a revert, non-Markdown files and nonlinear tails also refuse.
After a queue publication, the next qualifiedHead must be its published head,
not its testedSha: the publication merge already belongs to that base. The integrator
supplies this exact value; the queue does not discover or authenticate baseline
qualification receipts. Its own publication.json records head, testedSha,
qualifiedHead, codeUnchanged and the checked documentationPaths after comparing
the immutable Git commits, so the operator can inspect their relationship.

Inspect with `node scripts/merge-queue.mjs --dry-run <queue.json>`. It performs no
fetch, candidate creation, gate or push; it reports selection, committed snapshot
checks and review bindings. Run `node scripts/merge-queue.mjs <queue.json>` to
execute. It refreshes origin's integration ref and refuses moved unit heads.
An older branch base is reported by queue-check; the queue picks its own commit
range onto the new candidate and preserves a review only while its patch is bound.

## Candidate construction

The candidate starts at qualifiedHead in a disposable detached checkout. Each unit
is merge-base(unit head, remote integration tip)..unit head, cherry-picked there;
inherited remote documentation is excluded from the unit's own patch and review.
No merge commit imports another unit's
history. Nonlinear ranges need a mainline decision and return to the author.
Source commits need Agent trailers; queue-made commits use Agent: merge-queue
and also run the commit hook.

Only mechanical conflicts are joined: generated artifacts take theirs and are
regenerated; dependency maps merge three ways per dependency name and trigger a
non-frozen relock; installed-test regex alternatives union; import-only TypeScript
blocks merge three ways per source and local specifier (including side effects).
An unchanged side accepts the other side's deletion or version change; competing
changes or deletion against an edit return to the author. Generated README blocks and manifest fields preserve authored
content. Competing dependency versions, executable conflicts and other authored
conflicts return with their file list. The install is offline, then pnpm prune
removes stale dependencies, then `pnpm regen` reproduces generated output.

Journey entries join by id using their existing compact representation. Unchanged
text round-trips byte-exact. Clean cherry-picks retain Git's result byte for byte;
only unresolved journey conflicts use a three-way join per id. One-sided removals
remove entries and fields; removal against an edit needs judgement. Arrays without
ids are authored values: a one-sided replacement replaces the whole array, while
competing replacements conflict. Reorders in a conflicted id-array join return to
the author; clean picks retain the exact authored order. Changed legacy schema
fields need a person to align level with evidenceRequired and supportingTests
with provingTest. Current nested
provingTest.level remains valid. A fake-agent test never creates requiresInstalled.
Dropping requiresInstalled, lowering evidenceRequired or provingTest.level, removing
a proof, or narrowing a full proof to partial also needs judgement. A deliberate
journey retirement may remove the whole entry. Such judgement stops the queue and
returns the entries rather than weakening their guarantee. Clean picks compare the
result with integration, so unrelated earlier legacy edits are not blamed on a unit.

The candidate must already contain docs/execution.md and exactly one Integration
record section. Missing either refuses before installation or a gate. The queue
only appends one generated line to that section, preserving Now and prose bytes.

## Review bindings

A unit touching authority, secrets or effects requires a different model family's
ACCEPT. The explicit always-review list also covers everything under scripts/,
.github/ and deploy/, root .npmrc, pnpm-workspace.yaml and .pnpmfile.cjs, and every
root or workspace package.json. Whole manifests require review because test commands
can delegate through other script names, dependencies or loader configuration.
This includes the gate, graders, regeneration and install hooks, regardless of
security keywords in an individual diff. Security words add review requirements;
ordinary object/map keys do not. Key-related identifiers are narrowed to words such
as apiKey, privateKey, signingKey and secretKey (including underscore spellings).
The gate still runs the candidate's definition, so a unit changing that definition
must pass this review admission before any candidate command runs.

The binding is a small ignored JSON file named by review above. Other units may
omit review only if neither their paths nor their changed content is sensitive;
reviewedSha is then null and the record explicitly says not-required. This is a
review binding for security and oracle changes, not mandatory review of every unit.

```json
{
  "version": 1,
  "unit": "codex/example-unit",
  "authorSession": "example-author-session",
  "authorFamily": "openai",
  "review": {
    "verdict": "ACCEPT",
    "family": "anthropic",
    "session": "independent-review-session",
    "reviewedSha": "0123456789abcdef0123456789abcdef01234567",
    "base": "1111111111111111111111111111111111111111",
    "patchId": "2222222222222222222222222222222222222222",
    "coreDiffHash": "<reviewer-frozen raw Core diff SHA-256, only for a Core unit>",
    "artifact": {"path": ".gate/reviews/example.accept.json", "sha256": "<artifact bytes SHA-256>"}
  }
}
```

The artifact is regular ignored local evidence JSON repeating verdict, family,
session, reviewedSha, base, patchId and (for Core) coreDiffHash. Its bytes must
match the supplied hash.
The operator imports a real reviewer receipt; author notes cannot substitute for
it. The queue checks the review's original Git patch, not an asserted patch-id.
An exact reviewed head passes; a trivial rebase retains the binding only when the
unit's stable git patch-id is unchanged. Otherwise delta repeats the ACCEPT
receipt fields, names fromSha/fromPatchId and binds the current head/patchId.
A Core-touching unit additionally needs coreDiffHash equal to SHA-256 of the raw
live Git diff from integration base to unit head, scoped to packages/core and
packages/platform/src/composition/core.ts. This hash must come from the hashed
reviewer artifact, including a delta artifact; an unhashed top-level binding field
cannot attest it. A mismatch refuses stacking.

Receipts detect accidental mismatches and preserve what was attested. Reviewer
family and session are locally imported declarations; the queue does not authenticate
a remote reviewer or defend against a dishonest author fabricating that evidence.
The operator remains responsible for importing the real independent review.

## Qualification and failures

Before building, the queue samples free disk and one-minute load, checks active
gates, the heavy lock and its priority marker, and refuses doomed work in seconds.
The floor is 20 GiB; maxLoad defaults to 2 and is an explicit operator limit.
It never edits a driver while running: source fingerprints are rechecked at phase
boundaries. Existing lock functions reserve both slots so an old unit wrapper
cannot overlap qualification. Foreign controls remain untouched. A dead owner's
controls are reclaimed only from this queue's own matching receipt and dead PID,
with no running gate. A gate always uses its own candidate worktree.

Static checks run with BACKBONE_GUIDE_STEP=1 so guide-steps stays in the full gate.
Packaging, package metadata or lockfile changes also run `pnpm test:install`
before the gate. Qualification then runs the existing `pnpm gate` under the verified
lease, followed by native collector, restored-native proof, owned Colima start,
Docker smoke, Colima stop/delete, and `pnpm test:install`. Oracle output is restored
with Git afterward. Oracle exit 1 passes only when actual summary counts and
family lines show lifecycle and scenes as its only two unimplemented families.

Every failure records reviewed SHA, tested SHA, cause class, named author session,
log and action. Classes are integration, test-state/flake, environment and product
defect; unknown test failures remain investigation hypotheses, never load claims.
Disk/load observations precede attribution. Each failing file maps only to units
whose own diff touches it or statically proven code it drives. Computed or unresolved
imports prohibit automatic blame; suite/package membership alone never drops a unit.

There is at most one automatic retry per candidate, and only positive flake or
environment classification permits it. An unassigned failure retries only that
file and named test, inside the acquired heavy lease. Exactly one passing test
must be observed: zero matches cannot establish a flake. A passing isolated retry
uses the budget and still needs a fresh complete qualification; it never publishes
a partially failed gate. Assigned environment failures may retry the full gate once.
Product defects get no automatic retry, and only mapped units may be returned.
Every failure is delivered to its named session, including unassigned diagnostics.

On rerun the old evidence directory moves aside after admission proves it idle;
no gate evidence is overwritten. Successful candidate refs are pruned after local
synchronization. Failed candidates retain their source ref, tracked-tree patch and
status inventory for diagnosis, including pre-gate failures; untracked output bytes
are not included in the patch. A failed Git snapshot is recorded separately; the
original failure and its author notice remain authoritative. Remove the recorded
failed ref only after diagnosis.
Logs remain; the disposable
checkout, package builds, DMGs and owned Docker resources are cleaned up. Abrupt
termination may leave the recorded checkout for inspection and owned cleanup.

After success the generated record line names the tested parent, unit/review heads,
suites and counts, plus the native/Docker/install results. A record-only commit
follows the documentation join and passes static checks without guide-steps before
publication. Only known generated paths and the lockfile may be staged after regen;
unexpected install/build output refuses publication. Publication checks ancestry
and an exact remote-base lease. A verified porcelain lease rejection is recorded
as rejected-not-published and clears the pending intent. The queue refreshes an
eligible docs tail within the bounded publication loop below; if that budget is
exhausted, its status remains remote-moved.
The exact `--force-with-lease=<integration>:<base>` only detects concurrent updates: the preceding ancestor check permits only a fast-forward from the leased integration head, so it cannot rewrite history and stays within the AGENTS.md no-forced-push rule.
An uncertain push retains its pending receipt and cannot be blindly resent. After
confirmed publication the dedicated integration worktree and stack branch advance
under HEAD/index locks and a ref transaction. Dirty, switched or otherwise changed
local state is preserved; a confirmed remote with failed local synchronization
needs repair without another push.

Before that record commit, the queue reads the remote tip again, fetches a new tip
if needed and reinspects every intervening commit. A new code or oracle-input commit
refuses. From the verified remote tip it makes one ordinary no-ff merge of the exact
gated head; conflicts return to the integrator with no push. This keeps the remote
line as first parent and each original docs commit once, with no rebase copies or
ours strategy. All paths outside the eligible docs set must equal the gated tree.
The tested SHA and original remote ancestry both remain in the published history.

Publication has at most three attempts for a qualified candidate. If a pre-push
read or server lease proves that the remote moved without this attempt publishing,
the queue resets only its disposable checkout to testedSha, re-reads and rechecks
the tail, rejoins, regenerates the single record line and reruns static checks.
It reuses the same complete gate and native/Docker/install proof; it never gates
again for a harmless docs race. A newly ineligible tail stops the loop. Each attempt
has its own receipt/log directory, reviewed/tested SHAs and result; a known race is
classified as integration. An uncertain send or a confirmed publish needing local
repair never enters this loop and cannot be resent blindly. Within a serial run,
the published head is also the next qualified base.

## Standing rules and local proof

People or agents decide code conflicts, unresolved attribution and security review;
a person aligns ambiguous journey schemas. The queue changes neither Now nor
narrative status. No local fake-gate test promotes an app journey or installed claim.
No dependency was added: Git, Node, pnpm, existing Apache-2.0 queue/gate/locking
helpers and the already pinned MIT Babel parser supply the mechanism.

The deletion-preserving three-way contract replaces the old additive union tests:
one-sided removals and bumps are intentional, while competing edits still refuse.
No app journey status changes from these script-level proofs.

Run the disposable proof with temporary repositories and a local bare Git remote,
without an outside remote, real gate, account or Colima:

```bash test
node --test scripts/merge-queue.test.mjs scripts/merge-queue-mechanical.test.mjs scripts/merge-queue-policy.test.mjs scripts/merge-queue-runtime.test.mjs scripts/merge-queue-isolated.test.mjs
```
