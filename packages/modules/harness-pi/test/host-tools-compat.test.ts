import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { before, test } from 'node:test';
import { HOST_TOOLS, type HostToolName } from '@backbone-next/platform/ports';
import { probeHostTools } from './host-tools-probe.ts';

let captured: Awaited<ReturnType<typeof probeHostTools>>;
before(async () => { captured = await probeHostTools(); assert.equal(captured.outcome.status, 'done'); });

test('Pi sends the four Host declarations byte-for-byte as captured at c23b6d1', async () => {
  // Literal captured with probeHostTools against git show c23b6d1:.../src/index.ts.
  const literal = await readFile(new URL('./fixtures/host-tools-c23b6d1.json', import.meta.url), 'utf8');
  assert.equal(JSON.stringify(captured.declarations) + '\n', literal);
});

test('Pi keeps its baseline null query coercion to the string null', () => {
  assert.deepEqual(captured.queries, ['null']);
});

test('the shared Host schemas and descriptions match the declarations Pi actually sends', () => {
  for (const declaration of captured.declarations) {
    const { name, description, parameters } = declaration.function as { name: HostToolName; description: string; parameters: unknown };
    assert.equal(description, HOST_TOOLS[name].description);
    assert.deepEqual(parameters, HOST_TOOLS[name].inputSchema);
  }
});
