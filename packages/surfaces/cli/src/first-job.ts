// First-job commands are thin clients of the same Host settings and material methods as the app.
import { closeSync, constants, fstatSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { terminalModelHint } from '@backbone-next/platform';
import type { LocalProvider, MaterialEntry, Project, Receipt } from '@backbone-next/platform';
import type { Api, Io, Parsed } from './commands.ts';

import {MAX_ATTACHMENT_BYTES} from '@backbone-next/platform/doors/api-line';
export {MAX_ATTACHMENT_BYTES} from '@backbone-next/platform/doors/api-line';

export function attachFile(api: Api, projectId: string, path: string): Promise<Receipt<MaterialEntry>> {
  let bytes: Buffer; let fd: number | undefined;
  const refuse = (detail: string): Receipt<MaterialEntry> => ({ ok: false, outcome: 'REFUSED', reason: 'INVALID', detail });
  try {
    const target = resolve(path), before = statSync(target);
    if (!before.isFile()) return Promise.resolve(refuse('Attach requires a regular file; symlinks must point to a regular file. Nothing was attached.'));
    if (before.size > MAX_ATTACHMENT_BYTES) return Promise.resolve(refuse('An attachment must be at most 25 MiB. Nothing was attached.'));
    fd = openSync(target, constants.O_RDONLY | constants.O_NONBLOCK);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > MAX_ATTACHMENT_BYTES) return Promise.resolve(refuse('Attach requires the same regular file of at most 25 MiB. Nothing was attached.'));
    // Bounded even if the file grows after stat; never read a special device or an unlimited stream.
    const buffer = Buffer.alloc(opened.size + 1); let n = 0;
    while (n < buffer.length) { const read = readSync(fd, buffer, n, buffer.length - n, null); if (!read) break; n += read; }
    if (n > opened.size) return Promise.resolve(refuse('The attachment grew while being read. Nothing was attached; inspect it and try again.'));
    bytes = buffer.subarray(0, n);
  } catch { return Promise.resolve({ ok: false, outcome: 'REFUSED', reason: 'NOT_FOUND', detail: `Cannot read attachment ${path}. Nothing was attached.` }); }
  finally { if (fd !== undefined) closeSync(fd); }
  const mediaType = ({ '.csv': 'text/csv', '.md': 'text/markdown', '.txt': 'text/plain', '.json': 'application/json', '.pdf': 'application/pdf', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } as Record<string, string>)[extname(path).toLowerCase()] ?? 'application/octet-stream';
  return api.call('material.attach', { projectId, name: basename(path), base64: bytes.toString('base64'), mediaType });
}
export async function firstJobCommand(parsed: Parsed, api: Api, io: Io, project: () => Promise<Project>): Promise<number | undefined> {
  if (!['engine', 'model', 'files attach', 'files read', 'files save'].includes(parsed.name)) return undefined;
  const selectedProject = parsed.name.startsWith('files ') ? await project() : undefined;
  const say = (value: unknown, line: string) => io.out(parsed.json ? JSON.stringify(value, null, 2) : line);
  class Refusal extends Error { readonly receipt: Exclude<Receipt<unknown>, { ok: true }>; constructor(receipt: Exclude<Receipt<unknown>, { ok: true }>) { super(receipt.detail); this.receipt = receipt; } }
  const value = <T>(receipt: Receipt<T>) => { if (!receipt.ok) throw new Refusal(receipt); return receipt.value; };
  try {
    if (parsed.name === 'engine') {
      if (!parsed.target) { const settings = await api.call('settings.model.get', {}); say(settings, `Engine: ${settings.harness}\nRoute: ${settings.active?.label ?? terminalModelHint(settings.hint ?? 'none')}`); }
      else { const stored = value(await api.call('settings.engine.put', { engine: parsed.target })); say(stored, stored.detail); }
      return 0;
    }
    if (parsed.name === 'model') {
      const model = parsed.options.model!;
      const change = parsed.target === 'codex' ? { route: 'native' as const, provider: 'codex' as const, model }
        : { route: 'local' as const, provider: (parsed.options.runtime ?? 'other') as LocalProvider, baseUrl: parsed.options.endpoint!, model };
      const settings = value(await api.call('settings.model.put', { change: parsed.target === 'shared local' ? { route: 'shared', change } : change }));
      say(settings, `Engine: ${settings.harness}\nRoute: ${settings.active?.label ?? terminalModelHint(settings.hint ?? 'none')}${parsed.target === 'shared local' ? `\nShared work: Pi · ${settings.shared?.active?.label ?? 'not configured'}` : ''}${settings.localNote ? `\n${settings.localNote}` : ''}`);
      return 0;
    }
    const projectId = selectedProject!.id;
    if (parsed.name === 'files attach') {
      const entry = value(await attachFile(api, projectId, parsed.target!)); say(entry, `Attached ${entry.name} v${entry.current} (${entry.id}). Original bytes kept; available to this project's turns.`); return 0;
    }
    const entries = await api.call('material.list', { projectId });
    if (!Array.isArray(entries)) { io.err('REFUSED (NOT_AVAILABLE): The app or background service holding this data folder does not list documents on its CLI line. Read them in the app, or stop the service first.'); return 1; }
    const matches = entries.filter(e => e.id === parsed.target || e.name === parsed.target);
    if (matches.length !== 1) { io.err(`REFUSED (NOT_FOUND): Name one document in this project by its name or material id: ${parsed.target}.`); return 1; }
    const entry = matches[0];
    if (parsed.name === 'files read') {
      const read = value(await api.call('material.read', { id: entry.id, version: parsed.options.version }));
      if (read.text === undefined) { io.err('REFUSED (INVALID): This is not a text document. Read it with the app or export it.'); return 1; }
      say(read, read.text); return 0;
    }
    // Require the version the person actually inspected, including for accept-without-edit.
    // The Host's compare-and-swap refuses a concurrent engine revision.
    const baseVersion = parsed.options.baseVersion!;
    const read = value(await api.call('material.read', { id: entry.id, version: baseVersion }));
    let text = read.text;
    if (parsed.options.from) { try { text = readFileSync(resolve(parsed.options.from), 'utf8'); } catch { io.err(`REFUSED (NOT_FOUND): Cannot read ${parsed.options.from}. Nothing was saved.`); return 1; } }
    if (text === undefined) { io.err('REFUSED (INVALID): Only text documents can be saved here.'); return 1; }
    const saved = value(await api.call('material.save', { id: entry.id, text, baseVersion }));
    say(saved, `Saved ${saved.name} v${saved.current} · person · accepted (based on v${baseVersion}).`); return 0;
  } catch (error) {
    if (error instanceof Refusal) { const r = error.receipt; io.err(`${r.outcome} (${r.reason}): ${r.detail}`); return r.outcome === 'UNKNOWN' ? 4 : 1; }
    // A transport exception after a write is never claimed as a refusal or retried.
    io.err(`Unknown outcome: the call did not return. Read the settings or document before repeating it. ${(error as Error).message}`); return 4;
  }
}
