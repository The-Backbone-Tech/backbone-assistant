// Project the gateway's durable observations after restart. This neither proposes nor dispatches.
// Material is checked at the original expected version, never at whichever version is now current.
import type { EffectRecord, FileLink, MaterialEntry } from '../api.ts';
import type { MaterialStore } from '../stub/material.ts';
import { sha256 } from '../stub/fsx.ts';
import type { CoreLink } from './core.ts';

export interface StoredWrite {
  id: string;
  status: string;
  key?: string;
  run?: string;
  reason?: string | null;
  args: { document_id: string; title: string; content_sha256: string; base_version: number | null; task_id?: string };
}

/** Stamp a DONE write with the exact version it made and that content's hash, so it can be read back later as written. */
export function markWritten(effect: EffectRecord, entry: Pick<MaterialEntry, 'id' | 'current'>, sha: string): void {
  effect.materialId = entry.id;
  effect.version = entry.current;
  effect.sha256 = sha;
}

export function writtenVersion(material: MaterialStore, args: StoredWrite['args'], projectId: string): MaterialEntry | null {
  if (typeof args.document_id !== 'string' || typeof args.title !== 'string' || typeof args.content_sha256 !== 'string'
    || (args.base_version !== null && !Number.isSafeInteger(args.base_version))) return null;
  const expected = args.base_version === null ? 1 : args.base_version + 1;
  if (!Number.isSafeInteger(expected) || expected < 1) return null;
  const entry = material.load(args.document_id);
  if (!entry || entry.projectId !== projectId || entry.name !== args.title || entry.class === 'original') return null;
  const version = entry.versions.find((v) => v.n === expected && v.by === 'agent' && v.sha256 === args.content_sha256);
  if (!version) return null;
  try {
    if (sha256(material.bytes(entry.id, expected)) !== args.content_sha256) return null;
  } catch { return null; }
  return { ...entry, current: expected };
}

/** A material file alone cannot prove the Kernel document crossing completed. */
export async function verifiedWrittenVersion(link: CoreLink, row: StoredWrite, material: MaterialStore, projectId: string): Promise<MaterialEntry | null> {
  const entry = writtenVersion(material, row.args, projectId);
  if (!entry) return null;
  const { rows } = await link.read<{ title: string; content: string; via_effect: string | null }>(link.system(),
    `SELECT title, content, via_effect FROM app.documents WHERE id = $1 AND version = $2
     UNION ALL SELECT title, content, via_effect FROM app.document_versions WHERE document_id = $1 AND version = $2`, [entry.id, entry.current]);
  return rows.some((version) => version.title === row.args.title && version.via_effect === row.id && sha256(version.content) === row.args.content_sha256) ? entry : null;
}

/** The live host verifies both owners; the pure projection below is not SQL acceptance evidence. */
export async function verifiedRecoveredWrites(link: CoreLink, writes: readonly StoredWrite[], material: MaterialStore, projectId: string) {
  const result = projectRecoveredWrites(writes, material, projectId);
  for (const row of writes.filter((row) => row.status === 'succeeded')) {
    if (await verifiedWrittenVersion(link, row, material, projectId)) continue;
    result.files = result.files.filter((file) => file.materialId !== row.args.document_id || file.version !== (row.args.base_version === null ? 1 : row.args.base_version + 1));
    const effect = result.effects.find((effect) => effect.key === row.id);
    if (effect) { effect.outcome = 'UNKNOWN'; effect.detail = 'The exact artifact version is not verified in both material and Kernel. Nothing was resent.'; }
    result.stop = true;
    result.detail = 'An earlier success receipt lacks its exact verified artifact version. Nothing was resent.';
  }
  return result;
}

export function projectRecoveredWrites(writes: readonly StoredWrite[], material: MaterialStore, projectId: string): {
  effects: EffectRecord[]; files: FileLink[]; stop: boolean; pending: boolean; detail: string;
} {
  const effects: EffectRecord[] = [];
  const files: FileLink[] = [];
  let unknown = false;
  let pending = false;
  let missing = false;
  let refused = false;
  for (const row of writes) {
    const effect: EffectRecord = { key: row.id, kind: 'write-working-copy', target: row.args.title, outcome: 'UNKNOWN' };
    if (row.status === 'succeeded') {
      effect.outcome = 'DONE';
      const entry = writtenVersion(material, row.args, projectId);
      if (entry) { files.push({ materialId: entry.id, name: entry.name, version: entry.current }); markWritten(effect, entry, row.args.content_sha256); }
      else missing = true;
    } else if (row.status === 'unknown' || row.status === 'dispatching') {
      unknown = true;
      effect.detail = `The earlier write of ${row.args.title} is UNKNOWN. It will not be resent.`;
    } else if (['failed', 'denied', 'cancelled'].includes(row.status)) {
      refused = true;
      effect.outcome = 'REFUSED';
      effect.detail = row.reason === 'repeat_unknown_blocked'
        ? `This write of ${row.args.title} was refused because the original outcome is UNKNOWN. It is not resent.`
        : `The earlier write of ${row.args.title} was ${row.status}; it was not retried.`;
    } else {
      pending = true;
      effect.detail = `The earlier write of ${row.args.title} remains pending (${row.status}); no success is claimed.`;
    }
    effects.push(effect);
  }
  const detail = unknown ? 'An earlier write has an UNKNOWN outcome. Inspect its original receipt; nothing was resent.'
    : missing ? 'The earlier receipt succeeded, but its exact artifact version could not be verified. Nothing was resent.'
    : pending ? 'Earlier writes remain pending; only the original gateway change can continue.'
    : refused ? 'Recovered the earlier refused write. Nothing was retried.'
    : 'Recovered the completed artifact versions. Nothing was resent.';
  return { effects, files, stop: unknown || missing || (writes.length > 0 && !pending), pending, detail };
}
