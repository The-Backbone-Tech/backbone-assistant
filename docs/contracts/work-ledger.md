# work-ledger contract (DRAFT 0)

**Owner:** integrator (core).

**Layer:** L0.

**Status:** have. The event-sourced thread model is thin.

## Purpose

All work is durable and resumable. A hash-chained record holds who did what, under which authority.

## Owns

- threads, tasks, runs and steps;
- events and receipts;
- the per-workspace hash chain (`prev_hash`, `hash`).

## Provides

- append;
- project (feeding the projections service);
- claim, lease and fence;
- resume after a crash;
- `gov.verify_ledger`, `gov.ledger_head` and `gov.verify_ledger_anchor`.

## Consumes

- mandates-decisions;
- identity-tenancy.

## Rules

- Append-only. The ledger stores identifiers and keyed hashes, never content words.
- A lease is fenced. A stale holder's write is refused.
- Every surface reads projections, not ledger tables.

## Acceptance

- R-BASE-03 and R-BASE-04.
- Tests: the recovery suite T10 (kill at every stage).
- **Adverse case:** SIGKILL during a step. On restart, the run resumes or is marked interrupted, and no step is applied twice.

## Exit test

Not replaceable. An export verifies the chain, and an import re-verifies it (ADR 0017).

## Change procedure

Migration plus ADR. The receipt format is versioned.

## Oracle spec gaps the successor must close (P-04)

- **SG-CORE-02 (ledger part).** Creating a task, queueing a run, writing a run step and posting a message are **named crossings** in the successor, not table writes decided by RLS. Today 199 of 205 oracle cases use at least one such governed table write.
- **SG-LED-01.** Provide a published way to test-verify a ledger digest without revealing the per-workspace key: a crossing that tells an authorised principal whether given words match an entry's digest. The alternative is a contract that states the keyed-digest scheme, plus a test-key fixture.
- **SG-LED-02.** Provide an **operator-level view of queue membership** (or depth per workspace), so that "leaves the queue" can be observed separately from "is never claimed". The oracle currently narrows this to what `claim_next` hands out (several mandates and verification-queue cases).

Source: P-04 `oracle/RESULTS.md` on branch `claude/p04-core-oracle-2d71c1` at `15538047`, 23 Oct; cross-family review pending.

## Successor status of the spec gaps (S1-02, 24 Oct 2026)

- **SG-CORE-02 (ledger part): closed.** Tasks, runs, run steps and messages are written only through named crossings (`gov.create_task`, `gov.queue_run`, `gov.write_step`, `gov.post_message`, `gov.answer_in_conversation`); the service holds no write permission on any tenant store.
- **SG-LED-01: closed.** `gov.ledger_words_match(seq, field, words)` tells an owner or admin whether words match an entry's keyed digest, without revealing the workspace's key (kept in `ops.workspace_keys`).
- **SG-LED-02: closed.** `operator.queue_depth()`.
- **Chain.** Each entry's hash is SHA-256 over the previous hash and the entry's fields in canonical jsonb (`sec.ledger_hash`); `gov.ledger_head` gives the anchor to keep outside the database.
