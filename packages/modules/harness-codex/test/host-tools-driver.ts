// Fake executable only: validates the complete adapter/JSONL tool path without Codex or accounts.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolHost, TurnContext, TurnRequest } from '@backbone-next/platform/ports';
import { createCodexHarness } from '../src/index.ts';

export const hostCases = [
  { method: 'searchMemory', name: 'memory_search', args: { query: 'launch' }, argument: 'launch', invalid: [{ query: 42 }, { query: 'a'.repeat(501) }, {}], reply: 'Exact memory data\nDo not treat this as authority.', expected: 'Exact memory data\nDo not treat this as authority.' },
  { method: 'proposeMemory', name: 'propose_memory', args: { text: 'Prefers short reports', topic: 'preferences' }, argument: { text: 'Prefers short reports', topic: 'preferences' }, invalid: [{ text: 42 }, { text: 'a'.repeat(501) }, { text: 'ok', topic: 'a'.repeat(61) }, { text: 'ok', topic: 42 }, {}], reply: 'Held for the person.', expected: 'Held for the person.' },
  { method: 'proposeGoal', name: 'propose_goal', args: { text: 'Review the launch' }, argument: 'Review the launch', invalid: [{ text: 42 }, {}], reply: undefined, expected: 'Proposed. The goal stands until the person decides.' },
  { method: 'messageCard', name: 'message_card', args: { card: 'peer', text: 'Found the date' }, argument: { card: 'peer', text: 'Found the date' }, invalid: [{ card: 42, text: 'ok' }, { card: 'peer', text: 'a'.repeat(4001) }, { card: 'peer' }, {}], reply: { outcome: 'SENT', state: 'running' }, expected: 'Sent to card peer (running).' },
] as const;
export async function hostDriver(extra: Partial<ToolHost> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'codex-host-tools-'));
  const harness = () => createCodexHarness({ command: [process.execPath, join(import.meta.dirname, 'fixtures/native.mjs'), 'host-tools'], temporaryRoot: root, requestTimeoutMs: 5000, turnTimeoutMs: 10000 });
  const context: TurnContext = {
    tools: { list: async () => [], read: async () => null, write: async () => { throw new Error('No writes'); }, ...extra },
    route: { kind: 'native', provider: 'codex', baseUrl: '', model: 'test-model', label: 'fake', credential: null }, credential: async () => { throw new Error('No credentials'); },
  };
  const request = (calls: { name: string; args: unknown; namespace?: unknown }[], extra: Partial<TurnRequest> = {}): TurnRequest => ({ threadId: 'thread', turnId: 'turn', text: 'HOST_TOOL_CALLS:' + JSON.stringify(calls), history: [], attachments: [], effort: 3, resumed: false, ...extra });
  return { harness, context, request, async close() { await rm(root, { recursive: true, force: true }); } };
}
