import type { SessionUpdate } from '@agentclientprotocol/sdk';
import type { EngineCompaction } from '@backbone-next/platform';

/** ACP owns compaction. Apply its standard patch semantics without interpreting a summary as authority. */
export class AcpCompactions {
  private records = new Map<string, EngineCompaction>();
  receive(sessionId: string, update: SessionUpdate): EngineCompaction | undefined {
    if (update.sessionUpdate !== 'compaction_update' && update.sessionUpdate !== 'compaction_summary_chunk') return;
    const id = update.compactionId;
    const key = JSON.stringify([sessionId, id]);
    if (!this.records.has(key) && this.records.size >= 128) throw new Error('ACP compaction count exceeded its limit.');
    const record = { ...this.records.get(key) ?? { id, engine: 'acp' as const, sessionId, status: 'in_progress' } };
    if (update.sessionUpdate === 'compaction_summary_chunk') {
      if (update.content.type === 'text') record.summary = (record.summary ?? '') + update.content.text;
    } else {
      record.status = update.status;
      if (update.summary !== undefined) record.summary = update.summary?.filter(part => part.type === 'text').map(part => part.text).join('\n') ?? '';
      if (update.error !== undefined) record.error = update.error ?? '';
    }
    if ((record.summary?.length ?? 0) > 200_000 || id.length > 512) throw new Error('ACP compaction exceeded its text limit.');
    this.records.set(key, record);
    return { ...record };
  }
}
