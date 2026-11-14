// A data home belongs to one kernel, named once under the home lock when that kernel first opens it,
// so two kernels never hold live truth for it. A home with no stamp and nothing in it is free; one
// with no stamp and work in it is the older core's. This guards against mistakes: anything that can
// write the home can write this file.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writeJson } from '../stub/fsx.ts';
import { HomeBusy, withHomeLock } from './home-lock.ts';

export interface HomeKernel { kernel: string; database: string; workspace: string }
const stampPath = (home: string) => join(home, 'kernel.json');
// What a home holds before any work: its locks, its owner's user-only folder (`run`, home-owner.ts) and an empty threads folder.
const FREE = new Set(['.lock', '.owner', 'run', 'threads']);

function holdsWork(home: string) {
  const threads = join(home, 'threads');
  return (existsSync(home) && readdirSync(home).some((name) => !FREE.has(name) && !name.endsWith('.lock'))) || (existsSync(threads) && readdirSync(threads).length > 0);
}

export const homeKernel = (home: string) => readJson<HomeKernel | null>(stampPath(home), null);

/** A quick refusal before the older host touches anything. `claimCoreHome` is the decision. */
export function refuseStampedHome(home: string, own = 'core') {
  const stamp = homeKernel(home);
  if (stamp && stamp.kernel !== own) throw new Error(`This data home belongs to the ${stamp.kernel} kernel; the older core will not open it.`);
}

/** The older core claims a home it opens: a free one, or one already its own, as every installed home is. */
export async function claimCoreHome(home: string): Promise<void> {
  refuseStampedHome(home, 'core');
  // A stamp never changes, so a home already claimed need not wait for the lock a dispatch may hold.
  if (homeKernel(home)) return;
  const claim = async () => {
    refuseStampedHome(home, 'core');
    if (!homeKernel(home)) writeJson(stampPath(home), { kernel: 'core', database: '', workspace: '' });
  };
  // Existing work need not wait for another cooperating holder to finish stamping it.
  // Real storage/admission failures still propagate; existing bytes never waive safe access.
  if (holdsWork(home)) await withHomeLock(home, claim, 0).catch(error => { if (!(error instanceof HomeBusy)) throw error; refuseStampedHome(home, 'core'); });
  else await withHomeLock(home, claim);
}

/** Stamp a free home, or confirm the stamp. Call under the home lock. */
export function claimHomeKernel(home: string, wanted: HomeKernel) {
  const stamp = homeKernel(home);
  if (stamp) {
    if (stamp.kernel !== wanted.kernel) throw new Error(`This data home belongs to the ${stamp.kernel} kernel.`);
    if (stamp.database !== wanted.database || stamp.workspace !== wanted.workspace) throw new Error('This data home belongs to another database or workspace.');
    return;
  }
  if (holdsWork(home)) throw new Error('This data home already holds work under another kernel.');
  writeJson(stampPath(home), wanted);
}
