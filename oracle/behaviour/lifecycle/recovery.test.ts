import { copyFile, readdir, stat } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { effect } from '../../core/harness.ts';
import { HELD_AT_SOURCE, type HeldWork, heldWork, IN_DOUBT, nothingSendable, states } from './fixtures.ts';
import { digestOf, exists, ok, refusedBy, sessionsIn, useHomes, withHome } from './harness.ts';
import type { CliResult, Scratch } from './port.ts';

const homes = useHomes('recovery');

let s: Scratch;
let held: HeldWork;
let source: string;
let file: string;
let digest: string;
let restored: Promise<{ home: string; result: CliResult }> | undefined;

/** The backup restored once into a new Home, shared by the cases that look at it. */
function restoreOnce() {
  restored ??= (async () => {
    const home = s.home('restored');
    const result = await homes().cli(s, ['restore', file, '--expect-sha256', digest], { home });
    return { home, result };
  })();
  return restored;
}

/** Nothing was published beside the scratch's own entries: no Home, no half-written staging copy. */
async function nothingPublished(home: string, before: readonly string[]) {
  expect(await exists(home)).toBe(false);
  expect((await readdir(s.root)).filter((name) => !before.includes(name))).toEqual([]);
}

beforeAll(async () => {
  s = await homes().scratch('recovery');
  source = s.home('source');
  await homes().provision(source);
  held = await withHome(homes(), source, (t) => heldWork(t, 'Recovery'));
  file = s.file('instance.backup');
  digest = digestOf(ok(await homes().cli(s, ['backup', file], { home: source }), 'backup'));
});

describe('backup of a stopped private instance, restored into a new Home', () => {
  it('[O4][S21] the restored instance’s history verifies; its work stays stopped and its routines paused; the source is unchanged', async () => {
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const { home, result } = await restoreOnce();
    ok(result, 'restore');
    ok(await homes().cli(s, ['verify-ledger'], { home }), 'verify-ledger on the restored Home');
    await withHome(homes(), home, async (t) => {
      const { owner$ } = sessionsIn(t, held);
      expect(await owner$.call('ledger.verify')).toBeNull();
      expect(await states(t, held)).toMatchObject({ run: 'cancelled', routine: 'paused' });
      const [mandate] = await owner$.observe<{ revoked: boolean }>('mandate', { id: held.mandate });
      expect(mandate?.revoked, 'the stopped run’s authority came back on restore').toBe(true);
      expect(
        await t.setWorkspace(null).call('run.claim_next', { worker: 'oracle-worker', leaseMs: 30_000 }),
      ).toBeNull();
    });
    await withHome(homes(), source, async (t) => {
      expect(await states(t, held)).toEqual(HELD_AT_SOURCE);
    });
  });

  it('[S8][O1] an unknown outcome held at backup stays unknown after restore; a lost acknowledgement becomes unknown; nothing held is claimed or dispatched again', async () => {
    const { home, result } = await restoreOnce();
    ok(result, 'restore');
    await withHome(homes(), home, async (t) => {
      const now = await states(t, held);
      expect(now).toMatchObject({ unknown: 'unknown', inFlight: 'unknown', waiting: 'cancelled' });
      expect(IN_DOUBT, 'the in-flight message was taken for done or queued again').toContain(
        now.internalInFlight,
      );
      await nothingSendable(t, held);
      // Held, not lost: whoever answers for it can still settle it on the restored instance.
      const { owner$, system$ } = sessionsIn(t, held);
      await system$.call('effect.reconcile', {
        effect: held.inFlight,
        outcome: 'failed',
        externalRef: '',
        observationHash: 'absent-in-crm',
        note: 'not found by its idempotency key',
      });
      expect((await effect({ owner$ }, held.inFlight)).status).toBe('failed');
      expect((await effect({ owner$ }, held.unknown)).status).toBe('unknown');
    });
  });
});

describe('a backup that is not the one written is refused, and no Home is created', () => {
  it('[S21] a backup with one byte changed is refused against the digest printed at backup', async () => {
    const before = await readdir(s.root);
    const tampered = s.file('tampered.backup');
    await copyFile(file, tampered);
    await homes().adversary.attack('file.flip_byte', { file: tampered });
    const home = s.home('tampered-home');
    refusedBy(
      await homes().cli(s, ['restore', tampered, '--expect-sha256', digest], { home }),
      /sha-?256|differs/i,
    );
    await nothingPublished(home, [...before, 'tampered.backup']);
  });

  it('[S21] the right backup with a wrong digest is refused', async () => {
    const before = await readdir(s.root);
    const home = s.home('wrong-digest-home');
    refusedBy(
      await homes().cli(s, ['restore', file, '--expect-sha256', 'b'.repeat(64)], { home }),
      /sha-?256|differs/i,
    );
    await nothingPublished(home, before);
  });

  it('[S10][S21] a backup with a file rewritten is refused even against the digest of the rewritten file', async () => {
    const before = await readdir(s.root);
    const forged = s.file('forged.backup');
    const forgedDigest = await homes().adversary.attack<string>('backup.rewrite_file', { file, to: forged });
    expect(forgedDigest).not.toBe(digest);
    const home = s.home('forged-home');
    refusedBy(
      await homes().cli(s, ['restore', forged, '--expect-sha256', forgedDigest], { home }),
      /invalid|incomplete|refused/i,
    );
    await nothingPublished(home, [...before, 'forged.backup']);
  });
});
