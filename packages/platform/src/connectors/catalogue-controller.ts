import type { CatalogueApp, CatalogueConnection, CatalogueId, CataloguePreset, CatalogueDisconnect } from '../api-catalogue.ts';
import type { ConnectorServer, Receipt } from '../api.ts';
import type { Discovered } from './discover.ts';
import type { ListedTool, McpSession } from './client.ts';
import type { ConnectorService } from './service.ts';
import { CatalogueStore, type CatalogueRuntime } from './catalogue-store.ts';
import { CATALOGUE_READS, catalogueClass, catalogueId, catalogueServerId } from './catalogue.ts';
import type { HomeKeys } from '../keys/vault.ts';

export interface CataloguePort {
  launch(id: string): Discovered | null;
  session(id: string, launch: Discovered): Promise<McpSession>;
  service: Pick<ConnectorService, 'list' | 'set' | 'refresh' | 'enableStamp'>;
  stop(id: string): Promise<void>;
  admission?(): void;
}
/** A native setup operation grants no egress or standing signature. Its only direct tool calls
 * are the maintained server's OAuth bootstrap and a fixed read to confirm sign-in. */
export class CatalogueController {
  readonly store: CatalogueStore;
  private readonly port: CataloguePort;
  constructor(home: string, keys: HomeKeys | undefined, port: CataloguePort, runtime?: CatalogueRuntime) {
    this.port = port;
    this.store = new CatalogueStore(home, keys, runtime);
  }
  async connect(id: CatalogueId, app: CatalogueApp, open: (url: string) => Promise<void>, preset: CataloguePreset = 'reads'): Promise<Receipt<CatalogueConnection>> {
    if (!catalogueId(id)) return this.refused('No such catalogue entry.');
    const serverId = catalogueServerId(id);
    let installedHere = false;
    try {
      this.port.admission?.();
      const installed = await this.store.install(id, app, open, preset);
      installedHere = true;
      const listed = await this.port.service.refresh(serverId);
      if (!listed.ok || listed.value.problem) { await this.disconnect(id); return this.refused('Sign-in setup failed. Local access was removed; inspect the provider revocation receipt.'); }
      if (id === 'calendar' || id === 'drive') {
        const launch = this.port.launch(serverId); if (!launch) throw new Error('The installed connector changed.');
        const session = await this.port.session(serverId, launch);
        if (this.port.launch(serverId)?.launch.catalogue?.instance !== installed.instance) return this.refused('The connection was cancelled or changed.');
        const allowed = this.store.runtime.googleAuthorizationOrigin ?? 'https://accounts.google.com';
        const started = await session.startGoogleAuthorization(id, app.email!, allowed, async target => { this.port.admission?.(); await open(target); },
          () => this.port.launch(serverId)?.launch.catalogue?.instance === installed.instance);
        if (!started) { await this.disconnect(id); return this.refused('Google sign-in could not be started. Local access was removed; inspect the provider revocation receipt.'); }
        return { ok: true, value: { id, serverId, state: 'awaiting-google' } };
      }
      return { ok: true, value: { id, serverId, state: 'ready' } };
    } catch { if (installedHere) await this.disconnect(id); return this.refused('The connector was not connected. Check its provider revocation receipt and OAuth app configuration before starting again.'); }
  }
  async finish(id: CatalogueId): Promise<Receipt<CatalogueConnection>> {
    if (!catalogueId(id)) return this.refused('No such catalogue entry.');
    const serverId = catalogueServerId(id), launch = this.port.launch(serverId);
    if (!launch?.launch.catalogue || launch.launch.catalogue.id !== id) return this.refused('Connect this catalogue entry first.');
    try {
      this.port.admission?.();
      const session = await this.port.session(serverId, launch);
      const resolved = await this.store.resolve(launch.launch);
      const tool = id === 'calendar' ? 'list_calendars' : id === 'drive' ? 'list_drive_items' : id === 'github' ? 'get_me' : undefined;
      if (tool) {
        const live = (await session.tools()).find(t => t.name === tool);
        if (!live || catalogueClass(id, tool, live.annotations) !== 'read') return this.refused('The sign-in check is no longer a read tool. Nothing was called.');
        const answer = await session.call(tool, id === 'calendar' || id === 'drive' ? { user_google_email: resolved.env?.USER_GOOGLE_EMAIL } : {}, new AbortController().signal);
        if (!answer.observed || answer.status !== 'complete' || /https?:\/\/accounts\.google\.com|authentication|authenticate|sign.?in|\*\*error/i.test(answer.text)) return this.refused('Complete sign-in in your browser before finishing.');
      }
      await this.store.resolve(launch.launch); // Verify scopes again after the provider read may refresh credentials.
      const listed = await this.port.service.refresh(serverId);
      return listed.ok && !listed.value.problem ? { ok: true, value: { id, serverId, state: 'ready' } } : this.refused('The connected server could not be listed.');
    } catch { await this.disconnect(id); return this.refused('Sign-in could not be verified. The connector stays off.'); }
  }
  async activate(id: CatalogueId, preset: CataloguePreset, stamp: string): Promise<Receipt<ConnectorServer>> {
    if (!catalogueId(id) || !['reads', 'reads-and-effects'].includes(preset) || typeof stamp !== 'string') return this.refused('Invalid catalogue preset.');
    const launch = this.port.launch(catalogueServerId(id));
    if (!launch?.launch.catalogue || launch.launch.catalogue.preset !== preset) return this.refused('Disconnect and reconnect to change provider scopes or server mode.');
    try { await this.store.resolve(launch.launch); } catch { return this.refused('This installation changed. Nothing was enabled.'); }
    return this.port.service.set(catalogueServerId(id), { enabled: true, enableStamp: stamp, preset });
  }
  question(id: CatalogueId): Receipt<{ server: ConnectorServer; stamp: string }> {
    if (!catalogueId(id)) return this.refused('No such catalogue entry.');
    const serverId = catalogueServerId(id), server = this.port.service.list().servers.find(s => s.id === serverId && s.catalogue === id);
    const stamp = this.port.service.enableStamp(serverId);
    return server?.listedAt && !server.problem && stamp ? { ok: true, value: { server: { ...server, tools: server.tools.map(tool => ({ ...tool,
      kind: tool.kind === 'read' && CATALOGUE_READS[id].includes(tool.name) ? 'read' : 'effect' })) }, stamp } } : this.refused('List this catalogue connection before choosing a preset.');
  }
  async disconnect(id: CatalogueId): Promise<Receipt<CatalogueDisconnect>> {
    if (!catalogueId(id)) return this.refused('No such catalogue entry.');
    this.store.cancel(id);
    try {
      let stopped = true;
      try { await this.port.stop(catalogueServerId(id)); } catch { stopped = false; }
      const cleanup = await this.store.disconnect(id);
      if (!stopped) return this.refused('Provider cleanup was attempted and the server was stopped; local authority cleanup needs inspection.');
      return { ok: true, value: { disconnected: true, ...cleanup } };
    } catch { return this.refused('The connector is off, but credential cleanup needs inspection.'); }
  }
  private refused<T>(detail: string): Receipt<T> { return { ok: false, reason: 'NOT_AVAILABLE', outcome: 'REFUSED', detail }; }
}

/** Called synchronously inside the service's existing stamped home write. Never creates a read
 * override: a preset can only narrow the upstream hints and the released name floor. */
export function applyCataloguePreset(id: CatalogueId, tools: Record<string, { enabled: boolean; definition: string; listed: ListedTool; override?: 'read' | 'effect'; standing?: unknown; rev?: number }>, preset: CataloguePreset, revision: () => number) {
  for (const tool of Object.values(tools)) {
    const effect = tool.override === 'effect' || catalogueClass(id, tool.listed.name, tool.listed.annotations) === 'effect';
    if (effect) { tool.override = 'effect'; delete tool.standing; }
    tool.enabled = tool.listed.name !== 'start_google_auth' && (!effect || preset === 'reads-and-effects');
    tool.definition = tool.listed.definitionDigest ?? tool.definition;
    tool.rev = revision();
  }
}
