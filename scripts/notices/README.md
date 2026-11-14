# Retained licence sources

The build uses @quantco/pnpm-licenses 2.4.2 (MIT), with local inputs only.
The bundler records the package roots contributing to each emitted chunk and
asset. Copied pieces, entry shims, native loaders and PostgreSQL resources are
recorded from the staged files. SHA-256 binds each artifact and notice text to
the inventory. Packaging refuses an uncovered or changed file.

Some npm archives omit their upstream licence. `sources.json` records the exact
package version, retained source URL and text digest. Duplicate upstream texts
share a file. Package archives' licence and NOTICE files are retained in addition
to the generator's report. For archives with complete licence terms in README,
that publisher text is retained. Where neither is present but the publisher
identifies its author and licence, the generator supplies the SPDX terms with
that published attribution; the index records its resolution method. Missing
attribution is refused. A version update needs these sources reviewed again.

`native.json` pins GNU libiconv 1.18 and GNU gettext 0.26 (libintl), their
HTTPS archive URLs, SHA-256 digests and unmodified source status. The pins come
from the GNU release announcements for [libiconv](https://lists.gnu.org/archive/html/info-gnu/2024-12/msg00004.html)
and [gettext](https://lists.gnu.org/archive/html/info-gnu/2025-07/msg00007.html).
Run `node scripts/native-lgpl/build.mjs` on the target Mac. It verifies archive
hashes before extraction, verifies GNU signatures when GnuPG is available (and
records its absence otherwise), builds only shared-library targets with Xcode's
command-line tools, relocates Mach-O metadata and ad-hoc signs the two dylibs.
No source is patched. Ignored dist/native-lgpl retains downloads, sources and
an output build record with compiler, flags and resulting library digests.
A matching build returns without network or compilation; lipo and otool still inspect the files.
The recorded minimal environment excludes caller configure/make settings. Both
libraries contain arm64 and x86_64 slices with macOS 13.0 deployment targets,
read back from the binaries. Signature records include GnuPG key expiry.

The app uses available rebuilt output, rejecting invalid output; a local app
build without it retains the provider libraries. **The CLI bundles native
libraries and sets os/cpu restrictions only when BACKBONE_PUBLIC_DISTRIBUTION=1.**
An ordinary `pnpm test:install` always tests the portable npm-resolved variant,
regardless of the ignored cache. `BACKBONE_PUBLIC_DISTRIBUTION=1 pnpm test:install`
tests the public variant. Public mode requires rebuilt output in both packers.
Public packers and coverage require the current recipe hash, both pinned GNU
signature records marked verified, exact source pins, matching dylib digests,
and bytes different from the pinned provider originals. Staging also compares
against the files being replaced. These checks trust the local builder's record;
they are not a signed build attestation. Library architecture/deployment metadata
is checked against lipo/otool output, and PostgreSQL must need no missing slice.
Other libiconv/libintl-prefixed files are refused except links to the two rebuilt
files. The shipped record uses neutral work/staging paths; libraries are scanned for
absolute user paths too. libintl uses PostgreSQL's fixed default locale directory. Notices use that
staged record for source claims; source and version are unknown without it.
Run `node scripts/native-lgpl/smoke.mjs <native-folder>`
against staged or extracted payloads for disposable PostgreSQL initialisation,
encoding conversion, message-locale sessions and actual dylib-loading checks.
The provider's PostgreSQL imports no gettext functions and ships no message
catalogs; the smoke command also loads the packaged libintl dynamically and
checks a Spanish translation against its own disposable catalog. This last
check needs the Xcode compiler and lsof, not a PostgreSQL NLS rebuild.

App replacement files remain under Contents/Resources/postgres/native/lib,
outside app.asar. The CLI bundles them under
node_modules/@embedded-postgres/<platform>-<arch>/native/lib. Its shrinkwrap
preserves that bundle through npm installation, and a tarball containing these
libraries is restricted to the built OS and architecture. Generated notices
carry both replacement locations, exact source versions, archive URLs and
digests, and unmodified status. Keep the exact source archives available to
recipients; changing pins or the build recipe requires a fresh build and review.
Electron's installed distribution supplies its own LICENSE and complete
Chromium composite notice HTML; both ship as local reader resources.

The CLI packer uses npm to resolve its production graph in a disposable tree,
including optional packages for other targets with install scripts disabled.
It ships npm's shrinkwrap and inventories that exact resolution, refusing any
frozen identity without a notice, including locally omitted optional targets. The patched
Teams bundle is recreated separately; its frozen metadata matches its shipped
files, so npm cannot hoist an empty optional peer over a CLI dependency.
The install test checks npm's actual installed package identities and reads the
complete report with all network denied and an absent disposable data folder.

`prebundled.json` binds Pi's complete published bundle to a digest and retains
its embedded contributor names separately from npm dependency declarations.
The publisher's build strips legal comments. The extra contributor terms come
from the publisher's pinned lock and jiti's pinned build lock; changed bundle
bytes require review. Nested licence/NOTICE sidecars are retained too. The
opaque native payload has the same change-refusal property, including additions.

The app's installed journey checks the actual archive, unpacked pieces, emitted
chunks and native resources, then reads every notice through IPC. Composite HTML
has external resource elements and links removed, with a restrictive CSP and an
empty iframe sandbox. The spec is included in the installed suite; a development
run does not establish installed evidence.

Evidence for native component membership and payload hashes currently covers the
macOS distribution. Wrapper notices for the other frozen npm targets do not
establish their native component inventories; those targets need their own
payload review before claiming native-composite completeness there.

Public source copies omit contact email addresses from five retained upstream notices. Copyright holder names and licence terms remain; the inventory hashes identify these retained texts, whose source URLs identify their upstream originals.
