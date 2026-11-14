# mandates-decisions contract (DRAFT 0)

**Owner:** integrator (core).

**Layer:** L0.

**Status:** have. Mode ceilings are new.

## Purpose

Authority only narrows. A question is asked once, at the real crossing, and answered by someone other than the asker.

## Owns

- mandates (set-specs, budgets, ceilings);
- child-thread mode ceilings [new];
- decisions and their answers.

## Provides

- `gov.issue_mandate`, where child = request ∩ parent;
- attenuate;
- revoke, which cascades;
- `gov.answer_decision` (released ABI retained; strict: `sec.decision_is_strict`, `sec.may_decide`);
- `gov.answer_decision_with_basis`, with the [Core permission life and checked basis](standing-signature-ledger.md);
- the kernel twin: `attenuate`, `isWithin`, `intersectBudget`.

## Consumes

- identity-tenancy;
- principals-delegation.

## Rules

- No path widens a mandate.
- A decision card counts once, for one person, and is void if the question changed (ADR 0023).
- The maker is never the checker, across the whole delegation tree.
- A pre-granted budget never lowers an effect's class (R-GOV-PAY-01).

## Acceptance

- R-GOV-MAND-01, R-GOV-MAKER-01 and R-CH-03.
- Tests: `kernel/test/mandate.test.ts` (property tests) and the db parity tests.
- **Adverse case:** a sub-agent asks for a wider scope. It is refused, with a named reason.

## Exit test

Not replaceable. The PolicyDecision port may swap the *evaluator*, but it must pass the kernel parity property tests.

## Change procedure

ADR plus cross-model review. The kernel and SQL change together, and the parity test must stay green.

## Oracle spec gaps the successor must close (P-04)

- **SG-MAN-01.** Either provide a crossing that opens a policy-settled question, so that the oracle can try to answer it, or **state that policy questions never exist as answerable rows**. Today the legacy case seeds one as the administrator.
- **Narrowed cases.** The cases for revocation leaving the run queue, the verification queue (take once, escalate once, workspace without a verifier) and a spent budget are observed only through what the queue hands out. Closing SG-LED-02, the queue view in the work-ledger contract, makes them direct.

Source: P-04 `oracle/RESULTS.md` on branch `claude/p04-core-oracle-2d71c1` at `15538047`, 23 Oct; cross-family review pending.

## Successor status of the spec gaps (S1-02, 24 Oct 2026)

- **SG-MAN-01: retired, 24 Oct 2026, by statement.** Policy questions never exist as answerable rows: a question's subject is an effect, a promotion or an elevation (`app.decisions.subject_kind`), and policy settles nothing by asking.
- **Narrowed queue cases: closed.** `operator.queue_depth()` shows, per workspace, how many runs, effects and verifier questions wait and how many are claimable (with SG-LED-02).
- **Locked intent (R-MAND-01): partial.** A mandate stores its intent and the hash approved at issue (`app.mandates.intent`, `intent_hash`). The rubric, capability handles, permission tokens and two-phase budget holds are not built yet.
