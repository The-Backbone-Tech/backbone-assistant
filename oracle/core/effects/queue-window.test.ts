import { describe, expect, it } from 'vitest';
import { effect, newWorld, propose, sleep, useTarget } from '../harness.ts';
import { takeNext } from './fixtures.ts';

// Takes work from the cross-workspace dispatch queue: this file's installation holds only this case's work.
const target = useTarget('effects.queue-window');

describe('the dispatch queue', () => {
  it('[S8] an effect inside its cancellation window is handed out only once the window ends', async () => {
    const t = target();
    const w = await newWorld(t, 'QueueWindow', { windowMs: 1_000 });
    const id = await propose(w, { operation: 'email.send' });
    expect((await effect(w, id)).status).toBe('allowed');
    expect(await takeNext(t)).toBeNull();
    await sleep(1_100);
    expect(await takeNext(t)).toMatchObject({ effect: id, stale: false });
  });
});
