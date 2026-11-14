import type { EngineCompaction } from '@backbone-next/platform';

export function CompactionHistory({ records, openOriginalHistory }: { records?: EngineCompaction[]; openOriginalHistory: (turnId: string) => void }) {
  if (!records?.length) return null;
  return <section aria-label="Compacted history" className="space-y-2 text-sm">
    {records.map(record => <details key={record.recordKey ?? JSON.stringify([record.engine, record.sessionId, record.id])} className="rounded-lg border border-border px-3 py-2" data-testid="compaction">
      <summary className="cursor-pointer">{record.engine === 'pi' ? 'Pi' : record.engine === 'codex' ? 'Codex' : 'ACP'} compacted history · {record.status.replaceAll('_', ' ')}</summary>
      {record.summary ? <p className="mt-2 whitespace-pre-wrap break-words">{record.summary}</p> : <p className="mt-2 text-muted">The engine did not expose a readable summary. The original conversation remains in this thread.</p>}
      {record.summaryTruncated && <p className="mt-2 text-muted">This summary is too long to show in full. It will not replace earlier context on a later turn; open the original conversation below.</p>}
      {record.error && <p className="mt-2 text-danger">{record.error}</p>}
      {record.contextBefore !== undefined && <p className="mt-2 text-muted">{record.estimated ? 'Estimated context' : 'Context'}: {record.contextBefore.toLocaleString()} tokens{record.contextAfter !== undefined ? ` → ${record.contextAfter.toLocaleString()} tokens` : ''}</p>}
      {record.usage && <p className="text-muted">Compaction used {record.usage.input.toLocaleString()} input and {record.usage.output.toLocaleString()} output tokens. Included in this turn’s usage.</p>}
      <nav aria-label="Original conversation" className="mt-2 flex flex-wrap gap-2">
        {record.historyTurnIds?.map((id, i) => <a key={id} className="text-accent underline" href={`#turn-${encodeURIComponent(id)}`} onClick={event => { event.preventDefault(); openOriginalHistory(id); }}>Earlier turn {i + 1}</a>)}
      </nav>
    </details>)}
  </section>;
}
