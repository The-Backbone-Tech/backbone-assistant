import type { Args, Receipt, Schedule } from '@backbone-next/platform';
import type { Host } from '@backbone-next/platform/composition';
import { isAbsolute } from 'node:path';

interface Confirmation {
  type: 'warning'; buttons: string[]; defaultId: number; cancelId: number; message: string; detail: string;
}
const refused = (detail: string): Receipt<Schedule> => ({ ok: false, reason: 'NOT_AVAILABLE', outcome: 'REFUSED', detail });
const confirming = new WeakSet<Pick<Host, 'call'>>();

/** Main owns the immutable request and the native click. No renderer-provided approval is accepted. */
export async function confirmWakeGate(host: Pick<Host, 'call'>, request: unknown, show: (options: Confirmation) => Promise<{ response: number }>): Promise<Receipt<Schedule>> {
  // Refuse overlapping page requests instead of queueing native dialogs. Hold through the write too.
  if (confirming.has(host)) return refused('A script wake gate is already awaiting confirmation.');
  confirming.add(host);
  try { return await askWakeGate(host, request, show); }
  finally { confirming.delete(host); }
}

async function askWakeGate(host: Pick<Host, 'call'>, request: unknown, show: (options: Confirmation) => Promise<{ response: number }>): Promise<Receipt<Schedule>> {
  if (!request || typeof request !== 'object') return refused('No wake gate was requested.');
  const copied = structuredClone(request) as { method?: unknown; args?: Record<string, unknown> };
  if (!copied.args || typeof copied.args !== 'object' || !['schedules.create', 'schedules.update'].includes(String(copied.method))) return refused('No wake gate was requested.');
  const args = copied.args;
  const patch = args.patch as Record<string, unknown> | undefined;
  const gate = (copied.method === 'schedules.create' ? args.wakeGate : patch?.wakeGate) as { command?: unknown; args?: unknown; timeoutMs?: unknown } | null | undefined;
  if (gate === undefined || (copied.method === 'schedules.create' && gate === null)) return refused('No wake gate was requested.');
  if (gate !== null && (typeof gate.command !== 'string' || !isAbsolute(gate.command) || !Array.isArray(gate.args) || gate.args.some(a => typeof a !== 'string') || gate.command.length + gate.args.join('').length > 16_384)) return refused('Use an absolute program and an explicit argument array.');
  let current: Schedule | undefined;
  if (copied.method === 'schedules.update') {
    if (typeof args.id !== 'string' || !Number.isInteger(args.baseVersion)) return refused('Select the schedule version you saw.');
    current = (await host.call('schedules.get', {})).schedules.find(s => s.id === args.id);
    if (!current || current.version !== args.baseVersion) return refused('The schedule changed. Load it again before confirming.');
  }
  // JSON quoting shows argument boundaries and escapes newlines/control characters without truncation.
  const visible = (value: unknown, space?: number) => (JSON.stringify(value, null, space) ?? 'null').replace(/[\p{Cf}\p{Zl}\p{Zp}]/gu, c => `\\u{${c.codePointAt(0)!.toString(16)}}`);
  const program = gate === null ? `Remove this script check: ${visible(current?.wakeGate)}` : `Program: ${visible(gate.command)}\nArguments: ${visible(gate.args)}\nDeadline: ${gate.timeoutMs ?? 5_000} ms`;
  const context = current ? `\nSchedule: ${visible(current.text)}\nWhen: ${visible(current.when)}\nProject: ${visible(current.projectId)}` : '';
  const detail = `${program}${context}\n\nExact schedule request:\n${visible(args, 2)}\n\nThis trusted program runs with your OS rights, without a model or an OS sandbox. Use a read-only check and keep secrets out of arguments.`;
  if ((await show({ type: 'warning', buttons: ['Allow this wake gate', 'Cancel'], defaultId: 1, cancelId: 1, message: 'Allow this exact script wake gate?', detail })).response !== 0) return refused('The script wake gate was not allowed.');
  return copied.method === 'schedules.create'
    ? host.call('schedules.create', args as unknown as Args<'schedules.create'>)
    : host.call('schedules.update', args as unknown as Args<'schedules.update'>);
}
