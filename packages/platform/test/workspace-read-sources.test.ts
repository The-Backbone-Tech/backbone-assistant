import { TEST_HANG_MS } from '../../../scripts/lib/test-hang.ts';
// Whole-case hang guard; product deadlines are asserted separately.
import assert from 'node:assert/strict';
import { enableConnector } from '../src/testing/connectors.ts';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { startScriptedModel, type Message } from '../src/testing/scripted-model.ts';
import { WorkspaceStore } from '../src/workspace/store.ts';
import { defaultToolEnv } from '../src/tools/places.ts';
import { pollUntil, b64, freshDir, open, settings, value  } from './helpers.ts';
import type { Host } from '../src/composition/host.ts';
const text = (message: Message) => typeof message.content === 'string' ? message.content : (message.content ?? []).map(part => part.text ?? '').join('');
async function settled(host: Host, id: string) {
  return await pollUntil(async active => {
    while (active()) { const thread = value(await host.call('threads.get', { id })); if (!thread.summary.running) return thread; await new Promise(resolve => setTimeout(resolve, 25)); }
    throw new Error('workspace source turn did not settle');
  }, "packages/platform/test/workspace-read-sources.test.ts settled");
}
for (const kind of ['read_file', 'connector'] as const) test(`M1: ${kind} text written by the engine into scratch is retired after withdrawal next turn`, { timeout: TEST_HANG_MS * 2 }, async () => {
  if (process.platform !== 'darwin') return;
  const model = await startScriptedModel(`workspace-${kind}`, messages => {
    const start = messages.findLastIndex(message => message.role === 'user'), asked = text(messages[start]!);
    const results = messages.slice(start + 1).filter(message => message.role === 'tool').map(text);
    if (asked.includes('Copy what you read')) {
      if (!results.length) return { calls: [{ name: kind === 'read_file' ? 'read_file' : 'mcp__notes__search', args: kind === 'read_file' ? { name: 'note.md' } : { q: 'owned-review-source' } }] };
      if (results.length === 1) return { calls: [{ name: 'workspace_run', args: { command: `cat > copied.txt <<'OWNED_SOURCE'\n${results[0]}\nOWNED_SOURCE\nprintf copied` } }] };
      return { text: `Copied: ${results[1]}` };
    }
    if (!results.length) return { calls: [{ name: 'workspace_run', args: { command: 'cat copied.txt' } }] };
    return { text: results[0]! };
  });
  const previous = { endpoint: process.env.BACKBONE_MODEL_ENDPOINT, model: process.env.BACKBONE_MODEL_ID };
  process.env.BACKBONE_MODEL_ENDPOINT = model.url; process.env.BACKBONE_MODEL_ID = model.model;
  const person = freshDir('workspace-read-person-');
  writeFileSync(join(person, '.claude.json'), JSON.stringify({ mcpServers: { notes: { command: process.execPath, args: [join(import.meta.dirname, 'fake-mcp-server.ts')] } } }));
  const { host, home } = open(undefined, { harness: 'harness-pi', ...(kind === 'connector' ? { connectors: { env: defaultToolEnv({ HOME: person, PATH: process.env.PATH }), sources: ['claude-code'] } } : {}) });
  const store = new WorkspaceStore(home); let threadId: string | undefined;
  try {
    const project = value(await host.call('projects.create', { name: 'Read sources', kind: 'folder' }));
    const original = kind === 'read_file' ? value(await host.call('material.attach', { projectId: project.id, name: 'note.md', mediaType: 'text/markdown', base64: b64('owned-review-source') })) : undefined;
    if (kind === 'connector') {
      value(await host.call('connectors.refresh', { serverId: 'claude-code:notes' }));
      value(await enableConnector(host, 'claude-code:notes'));
      value(await enableConnector(host, 'claude-code:notes', 'search'));
      value(await host.openConnectorDoor('claude-code:notes', host.connectorDoorSeal('claude-code:notes')!));
    }
    threadId = value(await host.call('turns.send', { projectId: project.id, text: 'Copy what you read into scratch', attachments: [], settings, clientKey: 'read-copy' })).threadId;
    const first = (await settled(host, threadId)).turns[0]!;
    assert.equal(first.status, 'done', first.answer?.text ?? ''); assert.match(first.answer?.text ?? '', /copied/);
    const entry = original ?? (await host.call('material.list', { projectId: project.id })).find(entry => entry.fromServer)!;
    assert.ok(entry); const record = (await store.inspect(threadId))!; assert.ok(record);
    assert.ok(record.sources.some(source => source.materialId === entry.id && source.input === undefined), 'text/connector read is bound even without attachment copying');
    value(await host.call('material.lifecycle', { id: entry.id, version: 1, lifecycle: 0, state: 'withdrawn' }));
    value(await host.call('turns.send', { projectId: project.id, threadId, text: 'Check retained scratch', attachments: [], settings, clientKey: 'withdrawn-query' }));
    const second = (await settled(host, threadId)).turns.at(-1)!;
    assert.match(second.answer?.text ?? '', /withdrawn|retired|source/i); assert.doesNotMatch(second.answer?.text ?? '', /owned-review-source/);
    assert.equal(await store.inspect(threadId), null); assert.equal(second.effects.length, 0);
  } finally {
    if (threadId) await store.remove(threadId); host.close();
    if (previous.endpoint === undefined) delete process.env.BACKBONE_MODEL_ENDPOINT; else process.env.BACKBONE_MODEL_ENDPOINT = previous.endpoint;
    if (previous.model === undefined) delete process.env.BACKBONE_MODEL_ID; else process.env.BACKBONE_MODEL_ID = previous.model;
    await model.close();
  }
});

test('L4: an oversized original is refused before buffering and before its read is recorded', { timeout: TEST_HANG_MS * 2 }, async t => {
  if (process.platform !== 'darwin') return;
  const { MaterialStore } = await import('../src/stub/material.ts');
  const { workspaceTools } = await import('../src/composition/workspace-tools.ts');
  const home = freshDir('workspace-oversize-home-'), material = new MaterialStore(home, {}, () => {});
  const entry = material.create('p', 'large.csv', 'text/csv', Buffer.from('n\n1'), 'original', 'person');
  const large = structuredClone(entry); large.versions[0]!.bytes = 10_000_001;
  t.mock.method(material, 'load', () => large);
  let buffered = 0, recorded = 0;
  t.mock.method(material, 'bytes', () => { buffered++; throw new Error('must not buffer'); });
  const tools = workspaceTools({ home, material, threadId: 'thread', projectId: 'p', attachments: [large], signal: new AbortController().signal, alive: () => true, sources: () => [], tools: { stillGranted: () => true, read: async () => { recorded++; throw new Error('must not record'); } } });
  const store = new WorkspaceStore(home);
  try {
    await assert.rejects(tools.runWorkspace!({ attachment: 'large.csv', command: 'echo must-not-run' }), /input size limit/);
    assert.equal(buffered, 0); assert.equal(recorded, 0); assert.deepEqual((await store.inspect('thread'))!.sources, []);
  } finally { await store.remove('thread'); }
});

test('L4: bounded material reads reject an oversized retained file even when its metadata still says small', async () => {
  const { MaterialStore } = await import('../src/stub/material.ts');
  const { open: openFile, chmod } = await import('node:fs/promises');
  const home = freshDir('workspace-retained-size-'), material = new MaterialStore(home, {}, () => {});
  const entry = material.create('p', 'small.csv', 'text/csv', Buffer.from('n'), 'original', 'person');
  const path = join(home, 'material', entry.id, 'versions', '1');
  await chmod(path, 0o600); // Owned corruption fixture: product originals remain read-only.
  const file = await openFile(path, 'r+');
  try { await file.truncate(10_000_001); } finally { await file.close(); }
  assert.throws(() => material.bytes(entry.id, 1, 10_000_000), /input size limit/);
});

for (const change of ['changed', 'missing'] as const) test(`M1: a ${change} ordinary read source retires derived scratch before the next command`, { timeout: TEST_HANG_MS * 2 }, async t => {
  if (process.platform !== 'darwin') return;
  const { MaterialStore } = await import('../src/stub/material.ts');
  const { workspaceTools } = await import('../src/composition/workspace-tools.ts');
  const { withHomeLock } = await import('../src/composition/home-lock.ts');
  const home = freshDir('workspace-source-change-'), material = new MaterialStore(home, {}, () => {});
  const entry = material.create('p', 'working.md', 'text/markdown', Buffer.from('original read'), 'working', 'person');
  let reads = [{ id: entry.id, name: entry.name, version: 1, withdrawals: 0 }];
  const tools = workspaceTools({ home, material, threadId: 'thread', projectId: 'p', attachments: [], signal: new AbortController().signal, alive: () => true, sources: () => reads,
    tools: { stillGranted: () => true, read: async name => { const current = material.load(entry.id); return current && current.name === name ? { name, version: current.current, materialId: current.id, projectId: current.projectId, withdrawals: current.withdrawals?.length ?? 0, class: current.class, mediaType: current.mediaType, by: 'person', text: Buffer.from(material.bytes(entry.id, current.current)).toString() } : null; } } });
  const store = new WorkspaceStore(home);
  try {
    await tools.runWorkspace!({ command: 'printf "original read" > copied.txt' });
    assert.equal((await store.inspect('thread'))!.sources[0]!.materialId, entry.id);
    reads = []; // Another turn has no fresh read of this source yet.
    if (change === 'changed') await withHomeLock(home, async () => { assert.equal((await material.save(entry.id, 'person changed source', 1)).ok, true); });
    else t.mock.method(material, 'load', () => null);
    await assert.rejects(tools.runWorkspace!({ command: 'cat copied.txt' }), /changed|withdrawn|retired/);
    assert.equal(await store.inspect('thread'), null);
  } finally { await store.remove('thread'); }
});
