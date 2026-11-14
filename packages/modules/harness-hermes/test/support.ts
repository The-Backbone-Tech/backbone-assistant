// Shared by the harness tests: a fake ToolHost, a fake Hermes set up per test, and request helpers.
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarnessEvent, HarnessTurn, ModelRoute, ToolFile, ToolHost, TurnRequest, WriteOutcome } from '@backbone-next/platform/ports';
import { createHermesHarness, type HermesHarnessOptions } from '../src/index.ts';
import { FakeHermes, type FakeOptions } from './fake-hermes.ts';

export const note: ToolFile & { text: string } = { name: 'note.md', version: 1, by: 'person', class: 'original', mediaType: 'text/markdown', text: '# Revenue\nUp 4%.' };
export const route: ModelRoute = { kind: 'endpoint', provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', model: 'scripted-1', label: 'Scripted model', credential: null };
export const request = (extra: Partial<TurnRequest> = {}): TurnRequest => ({ threadId: 'thread-1', turnId: 'turn-1', text: 'Draft a brief', history: [], attachments: [], effort: 3, resumed: false, ...extra });
export const write = (name = 'brief.md', content = '# Brief') => ({ tool: 'door_write_file', args: { name, content } });

export async function freePort() {
  const { createServer } = await import('node:net');
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address() as { port: number };
  await new Promise((r) => s.close(r));
  return port;
}

export function fakeHost(files: (ToolFile & { text: string })[], onWrite?: (signal: AbortSignal, n: number) => Promise<WriteOutcome>) {
  const writes: { name: string; body: string; base: { targetVersion: number | null; sources: { name: string; version: number }[] } }[] = [];
  const reads: string[] = [];
  /** Calls to the unconditional write, which this adapter must never make. */
  const unconditional: string[] = [];
  const host: ToolHost = {
    list: async () => files.map(({ text: _t, ...f }) => f),
    read: async (name) => {
      reads.push(name);
      return files.find((f) => f.name === name) ?? null;
    },
    write: async (name) => {
      unconditional.push(name);
      return { outcome: 'REFUSED', detail: 'Unconditional writes are not this adapter\'s crossing.' };
    },
    writeIfVersion: async (name, body, base, signal) => {
      writes.push({ name, body, base });
      return onWrite ? onWrite(signal, writes.length) : { outcome: 'DONE', name, version: writes.length };
    },
  };
  return { host, writes, reads, unconditional };
}

export async function drain(events: AsyncIterable<HarnessEvent>) {
  const all: HarnessEvent[] = [];
  for await (const e of events) all.push(e);
  return all;
}

export async function setup(fake: Partial<FakeOptions> = {}, options: Partial<HermesHarnessOptions> = {}) {
  const apiKey = `canary-${randomUUID()}`;
  const gateToken = `canary-${randomUUID()}`;
  const gatePort = await freePort();
  const journalDir = await mkdtemp(join(tmpdir(), 'backbone-hermes-test-'));
  const hermes = await new FakeHermes({ apiKey, gateUrl: `http://127.0.0.1:${gatePort}`, gateToken, ...fake }).listen();
  const make = (extra: Partial<HermesHarnessOptions> = {}) => createHermesHarness({ baseUrl: hermes.url, apiKey: async () => apiKey, gate: { host: '127.0.0.1', port: gatePort, token: gateToken }, journalDir, planeModel: { baseUrl: route.baseUrl, model: route.model }, stopTimeoutMs: 400, lostAfterMs: 300, settleMs: 200, ...options, ...extra });
  const harness = make();
  return {
    hermes, harness, make, journalDir, apiKey, gateToken, gatePort,
    async done() {
      await harness.close();
      await hermes.close().catch(() => undefined);
      await rm(journalDir, { recursive: true, force: true });
    },
  };
}

export const context = (tools: ToolHost, extra: { credential?: (h: string) => Promise<string>; route?: ModelRoute } = {}) => ({ tools, route: extra.route ?? route, credential: extra.credential ?? (async () => { throw new Error('Hermes must never resolve a credential in this cut.'); }) });
export const run = async (turn: HarnessTurn) => {
  const [events, outcome] = await Promise.all([drain(turn.events), turn.outcome]);
  return { events, outcome };
};
export const tools = (events: HarnessEvent[], phase?: string) => events.filter((e): e is Extract<HarnessEvent, { type: 'tool' }> => e.type === 'tool' && (!phase || e.phase === phase));
