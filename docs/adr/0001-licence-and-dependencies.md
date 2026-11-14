# ADR 0001: Licence and dependency policy

**Status:** accepted (carried over from backbone-oss ADR 0013), 23 Oct 2026.

**Decision.**
- Backbone is licensed under Apache-2.0.
- Shipped dependencies may use these licences: MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD, PostgreSQL, MPL-2.0 (unmodified), BlueOak-1.0.0, CC0-1.0, Unlicense or Python-2.0.
- AGPL, GPL, SSPL, BUSL, Elastic, FSL and proprietary components are not shipped. They may run only as separate services that the user installs.
- Fonts may use OFL-1.1.

**Enforced by:** `scripts/licences.mjs`, as part of `pnpm check`.

**Revisit when:** a component the radar prefers is outside this policy. That needs a new ADR.
