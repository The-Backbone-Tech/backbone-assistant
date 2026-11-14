/** Engine-owned compaction, kept beside (never in place of) the original thread. */
export interface EngineCompaction {
  id: string;
  /** Host-generated stable identity; redaction of opaque engine IDs cannot merge observations. */
  recordKey?: string;
  engine: 'pi' | 'codex' | 'acp';
  sessionId?: string;
  status: string;
  /** Only user-displayable text supplied by the engine; never encrypted/internal context. */
  summary?: string;
  summaryTruncated?: boolean;
  error?: string;
  /** Engine-reported or explicitly estimated context sizes, not a billing balance. */
  contextBefore?: number;
  contextAfter?: number;
  estimated?: boolean;
  usage?: { input: number; output: number };
  /** A Pi summary may cover only this exact plain-history prefix, rechecked before every reuse. */
  replay?: { messages: number; sha256: string };
  /** Original turns remain readable even when the engine no longer sends their full text. */
  historyTurnIds?: string[];
}
