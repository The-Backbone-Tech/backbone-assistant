import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scriptedStep, type Message } from '../src/testing/scripted-model.ts';

test('the scripted write producer discovers and reads an existing target before replacement', () => {
  const messages: Message[] = [{ role: 'user', content: 'Draft a brief for the launch' }];
  assert.deepEqual(scriptedStep(messages), { calls: [{ name: 'list_files', args: {} }] });
  messages.push({ role: 'assistant', tool_calls: [{ id: 'listed', function: { name: 'list_files', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'listed', content: '- brief.md v2 (saved by you) accepted text/markdown' });
  assert.deepEqual(scriptedStep(messages), { calls: [{ name: 'read_file', args: { name: 'brief.md' } }] });
  messages.push({ role: 'assistant', tool_calls: [{ id: 'read', function: { name: 'read_file', arguments: '{"name":"brief.md"}' } }] },
    { role: 'tool', tool_call_id: 'read', content: 'brief.md v2 (saved by you)\n\nPerson wording.' });
  const write = scriptedStep(messages);
  assert.ok('calls' in write);
  assert.equal(write.calls[0].name, 'write_file');
  assert.equal(write.calls[0].args.name, 'brief.md');
});
