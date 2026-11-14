import assert from 'node:assert/strict';
import { test } from 'node:test';
import { askWords, serveApiLine, type LineAsk } from '../src/composition/api-line.ts';
import { attachApi } from '../src/doors/api-line.ts';
import { freshHome, settings } from './helpers.ts';

test('the process API line preserves memory off in the confirmed task and refuses an unrecognised setting', async () => {
  const home = freshHome(), questions: LineAsk[] = [], sent: unknown[] = [];
  const call = (async (method: string, args: unknown) => {
    if (method === 'projects.list') return [{ id: 'project', name: 'Project', kind: 'folder' }];
    if (method === 'turns.send') { sent.push(args); return { ok: true, value: { threadId: 'thread', turnId: 'turn' } }; }
    throw new Error(`Unexpected method ${method}`);
  }) as Parameters<typeof serveApiLine>[0]['call'];
  const server = await serveApiLine({ home, call, confirm: async ask => { questions.push(ask); return true; } });
  const client = await attachApi(home);
  assert.ok(client);
  try {
    const request = { projectId: 'project', text: 'Check the report', attachments: [], settings: { ...settings, memory: 'off' as const }, clientKey: 'memory-off' };
    assert.equal((await client.call('turns.send', request)).ok, true);
    assert.equal((sent[0] as { settings: { memory: string } }).settings.memory, 'off');
    assert.ok(askWords(questions[0], 'App').detail.includes('Memory: off'));
    assert.equal((await client.call('turns.send', { ...request, settings: { ...settings, memory: 'disabled' } as never, clientKey: 'invalid-memory' })).ok, false);
    assert.equal(sent.length, 1);
  } finally { client.close(); await server.close(); }
});
