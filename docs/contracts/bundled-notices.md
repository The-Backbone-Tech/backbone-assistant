# Bundled notices

The installed desktop app exposes Settings → Licences and notices. The CLI
exposes `backbone notices` and `backbone notices --json`, without a data folder.
Both read resources generated at build time; neither resolves dependencies or
fetches attribution at runtime. A missing or changed resource is a failure,
never an empty successful report.

The platform's `packages/platform/src/notices.ts` reads the local index and
verifies the requested text digest. Callers supply their fixed product resource
location; entry selection accepts only an indexed identifier. The renderer
cannot supply a filesystem path. Main validates the existing trusted sender.
Composite HTML has external resources and navigation removed and is displayed
with a restrictive CSP in an iframe without script or parent access.
These reads do not create a Host, give permission or write to a data folder.

The build inventory covers emitted code and copied payloads, including fonts,
pieces, native loader dependencies and PostgreSQL. The CLI freezes npm resolution with its shipped shrinkwrap. The npm declarations feed
the same licence policy as `check-piece-licence`; full licence and NOTICE texts
ship with the product. The retained native composite terms expose pre-existing
licensing limits, described in [retained sources](../../scripts/notices/README.md).
A notice report does not certify that a binary distribution satisfies policy.

`read-notices` in the journey catalogue requires the installed app proving spec,
with CLI installation and output-coverage tests as supporting evidence. The gate
must execute that spec against its freshly packaged product before it is green.
