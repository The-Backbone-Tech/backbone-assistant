import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse, runCommand } from '../src/commands.ts';

const settings = { harness: 'Codex', active: { label: 'Personal model', model: 'personal' }, shared: { harness: 'Pi', active: { label: 'Shared local model', model: 'shared' } } };
test('shared local model commands save the explicit colleague route and display it separately', async () => {
  const parsed = parse(['model', 'shared', 'local', '--endpoint', 'http://127.0.0.1:1234/v1', '--model', 'shared'], { BACKBONE_HOME: 'unused' });
  assert.equal(parsed.usage, undefined);
  const calls: unknown[] = [], lines: string[] = [];
  const api = { call: async (method: string, args: unknown) => { calls.push({ method, args }); return { ok: true, value: settings }; } };
  const io = { out: (line: string) => lines.push(line), err: (line: string) => lines.push(line), onInterrupt() {}, holding() {}, pollMs: 10, stopWaitMs: 100 };
  assert.equal(await runCommand(parsed, api as never, io), 0);
  assert.deepEqual(calls, [{ method: 'settings.model.put', args: { change: { route: 'shared', change: { route: 'local', provider: 'other', baseUrl: 'http://127.0.0.1:1234/v1', model: 'shared' } } } }]);
  assert.match(lines.join('\n'), /Shared work: Pi.*Shared local model/);
  calls.length = 0; lines.length = 0;
  const readApi = { call: async (method: string) => method === 'models.list' ? [] : settings };
  assert.equal(await runCommand(parse(['models'], { BACKBONE_HOME: 'unused' }), readApi as never, io), 0);
  assert.match(lines.join('\n'), /Engine: Codex\nRoute: Personal model\nShared work: Pi.*Shared local model/);
});
test('the shared model command refuses personal clients and incomplete routes before any call', () => {
  for (const words of [['shared', 'codex'], ['shared', 'local'], ['shared', 'local', 'extra']]) {
    assert.ok(parse(['model', ...words, '--model', 'example'], { BACKBONE_HOME: 'unused' }).usage);
  }
});
