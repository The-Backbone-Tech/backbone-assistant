import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { expect } from 'vitest';
import type { Id, Target } from '../../target.ts';
import { digestOf, exists, ok, refusedBy, withHome } from './harness.ts';
import type { HomePort, Scratch } from './port.ts';

/**
 * The lessons of transition-lists §3 that the command line's lifecycle can show, each a function of
 * a lifecycle port, so the same case runs against the target, a correct stub and the stub with the
 * lesson's flaw (behaviour/lifecycle/stub.ts).
 */
export interface LifecycleLesson {
  readonly id: string;
  readonly lesson: number;
  readonly title: string;
  readonly flaw: 'L13-setup-by-count' | 'L17-default-profile';
  /** Set when the legacy repository does not keep the lesson: what it does instead. */
  readonly legacyDeviation?: string;
  run(port: HomePort): Promise<void>;
}

/** A Home with one workspace made by its operator, stopped. */
async function homeWithWorkspace(port: HomePort, s: Scratch, name: string) {
  const home = s.home(name);
  await port.provision(home);
  const made = await withHome(port, home, (t) =>
    t.operator.createWorkspace({
      name: `${name} ${randomUUID().slice(0, 6)}`,
      kind: 'team',
      ownerName: 'Ari',
      ownerEmail: 'ari@example.com',
    }),
  );
  return { home, ...made };
}

/** Whether this instance would set itself up again: the service's first-run crossing, from an empty session. */
async function setsUpAgain(t: Target): Promise<boolean> {
  return t
    .setWorkspace(null)
    .call('workspace.create_first', {
      name: 'A second first workspace',
      ownerName: 'Mallory',
      ownerEmail: 'mallory@example.com',
    })
    .then(
      () => true,
      () => false,
    );
}

/** How many entries of `type` the workspace's ledger holds, as its owner reads it. */
async function entries(t: Target, ws: Id, owner: Id, type: string): Promise<number> {
  const all = await t.setWorkspace(ws).asPrincipal(owner).observe<{ type: string }>('ledger');
  return all.filter((e) => e.type === type).length;
}

async function scratchFor(port: HomePort, label: string, body: (s: Scratch) => Promise<void>) {
  const s = await port.scratch(label);
  try {
    await body(s);
  } finally {
    await port.discard(s);
  }
}

export const LIFECYCLE_LESSONS: readonly LifecycleLesson[] = [
  {
    id: 'L13a',
    lesson: 13,
    title:
      '[O4][S21] an instance that imported a workspace does not set itself up again, nor import it twice',
    flaw: 'L13-setup-by-count',
    async run(port) {
      await scratchFor(port, 'lesson-13a', async (s) => {
        const source = await homeWithWorkspace(port, s, 'source');
        const file = s.file('workspace.export');
        const digest = digestOf(ok(await port.cli(s, ['export', file], { home: source.home }), 'export'));
        const target = s.home('target');
        ok(
          await port.cli(s, ['import', file, '--expect-sha256', digest], { home: target }),
          'the first import',
        );
        refusedBy(
          await port.cli(s, ['import', file, '--expect-sha256', digest], { home: target }),
          /empty|already|not new|exists|holds/i,
          'the second import',
        );
        await withHome(port, target, async (t) => {
          expect(await setsUpAgain(t), 'the imported instance offered its first-run setup again').toBe(false);
          expect(
            await entries(t, source.workspace, source.owner, 'workspace.imported'),
            'the import ran twice',
          ).toBe(1);
        });
      });
    },
  },
  {
    id: 'L13b',
    lesson: 13,
    title:
      '[O4][S21] a restored instance does not set itself up again, and a second restore into it is refused',
    flaw: 'L13-setup-by-count',
    async run(port) {
      await scratchFor(port, 'lesson-13b', async (s) => {
        const source = await homeWithWorkspace(port, s, 'source');
        const file = s.file('instance.backup');
        const digest = digestOf(ok(await port.cli(s, ['backup', file], { home: source.home }), 'backup'));
        const target = s.home('restored');
        ok(
          await port.cli(s, ['restore', file, '--expect-sha256', digest], { home: target }),
          'the first restore',
        );
        refusedBy(
          await port.cli(s, ['restore', file, '--expect-sha256', digest], { home: target }),
          /new|exist|already/i,
          'the second restore',
        );
        await withHome(port, target, async (t) => {
          expect(await setsUpAgain(t), 'the restored instance offered its first-run setup again').toBe(false);
          expect(
            await entries(t, source.workspace, source.owner, 'workspace.imported'),
            'the restore ran twice',
          ).toBe(1);
        });
      });
    },
  },
  {
    id: 'L17',
    lesson: 17,
    title: '[V5] a test run that names no Home never resolves, creates or migrates the default profile',
    flaw: 'L17-default-profile',
    legacyDeviation:
      'The legacy command line has no test-run guard: with BACKBONE_HOME unset it resolves $HOME/.backbone/default (here the scratch profile), and `backbone import` creates that instance there, initialises and migrates its database and restores into it.',
    async run(port) {
      await scratchFor(port, 'lesson-17', async (s) => {
        const source = await homeWithWorkspace(port, s, 'source');
        const file = s.file('workspace.export');
        const digest = digestOf(ok(await port.cli(s, ['export', file], { home: source.home }), 'export'));
        expect(await readdir(s.profile)).toEqual([]);
        const result = await port.cli(s, ['import', file, '--expect-sha256', digest], { home: null });
        expect(await readdir(s.profile), 'a test run wrote into the user profile').toEqual([]);
        expect(
          result.code,
          `a test run with no Home went ahead:\n${result.stdout}\n${result.stderr}`,
        ).not.toBe(0);
        expect(await exists(s.home('target'))).toBe(false);
      });
    },
  },
];

/**
 * Where each lesson that concerns the command line's lifecycle is kept by this area, and why the
 * ones without a case have none (for oracle/lessons/register.ts, which this area does not edit).
 */
export const LIFECYCLE_REGISTER: readonly { lesson: number; where: string }[] = [
  {
    lesson: 5,
    where:
      'No case: "an upgrade drains work in flight, parking it unknown" needs two builds of one target (the release a Home was made with, and the next) and work in flight between them. The oracle has one build per target; on this machine the legacy upgrade is the migration step inside start, whose only black-box form is a start with pending migrations, which a single checkout cannot produce without the migration history (SG-LIF-05).',
  },
  {
    lesson: 6,
    where:
      'No case here: a refused restore publishes no Home, so recovery order is observable only as "a refused restore creates nothing and sends nothing", which the recovery adverse cases assert. The ordering itself (sort, never send, compatibility last) belongs to the service start after a crash: the journey area (restart and kill) owns it (SG-LIF-06).',
  },
  {
    lesson: 13,
    where:
      'L13a (import) and L13b (restore): the instance does not set itself up again and does not take the same history twice, shown failing first on the stub flaw L13-setup-by-count. The erasure half stays with the portability oracle. The installation identity itself has no public surface (SG-LIF-04).',
  },
  {
    lesson: 17,
    where:
      'L17 (a test run naming no Home leaves the user profile untouched) is a known legacy deviation; the lifecycle harness guard (guard.test.ts) keeps the oracle itself off the default profile.',
  },
];
