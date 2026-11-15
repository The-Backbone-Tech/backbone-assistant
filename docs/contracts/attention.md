# attention service contract: inbox and notifications (DRAFT 0, slice 2)

**Owner:** service owner, to be assigned.

**Layer:** L1 service.

**Status:** new.

## Purpose

The "needs me" inbox and notifications. They tell the person what needs them, without becoming a separate page or a sort key (the [app contract](../../packages/surfaces/app/CONTRACT.md) owns the composition).

## Owns

- a per-thread attention state: needs-you, working, done;
- a status line per thread, written by a model;
- notification preferences per event class and channel.

## Provides

- the attention projection for the sidebar's attention mode;
- `notify(event_class, thread)`, where the event class is approval, question or finished, and the channel is push, email or banner.

## Consumes

- work-ledger (events);
- mandates-decisions (pending decisions);
- devices (push).

## Rules

- A status line is derived from the thread and carries no authority.
- A notification carries identifiers, never content or action links (lab S19, O2).

## Acceptance

- R-UX-INBOX-01; J-ma.
- **Adverse case:** a notification payload contains no content and no approve link.

## Exit test

The status-line model can be swapped, and the attention state is unchanged.

## Change procedure

Inside the service.
