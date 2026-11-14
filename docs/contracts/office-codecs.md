# office-codecs module (Documents port) contract (DRAFT 0)

**Owner:** module owner.

**Layer:** L2.

**Status:** have.

## Purpose

Read hostile spreadsheets, documents and decks within explicit limits. Write editable files through maintained libraries.

## Owns

Nothing durable.

## Provides

- `read.ts`, the bounded XLSX reader: its own ZIP parser plus `saxes`, refusing past 2 MiB input, 256 entries, 16 MiB inflated, 4,096 rows or a 64 KiB projection. Never truncates [docs/claim, audit-3].
- `native.ts` writers: wrappers over `exceljs` and `pptxgenjs`.
- DOCX through `docx` (web).

## Consumes

`office/src/schema.ts`, the shared schemas.

## Rules

- An explicit refusal at every limit, never silent truncation.
- Writers are replaceable.
- Advanced authoring is secondary and goes to maintained editors or existing apps (non-goal).

## Acceptance

- J-01 attachment path; R-BASE-01.
- **Adverse case:** a zip bomb or oversized sheet gets a named refusal and the thread continues.

## Exit test

Swap a writer library: the round-trip tests and J-01 stay green.

## Change procedure

Inside the module, with the licence check (ADR 0001).
