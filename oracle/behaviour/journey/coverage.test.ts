import { readdir, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { coverage } from './coverage.ts';

const here = new URL('./', import.meta.url);

/** Every phase and adverse case of J-01 is accounted for, and every case it names exists. */
describe('the J-01 coverage inventory', () => {
  it('lists phases 1–10, A1–A3 and parity once, each with its cases or its gap', async () => {
    expect(Object.keys(coverage.phases).sort()).toEqual(
      ['1', '10', '2', '3', '4', '5', '6', '7', '8', '9', 'A1', 'A2', 'A3', 'parity'].sort(),
    );
    const gaps = new Set(coverage.gaps.map((g) => g.id));
    for (const [id, phase] of Object.entries(coverage.phases)) {
      if (phase.status === 'gap') expect(phase.gap, `phase ${id} is a gap without one`).toBeDefined();
      if (phase.gap) expect(gaps.has(phase.gap), `phase ${id} names an unknown gap`).toBe(true);
      if (['covered', 'narrowed', 'deviation'].includes(phase.status))
        expect(phase.oracle?.length, `phase ${id} names no case`).toBeGreaterThan(0);
    }
  });

  it('names only cases that exist in this folder', async () => {
    const sources = new Map<string, string>();
    for (const file of await readdir(here)) {
      if (file.endsWith('.ts')) sources.set(file, await readFile(new URL(file, here), 'utf8'));
    }
    const all = [...sources.values()].join('\n');
    for (const phase of Object.values(coverage.phases)) {
      for (const ref of phase.oracle ?? []) {
        const [file, title] = ref.split(' > ');
        expect(sources.has(file ?? ''), `${ref}: no such file`).toBe(true);
        // Lesson titles live in cases.ts; every other title in its own file.
        expect(
          (title && sources.get(file ?? '')?.includes(title)) || (title && all.includes(`id: '${title}'`)),
          `${ref}: no such case`,
        ).toBe(true);
      }
    }
  });
});
