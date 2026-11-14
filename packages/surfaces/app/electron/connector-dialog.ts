import { exactText } from '../src/lib/connector-call.ts';
export { exactText } from '../src/lib/connector-call.ts';
// App-owned decisions precede bounded server text. Raw identities are used only by the Host;
// their display forms here cannot add lines, directional formatting or an unbounded description.
import type { MessageBoxOptions } from 'electron';
import type { ConnectorServer, ConnectorTool, HeldCall, ConnectorEffectQuestion } from '@backbone-next/platform';

export function connectorText(value: string, limit = 600): string {
  const chars = Array.from(value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/gu, ' ').trim());
  return chars.length > limit ? `${chars.slice(0, limit - 1).join('')}…` : chars.join('');
}
const name = (value: string) => connectorText(value, 120);
const annotation = (t: ConnectorTool) => t.annotated === 'read' ? 'The server says it only reads.'
  : t.annotated === 'effect' ? 'The server says it can change things.'
    : 'The server does not say what it does, so it counts as a change.';
const kind = (t: ConnectorTool) => t.kind === 'read' ? 'This tool will run as a read without asking each time.'
  : 'This tool counts as a change; actions stay held unless you separately permit it to act without asking.';
const toolText = (t: ConnectorTool, descriptionLimit = 600) => `Tool: ${name(t.name)}${t.title ? `\nTitle supplied by server: ${name(t.title)}` : ''}\n${annotation(t)}\n${kind(t)}\nDescription supplied by server: ${connectorText(t.description, descriptionLimit)}`;
const question = (title: string, message: string, detail: string, button: string): MessageBoxOptions => ({
  type: 'warning', title, message, detail, buttons: [button, 'Cancel'], defaultId: 1, cancelId: 1, noLink: true,
});

export function enableDialog(server: ConnectorServer, tool?: ConnectorTool): MessageBoxOptions {
  return tool ? question('Turn on a tool', 'Turn on this tool for every engine?',
    `${kind(tool)}\n\nServer: ${name(server.name)}\n${toolText(tool)}`, 'Turn on')
    : question('Turn on a server', 'Turn on this server for every engine?',
      `This lets every engine use this server’s enabled tools. Read tools run without asking each time. ${server.plugin ? 'This also allows the plugin to run its command to list its tools.' : 'Each tool must also be turned on.'}\n\nServer: ${name(server.name)}\nLaunch supplied by config: ${connectorText(server.shown)}`, 'Turn on');
}

export function toolsDialog(server: ConnectorServer, tools: ConnectorTool[], remaining: number): MessageBoxOptions {
  const more = remaining ? ` ${remaining} more tools stay off. Choose “Turn on its tools” again to review the next group of up to 8.` : '';
  const action = tools.length === 1 ? 'Turn on this tool' : `Turn on these ${tools.length} tools`;
  return question('Turn on tools', `${action}?`,
    `Read tools will run without asking; tools that change things stay held unless separately permitted. Only the listed tools are turned on.${more}\n\nServer: ${name(server.name)}\n\n${tools.map((t, i) => `${i + 1}. ${toolText(t, 120)}`).join('\n\n')}`,
    action);
}

export function openDialog(view: { name: string; shown: string }): MessageBoxOptions {
  return question('Allow sending', 'Allow permitted calls to leave this app?',
    `Permitted calls are sent once; permitted tools may act without asking. Turning the server off closes this again. While its launch, account or configuration differs, nothing is sent; putting it back exactly restores this permission. An account switched through the server’s own sign-in without a config change is not detected.\n\nServer: ${name(view.name)}\nLaunch supplied by config: ${connectorText(view.shown)}`, 'Allow sending');
}

const ARGUMENT_LIMIT = 1500, VALUE_LIMIT = 600;
function releaseArguments(held: HeldCall) {
  const encoded = exactText(held.args);
  const fields = Object.entries(held.args).map(([key, value], index) => {
    const text = exactText(value), scalar = value === null || typeof value !== 'object';
    const size = typeof value === 'string' ? value.length : text.length;
    const normal = key.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
    const priority = /^(to|cc|bcc|recipients?)$/.test(normal) ? 0 : normal === 'subject' ? 1 : /(?:^|_)ids?$/.test(normal) ? 2 : 3;
    return { key, value, text, size, index, priority, rank: size > VALUE_LIMIT ? 2 : scalar ? 0 : 1 };
  }).sort((a, b) => Number(a.rank === 2) - Number(b.rank === 2) || a.priority - b.priority || a.rank - b.rank || a.index - b.index);
  const large = encoded.length > ARGUMENT_LIMIT || fields.some(f => f.size > VALUE_LIMIT) || exactText(held.statement).length > ARGUMENT_LIMIT;
  if (!large) return { large, detail: `Recorded statement: ${exactText(held.statement)}\nArguments: ${exactText(Object.fromEntries(fields.map(f => [f.key, f.value])))}` };
  const lines: string[] = []; let used = 0, omitted = 0;
  for (const field of fields) {
    const line = `${exactText(field.key)}: ${field.text}`;
    if (field.size > VALUE_LIMIT || used + line.length + 1 > ARGUMENT_LIMIT) { omitted++; continue; }
    lines.push(line); used += line.length + 1;
  }
  return { large, detail: `Short arguments (preview):\n${lines.join('\n') || 'No short fields fit this preview.'}\n${omitted ? `${omitted} argument${omitted === 1 ? '' : 's'} omitted from this preview.` : 'The recorded statement is omitted from this preview.'}\nArgument hash: ${held.argsHash ?? 'Not available.'}\nArguments length: ${encoded.length} JSON characters\nThe full call is in Connected tools. Read it there before releasing this call.` };
}

export function releaseDialog(held: HeldCall, open: boolean): MessageBoxOptions {
  const args = releaseArguments(held);
  return question('Permit an action', open ? 'Send this one approved call?' : 'Record this permission without sending?',
    `${args.large ? 'This approves only the recorded call identified below.' : 'This approves only the exact call below.'} ${open ? 'It will be sent once.' : 'Sending is closed: the permission is recorded and nothing is sent.'} ${args.large ? 'This is a preview, not the full call.' : 'The quoted statement and JSON arguments below are complete; escape sequences represent their exact characters.'}\n\nServer: ${name(held.serverName)}\nTool: ${name(held.tool)}\n${args.detail}`, open ? 'Send' : 'Permit');
}

type SigningView = { name: string; description: string; shown: string; blocklisted: boolean; destructive?: boolean;
  argumentNames?: string[]; additionalArgumentNames?: number; sendingArguments?: boolean; argumentWarning?: string };
export function standingDialog(tool: string, view: SigningView): MessageBoxOptions {
  const capabilities = [view.blocklisted ? 'Its name indicates an outside action such as sending, paying or deleting.' : '',
    view.destructive ? 'The server marks this tool as destructive.' : '', view.sendingArguments ? view.argumentWarning : ''].filter(Boolean).join(' ');
  const names = (view.argumentNames ?? []).slice(0, 20).map(value => exactText(connectorText(value, 120))).join(', ') || 'Not listed by the server.';
  return question('Act without asking', 'Allow this tool to act without asking?',
    `Every call to this tool goes out without asking you each time, including sending arguments. ${capabilities} Each call is recorded with its outcome. This applies only while the tool and server are exactly as permitted, with the same configured account and settings. Turning either off, closing sending or ending the permission ends it. An unknown outcome pauses this tool’s permission until you resolve it; you may still permit one new call yourself. Text an assistant reads can lead it to call this tool; permit only what you would let it do unattended.\n\nServer: ${name(view.name)}\nTool: ${name(tool)}\nArgument names supplied by server: ${names}${view.additionalArgumentNames ? `; ${view.additionalArgumentNames} more names` : ''}\nLaunch supplied by config: ${connectorText(view.shown)}\nDescription supplied by server: ${connectorText(view.description)}`, 'Act without asking');
}

export function resolutionDialog(view: ConnectorEffectQuestion, evidence: Pick<HeldCall, 'dispatchedAt' | 'standingSignatureId'> = {}): MessageBoxOptions {
  return { type: 'warning', title: 'Resolve an unknown call', message: 'What happened to this call?',
    detail: `Record only what you know. This never sends the original call again. “I do not know” keeps this tool’s permission paused; conclusive answers resume it once every unknown for this tool is resolved.\n\nCore dispatch admitted: ${connectorText(evidence.dispatchedAt ?? 'Not available.', 80)} (not proof of delivery).\nPermission: ${connectorText(evidence.standingSignatureId ?? 'Not available.', 80)}\nExact recorded statement: ${exactText(view.statement)}\nEffect: ${view.effect}`,
    buttons: ['It did happen', 'It did not happen', 'I do not know, keep it closed', 'Cancel'], defaultId: 3, cancelId: 3, noLink: true };
}

export function readDialog(server: ConnectorServer, tool: ConnectorTool): MessageBoxOptions {
  return question('Treat as a read', 'Treat this tool as a read without asking?',
    `Every call will run without waiting for you and bypass the egress door. Name rules still prevent a sending tool from being treated as a read on the server’s word alone.\n\nServer: ${name(server.name)}\n${toolText({ ...tool, kind: 'read' })}`, 'Treat as a read');
}
