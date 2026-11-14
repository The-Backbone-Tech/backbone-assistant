# Component radar: the format

A radar records, per capability, the leader and the challenger, why they hold those places, how fresh the evidence is, how we would leave, and what stays ours on top. This folder holds the **format** and its check. The dated entries are a distribution's choices and live in its repository (Backbone's are in `backbone-way:radar/README.md`); this repository has none.

The radar is consulted, not loaded: an agent reads the one entry it needs. Changing a leader is a crossing: it needs dated evidence, an updated `codeWeDelete` entry, and a person who signs.

## Fields

Every file uses `schema: backbone-radar/1`.

| Field | Meaning |
|---|---|
| `capability` | The file name without `.json`. |
| `family` | The capability family, as the distribution's acceptance doc names it, or a platform row (`plat-*`). |
| `acceptanceRow` | The row of the distribution's acceptance doc that the file serves. |
| `decision` | Who decided, and any condition on the decision (`status`: `decided` or `open`). |
| `leader` | The best choice this month, with exact pins (version and date). It is `null` when the evidence does not support naming one; see `candidates`. |
| `challenger` | The choice that would replace the leader, plus `switchIf` when the DR states its triggers. |
| `why` | A list of claims. Each claim has a `label`, its `sources` (ids into `sources`), and `checked`. `checked` is "P5 re-read 2026-10-23", "lane note, not re-opened by P5", or "freshness audit 2026-10-25" (a primary page re-read by the audit). A claim with no primary source carries "[unverified 25 Oct 2026]" in its text. |
| `label` | `source`: read in code, a registry or release metadata. `docs`: a vendor doc, changelog, blog or paper. `inference`: my judgement. |
| `evidenceDate` | The date of the newest evidence used. |
| `evidenceStrength` | `strong`, `moderate` or `weak`. It says how much the evidence supports the claims, not how good the product is. |
| `sources` | A list of `{id, url, date, what}`. The URL is a primary page, a registry or a local note. The date is the page's or release's own date where one exists, otherwise the date it was read. |
| `codeWeDelete` | Old code that this choice lets us leave behind, with line counts at a named commit. `basis` says when the removal comes from a different decision. |
| `ring` | `adopt`, `trial`, `assess`, `hold` or `caution`, using ThoughtWorks' rings. Decided rows keep their decided ring even when the evidence is weak; the weakness is stated in `evidenceStrength`. Undecided rows with weak evidence use `assess`. |
| `nextReview` | The next scheduled check, plus `reviewTriggers`, the events that should force an earlier one. |
| `revalidateBy` | The date after which no claim in the file may be relied on without a re-check. |
| `exit` | How we leave if something better appears. |
| `licence` | The SPDX licence of each named component and its verdict under [ADR 0001](../docs/adr/0001-licence-and-dependencies.md). |
| `backboneOwns` | What stays Backbone's own on top of the component. |
| `components` | Further decided or candidate pieces in the same family. Each has its own leader, challenger, ring and labelled `why`. |
| `references` | Products used as the best-in-class bar for behaviour and UX (not dependencies), with the pin and how each was seen. |
| `arena` | Measured results (task-set version, cost per success, pass^k, 95% interval, security failures), `null` until an arena runs; `plan` names what will fill them. |
| `openQuestions` | Questions only the owner of the choice can answer. |

## The check

`scripts/radar.mjs`, part of `pnpm check`, validates every `radar/*.json` in the repository it runs in against `schemas/radar.schema.json`, and also checks that:
- each file is named after its `capability`;
- each `ring` is one of the five values;
- every source id a claim cites, in `why` or in a component's `why`, is listed in `sources`.

A distribution may reuse the format check for its own dated entries. This repository does not need those entries for builds or tests.
