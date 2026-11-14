import { describe, expect, it } from 'vitest';
import { dispatch, effect, newWorld, propose, useTarget } from './harness.ts';

const target = useTarget('smoke');

describe('the adapter reaches a working installation', () => {
  it('a workspace, a run and a dispatched effect', async () => {
    const w = await newWorld(target(), 'Smoke');
    const id = await propose(w);
    expect((await effect(w, id)).status).toBe('allowed');
    await dispatch(w, id);
    expect((await effect(w, id)).status).toBe('succeeded');
    expect(await w.owner$.call('ledger.verify')).toBeNull();
  });
});
