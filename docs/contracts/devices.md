# devices service contract: phone pairing and remote approval (DRAFT 0, slice 2)

**Owner:** service owner, to be assigned.

**Layer:** L1 service.

**Status:** thin. The old app has web pairing (`backbone-oss:packages/web/src/router.tsx` `PairingPage`).

## Purpose

Pair a phone to the person's computer and answer approval cards from it, as Codex, Claude, Threadlines and T3 do (`reference-baseline.md` §2.8).

## Owns

- paired devices;
- pairing codes;
- push subscriptions;
- revocations.

## Provides

- `pair` (QR code plus a short code shown on the computer);
- `revoke`, from either device;
- `push(event_class)`;
- `answer(decision_id, verdict)`, which goes through mandates-decisions.

## Consumes

- identity-tenancy;
- mandates-decisions;
- the passkey approval of R-GOV-IRREV-01.

## Rules

- An approval from the phone binds the exact content hash. A change to the content voids it.
- Approver and recovery changes are two-party, with a delay (lab S19).

## Acceptance

- R-UX-PHONE-01; J-ma's phone step.
- **Adverse case:** approving changed content is refused, and a revoked phone's answer is refused.

## Exit test

The push provider can be swapped, and paired devices and pending approvals survive.

## Change procedure

Inside the service. Approval semantics belong to mandates-decisions.
