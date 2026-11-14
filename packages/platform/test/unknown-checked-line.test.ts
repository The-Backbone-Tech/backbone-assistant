import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveApiLine, askWords } from '../src/composition/api-line.ts';
import { attachApi } from '../src/doors/api-line.ts';
import { unknownCheckConfirmation } from '../src/api.ts';
const q = { revision: 'a'.repeat(64), steps: [{ label: 'Codex connector mail / send', at: '2026-11-13T12:00:00.000Z' }] };
for (const mode of ['allowed', 'no-confirm', 'read-only', 'no-binding', 'denied', 'changed'] as const) test(`checked API line ${mode} requires a fresh native person decision`, async t => {
  const home = mkdtempSync(join(tmpdir(), 'checked-line-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  let checks = 0, questions = 0;
  const capability = { question: async () => ({ ok: true as const, value: { ...q, revision: mode === 'changed' && questions++ ? 'b'.repeat(64) : q.revision } }),
    check: async () => { checks++; return { ok: true as const, value: { ...q, by: 'person', at: q.steps[0].at } }; } };
  const line = await serveApiLine({ home, call: async () => { throw Error('Never a general API call'); }, readOnly: mode === 'read-only',
    ...(mode === 'no-confirm' ? {} : { confirm: async ask => { assert.equal(askWords(ask, 'Backbone').message, unknownCheckConfirmation('Backbone')); return mode !== 'denied'; } }),
    ...(mode === 'no-binding' ? {} : { unknownChecks: capability }),
  });
  t.after(() => line.close()); const client = (await attachApi(home))!; t.after(() => client.close());
  const result = await client.checkedTurn({ threadId: 'thread', turnId: 'turn', revision: q.revision });
  assert.equal(result.ok, mode === 'allowed'); assert.equal(checks, mode === 'allowed' ? 1 : 0);
});
