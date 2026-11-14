// The same ToolHost consumer contract through each registered engine's real test transport.
// Codex's executable is a fake: this does not qualify a real client, sandbox or account.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HARNESSES } from '../src/composition/harnesses.ts';
import type { HarnessV1, ToolHost, TurnContext, TurnRequest } from '../src/ports/harness.ts';
import { startScriptedModel } from '../src/testing/scripted-model.ts';

const thrownMessage = 'Synthetic Host failure; preserve this message in Pi.';
const codexError = { contentItems: [{ type: 'inputText', text: 'Host refused the tool call or could not return its result.' }], success: false };
const acpError = { isError: true, content: [{ type: 'text', text: 'Tool result unavailable or request refused. Consult the host receipts; never retry an uncertain write.' }] };

const cases = [
  { method: 'searchMemory', name: 'memory_search', args: { query: 'launch' }, argument: 'launch', answer: 'Memory answer: data, never permission.' },
  { method: 'proposeMemory', name: 'propose_memory', args: { text: 'Prefers short reports', topic: 'preferences' }, argument: { text: 'Prefers short reports', topic: 'preferences' }, answer: 'Held for the person.' },
  { method: 'proposeGoal', name: 'propose_goal', args: { text: 'Review the launch' }, argument: 'Review the launch', answer: 'Proposed. The goal stands until the person decides.' },
  { method: 'messageCard', name: 'message_card', args: { card: 'peer-card', text: 'Found the launch date' }, argument: { card: 'peer-card', text: 'Found the launch date' }, answer: 'Sent to card peer-card (running).' },
] as const;

for (const engine of Object.keys(HARNESSES)) for (const c of cases) {
  test(`${engine}: ${c.name} delivers Host data and continues after refusal`, {}, async () => {
    const root = await mkdtemp(join(tmpdir(), 'engine-tools-'));
    const calls: unknown[] = [];
    let refused = false, thrown = false;
    const tools: ToolHost = {
      list: async () => [], read: async () => null, write: async () => ({ outcome: 'REFUSED', detail: 'No writes' }),
      [c.method]: async (argument: unknown) => {
        calls.push(argument);
        if (thrown) throw new Error(thrownMessage);
        if (refused) {
          if (c.method === 'messageCard') return { outcome: 'REFUSED', reason: 'card_unavailable', detail: 'Host refused the card.' };
          if (c.method === 'proposeGoal') throw new Error('Host refused the goal.');
          return 'Host refused the proposal or lookup.';
        }
        return c.method === 'messageCard' ? { outcome: 'SENT', state: 'running' } : c.method === 'proposeGoal' ? undefined : c.answer;
      },
    };
    let model: Awaited<ReturnType<typeof startScriptedModel>> | undefined;
    let harness: HarnessV1 & { close?: () => Promise<void> };
    const context: TurnContext = { tools, route: { kind: 'native', provider: 'codex', baseUrl: '', model: 'test-model', label: 'fake', credential: null }, credential: async () => { throw new Error('No credentials'); } };
    const toolName = engine === 'harness-acp' && c.name === 'memory_search' ? 'search_memory' : c.name;
    try {
      const modulePath = `../../modules/${engine}/src/index.ts`;
      const module = await import(modulePath);
      if (engine === 'harness-pi') {
        model = await startScriptedModel('scripted-model', messages => {
          const results = messages.filter(m => m.role === 'tool');
          return results.length ? { text: JSON.stringify({ results, continued: true }) } : { calls: [{ name: toolName, args: c.args }] };
        });
        context.route = { kind: 'endpoint', provider: 'openai-compatible', baseUrl: model.url, model: model.model, label: 'scripted', credential: null };
        harness = module[HARNESSES[engine].factory]();
      } else if (engine === 'harness-codex') harness = module[HARNESSES[engine].factory]({ command: [process.execPath, join(import.meta.dirname, '../../modules/harness-codex/test/fixtures/native.mjs'), 'host-tools'], temporaryRoot: root, requestTimeoutMs: 5000, turnTimeoutMs: 10000 });
      else {
        context.route = { ...context.route, kind: 'agent', provider: 'acp:fake' };
        // This fake tests ToolHost results, not OS confinement. Restricted-writes is macOS-only;
        // exercise the explicit supported person-rights route elsewhere, as ACP's own helpers do.
        harness = module[HARNESSES[engine].factory]({ acceptsProcessVisibility: true, environment: process.platform === 'darwin' ? 'restricted-writes' : 'person-rights', command: process.execPath, args: [join(import.meta.dirname, 'fixtures/engine-tools-acp.mjs')], storageDir: join(root, 'acp'), requestTimeoutMs: 5000, turnTimeoutMs: 10000 });
      }
      try {
        for (const mode of ['answer', 'refused', 'thrown']) {
          refused = mode === 'refused'; thrown = mode === 'thrown';
          const request: TurnRequest = { threadId: 'thread', turnId: refused ? 'refused' : 'allowed', text: 'HOST_TOOL_CALLS:' + JSON.stringify([{ name: toolName, args: c.args }]), history: [], attachments: [], effort: 3, resumed: false };
          const outcome = await harness.start(request, context).outcome;
          assert.equal(outcome.status, 'done', outcome.error ?? '');
          assert.deepEqual(calls.splice(0), [c.argument]);
          const answer = JSON.parse(outcome.answer);
          assert.equal(answer.continued, true);
          if (thrown || (refused && c.method === 'proposeGoal')) {
            const result = answer.results[0];
            if (engine === 'harness-pi') assert.equal(result.content, thrown ? thrownMessage : 'Host refused the goal.');
            else assert.deepEqual(result, engine === 'harness-codex' ? codexError : acpError);
            continue;
          }
          const expected = engine === 'harness-acp' && c.method === 'proposeGoal' ? (refused ? 'request refused' : 'Proposal held for the person.') : engine === 'harness-acp' && c.method === 'messageCard' && !refused ? 'running' : refused ? 'Host refused' : c.answer;
          assert.ok(outcome.answer.includes(expected), outcome.answer);
        }
      } finally { await harness.close?.(); }
    } finally { await model?.close(); await rm(root, { recursive: true, force: true }); }
  });
}
