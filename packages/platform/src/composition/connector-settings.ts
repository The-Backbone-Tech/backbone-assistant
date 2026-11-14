// The transport may only narrow connector authority. Runtime shapes are checked here too: a JSON
// caller has no TypeScript contract, and cannot hide another patch or a truthy enable in it.
import { dirname, join } from 'node:path';
import { launchFor } from '../connectors/discover.ts';
import { definitionOf } from '../connectors/service.ts';
import type { ListedTool } from '../connectors/client.ts';
import { readJson, sha256, writeJson } from '../stub/fsx.ts';
import type { ToolEnv } from '../tools/places.ts';
import { assertHomeWriteAdmission, withHomeLock } from './home-lock.ts';
import type { Args, ConnectorServer, Receipt } from '../api.ts';
import type { ConnectorService } from '../connectors/service.ts';

export const CONNECTOR_ENABLE_PERSON = 'Turning a connector on is done by the person in the desktop app.';
const refused = (detail: string): Receipt<ConnectorServer> => ({ ok: false, reason: 'NOT_AVAILABLE', outcome: 'REFUSED', detail });
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const only = (x: object, keys: string[]) => Object.keys(x).every((k) => keys.includes(k));

export function setConnectorFromApi(connectors: ConnectorService, args: Args<'connectors.set'>): Promise<Receipt<ConnectorServer>> | Receipt<ConnectorServer> {
  const invalid = () => refused('Invalid connector settings.');
  if (!object(args)) return invalid();
  const { serverId, enabled, egress, tool } = args;
  // Refuse before looking up a server: these words disclose nothing about a blocked server.
  if ((enabled !== undefined && enabled !== false) || (tool?.enabled !== undefined && tool.enabled !== false)) return refused(CONNECTOR_ENABLE_PERSON);
  if (egress !== undefined && egress !== false) return refused('Only the person allows sending, in the desktop app, where it asks them.');
  if (tool?.standing !== undefined && tool.standing !== false) return refused('Only the person signs a tool to act without asking, in the desktop app, where it asks them.');
  if (typeof serverId !== 'string' || !only(args, ['serverId', 'enabled', 'egress', 'tool'])) return invalid();
  if (tool !== undefined && (!object(tool) || typeof tool.name !== 'string' || !only(tool, ['name', 'enabled', 'override', 'standing'])
    || (tool.override !== undefined && tool.override !== null && tool.override !== 'read' && tool.override !== 'effect'))) return invalid();
  // Clearing a narrowing override on an annotated read would make its calls flow again.
  if (tool?.override === 'read' || (tool?.override === null && !connectors.readNeedsAsking(serverId, tool.name))) {
    return refused('Only the person says a tool only reads, in the desktop app, where it asks them.');
  }
  return connectors.set(serverId, { ...(enabled === undefined ? {} : { enabled }), ...(egress === undefined ? {} : { egress }), ...(tool ? { tool } : {}) });
}

interface ToolChoice { enabled?: boolean; definition?: string; listed: ListedTool; rev?: number; standing?: unknown }
interface Choice { enabled?: boolean; fingerprint?: string; connection?: { id: string }; rev?: number; tools?: Record<string, ToolChoice> }
interface Choices { servers: Record<string, Choice>; gen?: number; ver?: number }
const ENABLE_CHANGED = 'The connector changed while you were asked; nothing was turned on. Look again.';

/** Single enables recheck their native stamp again inside the service’s admitted write. Batch tools
 * use one synchronous, stamped file change under the home lock; no Core crossing runs there. */
export function connectorEnabling(home: string, env: () => ToolEnv, connectors: ConnectorService, emit: () => void, active: () => boolean) {
  const file = join(home, 'connectors', 'mcp.json');
  const choices = () => readJson<Choices>(file, { servers: {} });
  function snapshot(serverId: string, tool?: string) {
    try {
      const launch = launchFor(home, env(), serverId);
      const choice = choices().servers[serverId];
      const server = connectors.list().servers.find((s) => s.id === serverId);
      if (!launch || !server || server.blocked || (tool !== undefined && (!choice?.tools || !Object.hasOwn(choice.tools, tool)))) return null;
      // The view is bracketed by reads: refuse a listing/configuration that moved while it was built.
      const identity = () => JSON.stringify({ launch: launchFor(home, env(), serverId)?.launch, choice: choices().servers[serverId] });
      if (JSON.stringify({ launch: launch.launch, choice }) !== identity()) return null;
      return { server, fingerprint: launch.server.fingerprint, definition: tool === undefined ? undefined : definitionOf(choice!.tools![tool].listed),
        stamp: sha256(JSON.stringify({ launch: launch.launch, choice, server })) };
    } catch { return null; }
  }
  const batch = (serverId: string) => {
    const current = snapshot(serverId);
    if (!current?.server.enabled || !current.server.listedAt) return null;
    const pending = current.server.tools.filter((t) => !t.enabled).map((t) => t.name);
    const tools = pending.slice(0, 8);
    return tools.length ? { server: current.server, tools, remaining: pending.length - tools.length,
      stamp: sha256(JSON.stringify([current.stamp, tools])) } : null;
  };
  return {
    async toolsView(serverId: string) { if (!active()) return null; await connectors.ready(); return active() ? batch(serverId) : null; },
    async enableTools(serverId: string, tools: readonly string[], stamp: string): Promise<Receipt<ConnectorServer>> {
      if (!active() || typeof stamp !== 'string' || !stamp || !Array.isArray(tools)) return refused(ENABLE_CHANGED);
      await connectors.ready(); // all asynchronous preparation stays outside the home lock
      return withHomeLock(home, async () => {
        if (!active()) return refused(ENABLE_CHANGED);
        const shown = batch(serverId);
        if (!active() || !shown || shown.stamp !== stamp || JSON.stringify(shown.tools) !== JSON.stringify(tools)) return refused(ENABLE_CHANGED);
        const stored = choices();
        const version = stored.ver ?? 0;
        const choice = stored.servers[serverId];
        if (!choice?.enabled || !choice.connection?.id || !choice.tools) return refused(ENABLE_CHANGED);
        // Only off tools are granted, never signatures, overrides, egress or the server itself.
        for (const tool of tools) if (!Object.hasOwn(choice.tools, tool) || choice.tools[tool].standing) return refused(ENABLE_CHANGED);
        let gen = Math.max(stored.gen ?? 0, ...Object.values(stored.servers).flatMap((c) => [c.rev ?? 0, ...Object.values(c.tools ?? {}).map((t) => t.rev ?? 0)]));
        if (!Number.isSafeInteger(gen + tools.length) || !Number.isSafeInteger((stored.ver ?? 0) + 1)) return refused('The connector revision counter is exhausted. Nothing was turned on.');
        for (const tool of tools) {
          const t = choice.tools[tool];
          t.enabled = true; t.definition = definitionOf(t.listed); t.rev = ++gen;
        }
        stored.gen = gen; stored.ver = (stored.ver ?? 0) + 1;
        // Recheck the entire shown set and definition after building the candidate. Nothing has
        // been saved yet; no await separates this validation, write admission and the one save.
        if ((choices().ver ?? 0) !== version || batch(serverId)?.stamp !== stamp) return refused(ENABLE_CHANGED);
        assertHomeWriteAdmission(home, dirname(file));
        writeJson(file, stored);
        emit();
        return { ok: true, value: connectors.list().servers.find((s) => s.id === serverId)! };
      });
    },
    async view(serverId: string, tool?: string): Promise<{ server: ConnectorServer; stamp: string } | null> {
      if (!active()) return null;
      await connectors.ready();
      if (!active()) return null;
      const current = snapshot(serverId, tool);
      if (current?.server.plugin && choices().servers[serverId]?.enabled && !current.server.enabled) return null;
      return current ? { server: current.server, stamp: current.stamp } : null;
    },
    async enable(serverId: string, tool: string | undefined, stamp: string): Promise<Receipt<ConnectorServer>> {
      if (!active() || typeof stamp !== 'string' || !stamp) return refused(ENABLE_CHANGED);
      await connectors.ready();
      const shown = snapshot(serverId, tool);
      if (!active() || !shown || shown.stamp !== stamp || (shown.server.plugin && choices().servers[serverId]?.enabled && !shown.server.enabled)) return refused(ENABLE_CHANGED);
      return connectors.set(serverId, tool === undefined ? { enabled: true } : { tool: { name: tool, enabled: true } }, () => active() && snapshot(serverId, tool)?.stamp === stamp);
    },
  };
}
