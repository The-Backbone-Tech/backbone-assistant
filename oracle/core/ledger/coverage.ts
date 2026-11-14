import type { Coverage } from '../coverage.ts';

const chain = (name: string) => `ledger/chain.test.ts > the ledger > ${name}`;
const words = (name: string) =>
  `ledger/words.test.ts > the ledger every member reads holds identifiers and hashes, never words > ${name}`;
const runs = (name: string) => `ledger/runs.test.ts > runs: leases and fencing > ${name}`;
const queue = (file: string, name: string) => `ledger/${file}.test.ts > the cross-workspace queue > ${name}`;
const OWN_FILE =
  'Its own oracle file (a fresh installation holding only its runs) replaces the legacy administrator step that empties ops.run_queue.';

export const coverage: Coverage = {
  promise: 'ledger',
  legacyFiles: ['ledger.test.ts', 'runs.test.ts'],
  cases: {
    'ledger.test.ts > the ledger > verifies from the first entry': {
      status: 'narrowed',
      oracle: [
        chain(
          '[S10] verifies from the first entry, and holds an effect’s proposal, dispatch and observation in order',
        ),
      ],
      note: 'The exact legacy list of entry types (workspace.created, workspace.policy_changed, agent.created ×2, mandate.issued, …) is legacy-specific and left out; the oracle asserts verification from the first entry, a strictly increasing sequence, and the effect’s proposed/dispatched/observed entries last and in order.',
    },
    'ledger.test.ts > the ledger > is append-only for the service, which can neither change nor truncate it':
      {
        status: 'ported',
        oracle: [chain('[S10] is append-only for the service, which can neither change nor truncate it')],
        note: 'The service’s UPDATE/DELETE/INSERT on the ledger are governed-write attempts, refused; the record is observed unchanged and still verifying.',
      },
    'ledger.test.ts > the ledger > detects a changed payload': {
      status: 'adversary',
      oracle: [chain('[S10] detects a changed payload')],
    },
    'ledger.test.ts > the ledger > detects a changed actor, even though the payload is untouched': {
      status: 'adversary',
      oracle: [chain('[S10] detects a changed actor, even though the payload is untouched')],
    },
    'ledger.test.ts > the ledger > detects a rewritten entry whose hash was recomputed, at the entry after it':
      {
        status: 'adversary',
        oracle: [chain('[S10] detects a rewritten entry whose hash was recomputed, at the entry after it')],
      },
    'ledger.test.ts > the ledger > detects a truncated tail against a head kept outside the database': {
      status: 'adversary',
      oracle: [chain('[S10] detects a truncated tail against a head kept outside the database')],
    },
    'ledger.test.ts > the ledger every member reads holds identifiers and hashes, never words > a verifier’s note, and every reason, note, description and topic someone wrote, are there by their hash only':
      {
        status: 'narrowed',
        gap: 'SG-LED-01',
        oracle: [
          words(
            '[O2] a verifier’s note, and every reason, note, description and topic someone wrote, are there by their hash only',
          ),
          words(
            '[O2] the same words are hashed differently in another workspace: the digest is keyed per workspace',
          ),
        ],
        note: 'Left out: recomputing each keyed hash and finding it in the ledger (it needs the workspace key from ops.fingerprint_keys, SG-LED-01). Kept: the words and their plain sha256 are absent from what a member reads, each act has a digest-bearing entry, the ledger verifies, and the same words hash differently in another workspace.',
      },
    'ledger.test.ts > the ledger every member reads holds identifiers and hashes, never words > names a person’s own connection by its id: never its slug, nor the tool called through it; a workspace connection as before':
      {
        status: 'narrowed',
        gap: 'SG-LED-01',
        oracle: [
          words(
            '[O2] names a person’s own connection by its id: never its slug, nor the tool called through it; a workspace connection as before',
          ),
        ],
        note: 'Left out: the tool hash equals the keyed hash recomputed with the workspace key (SG-LED-01). Kept: one 64-hex tool hash across the proposed/dispatched/observed entries, not the plain sha256 of the tool name, and a different one for the same tool in another workspace.',
      },

    'runs.test.ts > runs: leases and fencing > a run held under a valid lease cannot be claimed by another worker':
      {
        status: 'ported',
        oracle: [runs('[O1] a run held under a valid lease cannot be claimed by another worker')],
      },
    'runs.test.ts > runs: leases and fencing > after the lease expires, a new worker takes over and the old one can no longer act':
      {
        status: 'ported',
        oracle: [
          runs('[O1] after the lease expires, a new worker takes over and the old one can no longer act'),
        ],
      },
    'runs.test.ts > runs: leases and fencing > a step left pending by an earlier holder is completed by the current holder; the stale secret cannot':
      {
        status: 'ported',
        oracle: [
          runs(
            '[O1] a step left pending by an earlier holder is completed by the current holder; the stale secret cannot',
          ),
        ],
      },
    'runs.test.ts > runs: leases and fencing > a run cannot act under a mandate held by another agent': {
      status: 'ported',
      oracle: [runs('[S4] a run cannot act under a mandate held by another agent')],
    },
    'runs.test.ts > runs: leases and fencing > the service queues runs but never writes their state': {
      status: 'ported',
      oracle: [runs('[O1] the service queues runs but never writes their state')],
    },
    'runs.test.ts > the cross-workspace queue > concurrent workers never claim the same run, and each claim’s secret acts as its run':
      {
        status: 'ported',
        oracle: [
          queue(
            'queue-concurrent',
            '[O1] concurrent workers never claim the same run, and each claim’s secret acts as its run',
          ),
        ],
        note: OWN_FILE,
      },
    'runs.test.ts > the cross-workspace queue > a parked run is not claimable until the decision it waits for wakes it':
      {
        status: 'ported',
        oracle: [
          queue(
            'queue-parked-answer',
            '[O1] a parked run is not claimable until the decision it waits for wakes it',
          ),
        ],
        note: OWN_FILE,
      },
    'runs.test.ts > the cross-workspace queue > a parked run wakes when the change it waits for is cancelled, as it does for an answer':
      {
        status: 'ported',
        oracle: [
          queue(
            'queue-parked-cancel',
            '[O1] a parked run wakes when the change it waits for is cancelled, as it does for an answer',
          ),
        ],
        note: OWN_FILE,
      },
    'runs.test.ts > the cross-workspace queue > a queued run whose mandate was revoked is cancelled and leaves the queue':
      {
        status: 'narrowed',
        gap: 'SG-LED-02',
        oracle: [
          queue(
            'queue-revoked',
            '[S5] a queued run whose mandate was revoked is cancelled and leaves the queue',
          ),
        ],
        note: `Left out: reading ops.run_queue with the administrator to see the row gone (SG-LED-02). Kept: the queue never hands the run out, a claim by name is refused, and the run reads cancelled. ${OWN_FILE}`,
      },
  },
  gaps: [
    {
      id: 'SG-LED-01',
      kind: 'administrative',
      summary:
        'The ledger’s word digests are keyed with a per-workspace key only the installer reads (ops.fingerprint_keys); a case cannot recompute the digest of known words to find it in the record.',
      needs:
        'A published way to test-verify a digest without revealing the key (e.g. a crossing that answers whether given words match a ledger entry’s digest, for an authorised principal), or a contract stating the keyed-digest scheme and a test-key fixture.',
    },
    {
      id: 'SG-LED-02',
      kind: 'no-surface',
      summary:
        'The cross-workspace run queue has no view; whether a cancelled run’s queue entry is gone is visible only to the administrator.',
      needs:
        'An operator-level view of queue membership (or depth per workspace) so “leaves the queue” is observable apart from “is never claimed”.',
    },
  ],
};
