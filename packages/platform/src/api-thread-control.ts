import type { Id, Receipt } from './api.ts';

export interface ThreadRestartRequest {
  threadId: Id;
  /** The exact turn the person saw. A later turn is never stopped by an old request. */
  turnId: Id;
}
export type ThreadRestartReceipt = Receipt<{ threadId: Id; turnId: Id }>;
export interface ThreadControlMethods {
  /** Stop and settle this turn, then continue from recorded progress without replaying its request. */
  'threads.restart': (args: ThreadRestartRequest) => ThreadRestartReceipt;
}
