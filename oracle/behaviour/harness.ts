import { mkdir, writeFile } from 'node:fs/promises';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';
import type { BehaviourTarget, BehaviourUse } from './target.ts';

/** The behaviour target named by ORACLE_TARGET (default: the current repository). */
export async function openBehaviourTarget(): Promise<BehaviourTarget> {
  const name = process.env.ORACLE_TARGET ?? 'legacy';
  // The legacy behaviour adapter binds the old repository and stays on its branch.
  if (name === 'successor') return (await import('../adapters/successor/behaviour/index.ts')).openSuccessorBehaviour();
  throw new Error(`no behaviour target named ${name}`);
}

/**
 * Open the behaviour target for this file and record how each case reached it
 * (results/usage/<target>.behaviour.<file>.json), as the core harness does.
 */
export function useBehaviour(file: string): () => BehaviourTarget {
  let target: BehaviourTarget | undefined;
  const usage: Record<string, BehaviourUse[]> = {};
  let setup: BehaviourUse[] = [];
  beforeAll(async () => {
    target = await openBehaviourTarget();
  });
  beforeEach(() => {
    if (target) setup = [...setup, ...target.drainUsage()];
  });
  afterEach((context) => {
    if (!target) return;
    const names: string[] = [];
    for (let t: { name: string; suite?: unknown } | undefined = context.task; t; t = t.suite as typeof t) {
      if (t.name) names.unshift(t.name);
    }
    const filepath = (context.task as { file?: { filepath?: string } }).file?.filepath ?? '';
    const base = relative(fileURLToPath(new URL('../', import.meta.url)), filepath);
    usage[[base, ...names].join(' > ')] = [...setup, ...target.drainUsage()];
  });
  afterAll(async () => {
    await mkdir(new URL('../results/usage/', import.meta.url), { recursive: true });
    await writeFile(
      new URL(`../results/usage/${process.env.ORACLE_TARGET ?? 'legacy'}.behaviour.${file}.json`, import.meta.url),
      JSON.stringify(usage, null, 2),
    );
  });
  return () => {
    if (!target) throw new Error('the behaviour target is not open yet');
    return target;
  };
}
