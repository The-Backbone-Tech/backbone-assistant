import { realpathSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import type { Id, Session, Target } from '../../target.ts';
import { useBehaviour } from '../harness.ts';
import type { CliOptions, CliResult, HomePort, Scratch } from './port.ts';

/** The guard refused to hand a run to the target: it named no scratch Home. Nothing ran. */
export class HomeGuardRefusal extends Error {
  override readonly name = 'HomeGuardRefusal';
}

const strictlyBelow = (root: string, path: string) => {
  const r = relative(root, resolve(path));
  return r !== '' && r !== '..' && !r.startsWith(`..${sep}`) && !r.startsWith(sep);
};

/**
 * Lesson 17 for the oracle itself: a lifecycle run can never reach the default profile. Every run,
 * provision and open must name a Home strictly below a scratch root this guard made (never its
 * user profile, never the real `$HOME/.backbone`), or name none at all — and then the adapter points the
 * user profile into the scratch. Anything else is refused before the target sees it.
 */
export function guarded(port: HomePort): HomePort {
  const made = new WeakSet<Scratch>();
  const live = new Set<Scratch>();
  const real = join(realpathSync(homedir()), '.backbone');
  const home = (path: string, scratch?: Scratch): string => {
    if (typeof path !== 'string' || path === '')
      throw new HomeGuardRefusal('a lifecycle run names its Home explicitly');
    if (path === real || strictlyBelow(real, path))
      throw new HomeGuardRefusal('refusing the default profile');
    const owner = (scratch ? [scratch] : [...live]).find((s) => strictlyBelow(s.root, path));
    if (!owner)
      throw new HomeGuardRefusal(
        `refusing ${path}: a lifecycle Home lives below a scratch root made for the case`,
      );
    if (resolve(path) === owner.profile || strictlyBelow(owner.profile, path)) {
      throw new HomeGuardRefusal(`refusing ${path}: the scratch's user profile holds no Home`);
    }
    return path;
  };
  const known = (scratch: Scratch) => {
    if (!made.has(scratch)) throw new HomeGuardRefusal('refusing a scratch root this harness did not make');
    return scratch;
  };
  return {
    async scratch(label) {
      const scratch = await port.scratch(label);
      if (!strictlyBelow(scratch.root, scratch.profile))
        throw new HomeGuardRefusal('the scratch profile is not below its root');
      made.add(scratch);
      live.add(scratch);
      return scratch;
    },
    async discard(scratch) {
      await port.discard(known(scratch));
      live.delete(scratch);
    },
    async cli(scratch, args, options: CliOptions): Promise<CliResult> {
      known(scratch);
      if (options.home !== null) home(options.home, scratch);
      return port.cli(scratch, args, options);
    },
    provision: async (path) => port.provision(home(path)),
    open: async (path) => port.open(home(path)),
    adversary: {
      async attack(name, args) {
        // An attack acts on a scratch Home or a file below a scratch root, never elsewhere.
        if (args.home !== undefined) home(String(args.home));
        for (const key of ['file', 'to'] as const) {
          const path = args[key];
          if (path !== undefined && ![...live].some((s) => strictlyBelow(s.root, String(path)))) {
            throw new HomeGuardRefusal(`refusing ${String(path)}: an attack acts below a scratch root`);
          }
        }
        return port.adversary.attack(name, args);
      },
    },
  };
}

/**
 * The lifecycle port for one file, behind the guard, recording usage as the behaviour harness does;
 * every scratch root made through it is removed after the file.
 */
export function useHomes(file: string): () => HomePort {
  const target = useBehaviour(`lifecycle.${file}`);
  let port: HomePort | undefined;
  const scratches: Scratch[] = [];
  afterAll(async () => {
    if (!port) return;
    for (const s of scratches.splice(0)) await port.discard(s).catch(() => {});
  });
  return () => {
    if (!port) {
      const inner = guarded(target().homes);
      port = {
        ...inner,
        async scratch(label) {
          const s = await inner.scratch(label);
          scratches.push(s);
          return s;
        },
      };
    }
    return port;
  };
}

/**
 * A case the legacy repository is known not to keep, run with `it.fails` there: it stays green
 * while the deviation is there and turns red the day it is fixed. Only a failed assertion counts as
 * the deviation; any other error is swallowed, so `it.fails` turns red on a crash too.
 */
export function deviates(body: () => Promise<void>): () => Promise<void> {
  return async () => {
    try {
      await body();
    } catch (error) {
      if ((error as Error)?.name === 'AssertionError') throw error;
      console.error('a known-deviation case crashed instead of failing its assertion:', error);
    }
  };
}

/** `it`, or `it.fails` with `deviates` against the legacy target when `deviation` is set. */
export function itKeeps(
  title: string,
  deviation: string | undefined,
  body: () => Promise<void>,
  timeout?: number,
) {
  if (deviation && (process.env.ORACLE_TARGET ?? 'legacy') === 'legacy') {
    it.fails(`${title} (known legacy deviation)`, deviates(body), timeout);
  } else it(title, body, timeout);
}

// --- what a case reads from the command line ------------------------------------------------------

/** The sha256 a command printed (`sha256: <hex>`). */
export function digestOf(result: CliResult): string {
  const found = /sha256: ([0-9a-f]{64})/.exec(result.stdout)?.[1];
  if (!found) throw new Error(`no sha256 printed:\n${result.stdout}\n${result.stderr}`);
  return found;
}

/** The ledger head an export printed (`ledger head: entry <seq>, <hash>`). */
export function exportedHead(result: CliResult): { seq: number; hash: string } {
  const found = /ledger head: entry (\d+), ([0-9a-f]{64})/.exec(result.stdout);
  if (!found?.[1] || !found[2]) throw new Error(`no ledger head printed:\n${result.stdout}`);
  return { seq: Number(found[1]), hash: found[2] };
}

/** The command succeeded; its output is attached when it did not. */
export function ok(result: CliResult, label = 'the command'): CliResult {
  expect(result.code, `${label} failed:\n${result.stdout}\n${result.stderr}`).toBe(0);
  return result;
}

/** The command refused: a non-zero exit, and the refusal said why (matching `reason`). */
export function refusedBy(result: CliResult, reason: RegExp, label = 'the command'): CliResult {
  expect(result.code, `${label} was expected to refuse:\n${result.stdout}\n${result.stderr}`).not.toBe(0);
  expect(`${result.stderr}\n${result.stdout}`, `${label} refused without naming why`).toMatch(reason);
  return result;
}

export const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

// --- reaching the same workspace in another instance ----------------------------------------------

/** The people and principals of a workspace, which an import or restore keeps. */
export interface Ids {
  ws: Id;
  owner: Id;
  system: Id;
  agent: Id;
}

/** Sessions for the same workspace's people in another instance (its runs' secrets do not travel). */
export function sessionsIn(
  t: Target,
  ids: Ids,
): { owner$: Session; system$: Session; worker$: Session; nobody$: Session } {
  const at = t.setWorkspace(ids.ws);
  return {
    owner$: at.asPrincipal(ids.owner),
    system$: at.asPrincipal(ids.system),
    worker$: at,
    nobody$: t.setWorkspace(null),
  };
}

/** Open a Home, do `fn`, and stop it again whatever happened. */
export async function withHome<T>(port: HomePort, path: string, fn: (t: Target) => Promise<T>): Promise<T> {
  const t = await port.open(path);
  try {
    return await fn(t);
  } finally {
    await t.close();
  }
}
