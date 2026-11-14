import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Resolved when used, so a bundle shipping prebuilt SQL never needs developer sources. */
const schemaDir = () => fileURLToPath(new URL('../../schema/', import.meta.url));
interface Manifest {
  format: 1;
  comment: string;
  sections: { role: string | null; files: string[] }[];
  sourceHashes: Record<string, string>;
  bodyChecksum: string;
  artifactChecksum: string;
}
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const hex = /^[a-f0-9]{64}$/;
const safe = /^[a-z0-9_-]+(?:\/[a-z0-9_-]+)*\.sql$/;
const roles = new Set([null, 'backbone_gov', 'backbone_owner']);
const exact = (value: object, keys: string[]) => Object.keys(value).sort().join('\0') === keys.sort().join('\0');
function frozenManifest(): Manifest {
  const m = JSON.parse(readFileSync(join(schemaDir(), 'baseline.json'), 'utf8')) as Manifest;
  if (!m || !exact(m, ['format', 'comment', 'sections', 'sourceHashes', 'bodyChecksum', 'artifactChecksum']) || m.format !== 1 ||
      !hex.test(m.bodyChecksum) || !hex.test(m.artifactChecksum) || !Array.isArray(m.sections) || !m.sections.length ||
      !m.sourceHashes || typeof m.sourceHashes !== 'object' || Array.isArray(m.sourceHashes)) throw new Error('Frozen baseline manifest fields differ.');
  const files: string[] = [];
  for (const section of m.sections) {
    if (!section || !exact(section, ['role', 'files']) || !roles.has(section.role) || !Array.isArray(section.files) || !section.files.length)
      throw new Error('Frozen baseline section differs.');
    for (const file of section.files) {
      if (!safe.test(file) || file.startsWith('versions/') || files.includes(file)) throw new Error('Frozen baseline source path differs.');
      files.push(file);
      if (!hex.test(m.sourceHashes[file]) || hash(readFileSync(join(schemaDir(), file))) !== m.sourceHashes[file])
        throw new Error(`Frozen baseline raw source digest differs: ${file}`);
    }
  }
  if (!exact(m.sourceHashes, files)) throw new Error('Frozen baseline source inventory differs.');
  return m;
}
/** Finite historical bootstrap only. No wildcard can silently add fresh-install SQL. */
export function baselineFiles(): string[] { return frozenManifest().sections.flatMap(s => s.files); }
/** Historical build artifact, unchanged by appended versions. A receipt is not catalogue proof. */
export function buildBaseline(): { sql: string; checksum: string } {
  const manifest = frozenManifest();
  const parts = ['-- Core baseline (generated from packages/core/schema; do not edit).', 'SET check_function_bodies = false;'];
  for (const section of manifest.sections) {
    parts.push(section.role ? `SET ROLE ${section.role};` : 'RESET ROLE;');
    for (const file of section.files) parts.push(`-- ${file}`, readFileSync(join(schemaDir(), file), 'utf8').replace(/\r\n/g, '\n').trim());
  }
  parts.push('RESET ROLE;');
  const body = parts.join('\n\n'), checksum = hash(body);
  if (checksum !== manifest.bodyChecksum) throw new Error('Frozen baseline body checksum differs.');
  const sql = `${body}\n\nINSERT INTO ops.schema_migrations (version, checksum) VALUES ('baseline', '${checksum}');\n`;
  if (hash(sql) !== manifest.artifactChecksum) throw new Error('Frozen baseline artifact checksum differs.');
  return { sql, checksum };
}
