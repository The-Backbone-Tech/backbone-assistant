# Export the audit record

For an operator shipping a data folder's committed activity to a company's audit archive or SIEM.
Allow about five minutes. You need the CLI, an existing Core data folder and its active owner or admin.
Examples use the installed `backbone` bin; in a checkout use
`node packages/surfaces/cli/src/main.ts` in its place.

The output is append-only JSON Lines, schema `backbone.audit.v1`, with one event per selected Core
ledger entry. The [line schema](../../schemas/audit-export.schema.json) describes the fields;
the [contract](../contracts/audit-export.md) lists sources, omissions, permissions and gaps.
By default there are no prompts, answers, document text, file names, document titles, connector
arguments or results. Each event lists omitted fields. This is independent of optional telemetry.

## Export and check a period

Use explicit RFC 3339 instants with a UTC offset. The interval includes since and excludes until.
The command reads through a running app or daemon's API line, beside ongoing work. A headless
data folder that nobody holds is read directly; a stopped embedded database is copied to a temporary
folder first, so the source data folder is never initialized, renewed, recovered or migrated. A data folder
whose keys the Keychain holds needs the app running. No command sends these files over a network.

```bash
backbone audit export /var/spool/company-audit/home-20261110.jsonl \
  --home "$BACKBONE_HOME" \
  --since 2026-11-10T00:00:00Z --until 2026-11-11T00:00:00Z
backbone audit verify /var/spool/company-audit/home-20261110.jsonl
```

Success says how many events were exported, then `Verified … events: internally whole`.
A file is created exclusively with mode 0600; an existing file is refused. The destination must
be outside the data folder. Leave out the destination, or use `-`, to write exact JSONL to stdout.
`--json` makes the file summary or verification result machine-readable; stdout export remains JSONL.
Offline verification needs neither a data folder nor database credentials.

The header names the data folder, period, tool version, snapshot head, scan boundary, content choice,
event count, transport and known caller. Direct export identifies the database person used by
the command; API-line export identifies only a same-user process and server user id. Each event names its data folder, stable id, sequence, actor, subject, keyed
Core receipt anchors, redacted data and previous line's SHA-256. The trailer has the digest of the
exact event lines and the last scanned sequence as its resume cursor. Keep header and trailer with the events for readback.
Dispatch-started means dispatch began; only a later observation reports succeeded, failed or unknown.

To deliberately export Core receipt statements, add `--include-content` on an idle plaintext-key data folder. This is refused over the app or daemon API line; person-confirmed content export there is not built. The header records
that choice and the exporting person's UUID. This adds receiptStatement, raw receipt and retained payload digests, and the Core's three unkeyed argument/proposal/intent digests. Raw commitments can confirm low-entropy guesses of omitted values. The statement may contain
sensitive work or credentials typed into the original statement. It adds no other work content.
The record cannot say that a call went out under a permission, nor when one was given
or ended. The Core lacks those structured receipts; this remains a stated gap. It cannot serve as a complete audit of the computer or every engine tool.

## Resume while work continues

Use the trailer's cursor id, never the last wall-clock event time. Core ledger sequence is commit
ordered: two writers cannot commit N+1 before N. An event can commit later with an earlier time.
One export is complete only through its scanThrough boundary (at most sourceHead); future commits can still fall within its period.
For continuing collection, keep a broad fixed period and partition by event.at downstream, or keep
polling the same day with its cursor until the relevant writers have finished. Moving to tomorrow
by timestamp alone can miss a late commit from today.

```bash
cursor=$(python3 -c 'import json,sys; from collections import deque; print(json.loads(deque(open(sys.argv[1],encoding="utf-8"),maxlen=1)[0])["cursor"]["id"])' \
  /var/spool/company-audit/home-20261110.jsonl)
backbone audit export /var/spool/company-audit/home-20261110-002.jsonl \
  --home "$BACKBONE_HOME" \
  --since 2026-11-10T00:00:00Z --until 2026-11-11T00:00:00Z --after "$cursor"
backbone audit verify /var/spool/company-audit/home-20261110-002.jsonl \
  --previous /var/spool/company-audit/home-20261110.jsonl
```

The second header's after anchor must match the first trailer's cursor, including the same keyed
Core receipt anchor (raw only with content opt-in). Its byte chain starts at its own header. Verification with `--previous` checks
that join, the data folder, period and content policy. A trailer cursor advances through all scanned
source rows, including rows outside the period; an empty export still carries its scan boundary.
Store a cursor only after the file is verified and durably accepted by the shipper. A retry may
repeat a file; deduplicate by event.id. The command keeps no cursor file or hidden progress in the data folder.

## Ship with an existing log shipper

For example, let a scheduled job produce files into a private staging directory beside the
shipper's watched spool. Verify before publishing a completed file to that spool:

```bash
set -euo pipefail
umask 077
staged=$(mktemp -d /var/spool/company-audit-staging/export.XXXXXX)
backbone audit export "$staged/record.jsonl" --home "$BACKBONE_HOME" \
  --since 2026-01-01T00:00:00Z --until 2027-01-01T00:00:00Z --after "$last_accepted_cursor" --limit 10000
backbone audit verify "$staged/record.jsonl"
# staging and spool are on the same filesystem; publish under a unique batch name.
mv "$staged/record.jsonl" "/var/spool/company-audit/$batch_id.jsonl"
rmdir "$staged"
```

For the first batch omit `--after`. Keep that broad period unchanged for later batches. The
scheduler supplies a unique batch_id and the last cursor accepted by your own shipper. Only
advance the period once collection is quiescent or retain the older period's collector for late commits.

Map these settings to your company's existing generic file/log shipper (this is a configuration
recipe, not a vendor-specific configuration or a new sender supplied by the CLI):

| Shipper setting | Worked value and behavior |
| --- | --- |
| Input | Watch `/var/spool/company-audit/*.jsonl`, read each completed file from the beginning |
| Framing | One UTF-8 JSON object per LF; preserve the original file bytes in the audit archive |
| Event routing | Index objects whose type is event; retain header and trailer in the archive |
| Identity | Use id as the deduplication key, homeId as the data folder dimension |
| Time | Use at as the event time; preserve sequence as a decimal string and order by its integer value |
| Delivery | Use the company's configured audit/SIEM destination, credentials and transport |
| Acknowledgment | Persist the file's trailer cursor only after durable acceptance; retry unacknowledged batches |
| Retention | Keep the original complete JSONL files and predecessor links under the company's retention policy |

Re-serialization changes the bytes and breaks the file hashes. Index parsed objects separately
from the original archive. On a verification failure, retain the source file for investigation
and do not advance its cursor.

Offline verification proves internal consistency relative to the supplied header and trailer.
It does not prove the database was not altered before export, that every action was recorded, or
that a remote effect landed. Stronger evidence requires timely ledger anchors and file digests
kept outside the data folder in independently controlled append-only storage, plus protected signing
keys and trusted timestamps. A party who can rewrite a whole file can recompute its hashes.

## Try safely in a disposable data folder

This runs a stub turn, uses the actual export and offline CLI verification, checks every line
against the JSON Schema, reads the events back, and removes the disposable data folder and output.
It uses a shared temporary test cluster, no account, model provider, outside message or shipper.

```bash test
node scripts/no-leftovers.mjs node scripts/with-test-cluster.mjs node packages/platform/examples/try-audit.mjs
```

The focused [day reader test](../../packages/platform/test/audit-day.test.ts) reconstructs every
effect lifecycle from the events and matches the Core's receipts one for one. It simulates 24 work
slots within one UTC day, with real Core commits and scripted outcomes, rather than waiting 24 hours.

The exporter streams pages of 64 events with no total period cap. Use --limit to bound the number
of source sequences scanned per batch, then resume the same period using the accepted trailer
cursor. Standalone snapshots need temporary space with at least 8 GiB remaining; links or
tablespaces require the live API line. One export runs on a holder at a time; the CLI announces a wait and retries the explicit slot refusal for up to three minutes. A session ends after at most two minutes whatever its page progress, or 60 seconds idle. Continuations belong to one connection; another same-user connection cannot extend them. A killed client releases its slot when its socket closes. Use --limit and accepted cursors for batches that finish within two minutes. No network
sender, cursor storage service or stronger external witness is installed by these commands.

The standalone copy cost is proportional to the database: the independent review observed
61.7 MB for a nearly empty data folder (1,489 files). Filesystem cloning may reduce physical copying,
but space for the copy must be available. The database's role verifiers are present in it until
cleanup; the vault, data key and data folder passwords are never copied. Its server has no TCP listener.

Stale copies are swept only at standalone-export startup (in that export's scratch root) and
once when an app or daemon API line starts (in the default root). They are never swept per line
export. If both owner and supervisor are killed, the copy and trust server remain until one of
those startups. A supervisor killed alone makes the owner stop its known server before removal.
To request the same attributable stale-copy cleanup manually from the checkout:

```bash
node --input-type=module -e "const m=await import('./packages/platform/src/composition/audit-temporary.ts'); await m.sweepAuditTemporary()"
```

Live-owner folders and servers whose identity cannot be proved are preserved. Investigate them;
do not delete a running server's database folder.

The default parent is /tmp/backbone-audit-<uid>, fixed per user and mode 0700. It is created if
absent; links, another owner's directory or any other mode are refused. /tmp may be RAM-backed.
To choose a disk with room, create a short private parent and pass it to the standalone command:

```bash
mkdir -m 700 /short/audit-scratch
backbone audit export day.jsonl --since 2026-11-10T00:00:00Z --until 2026-11-11T00:00:00Z --scratch-root /short/audit-scratch
```

The full socket path must fit 100 bytes; a longer root is refused before copying. This flag
never crosses the API line and has no effect when attaching to a holder. Startup of a holder
sweeps the default parent only. For an override, the manual sweep command above takes that
root as the argument to sweepAuditTemporary. The ACP read exclusion covers only the default
parent; if an override puts the copy elsewhere, exclude that directory from restricted-agent
reads as well. A same-user process outside that profile still has the user's filesystem rights.

A page write with no completion for 30 seconds fails the export. A stalled reader cannot keep
the standalone copy, its trust server or read-only transaction alive indefinitely. The command
exits non-zero; discard the partial file and resume from the last previously accepted cursor.
Default exports use keyed receipt anchors and keyed retained digests. --include-content exposes
raw ledger commitments as well as the receipt statements and opt-in fields; those commitments
allow offline guesses of other omitted values. Treat that output as sensitive content.


The audit key is dedicated to this format: HKDF-SHA-256 from the credential master, with a fixed
schema domain and data folder UUID. It stays in trusted memory and is never delivered to the auditor.
The header contains only its short keyed identifier. Line and direct exports of the same data folder
use the same key; a changed credential master changes that identifier and --previous reports
that both files verify alone but were digested under different keys. Rewrapping the same master
or rotating a database password does not change a master-derived chain.

Only a writable Host that already holds the data folder prepares the credential master. Doctor,
read-only Hosts, general Core opens, backup inspection, API-line clients and standalone export
do not. While no master exists, either export transport uses the labelled legacy-service-secret
fallback without creating one. The header gives its key kind and
identifier. The writable Host creates a missing master once, starting the master-derived key chain;
Files before and after that switch verify alone and --previous gives the changed-key message.
No audit-specific key file is stored. An auditor ties default events to raw Core receipts only with a raw --include-content
export. That requires an idle plaintext-key data folder today. For a data folder whose keys the app keeps,
there is no raw route yet: a future asked call must obtain the person's confirmation in the app.


The same value yields the same digest across events and files of one data folder, so a holder can see that two calls had the same description, can separate permissions that share the constant per-call note from permissions with their own note, and can count them; this is not a statement by the record and may change when the Core records the basis of a permission (another unit).
These comparisons concern the same field/purpose under an unchanged audit key. The published piece-file digest stays plain
on piece registrations and unregistrations, identifying registered engine code without adding
work text. Receipt commitments and other private digest values stay keyed.
