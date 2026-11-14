import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
/** Checkout/CLI use the source files; the desktop bundle stages the same trusted closure beside it. */
export function workspaceProcess(name: 'worker' | 'processes' | 'linux' | 'linux-worker'): string {
  const filename = name === 'processes' || name === 'linux' ? `${name}.py` : `${name}.ts`;
  const source = new URL(`./${filename}`, import.meta.url);
  const staged = new URL(`./workspace-runtime/${filename}`, import.meta.url);
  for (const candidate of [source, staged]) if (existsSync(candidate)) return fileURLToPath(candidate);
  throw new Error('Thread workspace runtime is missing from this installation.');
}
