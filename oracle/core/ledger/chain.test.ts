import { describe, expect, it } from 'vitest';
import { dispatch, newWorld, propose, refused, useTarget } from '../harness.ts';
import { ledgerOf } from './fixtures.ts';

const target = useTarget('ledger.chain');

describe('the ledger', () => {
  it('[S10] verifies from the first entry, and holds an effect’s proposal, dispatch and observation in order', async () => {
    const w = await newWorld(target(), 'LedgerOk');
    const id = await propose(w);
    await dispatch(w, id);
    expect(await w.owner$.call('ledger.verify')).toBeNull();
    const entries = await ledgerOf(w.owner$);
    // The record starts at the workspace's first act and only grows.
    expect(entries.length).toBeGreaterThan(3);
    const seqs = entries.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(entries.filter((e) => e.subject === id).map((e) => e.type)).toEqual([
      'effect.proposed',
      'effect.dispatched',
      'effect.observed',
    ]);
    // The effect's entries are the last ones: nothing is recorded out of order after them.
    expect(entries.slice(-3).every((e) => e.subject === id)).toBe(true);
  });

  it('[S10] is append-only for the service, which can neither change nor truncate it', async () => {
    const w = await newWorld(target(), 'LedgerGrants');
    const before = await ledgerOf(w.owner$);
    for (const crossing of ['led.ledger_rewrite', 'led.ledger_erase', 'led.ledger_forge']) {
      await refused(w.owner$.call(crossing), 'denied', crossing);
      await refused(w.worker$.call(crossing), 'denied', `${crossing} as a worker`);
    }
    // Nothing the attempts touched changed: same entries, same words, still verifying.
    expect(await ledgerOf(w.owner$)).toEqual(before);
    expect(await w.owner$.call('ledger.verify')).toBeNull();
  });

  it('[S10] detects a changed payload', async () => {
    const w = await newWorld(target(), 'TamperPayload');
    const [first] = await ledgerOf(w.owner$);
    const seen = await w.t.adversary.attack<{ bad: string | number | null }>('ledger.rewrite_payload', {
      workspace: w.ws,
    });
    expect(Number(seen.bad)).toBe(first?.seq);
    // The attack was rolled back: the public record verifies again.
    expect(await w.owner$.call('ledger.verify')).toBeNull();
  });

  it('[S10] detects a changed actor, even though the payload is untouched', async () => {
    const w = await newWorld(target(), 'TamperActor');
    const [first] = await ledgerOf(w.owner$);
    const seen = await w.t.adversary.attack<{ bad: string | number | null }>('ledger.rewrite_actor', {
      workspace: w.ws,
    });
    expect(Number(seen.bad)).toBe(first?.seq);
    expect(await w.owner$.call('ledger.verify')).toBeNull();
  });

  it('[S10] detects a rewritten entry whose hash was recomputed, at the entry after it', async () => {
    const w = await newWorld(target(), 'TamperRehash');
    const [, second] = await ledgerOf(w.owner$);
    const seen = await w.t.adversary.attack<{ bad: string | number | null }>('ledger.rewrite_and_rehash', {
      workspace: w.ws,
    });
    expect(Number(seen.bad)).toBe(second?.seq);
    expect(await w.owner$.call('ledger.verify')).toBeNull();
  });

  it('[S10] detects a truncated tail against a head kept outside the database', async () => {
    const w = await newWorld(target(), 'TamperTail');
    await dispatch(w, await propose(w));
    const anchor = await w.owner$.call<{ seq: number; hash: string }>('ledger.head');
    expect(anchor).not.toBeNull();
    const seen = await w.t.adversary.attack<{ internal: unknown; anchored: boolean }>(
      'ledger.truncate_tail',
      {
        workspace: w.ws,
        seq: anchor.seq,
        hash: anchor.hash,
      },
    );
    // After a careful truncation the chain is internally consistent; only the external anchor catches it.
    expect(seen.internal).toBeNull();
    expect(seen.anchored).toBe(false);
    expect(await w.owner$.call('ledger.verify_anchor', anchor)).toBe(true);
  });
});
