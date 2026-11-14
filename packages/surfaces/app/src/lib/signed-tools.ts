import type { ConnectorsView, ConnectorServer, ConnectorTool, HeldCall, Receipt } from '@backbone-next/platform';

export interface SignedToolRow {
  key: string;
  id?: string;
  server: ConnectorServer;
  tool: ConnectorTool;
  at: string;
  /** Exact signature when its Core identity is available; legacy views remain tool-wide. */
  calls: number;
  unknowns?: number;
  last?: HeldCall;
}

/** Optional fields reserved for the ledger owner's listing hunk. Missing data stays unknown. */
export type SignatureListing = ConnectorsView & { signatureEndings?: { pending: string[]; conflicts: string[] } };
export type SignatureEndState = 'ended' | 'pending' | 'conflict' | 'unavailable';
export function signatureEndState(view: SignatureListing | undefined, row: SignedToolRow): SignatureEndState {
  if (!row.id || !view?.signatureEndings) return 'unavailable';
  if (view.signatureEndings.conflicts.includes(row.id)) return 'conflict';
  if (view.signatureEndings.pending.includes(row.id)) return 'pending';
  return 'ended';
}
export const localTime = (at: string) => new Date(at).toLocaleString();

/** Backend diagnostics are already safe to display. Never classify them by their text. */
export function signatureFailureMessage(error: unknown, fallback: string): string {
  return error instanceof Error && !(error instanceof TypeError) ? error.message : fallback;
}

/** Retained acknowledgements must not restore tool text hidden by a newer listing. */
export function visibleRetainedTools(view: ConnectorsView | undefined, rows: SignedToolRow[]): SignedToolRow[] {
  return rows.filter(row => view?.servers.some(server => server.id === row.server.id && !server.blocked
    && server.tools.some(tool => tool.name === row.tool.name)));
}

export function signedTools(view: ConnectorsView): SignedToolRow[] {
  return view.servers.flatMap((server) => server.tools.flatMap((tool) => {
    if (!tool.standing) return [];
    const id = tool.standing.id;
    const calls = [...new Map(view.held.filter((h) => h.serverId === server.id && h.tool === tool.name
      && (id ? h.standingSignatureId === id : h.standing) && ['sent', 'failed', 'unknown'].includes(h.state)).map((h) => [h.effect, h])).values()]
      .sort((a, b) => b.at.localeCompare(a.at) || b.effect.localeCompare(a.effect));
    return [{ key: JSON.stringify([server.id, tool.name, id ?? tool.standing.at]), id, server, tool,
      at: tool.standing.at, calls: calls.length, last: calls[0], unknowns: view.held.filter(h => h.serverId === server.id && h.tool === tool.name && h.state === 'unknown').length }];
  })).sort((a, b) => a.server.name.localeCompare(b.server.name) || a.tool.name.localeCompare(b.tool.name));
}

export type EndSignature = (method: 'connectors.set', args: { serverId: string; tool: { name: string; standing: false } }) => Promise<Receipt<ConnectorServer | { ended: true }>>;

/** The existing Host command removes permission locally and queues its end in Core. */
export async function endSignature(call: EndSignature, row: SignedToolRow): Promise<Receipt<ConnectorServer | { ended: true }>> {
  const result = await call('connectors.set', { serverId: row.server.id, tool: { name: row.tool.name, standing: false } });
  if (!result.ok && result.outcome === 'UNKNOWN') throw new Error(result.detail);
  if (result.ok && 'tools' in result.value && result.value.tools.some((tool) => tool.name === row.tool.name && tool.standing)) {
    throw new Error('The connection still reports a permission. Check its current status.');
  }
  return result;
}
