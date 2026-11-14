import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attachmentDisplay } from '../src/lib/connector-attachments.ts';

test('held attachments expose reviewed names, MIME types, decoded sizes and original bytes without base64 prose', () => {
  const content = Buffer.from('Reviewed attachment.').toString('base64');
  const args = { to: 'person@example.com', attachments: [{ filename: 'reviewed.txt', mime_type: 'text/plain', content }] };
  const statement = `Call send with exactly: ${JSON.stringify(args)}`, before = structuredClone(args);
  const view = attachmentDisplay({ args, statement });
  assert.equal(view.files.length, 1);
  assert.deepEqual([...view.files[0].bytes], [...Buffer.from('Reviewed attachment.')]);
  assert.deepEqual(view.args.attachments, [{ filename: 'reviewed.txt', mime_type: 'text/plain', size: 20 }]);
  assert.equal(view.statement.includes(content), false);
  assert.equal(JSON.stringify(view.args).includes(content), false);
  assert.deepEqual(args, before, 'a presentation cannot rewrite the approved call');
  assert.equal(statement, `Call send with exactly: ${JSON.stringify(args)}`);
});

test('invalid encodings and mismatched statements stay visible rather than being silently decoded or rewritten', () => {
  const args = { attachments: [{ filename: 'bad.txt', content: 'bad base64!' }] };
  const held = { args, statement: 'a different recorded statement' };
  assert.deepEqual(attachmentDisplay(held), { ...held, files: [] });
  const valid = { attachments: [{ filename: 'empty.bin', content: '' }] };
  const view = attachmentDisplay({ args: valid, statement: 'unrelated statement' });
  assert.equal(view.statement, 'unrelated statement');
  assert.equal(view.files[0].mime, 'application/octet-stream');
  assert.equal(view.files[0].bytes.byteLength, 0);
});
