import assert from 'node:assert/strict';
import { test } from 'node:test';
import { freshDir, settings } from './helpers.ts';
import { serveApiLine, type LineAsk } from '../src/composition/api-line.ts';
import { attachApi } from '../src/doors/api-line.ts';
import { choose } from '../src/selection/choose.ts';
import { pinFor, pinnedRoute, withNamedModel } from '../src/selection/pin.ts';
import { routeFingerprint } from '../src/selection/route-identity.ts';

// No native client or model is contacted. The stand-in uses the real pin/continuation/dispatch gates.
test('native selection refuses a different named model before asking and binds matching or default models', async () => {
  const configured = { kind: 'native' as const, provider: 'codex' as const, baseUrl: '', model: 'gpt-5-mini', label: 'Codex · gpt-5-mini · Codex sign-in', credential: null };
  const route = { id: 'codex', kind: 'native-engine' as const, label: configured.label, model: configured.model, fingerprint: routeFingerprint(configured), capabilities: ['model' as const], network: true, spends: 'metered' as const, eligible: true };
  const questions: LineAsk[] = [], dispatched: string[] = [];
  let childModel = 'gpt-5-pro';
  const home = freshDir('selection-native-approval-');
  const server = await serveApiLine({ home, confirm: async ask => { questions.push(ask); return true; }, call: (async (method: string, args: any) => {
    if (method === 'projects.list') return [{ id: 'p', name: 'Approval', kind: 'folder' }];
    if (method === 'threads.get') return { ok: true, value: { summary: { id: 'child', projectId: 'p', title: 'Helper' }, turns: [], child: { settings: { ...settings, model: childModel } } } };
    if (method === 'solutions.options') return choose([route], args);
    if (method === 'solutions.run') {
      const selected = choose([route], args.task);
      assert.ok(selected.choice);
      const pin = pinFor(selected.choice.route, [], args.task, { runtimes: [] }, configured);
      assert.ok('selection' in pin);
      const named = withNamedModel(pin.selection, args.settings.model, false);
      assert.ok('selection' in named);
      const target = pinnedRoute(named.selection, configured);
      assert.ok('route' in target); dispatched.push(target.route.model);
      return { ok: true, value: { selection: selected, started: { threadId: 't', turnId: 'u' }, detail: 'Dispatched' } };
    }
    throw new Error(`Unexpected method ${method}`);
  }) as never });
  const line = await attachApi(home); assert.ok(line);
  const request = (model: string, threadId?: string) => line.call('solutions.run', { projectId: 'p', ...(threadId ? { threadId } : {}), text: 'Write a brief', task: { needs: ['model'], network: true, spend: 'metered' }, settings: { ...settings, model }, clientKey: model });
  try {
    const refused = await request('gpt-5-pro');
    assert.equal(refused.ok, false);
    assert.equal(questions.length, 0, 'a different native model is refused before confirmation');
    assert.deepEqual(dispatched, []);
    const longName = await line.call('solutions.run', { projectId: 'p', text: 'Write', task: { needs: ['model'], network: true, spend: 'metered' }, settings: { ...settings, model: configured.model }, clientKey: 'name', caller: { mcp: 'x'.repeat(61) } });
    assert.equal(longName.ok, false);
    assert.equal(questions.length, 0, 'an oversized client name cannot reach a question');
    const childRefused = await request(configured.model, 'child');
    assert.equal(childRefused.ok, false, 'the child’s admitted model also cannot replace the shown model');
    assert.equal(questions.length, 0);
    childModel = configured.model;
    const childAccepted = await request('gpt-5-pro', 'child');
    assert.ok(childAccepted.ok, 'a child keeps its admitted model even when the caller names another');
    const childQuestion = questions.at(-1); assert.ok(childQuestion && 'model' in childQuestion);
    assert.equal(childQuestion.model, configured.model);
    assert.equal(dispatched.at(-1), childQuestion.model);
    for (const model of [configured.model, 'stub', 'none']) {
      const result = await request(model); assert.ok(result.ok);
      const question = questions.at(-1); assert.ok(question && 'model' in question);
      assert.equal(question.model, dispatched.at(-1));
      assert.equal(question.model, configured.model);
    }
  } finally { line.close(); await server.close(); }
});

test('MCP questions distinguish a claimed name from an absent name', async () => {
  const { askWords } = await import('../src/composition/api-line.ts');
  const ask = { method: 'solutions.run' as const, projectId: 'p', project: 'Test', thread: 'new', text: 'Write', task: { needs: ['model' as const], network: true, spend: 'metered' as const }, spend: 'metered' as const, ...settings };
  const named = askWords({ ...ask, caller: { mcp: 'client' } }, 'App').detail;
  assert.match(named, /An MCP client asked for this/);
  assert.match(named, /It calls itself: "client"/);
  const unnamed = askWords({ ...ask, caller: { mcp: null } }, 'App').detail;
  assert.match(unnamed, /did not supply a name/);
  assert.ok(!unnamed.includes('self-reported') && !unnamed.includes('calls itself'));
});
