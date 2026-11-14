// Capture the actual provider request, after Pi's schema conversion and argument validation.
import { startScriptedModel } from '@backbone-next/platform/testing';
import type { HarnessV1, ToolHost, TurnRequest } from '@backbone-next/platform/ports';
import { createPiHarness } from '../src/index.ts';

export async function probeHostTools(harness: HarnessV1 = createPiHarness()) {
  const queries: string[] = [];
  const model = await startScriptedModel('scripted-model', messages => messages.some(m => m.role === 'tool') ? { text: 'continued' } : { calls: [{ name: 'memory_search', args: { query: null } }] });
  const tools: ToolHost = {
    list: async () => [], read: async () => null, write: async () => { throw new Error('No writes'); },
    searchMemory: async query => { queries.push(query); return 'Host data'; },
    proposeMemory: async () => 'Held', proposeGoal: async () => {}, messageCard: async () => ({ outcome: 'SENT', state: 'running' }),
  };
  const request: TurnRequest = { threadId: 'thread', turnId: 'turn', text: 'Probe memory', history: [], attachments: [], effort: 3, resumed: false };
  try {
    const outcome = await harness.start(request, { tools, route: { kind: 'endpoint', provider: 'openai-compatible', baseUrl: model.url, model: model.model, label: 'scripted', credential: null }, credential: async () => { throw new Error('No credentials'); } }).outcome;
    const declarations = JSON.parse(model.requests[0].body).tools.filter((t: { function: { name: string } }) => ['memory_search', 'propose_memory', 'propose_goal', 'message_card'].includes(t.function.name));
    return { outcome, declarations, queries };
  } finally { await model.close(); }
}
