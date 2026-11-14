import type { Args, Result } from '../api.ts';
import type { CoreLink } from './core.ts';
import type { StoredThread } from './thread-journal.ts';
import type { MaterialStore } from '../stub/material.ts';
import { withHomeLock } from './home-lock.ts';
import { rewindWriteHold } from './rewind-admission.ts';

/** Inspect Core outside the home lock; recheck pending rewinds at the local write. */
export function createMaterialSave(deps: {
  home: string;
  core: Promise<CoreLink>;
  material: MaterialStore;
  threads: Map<string, StoredThread>;
  changed(project: string): void;
}): (args: Args<'material.save'>) => Promise<Result<'material.save'>> {
  const { home, core, material, threads } = deps;
  return async ({ id, text, baseVersion }) => {
    const refusal = () => {
      const detail = rewindWriteHold(threads.values(), 'material.save', { id });
      return detail ? { ok: false as const, reason: 'NOT_AVAILABLE' as const, detail, outcome: 'REFUSED' as const } : undefined;
    };
    const held = refusal();
    if (held) return held;
    const link = await core;
    if (material.load(id)?.recovery) return { ok: false, reason: 'INVALID', detail: 'This is an unimported recovery copy. Inspect or retire it; use a deliberate new input to work from its contents.', outcome: 'REFUSED' };
    const project = material.load(id)?.projectId;
    const coreVersion = project ? await link.documentVersion(id, project) : null;
    const result = await withHomeLock(home, async () => refusal() ?? material.save(id, text, baseVersion));
    if (result.ok) {
      // Startup reconciles a local Save interrupted before its Core revision.
      if (coreVersion !== null) await link.reviseDocument(id, text, project, coreVersion);
      deps.changed(result.value.projectId);
    }
    return result;
  };
}
