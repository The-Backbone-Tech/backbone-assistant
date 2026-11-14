import { describe, expect, it } from 'vitest';
import type { Session } from '../../target.ts';
import { newWorld, queueRun, refused, useTarget, type World } from '../harness.ts';

// Its own installation: the cross-workspace run queue holds only this case's work.
const target = useTarget('isolation.queue-run');

const nonEmpty = (w: World): [string, Session][] => [
  ['a workspace and a principal', w.owner$],
  ['a workspace', w.worker$],
  ['a run', w.agent$],
  ['a principal alone', w.t.setWorkspace(null).asPrincipal(w.owner)],
];

describe('crossings that choose a workspace start from an empty session and leave none behind', () => {
  it('[S1] claiming the next run refuses any session that names someone, and leaves the session empty after a claim', async () => {
    const w = await newWorld(target(), 'EmptyClaim');
    const { run } = await queueRun(w.owner$, w.owner, w.mandate, w.agent);
    for (const [label, session] of nonEmpty(w)) {
      await refused(session.call('iso.run.claim_next_and_look', { worker: 'worker-x' }), 'empty_session_only', label);
    }
    const seen = await target().setWorkspace(null).call('iso.run.claim_next_and_look', { worker: 'worker-x' });
    expect(seen).toEqual({ claimed: [{ workspace: w.ws, run }], after: { workspace: '', principal: '', visible: 0 } });
  });
});
