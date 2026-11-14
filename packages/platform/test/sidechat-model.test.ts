// Contract for a model-backed side chat. It uses a local scripted endpoint and an isolated home,
// never a real provider or account. R-UX-SIDECHAT-01 and J-01 A3 need a named effect refusal.
import assert from 'node:assert/strict';
import { after, before, test, type TestContext } from 'node:test';
import { createHost, hostClosed, removeDataHome, type Host } from '../src/composition/host.ts';
import { freshDataHome } from '../src/testing/data-home.ts';
import { startScriptedModel, type Message, type ScriptedModel, type Step } from '../src/testing/scripted-model.ts';
import { b64, idle, settings, value } from './helpers.ts';

const words = (m: Message) => typeof m.content === 'string' ? m.content : (m.content ?? []).map((c) => c.text ?? '').join('');
const lastUser = (messages: Message[]) => words(messages.findLast((m) => m.role === 'user')!);
const sideRequest = (messages: Message[]) => /SIDE-(?:READ|ATTEMPT|OTHER|LOSS)/.test(lastUser(messages));
const posts = (model: ScriptedModel) => model.requests.filter((r) => r.body && r.body.includes('"messages"'));
let model: ScriptedModel;
let savedEndpoint: string | undefined;
let savedModel: string | undefined;
const attempted = { write: 0, other: 0 };

function script(messages: Message[]): Step {
  const question = lastUser(messages);
  if (question.includes('SIDE-READ')) {
    const start = messages.findLastIndex((m) => m.role === 'user');
    const result = messages.slice(start + 1).find((m) => m.role === 'tool');
    if (!result) return { calls: [{ name: 'read_file', args: { name: 'source.md' } }] };
    return { text: `MODEL-SIDE-ANSWER ${words(result)}` };
  }
  if (question.includes('SIDE-ATTEMPT')) {
    const start = messages.findLastIndex((m) => m.role === 'user');
    const result = messages.slice(start + 1).find((m) => m.role === 'tool');
    if (!result) { attempted.write++; return { calls: [{ name: 'write_file', args: { name: 'working.md', content: 'MALICIOUS OVERWRITE' } }] }; }
    return { text: `MODEL-TOOL-RESULT ${words(result)}` };
  }
  if (question.includes('SIDE-OTHER')) {
    const start = messages.findLastIndex((m) => m.role === 'user');
    const result = messages.slice(start + 1).find((m) => m.role === 'tool');
    if (!result) { attempted.other++; return { calls: [{ name: 'read_file', args: { name: 'secret.md' } }] }; }
    return { text: `MODEL-READ-RESULT ${words(result)}` };
  }
  if (question.includes('MAIN-QUESTION-ANCHOR')) {
    const start = messages.findLastIndex((m) => m.role === 'user');
    const result = messages.slice(start + 1).find((m) => m.role === 'tool');
    if (!result) return { calls: [{ name: 'write_file', args: { name: 'working.md', content: 'MAIN-WORKING-ORIGINAL' } }] };
    return { text: 'MAIN-ANSWER-ANCHOR' };
  }
  return { text: 'OTHER-MODEL-ANSWER' };
}

before(async () => {
  savedEndpoint = process.env.BACKBONE_MODEL_ENDPOINT;
  savedModel = process.env.BACKBONE_MODEL_ID;
  model = await startScriptedModel('sidechat-contract', script, {
    before(messages) {
      if (lastUser(messages).includes('SIDE-LOSS')) return { status: 503, message: 'scripted side model unavailable' };
    },
  });
  process.env.BACKBONE_MODEL_ENDPOINT = model.url;
  process.env.BACKBONE_MODEL_ID = model.model;
});
after(async () => {
  if (savedEndpoint === undefined) delete process.env.BACKBONE_MODEL_ENDPOINT; else process.env.BACKBONE_MODEL_ENDPOINT = savedEndpoint;
  if (savedModel === undefined) delete process.env.BACKBONE_MODEL_ID; else process.env.BACKBONE_MODEL_ID = savedModel;
  await model.close();
});

async function setup(t: TestContext) {
  const home = freshDataHome('sidechat-contract');
  const hosts = new Set<Host>();
  const close = (host: Host) => { if (hosts.delete(host)) host.close(); };
  t.after(async () => {
    for (const host of hosts) close(host);
    await removeDataHome(home);
  });
  const open = () => {
    const host = createHost({ home, harness: 'harness-pi' });
    hosts.add(host);
    void host.resumeInterrupted().catch(() => {});
    return host;
  };
  const host = open();
  const p = value(await host.call('projects.create', { name: 'Side chat A', kind: 'folder' }));
  const secret = value(await host.call('projects.create', { name: 'Side chat B', kind: 'folder' }));
  const source = value(await host.call('material.attach', { projectId: p.id, name: 'source.md', base64: b64('PERSON-SOURCE-ANCHOR'), mediaType: 'text/markdown' }));
  value(await host.call('material.attach', { projectId: secret.id, name: 'secret.md', base64: b64('OTHER-PROJECT-SECRET'), mediaType: 'text/markdown' }));
  const sent = value(await host.call('turns.send', { projectId: p.id, text: 'MAIN-QUESTION-ANCHOR', attachments: [], settings, clientKey: 'main' }));
  const main = await idle(host, sent.threadId);
  assert.equal(main.turns[0].answer?.text, 'MAIN-ANSWER-ANCHOR', 'positive control: this host reached the local model');
  const working = (await host.call('material.list', { projectId: p.id })).find((entry) => entry.name === 'working.md');
  assert.ok(working, 'positive control: the main turn can write an ordinary working document');
  assert.equal(main.turns[0].effects.at(-1)?.outcome, 'DONE');
  return { host, home, open, close, project: p.id, thread: sent.threadId, source, working };
}

test('side chat uses the thread route, its prior context and current project source; its result survives a cold start', async (t) => {
  const s = await setup(t);
  const before = posts(model).length;
  const answer = value(await s.host.call('sidechat.ask', { threadId: s.thread, text: 'SIDE-READ: explain the current source' }));
  const later = posts(model).slice(before).map((r) => JSON.parse(r.body) as { model: string; messages: Message[] });
  const requests = later.filter((r) => sideRequest(r.messages));
  assert.ok(requests.length, 'the side question must actually reach the configured model');
  assert.ok(requests.every((r) => r.model === model.model), 'the pinned local model receives the side question');
  assert.match(JSON.stringify(requests[0].messages), /MAIN-QUESTION-ANCHOR/);
  assert.match(JSON.stringify(requests[0].messages), /MAIN-ANSWER-ANCHOR/);
  assert.doesNotMatch(JSON.stringify(requests), /OTHER-PROJECT-SECRET/);
  assert.equal(answer.status, 'done');
  assert.match(answer.answer?.text ?? '', /MODEL-SIDE-ANSWER[\s\S]*PERSON-SOURCE-ANCHOR/);
  assert.equal(answer.effects.length, 0);
  const thread = value(await s.host.call('threads.get', { id: s.thread }));
  assert.equal(thread.turns.length, 1, 'the consultation does not enter the main transcript');
  assert.equal(thread.sideTurns.at(-1)?.id, answer.id);
  s.close(s.host);
  await hostClosed(s.home);
  const again = s.open();
  const restored = value(await again.call('threads.get', { id: s.thread }));
  assert.equal(restored.sideTurns.at(-1)?.answer?.text, answer.answer?.text);
});

test('an unsolicited model write cannot alter the original or dispatch an effect', async (t) => {
  const s = await setup(t);
  const before = posts(model).length;
  const attemptedBefore = attempted.write;
  const response = await s.host.call('sidechat.ask', { threadId: s.thread, text: 'SIDE-ATTEMPT: inspect this' });
  const requests = posts(model).slice(before).map((r) => JSON.parse(r.body) as { messages: Message[]; tools?: { function?: { name?: string } }[] });
  const side = requests.find((r) => sideRequest(r.messages));
  assert.ok(side, 'exercise a model call, not an intent-matching stub');
  assert.ok(attempted.write > attemptedBefore, 'the model actually attempted the forbidden call');
  assert.ok(!side.tools?.some((t) => t.function?.name === 'write_file'), 'Pi is not offered a write tool');
  const after = value(await s.host.call('material.read', { id: s.working.id }));
  assert.equal(after.text, 'MAIN-WORKING-ORIGINAL');
  const entry = (await s.host.call('material.list', { projectId: s.project })).find((m) => m.id === s.working.id);
  assert.equal(entry?.current, s.working.current);
  assert.ok(response.ok);
  assert.equal(response.value.effects.length, 0);
  assert.equal(response.value.status, 'refused');
  assert.equal(response.value.refusal?.reason, 'SIDE_CHAT_READ_ONLY');
  assert.match(response.value.refusal.detail, /not performed/i);
});

test('a side model cannot read a file present only in a different project', async (t) => {
  const s = await setup(t);
  const before = posts(model).length;
  const attemptedBefore = attempted.other;
  const response = await s.host.call('sidechat.ask', { threadId: s.thread, text: 'SIDE-OTHER: inspect the other document' });
  const requests = posts(model).slice(before).map((r) => JSON.parse(r.body) as { messages: Message[] });
  assert.ok(requests.some((r) => sideRequest(r.messages)), 'the attempted read must come from the side model');
  assert.ok(attempted.other > attemptedBefore, 'the model actually attempted the other project read');
  assert.doesNotMatch(JSON.stringify(requests), /OTHER-PROJECT-SECRET/);
  if (response.ok) assert.doesNotMatch(response.value.answer?.text ?? '', /OTHER-PROJECT-SECRET/);
});

test('a failed model call is not recorded as a successful answer', async (t) => {
  const s = await setup(t);
  const before = posts(model).length;
  const response = await s.host.call('sidechat.ask', { threadId: s.thread, text: 'SIDE-LOSS: answer this' });
  const called = posts(model).slice(before).some((r) => sideRequest((JSON.parse(r.body) as { messages: Message[] }).messages));
  assert.ok(called, 'the failure must come from the side call, not a stub');
  if (response.ok) {
    assert.notEqual(response.value.status, 'done');
    assert.ok(response.value.refusal?.detail || response.value.answer?.text, 'the existing side panel needs a visible reason when an accepted turn fails');
  } else assert.ok(response.detail, 'an unaccepted side question keeps its draft and needs a reason');
  const stored = value(await s.host.call('threads.get', { id: s.thread }));
  assert.ok(stored.sideTurns.every((t) => t.user.text !== 'SIDE-LOSS: answer this' || t.status !== 'done'));
});
