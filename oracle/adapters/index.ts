import type { Target } from '../target.ts';

/**
 * The target named by ORACLE_TARGET. In this repository the only target is the successor; the
 * legacy adapter binds the old repository's schema and stays on its frozen branch.
 */
export async function openTarget(): Promise<Target> {
  const name = process.env.ORACLE_TARGET ?? 'successor';
  switch (name) {
    case 'successor':
      return (await import('./successor/index.ts')).openSuccessor();
    default:
      throw new Error(`no oracle target named ${name}`);
  }
}
