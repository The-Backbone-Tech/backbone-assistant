import type { SpecGap } from '../../core/coverage.ts';

/**
 * The lifecycle area's inventory: every case, the lab properties it covers, the legacy tests it
 * restates through the command line (the yardstick: packages/cli/test and packages/db/test), and
 * the spec gaps that kept part of it from being black-box. `coverage.test.ts` fails when a case is
 * missing here or listed without a case.
 */
export interface LifecycleCase {
  /** Legacy tests whose promise this case restates, as `file > title`. */
  readonly yardstick: readonly string[];
  /** `restated`: the yardstick's promise through the command line; `new`: no legacy test states it. */
  readonly status: 'restated' | 'new';
  /** Gaps the case works around (see `gaps`). */
  readonly gaps?: readonly string[];
  readonly note?: string;
}

/** Known legacy deviations of the lifecycle cases, by key; each case using one runs as `it.fails` on legacy. */
export const DEVIATIONS: Readonly<Record<string, string>> = {
  'import-routines':
    'An import keeps an active routine active on the new instance and only prints that it will fire in both places unless the source is stopped; a restore from backup pauses it.',
};

const CLI = 'packages/cli/test';
const DB = 'packages/db/test';

export const coverage: {
  readonly area: string;
  readonly cases: Readonly<Record<string, LifecycleCase>>;
  readonly lessons: Readonly<Record<string, LifecycleCase>>;
  readonly gaps: readonly SpecGap[];
} = {
  area: 'the command line lifecycle',
  cases: {
    'portable.test.ts > export, then import into an empty instance > [O4][S21] export writes an archive only its operator reads and prints its digest; importing it with that digest restores the workspace, whose history verifies':
      {
        status: 'restated',
        yardstick: [
          `${CLI}/portability.test.ts > (the whole journey with the real backbone command)`,
          `${DB}/portability.test.ts > an import restores the workspace exactly, then proves it > works under the same policies: its people see their work, the ledger verifies and goes on`,
        ],
        gaps: ['SG-LIF-01', 'SG-LIF-02', 'SG-CORE-01'],
        note: 'Checks the file mode, the digest, the ledger anchor printed at export on the new instance, one anchored workspace.imported entry, and verify-ledger on the new Home.',
      },
    'portable.test.ts > export, then import into an empty instance > [S8][O4] an unknown outcome stays unknown through export and import; nothing held is sent again, and no authority comes back':
      {
        status: 'restated',
        yardstick: [
          `${DB}/restore-in-flight.test.ts > what was under way at export is stopped on the restored instance, never done a second time`,
        ],
        gaps: ['SG-LIF-02'],
        note: 'Held work made through crossings (an unknown, a lost acknowledgement, a waiting change, an internal change in flight); after the import none is claimable, the queue hands out none to send, the run’s mandate is revoked, and the unknown can still be reconciled. Channel replies and decisions of the yardstick are not in the fixture.',
      },
    'portable.test.ts > export, then import into an empty instance > [O4] an imported workspace’s routines do not fire on the new instance until a person resumes them':
      {
        status: 'new',
        yardstick: [],
        note: `Known legacy deviation: ${DEVIATIONS['import-routines']}`,
      },
    'portable.test.ts > an archive that is not the one exported is refused, and no instance is created > [S21] an archive with one byte changed is refused against the digest printed at export':
      {
        status: 'restated',
        yardstick: [
          `${DB}/portability.test.ts > an archive that is not what was exported is refused with the reason, and nothing is written > a file truncated, or the archive itself`,
        ],
      },
    'portable.test.ts > an archive that is not the one exported is refused, and no instance is created > [S21] the right archive with a wrong digest is refused':
      {
        status: 'restated',
        yardstick: [
          `${DB}/portability.test.ts > a restore needs the digest printed at export > a ledger rewritten with its chain, head and manifest recomputed is refused against the digest, and restores only unverified, flagged`,
        ],
      },
    'portable.test.ts > an archive that is not the one exported is refused, and no instance is created > [S10][S21] an archive whose rows were rewritten is refused even against the digest of the rewritten file':
      {
        status: 'restated',
        yardstick: [
          `${DB}/portability.test.ts > an archive that is not what was exported is refused with the reason, and nothing is written > a row changed`,
        ],
      },
    'portable.test.ts > an archive that is not the one exported is refused, and no instance is created > [S21] an archive is not restored without the digest unless the operator asks for it unverified':
      {
        status: 'restated',
        yardstick: [
          `${DB}/portability.test.ts > a restore needs the digest printed at export > refuses an archive it is given no way to prove`,
        ],
      },
    'ledger.test.ts > backbone verify-ledger > [S10] passes on a healthy instance, naming every workspace': {
      status: 'restated',
      yardstick: [
        `${CLI}/integration.test.ts > serves health, verifies the ledger, prints no secret, and stops cleanly`,
      ],
      gaps: ['SG-LIF-01', 'SG-CORE-01'],
    },
    'ledger.test.ts > backbone verify-ledger > [S10] fails, non-zero, naming the workspace and the entry, when an entry was rewritten below every grant':
      {
        status: 'new',
        yardstick: [],
        note: 'The tamper is the adversary port (a persisted payload rewrite with the append-only trigger disabled); the legacy CLI suite never runs verify-ledger on a tampered instance.',
      },
    'ledger.test.ts > backbone verify-ledger > [S10] refuses a Home with no instance, and creates none': {
      status: 'restated',
      yardstick: [
        `${CLI}/exit-code.test.ts > verify-ledger exits non-zero when there is no instance yet (no PostgreSQL boot needed)`,
      ],
    },
    'recovery.test.ts > backup of a stopped private instance, restored into a new Home > [O4][S21] the restored instance’s history verifies; its work stays stopped and its routines paused; the source is unchanged':
      {
        status: 'restated',
        yardstick: [
          `${CLI}/recovery-populated.test.ts > recovers a populated cold PostgreSQL instance with private work, held effects and no inherited host authority`,
        ],
        gaps: ['SG-LIF-01', 'SG-LIF-02', 'SG-CORE-01'],
        note: 'Narrower than the yardstick: private drafts, direct local roots, sealed channel credentials, consents and host-owner evidence are not in the fixture; the yardstick seeds its held effect with an administrator INSERT, here it is reached through crossings.',
      },
    'recovery.test.ts > backup of a stopped private instance, restored into a new Home > [S8][O1] an unknown outcome held at backup stays unknown after restore; a lost acknowledgement becomes unknown; nothing held is claimed or dispatched again':
      {
        status: 'restated',
        yardstick: [
          `${CLI}/recovery-populated.test.ts > recovers a populated cold PostgreSQL instance with private work, held effects and no inherited host authority`,
        ],
        gaps: ['SG-LIF-02'],
        note: 'Adds what the yardstick does not: an effect already unknown at backup, a waiting change, an internal change in flight, the cross-workspace queue, and reconciling after restore.',
      },
    'recovery.test.ts > a backup that is not the one written is refused, and no Home is created > [S21] a backup with one byte changed is refused against the digest printed at backup':
      {
        status: 'restated',
        yardstick: [
          `${CLI}/recovery-archive.test.ts > checks the separately retained digest and every private file hash`,
        ],
      },
    'recovery.test.ts > a backup that is not the one written is refused, and no Home is created > [S21] the right backup with a wrong digest is refused':
      {
        status: 'restated',
        yardstick: [
          `${CLI}/recovery-archive.test.ts > checks the separately retained digest and every private file hash`,
        ],
      },
    'recovery.test.ts > a backup that is not the one written is refused, and no Home is created > [S10][S21] a backup with a file rewritten is refused even against the digest of the rewritten file':
      {
        status: 'restated',
        yardstick: [
          `${CLI}/recovery-archive.test.ts > checks the separately retained digest and every private file hash`,
        ],
      },
    'guard.test.ts > the lifecycle harness never lets a run reach the default profile (lesson 17, for the oracle itself) > [V5] refuses the default profile, a Home or file outside the scratch, the scratch profile and a scratch it did not make; nothing reaches the target':
      {
        status: 'new',
        yardstick: [],
        note: 'A harness case: it runs on a spy port, not on a target.',
      },
  },
  lessons: {
    L13a: {
      status: 'restated',
      yardstick: [
        `${DB}/portability.test.ts > an import restores the workspace exactly, then proves it > refuses an instance that is not empty`,
        `${CLI}/portability.test.ts > (a second restore is refused)`,
      ],
      gaps: ['SG-LIF-04'],
    },
    L13b: {
      status: 'restated',
      yardstick: [
        `${CLI}/recovery-populated.test.ts > recovers a populated cold PostgreSQL instance with private work, held effects and no inherited host authority (restore into an existing Home refused)`,
      ],
      gaps: ['SG-LIF-04'],
    },
    L17: {
      status: 'new',
      yardstick: [],
      gaps: ['SG-LIF-07'],
      note: 'The legacy suite pins the opposite: packages/cli/test/home.test.ts expects instanceHome to fall back to $HOME/.backbone/default when BACKBONE_HOME is unset.',
    },
  },
  gaps: [
    {
      id: 'SG-LIF-01',
      kind: 'no-surface',
      summary:
        'No command creates an instance short of serving: `backbone start` makes the Home, its cluster and its master-key binding only while starting the whole service (with a model route). The adapter provisions a Home with the command line’s own first-run functions in process (loadOrCreateConfig, startCluster, bindVerifiedMasterKey).',
      needs: 'A command that creates a Home’s instance and stops (`backbone init`, or `start --no-serve`).',
    },
    {
      id: 'SG-LIF-02',
      kind: 'administrative',
      summary:
        'No command opens a stopped Home for work or reading short of serving it. Held work is made, and its states read after a restore, through the service role’s crossings on the Home’s database, which the adapter starts in process as verify-ledger and export start it. A workspace is created through the operator (SG-CORE-01).',
      needs:
        'The service’s HTTP API over a started instance with dispatch held (the journey area), or a maintenance start that serves the API and dispatches nothing.',
    },
    {
      id: 'SG-LIF-03',
      kind: 'no-surface',
      summary:
        'S10/S21 ask that a restore or import extend the last externally anchored head. The only anchor is the sha256 the operator keeps: an older valid backup or export, given its own digest, restores without notice, and nothing records or checks the last anchored head.',
      needs:
        'An anchor the restore checks (a head the operator passes, or an anchor registry), and a refusal or quarantine when the restored history does not extend it.',
    },
    {
      id: 'SG-LIF-04',
      kind: 'no-surface',
      summary:
        'An installation’s identity has no public surface (legacy keeps it in the Home’s task-material installation file). Lesson 13 is stated through its consequences: no second first-run setup, no second import or restore into the same instance, one imported entry.',
      needs:
        'An installation identity the operator can read (for example from `backbone status`), stable across restarts and new after a restore into another Home.',
    },
    {
      id: 'SG-LIF-05',
      kind: 'migration-history',
      summary:
        'Lesson 5 (an upgrade drains work in flight, parking it unknown) needs two builds of one target and work in flight between them; the oracle has one build, and the legacy upgrade on this machine is the migration step inside start.',
      needs:
        'Two published builds (a release and the next), or an upgrade command whose drain can be observed with pending schema changes.',
    },
    {
      id: 'SG-LIF-06',
      kind: 'no-surface',
      summary:
        'Lesson 6 (recovery sorts first, never sends, checks compatibility last): a refused restore publishes no Home, so its order is not observable beyond "a refused restore creates and sends nothing" (the adverse cases). The ordering belongs to the service start after a crash, which the journey area drives.',
      needs: 'A recovery report, or the journey area’s restart with an effect in flight.',
    },
    {
      id: 'SG-LIF-07',
      kind: 'no-surface',
      summary:
        'The legacy command line recognises no development or test run: the adapter marks every run with NODE_ENV=test, which the target ignores.',
      needs:
        'A named way for a run to say it is a development or test run (an environment variable or a build flag), which the command line honours.',
    },
  ],
};
