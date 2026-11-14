// An empty message is refused before a chat is made for it, so a caller that retries leaves no trail of empty chats.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { open, settings, value } from './helpers.ts';

test('a message with no words is refused and makes no chat, however often it is retried', async () => {
  const { host } = open();
  const project = value(await host.call('projects.create', { name: 'Synthetic', kind: 'folder' }));
  for (let attempt = 0; attempt < 5; attempt++) {
    for (const text of ['', '   ', '\n\t']) {
      const r = await host.call('turns.send', { projectId: project.id, text, attachments: [], settings, clientKey: `empty-${attempt}-${text.length}` });
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.reason, 'INVALID');
    }
  }
  assert.deepEqual(await host.call('threads.list', {}), []);
  // A worded message still makes exactly one chat.
  const sent = value(await host.call('turns.send', { projectId: project.id, text: 'Hello', attachments: [], settings, clientKey: 'worded' }));
  const listed = await host.call('threads.list', {}) as { id: string }[];
  assert.deepEqual(listed.map((t: { id: string }) => t.id), [sent.threadId]);
});
