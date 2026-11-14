import { readdir, readFile } from 'node:fs/promises';
import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';
import { coverage } from './coverage.ts';
import { LIFECYCLE_LESSONS } from './lessons.ts';

type Node = { type: string; [key: string]: unknown };
/** Calls that declare a case in this area's files. */
const CASES = new Set(['it', 'test', 'itKeeps']);

/** Every statically titled case of one file, as `file > describe > … > title`. */
async function cases(file: string): Promise<string[]> {
  const source = await readFile(new URL(`./${file}`, import.meta.url), 'utf8');
  const names: string[] = [];
  const title = (n: Node | undefined) => (n?.type === 'StringLiteral' ? (n.value as string) : undefined);
  const visit = (node: unknown, path: string[]) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, path);
      return;
    }
    const n = node as Node;
    if (n.type === 'CallExpression') {
      const callee = n.callee as Node;
      const base = callee.type === 'MemberExpression' ? (callee.object as Node) : callee;
      const name = base.type === 'Identifier' ? (base.name as string) : undefined;
      const args = n.arguments as Node[];
      const label = title(args[0]);
      if (name === 'describe' && label !== undefined) return visit(args.slice(1), [...path, label]);
      if (name && CASES.has(name) && label !== undefined) {
        names.push([file, ...path, label].join(' > '));
        return;
      }
    }
    for (const [key, value] of Object.entries(n))
      if (key !== 'loc' && key !== 'start' && key !== 'end') visit(value, path);
  };
  visit(parse(source, { sourceType: 'module', plugins: ['typescript'] }).program.body, []);
  return names;
}

describe('the lifecycle inventory lists every case once, with its gaps', () => {
  it('every statically titled case is listed, and every listed case exists', async () => {
    const files = (await readdir(new URL('./', import.meta.url))).filter(
      (f) => f.endsWith('.test.ts') && f !== 'coverage.test.ts',
    );
    const found = (await Promise.all(files.map(cases))).flat();
    expect(Object.keys(coverage.cases).sort()).toEqual(found.sort());
  });

  it('every lesson case is listed, and every gap a case names is defined', () => {
    expect(Object.keys(coverage.lessons).sort()).toEqual(LIFECYCLE_LESSONS.map((l) => l.id).sort());
    const ids = new Set([...coverage.gaps.map((g) => g.id), 'SG-CORE-01']);
    for (const [name, entry] of [...Object.entries(coverage.cases), ...Object.entries(coverage.lessons)]) {
      for (const gap of entry.gaps ?? []) expect(ids.has(gap), `${name} names ${gap}`).toBe(true);
      if (entry.status === 'restated') expect(entry.yardstick.length, name).toBeGreaterThan(0);
    }
  });
});
