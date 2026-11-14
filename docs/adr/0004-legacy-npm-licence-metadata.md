# ADR 0004: Accept complete legacy npm licence declarations

**Status:** accepted, 11 November 2026.

**Context.** The pinned Teams adapter brings in limiter 1.1.5 through
Microsoft Teams Apps 2.2.1 and jwks-rsa 4.1.0. limiter is a token-bucket rate
limiter used by the signing-key client. Its package metadata has no singular
`license` field. The previous checker reported that absence as `none`, although
the package declares MIT in the older `licenses` array. This is a metadata
compatibility exception, not permission to ship unlicensed code.

**Source checked.** On 11 November 2026 we inspected package.json and LICENSE.txt
from the installed limiter 1.1.5 package selected by the frozen lockfile and an
offline install. The [published version](https://www.npmjs.com/package/limiter/v/1.1.5)
identifies the artifact; its package metadata points to
[the upstream licence](https://github.com/jhurliman/node-rate-limiter/blob/master/LICENSE.txt).
The installed LICENSE.txt names John Hurliman, copyright 2011, and contains the
MIT grant, notice condition and warranty disclaimer. Its SHA-256 is
`a3aebd11ea5598ef12949bf793311bf155ab7727181e3d373bd0b47813d41111`.
The installed package.json also declares one legacy entry with type MIT and a
link to that licence. We verified the pinned artifact rather than relying on
the mutable upstream branch or treating an absent field as a licence.

**Decision.** Under [ADR 0001](0001-licence-and-dependencies.md), MIT is permitted.
The checker in `scripts/licences.mjs` accepts a nonempty, well-formed legacy
array only when a current declaration is absent and every legacy entry passes
the existing policy. Entries are combined as obligations, not alternatives.
A current declaration always takes precedence, even when prohibited or empty.
Missing, malformed or mixed prohibited legacy declarations still fail. There
is no package-name allowlist and no blanket acceptance of metadata `none`.
`scripts/licence-metadata.test.mjs` proves these properties with disposable
package metadata, including prohibited current and mixed legacy declarations.

**Consequences.** limiter 1.1.5 passes because its actual MIT declaration and
licence are present. Packaging must retain its copyright and licence notice.
This adds no dependency and changes no permitted licence. Revisit if the pinned
artifact changes, its declarations conflict with its licence text, or npm stops
supporting legacy declarations; do not infer the licence of another version
from this observation.
