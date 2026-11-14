// All turn reads can reach scratch through command text, not just copied attachments.
import { createHash } from 'node:crypto';
import type { MaterialEntry } from '../api.ts';
import type { ToolHost } from '../ports/harness.ts';
import { isWithdrawn, type MaterialStore } from '../stub/material.ts';
import { MAX_WORKSPACE_INPUT, WorkspaceStore, type WorkspaceRecord, type WorkspaceSource } from '../workspace/store.ts';
import { withHomeLock } from './home-lock.ts';
import { WorkspaceRefusal } from '../workspace/result.ts';
class StaleWorkspace extends WorkspaceRefusal {}
export function workspaceTools(options: {
  home: string; threadId: string; projectId: string; material: MaterialStore;
  attachments: MaterialEntry[]; signal: AbortSignal; alive(): boolean;
  sources(): readonly { id: string; name: string; version: number; withdrawals: number; inherited?: boolean }[];
  tools: Pick<ToolHost, 'read' | 'stillGranted'>;
}): Pick<ToolHost, 'runWorkspace'> {
  const { home, threadId, tools, signal, material } = options, store = new WorkspaceStore(home);
  return { runWorkspace: async ({ command, attachment }, callSignal) => {
    const active = callSignal ? AbortSignal.any([signal, callSignal]) : signal;
    let executionStarted = false;
    const check = () => {
      active.throwIfAborted(); if (!options.alive()) throw new WorkspaceRefusal('This turn has ended.');
      const allowed = tools.stillGranted?.([]); if (allowed !== undefined && allowed !== true) throw new StaleWorkspace('A workspace source is no longer granted.');
    };
    const retainReads = async (record: WorkspaceRecord) => {
      await withHomeLock(home, async () => {
        check();
        for (const source of options.sources()) {
          const entry = material.load(source.id);
          if (!entry || entry.projectId !== options.projectId || entry.name !== source.name || entry.current !== source.version || (entry.withdrawals?.length ?? 0) !== source.withdrawals || entry.hidden || entry.held || entry.unsure || entry.recovery || isWithdrawn(entry)) throw new StaleWorkspace('A turn source changed or was withdrawn; its scratch was retired.');
          const prior = record.sources.find(item => item.materialId === source.id);
          if (prior && (prior.version !== source.version || prior.withdrawals !== source.withdrawals || prior.name !== source.name)) throw new StaleWorkspace('A retained workspace source changed; its scratch was retired.');
          if (!prior) record.sources.push({ materialId: source.id, name: source.name, version: source.version, withdrawals: source.withdrawals });
        }
      });
      // Commit dependencies before execution; a kill cannot leave unbound derived data.
      await store.save(record);
    };
    try {
      check();
      return await store.use(threadId, async record => {
        check();
        for (const source of record.sources) {
          if (options.sources().some(read => !read.inherited && read.id === source.materialId && read.name === source.name && read.version === source.version && read.withdrawals === source.withdrawals)) continue;
          const file = await tools.read(source.name);
          if (!file || file.projectId !== options.projectId || file.materialId !== source.materialId || file.version !== source.version || file.withdrawals !== source.withdrawals) throw new StaleWorkspace('A retained workspace source changed or was withdrawn; its scratch was retired.');
        }
        const inputs: { name: string; bytes: Buffer }[] = [];
        let input: string | undefined;
        if (attachment !== undefined) {
          const original = options.attachments.find(entry => entry.name === attachment && entry.class === 'original');
          if (!original) throw new WorkspaceRefusal('Only an original attached to this turn can be copied into the workspace.');
          // Check immutable byte count and actual file size before allocation OR gateway source registration.
          const bytes = await withHomeLock(home, async () => {
            check(); const entry = material.load(original.id), version = entry?.versions.find(item => item.n === original.current);
            if (!entry || entry.current !== original.current || entry.projectId !== options.projectId || entry.hidden || entry.held || isWithdrawn(entry)) throw new StaleWorkspace('The attached original is no longer available.');
            if (!version || !Number.isSafeInteger(version.bytes) || version.bytes < 0 || version.bytes > MAX_WORKSPACE_INPUT) throw new WorkspaceRefusal('Original exceeds the 10 MB workspace input size limit.');
            const copy = Buffer.from(material.bytes(entry.id, entry.current, MAX_WORKSPACE_INPUT));
            if (copy.length !== version.bytes || createHash('sha256').update(copy).digest('hex') !== version.sha256) throw new StaleWorkspace('The attached original bytes changed.');
            return copy;
          });
          const delivered = await tools.read(attachment);
          if (!delivered || delivered.materialId !== original.id || delivered.version !== original.current || delivered.projectId !== options.projectId) throw new StaleWorkspace('The attached original changed before copying.');
          const name = `${createHash('sha256').update(`${original.id}:${original.current}`).digest('hex')}.${/\.xlsx$/i.test(attachment) ? 'xlsx' : /\.csv$/i.test(attachment) ? 'csv' : 'bin'}`;
          let source = record.sources.find(item => item.materialId === original.id);
          if (!source) { source = { name: original.name, materialId: original.id, version: original.current, withdrawals: delivered.withdrawals ?? 0 }; record.sources.push(source); }
          source.input = name; inputs.push({ name, bytes }); input = `../inputs/${name}`;
        }
        await retainReads(record); check();
        executionStarted = true;
        const result = await store.execute(record, { command, inputs, signal: active }).catch(error => {
          // Store validation precedes spawning. Post-execution source checks below must stay unknown.
          if (error instanceof WorkspaceRefusal && !active.aborted) throw WorkspaceRefusal.beforeCommand(error);
          throw error;
        });
        await retainReads(record); check();
        return JSON.stringify({ ...result, ...(input ? { input } : {}), inputs: record.sources.filter(source => source.input).map(source => ({ name: source.name, path: `../inputs/${source.input}` })), expiresAt: new Date(record.expiresAt).toISOString() });
      });
    } catch (error) {
      if (error instanceof StaleWorkspace) await store.remove(threadId);
      // Reject with the original diagnostic. Engines project the marker without swallowing this refusal.
      if (!executionStarted && !active.aborted && error instanceof WorkspaceRefusal) throw WorkspaceRefusal.beforeCommand(error);
      if (error instanceof Error && error.message.includes(home)) throw new Error('Workspace input or execution could not be confirmed. Nothing was promoted.');
      throw error;
    }
  } };
}
