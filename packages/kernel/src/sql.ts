// The v0.8 kernel's SQL, vendored byte for byte from the kernel lab at the commit pin.json names.
// Every load recomputes each file's sha256 and refuses bytes that differ from the pin, so a local
// edit cannot reach a database without a new pin (and the acceptance that goes with one).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export interface KernelPin { kernelCommit: string; sqlSha256: Record<string, string> }

const at = (name: string) => new URL(`../sql/${name}`, import.meta.url);

export const kernelPin: KernelPin = JSON.parse(readFileSync(at('pin.json'), 'utf8'));

/** The pinned statements in order (0000_roles, 0001_core, 0002_services), each checked against its digest. */
export function kernelSql(read: (name: string) => string = (name) => readFileSync(at(`${name}.sql`), 'utf8')): { name: string; sql: string }[] {
  return Object.entries(kernelPin.sqlSha256).map(([name, sha]) => {
    const sql = read(name);
    const actual = createHash('sha256').update(sql).digest('hex');
    if (actual !== sha) throw new Error(`kernel SQL ${name} is not the pinned ${kernelPin.kernelCommit.slice(0, 8)} (sha256 ${actual}, pinned ${sha})`);
    return { name, sql };
  });
}
