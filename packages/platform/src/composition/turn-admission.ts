// Admissions serialize against each other without retaining the cross-process home lock.
// Local state is revalidated and journalled by the caller's short reservation section.
import { inActiveHomeLockScope } from './home-lock.ts';
import type { Turn, TurnSelection } from '../api.ts';
export interface TurnAdmissionOptions {
  queued?: string;
  stillWanted?: () => boolean;
  validate?: () => string | undefined;
  prepare?: (turn: Turn) => void;
  reserved?: (threadId:string,turnId:string) => void;
  stopMark?: number;
  selection?: TurnSelection | null;
}
export function turnAdmissions(home: string) {
  let pending: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    if (inActiveHomeLockScope(home)) throw new Error('Turn admission must start outside the home lock.');
    const next=pending.then(work,work);
    pending=next.catch(()=>{});
    return next;
  };
}
