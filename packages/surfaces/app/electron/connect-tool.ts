// The person's confirmation of a tool's permission, owned by the main process. A native dialog
// shows the actual grant (tool, operations, ceiling, expiry), computed here from the door's own
// declaration; one click on Connect approves it, and "Change…" narrows it. The renderer can only
// ask for this flow to start: connecting is not a method of the api transport it reaches.
import { type BrowserWindow, dialog, type MessageBoxOptions } from 'electron';
import { type AiTool, type AiToolId, CEILING_WORDS, type ConnectTool, type Receipt } from '@backbone-next/platform';
import type { Host } from '@backbone-next/platform/composition';
import { brand } from '../src/brand';
import { permissionWords } from '../src/lib/permission';

const TOOLS: AiToolId[] = ['claude-code', 'codex', 'cursor', 'claude-desktop'];
const DAY = 86_400_000;
const refused = (reason: 'NOT_FOUND' | 'NOT_AVAILABLE', detail: string): Receipt<AiTool> => ({ ok: false, reason, detail, outcome: 'REFUSED' });

export async function confirmAndConnect(host: Host, win: BrowserWindow | null, tool: unknown): Promise<Receipt<AiTool>> {
  if (!TOOLS.includes(tool as AiToolId)) return refused('NOT_FOUND', 'No such tool.');
  const { tools, offer } = await host.call('tools.list', {});
  const found = tools.find((t) => t.id === tool);
  if (!offer || !found) return refused('NOT_AVAILABLE', 'Connecting AI tools is not available here.');
  const name = found.name;
  const choice: Required<ConnectTool> = { tool: found.id, operations: offer.operations, ceiling: offer.ceiling, days: offer.days, askEachCall: false };
  const show = (o: MessageBoxOptions) => (win ? dialog.showMessageBox(win, o) : dialog.showMessageBox(o));
  for (;;) {
    const words = permissionWords({ operations: choice.operations, ceiling: choice.ceiling, expiresAt: new Date(Date.now() + choice.days * DAY).toISOString() }, brand.name);
    // After an update changed the door, the same window asks to approve it again: one click.
    const asked = await show({
      type: 'question',
      title: `Connect ${name}`,
      message: found.update ? `${brand.name} was updated. Approve ${name} again?` : `Connect ${name} to ${brand.name}?`,
      detail: `${name} may: ${words}${choice.askEachCall ? ' · asks you before each call' : ''}\n\nAnything riskier waits for you. You can disconnect at any time.`,
      buttons: ['Connect', 'Change…', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    if (asked.response === 0) return host.connectTool(choice);
    if (asked.response !== 1) return refused('NOT_AVAILABLE', 'Not connected: you cancelled.');
    // Narrowing only: the choices stop at what the door declares.
    const ceilings = Array.from({ length: offer.ceiling }, (_, i) => i + 1);
    const risk = await show({
      type: 'question',
      title: `Connect ${name}`,
      message: 'Without asking you, up to',
      detail: 'Anything above this waits for you in the app.',
      buttons: [...ceilings.map((c) => CEILING_WORDS[c]), 'Back'],
      defaultId: ceilings.indexOf(choice.ceiling),
      cancelId: ceilings.length,
      ...(found.id === 'codex' ? { checkboxLabel: 'Codex also asks me before each call', checkboxChecked: choice.askEachCall } : {}),
      noLink: true,
    });
    if (risk.response < ceilings.length) {
      choice.ceiling = ceilings[risk.response];
      if (found.id === 'codex') choice.askEachCall = !!risk.checkboxChecked;
    }
    const spans = [...new Set([1, 7, offer.days])].filter((d) => d <= offer.days);
    const span = await show({
      type: 'question',
      title: `Connect ${name}`,
      message: 'For how long?',
      buttons: [...spans.map((d) => (d === 1 ? 'Until tomorrow' : `${d} days`)), 'Back'],
      defaultId: spans.indexOf(choice.days),
      cancelId: spans.length,
      noLink: true,
    });
    if (span.response < spans.length) choice.days = spans[span.response];
  }
}
