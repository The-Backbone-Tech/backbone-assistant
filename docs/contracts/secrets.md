# secrets contract (DRAFT 0)

**Owner:** integrator (core).

**Layer:** L0.

**Status:** have.

## Purpose

Credentials stay sealed. Models and modules hold handles, never values.

## Owns

- sealed secrets (`app.secrets`);
- workspace keys;
- the master-key binding. The master key itself lives outside the database.

## Provides

- reference by handle;
- resolution only for the system principal at dispatch;
- rotation;
- revocation.

## Consumes

identity-tenancy.

## Rules

- Never exported (ADR 0017).
- Never in logs, fixtures or model requests.
- Canary tests run in CI.

## Acceptance

- R-GOV-SECRET-01 (threat T4).
- **Adverse case:** a canary secret is planted, and model and log output are scanned. Zero hits are allowed.

## Exit test

A maintained broker (for example OpenBao or 1Password Connect) may replace storage behind the same handle API, and must pass the canary suite.

## Change procedure

ADR 0011 amendment plus security review.
