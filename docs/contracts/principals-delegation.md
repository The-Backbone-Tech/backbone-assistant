# principals-delegation contract (DRAFT 0)

**Owner:** integrator (core).

**Layer:** L0.

**Status:** thin. Agents are not yet first-class principals.

## Purpose

An agent acts *for* a person, under a delegation that the person owns and can revoke. A permission is not authority: Buzz prior art.

## Owns

- agent principals;
- owner links;
- delegation edges;
- revocation records.

## Provides

- `acts_for(principal) → owner`;
- `owned_by`;
- `delegate(owner, agent, mandate)`;
- `revoke(delegation)`, which cascades to child mandates and leases.

## Consumes

- identity-tenancy;
- mandates-decisions (a delegation carries a mandate).

## Rules

- A delegation's mandate is no larger than the owner's.
- Revocation is immediate for new claims, and fences running leases.
- Each principal belongs to exactly one workspace.
- An agent principal can never answer its own owner's decisions about itself (I-4).

## Acceptance

- R-TEAM-01 and R-TEAM-02; journey J-team.
- **Adverse case:** revoke the delegation while the agent holds a lease. The next claim is refused; any in-flight dispatch reconciles to unknown outcome or done, and is never repeated.

## Exit test

Not replaceable. Migrate today's "app session" and run principals into the model and prove that existing mandates are unchanged (catalog plus db suite).

## Change procedure

New migration plus an ADR (expensive to reverse). Memo 04 proposes the shape.
