// The renderer supplies an entry and a preset. App credentials come only from a native file
// picker, and main owns both the browser handoff and the exact live definition confirmation.
import { dialog, shell, type BrowserWindow, type MessageBoxOptions } from 'electron';
import { readFileSync, statSync } from 'node:fs';
import { CONNECTOR_CATALOGUE, type CatalogueApp, type CatalogueId, type CataloguePreset, type Receipt, type ConnectorServer } from '@backbone-next/platform';
import type { Host } from '@backbone-next/platform/composition';
import { connectorText } from './connector-dialog.ts';
import { catalogueConsent } from '../src/lib/catalogue-consent.ts';
const refused = <T>(detail: string): Receipt<T> => ({ ok: false, reason: 'NOT_AVAILABLE', outcome: 'REFUSED', detail });
const show = (win: BrowserWindow | null, options: MessageBoxOptions) => win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
function request(value: unknown): { id: CatalogueId; preset: CataloguePreset } | null {
  if (!value || typeof value !== 'object') return null;
  const { id, preset } = value as { id?: unknown; preset?: unknown };
  return CONNECTOR_CATALOGUE.some(entry => entry.id === id) && (preset === 'reads' || preset === 'reads-and-effects') ? { id: id as CatalogueId, preset } : null;
}
async function activate(host: Host, win: BrowserWindow | null, id: CatalogueId, preset: CataloguePreset): Promise<Receipt<ConnectorServer>> {
  const question = await host.connectorCatalogue.question(id); if (!question.ok) return question;
  const { server, stamp } = question.value;
  const tools = server.tools.filter(tool => tool.name !== 'start_google_auth' && (preset === 'reads-and-effects' || tool.kind === 'read'));
  const response = await show(win, { type: 'question', message: `Connect ${CONNECTOR_CATALOGUE.find(entry => entry.id === id)!.name} with these tools?`,
    detail: `Read tools run without asking each time. Tools that change things wait for permission under your existing rules. Sending stays closed. A changed definition requires a new choice.\n\n${tools.map(tool => `${connectorText(tool.name, 120)}: ${tool.kind === 'read' ? 'reads' : 'changes things; held'}`).join('\n')}`,
    buttons: ['Connect tools', 'Cancel'], defaultId: 1, cancelId: 1 });
  if (response.response !== 0) { await host.connectorCatalogue.disconnect(id); return refused('No tools were enabled. Local sign-in was removed; inspect its provider revocation receipt.'); }
  const activated = await host.connectorCatalogue.activate(id, preset, stamp);
  if (!activated.ok) await host.connectorCatalogue.disconnect(id);
  return activated;
}
export async function connectCatalogue(host: Host, win: BrowserWindow | null, value: unknown): Promise<Receipt<unknown>> {
  const input = request(value); if (!input) return refused('No such catalogue entry or preset.');
  const entry = CONNECTOR_CATALOGUE.find(entry => entry.id === input.id)!;
  const options = { title: `${entry.name}: choose your OAuth app JSON`, filters: [{ name: 'OAuth app JSON', extensions: ['json'] }], properties: ['openFile'] as ['openFile'] };
  const selected = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  if (selected.canceled || !selected.filePaths[0]) return refused('Sign-in was cancelled.');
  let app: CatalogueApp;
  try {
    const file = selected.filePaths[0], info = statSync(file);
    if (!info.isFile() || info.size > 16_384) return refused('Choose an OAuth app JSON file smaller than 16 KiB.');
    app = JSON.parse(readFileSync(file, 'utf8')) as CatalogueApp;
  } catch { return refused('The OAuth app file could not be read.'); }
  if ((await show(win, { type: 'question', message: `Sign in to ${entry.name}?`,
    detail: catalogueConsent(entry, input.preset),
    buttons: ['Sign in', 'Cancel'], defaultId: 1, cancelId: 1 })).response !== 0) return refused('Sign-in was cancelled.');
  const connected = await host.connectorCatalogue.connect(input.id, app, url => shell.openExternal(url), input.preset);
  if (!connected.ok || connected.value.state === 'awaiting-google') return connected;
  const verified = await host.connectorCatalogue.finish(input.id);
  if (!verified.ok) { await host.connectorCatalogue.disconnect(input.id); return verified; }
  return activate(host, win, input.id, input.preset);
}
export async function finishCatalogue(host: Host, win: BrowserWindow | null, value: unknown): Promise<Receipt<unknown>> {
  const input = request(value); if (!input) return refused('No such catalogue entry or preset.');
  const verified = await host.connectorCatalogue.finish(input.id); if (!verified.ok) return verified;
  return activate(host, win, input.id, input.preset);
}
export async function disconnectCatalogue(host: Host, id: unknown): Promise<Receipt<unknown>> {
  return CONNECTOR_CATALOGUE.some(entry => entry.id === id) ? host.connectorCatalogue.disconnect(id as CatalogueId) : refused('No such catalogue entry.');
}
