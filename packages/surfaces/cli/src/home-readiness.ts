// Share the Host's non-mutating structural preflight before selecting keys or taking a CLI lock.
import {keyHomeRecovery} from './key-recovery.ts';
import {HomeIncomplete,requireCompleteHome} from '@backbone-next/platform/composition';

export function completeHome(home: string): boolean {
  try { requireCompleteHome(home); return true; }
  catch (error) { if (error instanceof HomeIncomplete) return false; throw error; }
}
export function unfinishedHome(home: string): string {
  const recovery = keyHomeRecovery(home);
  if (recovery) return recovery;
  try { requireCompleteHome(home); }
  catch (error) { if (error instanceof HomeIncomplete) return error.message; throw error; }
  return 'This data folder is complete; retry the read.';
}
