import type { Coverage } from '../coverage.ts';

const PROMOTION = 'knowledge: promotion happens only inside an independent approving answer';
const MEMORY = 'memory stays with its person';
const K = `knowledge.test.ts > ${PROMOTION}`;
const M = `knowledge.test.ts > ${MEMORY}`;
const oracle = (file: string, describe: string, it: string) =>
  `promotion/${file}.test.ts > ${describe} > ${it}`;

/**
 * Promise-specific refusal reasons the legacy adapter declares (adapters/legacy/refusals/promotion.ts):
 * `not_verbatim`, `self_evidence`, `system_records`, `not_member`.
 */
export const coverage: Coverage = {
  promise: 'promotion',
  legacyFiles: ['knowledge.test.ts', 'knowledge-retraction-authority.test.ts'],
  cases: {
    [`${K} > the approving answer promotes the candidate with exactly the terms that were approved`]: {
      status: 'ported',
      oracle: [
        oracle(
          'accepted',
          PROMOTION,
          '[S7] the approving answer promotes the candidate with exactly the terms that were approved',
        ),
      ],
      note: 'Also asserts that accepted knowledge is not rewritten in place afterwards, even by the workspace owner.',
    },
    [`${K} > the terms are part of what is approved: set once, and a different owner is a different proposal`]:
      {
        status: 'ported',
        oracle: [
          oracle(
            'promotion',
            PROMOTION,
            '[S14] the terms are part of what is approved: set once, and a different owner is a different proposal',
          ),
        ],
      },
    [`${K} > what is approved does not depend on the time zone of whoever asks or answers`]: {
      status: 'ported',
      oracle: [
        oracle(
          'time-zone',
          PROMOTION,
          '[S14] what is approved does not depend on the time zone of whoever asks or answers',
        ),
      ],
      note: 'The asker names its zone (pro.request_promotion_in_zone); the verifier answers in the installation zone, checked to differ.',
    },
    [`${K} > the maker cannot promote its own candidate, by any route`]: {
      status: 'narrowed',
      oracle: [
        oracle('promotion', PROMOTION, '[S7] the maker cannot promote its own candidate, by any route'),
      ],
      note: 'The legacy route of calling the private gov._promote directly is not stated (SG-PRO-01); the answer from the run, the answer as the maker and the direct table write are, and a person writing knowledge directly is added.',
    },
    [`${K} > evidence must be found verbatim in its source, and is checked when promotion is requested`]: {
      status: 'ported',
      oracle: [
        oracle(
          'promotion',
          PROMOTION,
          '[S7] evidence must be found verbatim in its source, and is checked when promotion is requested',
        ),
      ],
    },
    [`${K} > what an agent wrote, or what the proposer wrote, is not evidence`]: {
      status: 'ported',
      oracle: [
        oracle(
          'promotion',
          PROMOTION,
          '[S7] what an agent wrote, or what the proposer wrote, is not evidence',
        ),
      ],
    },
    [`${K} > what code printed in the sandbox is the agent’s own work: never evidence, whoever cites it`]: {
      status: 'ported',
      oracle: [
        oracle(
          'promotion',
          PROMOTION,
          '[S7] what code printed in the sandbox is the agent’s own work: never evidence, whoever cites it',
        ),
      ],
    },
    [`${K} > only the system principal records sources, outside any run`]: {
      status: 'ported',
      oracle: [
        oracle('promotion', PROMOTION, '[S6] only the system principal records sources, outside any run'),
      ],
      note: 'The system-principal-inside-a-run session is built by the composite pro.source_record_as_in_run: the oracle Session cannot name a principal and a run at once.',
    },
    [`${K} > a candidate is always proposed by the principal acting now, with no terms of its own`]: {
      status: 'ported',
      oracle: [
        oracle(
          'promotion',
          PROMOTION,
          '[S7] a candidate is always proposed by the principal acting now, with no terms of its own',
        ),
      ],
    },
    [`${K} > a rejection closes the candidate, and the same proposal is not asked again`]: {
      status: 'ported',
      oracle: [
        oracle(
          'rejection',
          PROMOTION,
          '[S14] a rejection closes the candidate, and the same proposal is not asked again',
        ),
      ],
    },
    [`${K} > knowledge is owned by a member of the workspace, and retracted only by its owner or an admin`]: {
      status: 'ported',
      oracle: [
        oracle(
          'retraction',
          PROMOTION,
          '[S7] knowledge is owned by a member of the workspace, and retracted only by its owner or an admin',
        ),
      ],
    },
    [`${M} > when a run acts, the database decides whose memory it may read — not the session settings`]: {
      status: 'ported',
      oracle: [
        oracle(
          'memory',
          MEMORY,
          'when a run acts, the database decides whose memory it may read — not the session settings',
        ),
      ],
      note: 'A session claiming a principal while presenting a run is built by the composite pro.memory_recall_claiming; run writes use pro.memory_write (no read-back).',
    },
    [`${M} > forgetting erases the content and cannot be undone; only the person forgets`]: {
      status: 'ported',
      oracle: [
        oracle(
          'memory',
          MEMORY,
          '[S12] forgetting erases the content and cannot be undone; only the person forgets',
        ),
      ],
    },
    'knowledge-retraction-authority.test.ts > knowledge correction holds fresh authority through commit > preserves exact active-owner correction after a guest downgrade or absent membership, without granting a nonowner the same right':
      {
        status: 'narrowed',
        oracle: [
          oracle(
            'retraction-authority',
            'knowledge correction holds fresh authority through commit',
            'the exact owner corrects its knowledge after a guest downgrade, without granting a downgraded nonowner the same right',
          ),
        ],
        note: 'The absent-membership half deletes membership rows with the administrator (SG-PRO-02); the nonowner is instead an admin downgraded to guest through the public role change. The guest-downgrade correction, the single retraction event and the refused duplicate are kept.',
      },
  },
  gaps: [
    {
      id: 'SG-PRO-01',
      kind: 'private-function',
      summary:
        'The legacy case shows the service cannot call the private promotion helper gov._promote; the oracle cannot name a private function.',
      needs:
        'Nothing beyond the published contract: promotion inside the approving answer is the only door, and the direct table write is already refused. A successor states its private helpers are unexecutable by the service role in its own catalog check.',
    },
    {
      id: 'SG-PRO-02',
      kind: 'administrative',
      summary:
        'An active principal without a membership row is reachable only by deleting the membership with the administrator; every public removal deprovisions the principal too.',
      needs:
        'Either a public crossing that ends membership while the principal stays active (if that state is meant to exist), or a contract that it cannot exist, in which case the half of the case is retired.',
    },
  ],
};
