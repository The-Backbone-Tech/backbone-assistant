import type { Id, Receipt, Turn } from './api.ts';
export interface RewindFile {
  materialId: Id;
  name: string;
  current: number;
  /** Zero means this thread created the file after the selected turn. */
  restore: number;
  conflict: boolean;
  /** Versions in the reverted interval that this branch did not write. */
  foreignVersions?: number[];
  agentVersions?: number[];
  outcome?: 'pending' | 'restored' | 'kept' | 'not-restored';
  core?: 'recorded' | 'failed';
  problem?: string;
  /** Observation for interruption recovery, never a filesystem grant. */
  folderDigest?: string;
}
export interface RewindPlan { pendingKey?: string; revision: string; files: RewindFile[]; turns: Turn[] }
export interface RewindChoice { materialId: Id; action: 'keep' | 'restore' }
export interface RewindRecord { id: string; turnId: Id; turns: Turn[]; clientKeys?: string[]; sideTurns?: Turn[]; files: RewindFile[]; choices: RewindChoice[]; problem?: string; resolution?: 'complete' | 'without-remaining-files' }
export interface RewindMethods {
  'threads.rewindPreview': (a: { threadId: Id; turnId: Id }) => Receipt<RewindPlan>;
  'threads.rewind': (a: { threadId: Id; turnId: Id; revision: string; clientKey: string; choices: RewindChoice[] }) => Receipt<RewindRecord>;
  'threads.rewindFinish': (a: { threadId: Id; pendingKey: string }) => Receipt<RewindRecord>;
}
