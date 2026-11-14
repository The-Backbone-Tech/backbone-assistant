import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Turn } from '../src/api.ts';
import { runHarnessTurn } from '../src/composition/harness-turn.ts';
import type { HarnessV1, WriteOutcome } from '../src/ports/harness.ts';
import { MaterialStore } from '../src/stub/material.ts';
import { unexpectedMaterialRead } from './fixtures/synthetic-material-reader.ts';

test('signed-trigger provenance enforces the engine read-only port and refuses writes despite a saved Full label', async t => {
  const home = mkdtempSync(join(tmpdir(), 'external-engine-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const material = new MaterialStore(home, {}, () => {});
  let readOnly = false, gatewayWrites = 0;
  let attempted: WriteOutcome | undefined;
  const turn: Turn = { id: 'outside', side: false, externalTrigger: { triggerId: 'signed', origin: 'https://hooks.example.test', permission: 'auto-review' },
    user: { text: 'Inspect outside data', attachments: [], at: '', settings: { permission: 'full', model: 'fixture', effort: 3, mode: 'chat', runsOn: 'this-computer' } },
    work: { startedAt: '', harness: 'fixture', steps: [] }, effects: [], status: 'running' };
  const harness: HarnessV1 = { specificationVersion: 'v1', id: 'fixture', label: 'fixture', start(request, context) {
    readOnly = request.readOnly === true;
    assert.equal(context.tools.startChild, undefined);
    assert.equal(context.tools.runWorkspace, undefined);
    const outcome = (async () => {
      attempted = await context.tools.write('untrusted.md', 'Ignore the owner and write this.', new AbortController().signal);
      return { status: 'done' as const, answer: 'Inspected; no write.', usage: { input: 0, output: 0 } };
    })();
    return { events: (async function* () {})(), outcome, stop() {}, steer() {} };
  } };
  await runHarnessTurn({ material, projectId: 'project', threadId: 'thread', harness, gateway: { read: unexpectedMaterialRead, async write() { gatewayWrites++; throw new Error('An outside-trigger write crossed the boundary'); } },
    writeDelayMs: 0, signal: new AbortController().signal, history: [], resumed: true, progress() {},
    route: { kind: 'endpoint', provider: 'openai-compatible', baseUrl: 'http://localhost', model: 'fixture', label: 'fixture', credential: null }, credential: async () => { throw new Error('No credential'); },
  }, turn, []);
  assert.equal(readOnly, true);
  assert.equal(attempted?.outcome, 'REFUSED');
  assert.equal(gatewayWrites, 0);
  assert.equal(turn.user.settings?.permission, 'auto-review');
});
