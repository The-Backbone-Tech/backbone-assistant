import type { SpecGap } from '../../core/coverage.ts';

/**
 * The scene area's spec gaps. Every one of the legacy harness's 75 scenarios is restated
 * (inventory.test.ts checks the ids); these are the places where the port bends.
 */
export const coverage: { readonly gaps: readonly SpecGap[] } = {
  gaps: [
    {
      id: 'SG-SC-B-01',
      kind: 'no-surface',
      summary:
        'Three scenario runs (PS2, LD1, AP1) use a read-only observer to drive a later step — a document’s id, a note’s version, the open send question an app is told of — not only to judge a goal.',
      needs: 'Named product reads for these (a person’s own document list, a document’s version, their open questions), so a scenario needs no observer to act.',
    },
    {
      id: 'SG-SC-B-02',
      kind: 'no-surface',
      summary:
        'A scenario cannot record an observation of its own: the port’s direct-attempt log is written only by `attempt`, so SK2’s blocking findings and AP1’s answerable count are not kept (no assertion depends on them).',
      needs: 'A port method for a scenario to note what it saw, carried into the result.',
    },
  ],
};
