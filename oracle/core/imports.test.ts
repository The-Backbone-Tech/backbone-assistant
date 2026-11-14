import { readdir, readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ORACLE = fileURLToPath(new URL('..', import.meta.url));
const REPO = resolve(ORACLE, '..');

/** What a case may import: the adapter interface and selector, the stub, oracle helpers, and the kernel as the reference model. */
function allowed(from: string, specifier: string): boolean {
  if (specifier === 'vitest' || specifier.startsWith('node:') || specifier === '@babel/parser' || specifier === 'fast-check') return true;
  if (!specifier.startsWith('.')) return false;
  const target = relative(REPO, resolve(from, '..', specifier));
  if (target.startsWith('packages/')) return target === 'packages/core/src/kernel/index.ts';
  if (!target.startsWith('oracle/')) return false;
  // A case never reaches into an adapter's bindings: only the interface, the selector and the stub.
  return !target.startsWith('oracle/adapters/') || ['oracle/adapters/index.ts', 'oracle/adapters/stub/index.ts'].includes(target);
}

async function files(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await files(path)));
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out;
}

describe('cases reach a target only through the adapter (lesson 15, applied to the oracle)', () => {
  it('no case or lesson imports a legacy package, a database driver or an adapter’s bindings', async () => {
    const offending: string[] = [];
    for (const file of [...(await files(resolve(ORACLE, 'core'))), ...(await files(resolve(ORACLE, 'lessons')))]) {
      const source = await readFile(file, 'utf8');
      for (const [, imported, dynamic] of source.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+'([^']+)'|\bimport\('([^']+)'\)/gm)) {
        const specifier = imported ?? dynamic;
        if (specifier && !allowed(file, specifier)) offending.push(`${relative(ORACLE, file)} → ${specifier}`);
      }
      for (const [, url] of source.matchAll(/new URL\('([^']+)'/g)) {
        if (url && /packages\/(?!core\/src\/kernel\/index\.ts)/.test(url)) offending.push(`${relative(ORACLE, file)} → ${url}`);
      }
    }
    expect(offending).toEqual([]);
  });
});
