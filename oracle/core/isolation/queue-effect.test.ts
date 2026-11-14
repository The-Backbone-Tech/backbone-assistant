import { describe, expect, it } from 'vitest';
import type { Session } from '../../target.ts';
import { newWorld, propose, refused, useTarget, type World } from '../harness.ts';

// Its own installation: the cross-workspace effect queue holds only this case's work.
const target = useTarget('isolation.queue-effect');

const nonEmpty = (w: World): [string, Session][] => [
  ['a workspace and a principal', w.owner$],
  ['a workspace', w.worker$],
  ['a run', w.agent$],
  ['a principal alone', w.t.setWorkspace(null).asPrincipal(w.owner)],
];

describe('crossings that choose a workspace start from an empty session and leave none behind', () => {
  it('[S8] claiming the next effect refuses any session that names someone, and leaves the session empty after a claim', async () => {
    const w = await newWorld(target(), 'EmptyDispatch');
    const effect = await propose(w);
    for (const [label, session] of nonEmpty(w)) {
      await refused(session.call('iso.effect.claim_next_and_look', { worker: 'dispatcher-x' }), 'empty_session_only', label);
    }
    const seen = await target().setWorkspace(null).call('iso.effect.claim_next_and_look', { worker: 'dispatcher-x' });
    expect(seen).toEqual({
      claimed: [{ workspace: w.ws, effect, stale: false, system: w.system }],
      after: { workspace: '', principal: '', visible: 0 },
    });
  });
});
