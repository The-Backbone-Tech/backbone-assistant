import { copyFile, stat } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { effect } from '../../core/harness.ts';
import { DEVIATIONS } from './coverage.ts';
import { type HeldWork, heldWork, IN_DOUBT, nothingSendable, states } from './fixtures.ts';
import {
  digestOf,
  exists,
  exportedHead,
  itKeeps,
  ok,
  refusedBy,
  sessionsIn,
  useHomes,
  withHome,
} from './harness.ts';
import type { CliResult, Scratch } from './port.ts';

const homes = useHomes('portable');

let s: Scratch;
let held: HeldWork;
let file: string;
let exported: CliResult;
let digest: string;
let imported: Promise<{ home: string; result: CliResult }> | undefined;

/** The archive imported once into a new instance, shared by the cases that look at it. */
function importOnce() {
  imported ??= (async () => {
    const home = s.home('imported');
    const result = await homes().cli(s, ['import', file, '--expect-sha256', digest], { home });
    return { home, result };
  })();
  return imported;
}

beforeAll(async () => {
  s = await homes().scratch('portable');
  const source = s.home('source');
  await homes().provision(source);
  held = await withHome(homes(), source, (t) => heldWork(t, 'Portable'));
  file = s.file('workspace.export');
  exported = ok(await homes().cli(s, ['export', file, '--workspace', held.ws], { home: source }), 'export');
  digest = digestOf(exported);
});

describe('export, then import into an empty instance', () => {
  it('[O4][S21] export writes an archive only its operator reads and prints its digest; importing it with that digest restores the workspace, whose history verifies', async () => {
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const head = exportedHead(exported);
    const { home, result } = await importOnce();
    ok(result, 'import');
    expect(result.stdout).toContain(held.ws);
    const verified = ok(await homes().cli(s, ['verify-ledger'], { home }), 'verify-ledger');
    expect(verified.stdout).toMatch(new RegExp(`${held.ws}.*OK`));
    await withHome(homes(), home, async (t) => {
      const { owner$ } = sessionsIn(t, held);
      expect(await owner$.call('ledger.verify')).toBeNull();
      expect(await owner$.call('ledger.verify_anchor', head)).toBe(true);
      const ledger = await owner$.observe<{ type: string; payload: Record<string, unknown> }>('ledger');
      const restores = ledger.filter((e) => e.type === 'workspace.imported');
      expect(restores).toHaveLength(1);
      expect(restores[0]?.payload).toMatchObject({ archive: digest, anchored: true });
    });
  });

  it('[S8][O4] an unknown outcome stays unknown through export and import; nothing held is sent again, and no authority comes back', async () => {
    const { home } = await importOnce();
    await withHome(homes(), home, async (t) => {
      const now = await states(t, held);
      expect(now).toMatchObject({
        unknown: 'unknown',
        inFlight: 'unknown',
        waiting: 'cancelled',
        run: 'cancelled',
      });
      expect(IN_DOUBT, 'the in-flight message was taken for done or queued again').toContain(
        now.internalInFlight,
      );
      await nothingSendable(t, held);
      expect(
        await t.setWorkspace(null).call('run.claim_next', { worker: 'oracle-worker', leaseMs: 30_000 }),
      ).toBeNull();
      const { owner$ } = sessionsIn(t, held);
      const [mandate] = await owner$.observe<{ revoked: boolean }>('mandate', { id: held.mandate });
      expect(mandate?.revoked, 'the stopped run’s authority came back on import').toBe(true);
      // Held, not lost: whoever answers for it can still settle it here.
      await sessionsIn(t, held).system$.call('effect.reconcile', {
        effect: held.unknown,
        outcome: 'succeeded',
        externalRef: 'crm://deal/D-1',
        observationHash: 'seen-in-crm',
        note: 'found by its idempotency key',
      });
      expect((await effect({ owner$ }, held.unknown)).status).toBe('succeeded');
    });
  });

  itKeeps(
    '[O4] an imported workspace’s routines do not fire on the new instance until a person resumes them',
    DEVIATIONS['import-routines'],
    async () => {
      const { home } = await importOnce();
      await withHome(homes(), home, async (t) => {
        expect((await states(t, held)).routine, 'the routine fires on the imported instance').not.toBe(
          'active',
        );
      });
    },
  );
});

describe('an archive that is not the one exported is refused, and no instance is created', () => {
  it('[S21] an archive with one byte changed is refused against the digest printed at export', async () => {
    const tampered = s.file('tampered.export');
    await copyFile(file, tampered);
    await homes().adversary.attack('file.flip_byte', { file: tampered });
    const home = s.home('tampered-home');
    refusedBy(
      await homes().cli(s, ['import', tampered, '--expect-sha256', digest], { home }),
      /sha-?256|not the archive/i,
    );
    expect(await exists(home)).toBe(false);
  });

  it('[S21] the right archive with a wrong digest is refused', async () => {
    const home = s.home('wrong-digest-home');
    refusedBy(
      await homes().cli(s, ['import', file, '--expect-sha256', 'a'.repeat(64)], { home }),
      /sha-?256|not the archive/i,
    );
    expect(await exists(home)).toBe(false);
  });

  it('[S10][S21] an archive whose rows were rewritten is refused even against the digest of the rewritten file', async () => {
    const forged = s.file('forged.export');
    const forgedDigest = await homes().adversary.attack<string>('export.rewrite_row', { file, to: forged });
    expect(forgedDigest).not.toBe(digest);
    const home = s.home('forged-home');
    refusedBy(
      await homes().cli(s, ['import', forged, '--expect-sha256', forgedDigest], { home }),
      /hash|changed|damaged|match/i,
    );
    expect(await exists(home)).toBe(false);
  });

  it('[S21] an archive is not restored without the digest unless the operator asks for it unverified', async () => {
    const home = s.home('no-digest-home');
    refusedBy(await homes().cli(s, ['import', file], { home }), /sha-?256|unverified/i);
    expect(await exists(home)).toBe(false);
  });
});
