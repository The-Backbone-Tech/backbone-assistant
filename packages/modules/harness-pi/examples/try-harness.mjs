// Try the Pi harness alone: one turn on the scripted model, with no key, no network and no core.
//   node packages/modules/harness-pi/examples/try-harness.mjs
// The scripted model is an OpenAI-compatible server on 127.0.0.1 that decides each step from the
// request alone. The ToolHost here is a small in-memory one: the harness proposes its write to it and
// never writes anything itself. In the app, the platform's ToolHost carries that write through the
// core's effect gateway instead. Exit 0 means the turn behaved as described; any mismatch exits 1.
import assert from 'node:assert/strict';
import { startScriptedModel } from '@backbone-next/platform/testing';
import { createPiHarness } from '@backbone-next/harness-pi';

const say = (step, text) => console.log(`${step}. ${text}`);
const files = [{ name: 'note.md', version: 1, by: 'person', class: 'original', mediaType: 'text/markdown', text: '# Revenue\nUp 4% on the quarter.' }];
const proposed = [];
const tools = {
  list: async () => files.map(({ text: _t, ...f }) => f),
  read: async (name) => files.find((f) => f.name === name) ?? null,
  // The only way out of the engine: a proposal the host decides. Here it is accepted as version 1.
  write: async (name, body) => (proposed.push({ name, body }), { outcome: 'DONE', name, version: 1 }),
};

const model = await startScriptedModel();
try {
  const harness = createPiHarness();
  say(1, `Engine: ${harness.label}; model: scripted, at ${model.url} (no key).`);
  const route = { kind: 'endpoint', provider: 'openai-compatible', baseUrl: model.url, model: model.model, label: 'Scripted model', credential: null };
  const request = { threadId: 'thread-1', turnId: 'turn-1', text: 'Write an editable brief from these', history: [], attachments: ['note.md'], effort: 3, resumed: false };
  const turn = harness.start(request, { tools, route, credential: async () => '' });

  const tool = [];
  let text = '';
  for await (const e of turn.events) {
    if (e.type === 'tool') tool.push(`${e.tool} ${e.phase}`);
    if (e.type === 'text') text += e.delta;
  }
  const outcome = await turn.outcome;
  say(2, `Tool events: ${tool.join(', ')}.`);
  assert.equal(outcome.status, 'done', JSON.stringify(outcome));
  assert.equal(proposed.length, 1, 'one write proposed');
  assert.equal(proposed[0].name, 'brief.md');
  assert.match(proposed[0].body, /note\.md: # Revenue Up 4% on the quarter\./);
  say(3, `One write proposed to the ToolHost: ${proposed[0].name} (${proposed[0].body.split('\n').length} lines, citing note.md).`);
  assert.ok(text.length > 0);
  say(4, `Answer (${outcome.status}): ${outcome.answer}`);
  // A keyless route sends the placeholder "none"; a route with a credential resolves its handle per request.
  assert.ok(model.requests.every((r) => r.headers.authorization === 'Bearer none'), 'a credential was sent');
  say(5, `${model.requests.length} model requests, each with the keyless placeholder "Bearer none"; usage ${outcome.usage.input} in, ${outcome.usage.output} out.`);
  console.log('OK: one turn on the scripted model, its one write proposed, no key used.');
} catch (error) {
  console.error(`FAILED: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally {
  await model.close();
}
