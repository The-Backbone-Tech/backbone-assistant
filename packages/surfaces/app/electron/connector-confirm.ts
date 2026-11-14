// Main owns the questions; the renderer may request them but cannot supply a stamp or an answer.
import { type BrowserWindow, dialog, type MessageBoxOptions } from 'electron';
import type { ConnectorServer, HeldCall, Receipt, ConnectorEffectResolution } from '@backbone-next/platform';
import type { Host } from '@backbone-next/platform/composition';
import { enableDialog, toolsDialog, openDialog, readDialog, releaseDialog, standingDialog, resolutionDialog } from './connector-dialog.ts';
import { CONNECTOR_CANCEL } from '../src/lib/connector-cancel.ts';

const exactCall = (effect: unknown, hash: unknown) => typeof effect === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(effect) && typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash);
const refused = <T>(detail: string): Receipt<T> => ({ ok: false, reason: 'NOT_AVAILABLE', detail, outcome: 'REFUSED' });
const show = (win: BrowserWindow | null, o: MessageBoxOptions) => (win ? dialog.showMessageBox(win, o) : dialog.showMessageBox(o));

export async function confirmRelease(host: Host, win: BrowserWindow | null, request: unknown): Promise<Receipt<HeldCall>> {
  const { effect, argsHash } = (request ?? {}) as { effect?: unknown; argsHash?: unknown };
  if (!exactCall(effect, argsHash)) return refused('No exact call to permit.');
  const view = await host.call('connectors.list', {});
  const held = view.held.find((h) => h.effect === effect && h.argsHash === argsHash && h.state === 'waiting');
  if (!held) return refused('That call is not waiting for you, or its statement changed.');
  const open = view.servers.find((s) => s.id === held.serverId)?.egress === true;
  if ((await show(win, releaseDialog(held, open))).response !== 0) return refused(CONNECTOR_CANCEL.release);
  const current = (await host.call('connectors.list', {})).held.find(h => h.effect === effect && h.argsHash === argsHash && h.state === 'waiting');
  if (!current || current.statement !== held.statement || JSON.stringify(current.args) !== JSON.stringify(held.args)) return refused('The exact call changed while you were asked. Nothing was permitted.');
  return host.releaseConnectorCall(effect as string, argsHash as string);
}

export async function confirmEnable(host: Host, win: BrowserWindow | null, request: unknown): Promise<Receipt<ConnectorServer>> {
  const { serverId, tool } = (request ?? {}) as { serverId?: unknown; tool?: unknown };
  if (typeof serverId !== 'string' || (tool !== undefined && typeof tool !== 'string')) return refused('No such connector.');
  await host.call('connectors.list', {});
  const view = await host.connectorEnableView(serverId, tool);
  if (!view || view.server.blocked) return refused('This connector cannot be turned on.');
  const t = tool === undefined ? undefined : view.server.tools.find((t) => t.name === tool);
  if (tool !== undefined && !t) return refused('No such tool.');
  if ((await show(win, enableDialog(view.server, t))).response !== 0) return refused(CONNECTOR_CANCEL.enable);
  return host.enableConnector(serverId, tool, view.stamp);
}

export async function confirmToolsEnable(host: Host, win: BrowserWindow | null, serverId: unknown): Promise<Receipt<ConnectorServer>> {
  if (typeof serverId !== 'string') return refused('No such server.');
  const view = await host.connectorToolsEnableView(serverId);
  if (!view) return refused('No tools are ready to turn on. Turn the server on and list its tools first.');
  const tools = view.tools.map((name) => view.server.tools.find((t) => t.name === name)!);
  if ((await show(win, toolsDialog(view.server, tools, view.remaining))).response !== 0) return refused(CONNECTOR_CANCEL.enable);
  return host.enableConnectorTools(serverId, view.tools, view.stamp);
}

export async function confirmOpen(host: Host, win: BrowserWindow | null, serverId: unknown): Promise<Receipt<ConnectorServer>> {
  if (typeof serverId !== 'string') return refused('No such server.');
  const server = (await host.call('connectors.list', {})).servers.find((s) => s.id === serverId);
  if (!server?.enabled) return refused('Turn the server on first.');
  const view = host.connectorDoorView(serverId);
  if (!view) return refused('No such server.');
  if ((await show(win, openDialog(view))).response !== 0) return refused(CONNECTOR_CANCEL.open);
  return host.openConnectorDoor(serverId, view.seal);
}

export async function confirmStanding(host: Host, win: BrowserWindow | null, request: unknown): Promise<Receipt<ConnectorServer>> {
  const { serverId, tool } = (request ?? {}) as { serverId?: unknown; tool?: unknown };
  if (typeof serverId !== 'string' || typeof tool !== 'string') return refused('No such tool.');
  const server = (await host.call('connectors.list', {})).servers.find((s) => s.id === serverId);
  const t = server?.tools.find((x) => x.name === tool);
  if (!server || !t) return refused('No such tool.');
  if (!server.enabled || !server.egress) return refused('Allow sending to this server first.');
  if (!t.enabled || t.kind !== 'effect') return refused(t.kind === 'read' ? 'This tool only reads, so it already runs without asking.' : 'Turn the tool on first.');
  const view = host.connectorToolView(serverId, tool);
  if (!view) return refused('This tool cannot be permitted as it is now. Look again.');
  if ((await show(win, standingDialog(tool, view))).response !== 0) return refused(CONNECTOR_CANCEL.sign);
  return host.signConnectorTool(serverId, tool, view.seal, view.stamp, false).catch(() => ({ ok: false, reason: 'NOT_AVAILABLE', outcome: 'UNKNOWN', detail: 'The Core permission could not be confirmed. Inspect its receipt before trying again.' }));
}

export async function confirmRead(host: Host, win: BrowserWindow | null, request: unknown): Promise<Receipt<ConnectorServer>> {
  const { serverId, tool, asServer } = (request ?? {}) as { serverId?: unknown; tool?: unknown; asServer?: unknown };
  if (typeof serverId !== 'string' || typeof tool !== 'string' || (asServer !== undefined && typeof asServer !== 'boolean')) return refused('No such tool.');
  const server = (await host.call('connectors.list', {})).servers.find((s) => s.id === serverId);
  const t = server?.tools.find((x) => x.name === tool);
  if (!server || !t) return refused('No such tool.');
  if ((await show(win, readDialog(server, t))).response !== 0) return refused(CONNECTOR_CANCEL.read);
  return host.markConnectorToolRead(serverId, tool, asServer === true);
}

/** The renderer supplies an identity only. Main owns the three answers and takes the click. */
export async function confirmResolution(host: Host, win: BrowserWindow | null, request: unknown): Promise<Receipt<ConnectorEffectResolution>> {
  const { effect, argsHash } = (request ?? {}) as { effect?: unknown; argsHash?: unknown };
  if (!exactCall(effect, argsHash)) return refused('No unknown call on that exact statement.');
  const question = await host.connectorEffectDecisions.question(effect as string, argsHash as string);
  if (!question.ok) return question;
  const held = (await host.call('connectors.list', {})).held.find(h => h.effect === effect && h.argsHash === argsHash && h.state === 'unknown');
  if (!held || held.statement !== question.value.statement) return refused('The unknown call changed before it could be shown.');
  const response = (await show(win, resolutionDialog(question.value, held))).response;
  const answer = (['happened', 'did_not_happen', 'keep_closed'] as const)[response];
  if (!answer) return refused(CONNECTOR_CANCEL.resolve);
  const current = await host.connectorEffectDecisions.question(effect as string, argsHash as string);
  if (!current.ok || JSON.stringify(current.value) !== JSON.stringify(question.value)) return refused('The unknown call changed while you were asked. Nothing was resolved.');
  const latest = (await host.call('connectors.list', {})).held.find(h => h.effect === effect && h.argsHash === argsHash && h.state === 'unknown');
  if (!latest || latest.dispatchedAt !== held.dispatchedAt || latest.standingSignatureId !== held.standingSignatureId) return refused('The dispatch evidence changed while you were asked. Nothing was resolved.');
  return host.connectorEffectDecisions.resolve({ effect: effect as string, argsHash: argsHash as string, answer });
}
