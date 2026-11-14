import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Actor, Refusal, type Session, type Target } from '../../target.ts';
import type { CliResult, HomePort } from './port.ts';

/**
 * A deliberately small lifecycle target for the lifecycle lessons: Homes are directories holding one
 * JSON file, archives are JSON files, and the "command line" is a function. With no flaw it keeps
 * each lesson; with one flaw it makes exactly the mistake the lesson records.
 */
export type LifecycleFlaw =
  /** Whether an instance is set up (or empty enough to import into) is read from a count of signed-in people, which an import or restore does not carry. */
  | 'L13-setup-by-count'
  /** A run that names no Home falls back to the user profile's default Home and acts on it. */
  | 'L17-default-profile';

interface Person {
  id: string;
  account: boolean;
}
interface Workspace {
  id: string;
  name: string;
  owner: string;
  system: string;
  people: Person[];
  ledger: { seq: number; type: string; payload: Record<string, unknown> }[];
}
interface Instance {
  workspaces: Workspace[];
  /** Signed-in sessions: never carried by an archive, dropped by a restore. */
  sessions: number;
}

const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const statePath = (home: string) => join(home, 'instance.json');

async function load(home: string): Promise<Instance | null> {
  try {
    return JSON.parse(await readFile(statePath(home), 'utf8')) as Instance;
  } catch {
    return null;
  }
}
async function save(home: string, instance: Instance) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  await writeFile(statePath(home), JSON.stringify(instance), { mode: 0o600 });
}
const absent = (path: string) =>
  stat(path).then(
    () => false,
    () => true,
  );

export function openLifecycleStub(flaw: LifecycleFlaw | null = null): HomePort {
  const setUp = (i: Instance) => (flaw === 'L13-setup-by-count' ? i.sessions > 0 : i.workspaces.length > 0);
  const result = (code: number, stdout: string, stderr = ''): CliResult => ({ code, stdout, stderr });

  function append(w: Workspace, type: string, payload: Record<string, unknown> = {}) {
    w.ledger.push({ seq: w.ledger.length + 1, type, payload });
  }

  async function command(args: readonly string[], home: string): Promise<CliResult> {
    const [verb, file, flag, hex] = args;
    if (verb === 'export' && file) {
      const i = await load(home);
      const w = i?.workspaces[0];
      if (!w) return result(1, '', 'refused: nothing to export');
      // An export leaves passwords and sessions out.
      const bytes = JSON.stringify({
        kind: 'export',
        workspace: { ...w, people: w.people.map((p) => ({ ...p, account: false })) },
      });
      await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
      return result(0, `exported ${w.id}\n  sha256: ${digest(bytes)}\n`);
    }
    if (verb === 'backup' && file) {
      const i = await load(home);
      if (!i) return result(1, '', 'refused: no instance');
      const bytes = JSON.stringify({ kind: 'backup', instance: i });
      await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
      return result(0, `backup written\n  sha256: ${digest(bytes)}\n`);
    }
    if ((verb === 'import' || verb === 'restore') && file && flag === '--expect-sha256' && hex) {
      const bytes = await readFile(file);
      if (digest(bytes) !== hex) return result(1, '', 'refused: the sha256 differs from the one printed');
      const archive = JSON.parse(bytes.toString('utf8')) as { workspace?: Workspace; instance?: Instance };
      if (verb === 'restore') {
        if (!(await absent(home))) return result(1, '', 'refused: recovery requires a new, nonexistent Home');
        const restored: Instance = { ...(archive.instance as Instance), sessions: 0 };
        for (const w of restored.workspaces) append(w, 'workspace.imported', { archive: hex });
        await save(home, restored);
        return result(0, 'recovered\n');
      }
      const i = (await load(home)) ?? { workspaces: [], sessions: 0 };
      if (setUp(i)) return result(1, '', 'refused: the instance is not empty');
      const w = archive.workspace as Workspace;
      append(w, 'workspace.imported', { archive: hex });
      i.workspaces.push(w);
      await save(home, i);
      return result(0, `restored ${w.id}\n`);
    }
    return result(2, '', `usage: ${args.join(' ')}`);
  }

  function target(home: string, i: Instance): Target {
    const session = (actor: Actor): Session => ({
      actor,
      asPrincipal: (principal) =>
        session(actor.workspace ? { workspace: actor.workspace, principal } : { principal }),
      asRun: (id, secret) => session({ ...actor, run: { id, secret } }),
      async call<T>(name: string, args: Record<string, unknown> = {}) {
        if (name !== 'workspace.create_first') throw new Error(`the lifecycle stub has no crossing ${name}`);
        if (actor.workspace || actor.principal)
          throw new Refusal('empty_session_only', 'from an empty session', name);
        if (setUp(i)) throw new Refusal('role', 'the installation is set up', name);
        const owner = randomUUID();
        const w: Workspace = {
          id: randomUUID(),
          name: String(args.name),
          owner,
          system: randomUUID(),
          people: [{ id: owner, account: true }],
          ledger: [],
        };
        append(w, 'workspace.created');
        i.workspaces.push(w);
        i.sessions += 1;
        return [{ workspace: w.id, owner, system: w.system }] as T;
      },
      async observe<T>(name: string) {
        if (name !== 'ledger') throw new Error(`the lifecycle stub has no view ${name}`);
        const w = i.workspaces.find((x) => x.id === actor.workspace);
        if (!w?.people.some((p) => p.id === actor.principal)) return [];
        return w.ledger as T[];
      },
      hold() {
        throw new Error('the lifecycle stub holds no transactions');
      },
    });
    return {
      name: 'lifecycle-stub',
      setWorkspace: (ws) => session(ws ? { workspace: ws } : {}),
      operator: {
        async createWorkspace({ name }) {
          const owner = randomUUID();
          const w: Workspace = {
            id: randomUUID(),
            name,
            owner,
            system: randomUUID(),
            people: [{ id: owner, account: true }],
            ledger: [],
          };
          append(w, 'workspace.created');
          i.workspaces.push(w);
          // Its owner signs in, as a first owner does.
          i.sessions += 1;
          return { workspace: w.id, owner, system: w.system };
        },
      },
      adversary: {
        attack() {
          throw new Error('the lifecycle stub has no attacks');
        },
      },
      race() {
        throw new Error('the lifecycle stub runs no races');
      },
      drainUsage: () => [],
      close: () => save(home, i),
    };
  }

  return {
    async scratch(label) {
      const root = await realpath(await mkdtemp(join(tmpdir(), `bb-oracle-stub-${label}-`)));
      const profile = join(root, 'profile');
      await mkdir(profile, { mode: 0o700 });
      return { root, profile, home: (n) => join(root, n), file: (n) => join(root, n) };
    },
    async discard(scratch) {
      await rm(scratch.root, { recursive: true, force: true });
    },
    async cli(scratch, args, options) {
      if (options.home !== null) return command(args, options.home);
      if (flaw === 'L17-default-profile') return command(args, join(scratch.profile, '.backbone', 'default'));
      return result(
        2,
        '',
        'refused: a test run names its Home (BACKBONE_HOME); the default profile is never used',
      );
    },
    async provision(home) {
      if (!(await absent(home))) throw new Error(`${home} exists`);
      await save(home, { workspaces: [], sessions: 0 });
    },
    async open(home) {
      const i = await load(home);
      if (!i) throw new Error(`no instance at ${home}`);
      return target(home, i);
    },
    adversary: {
      attack() {
        throw new Error('the lifecycle stub has no attacks');
      },
    },
  };
}
