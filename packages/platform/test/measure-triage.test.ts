import { childHangTimer } from '../../../scripts/lib/test-child.ts';
import { spawnSyncHang, TEST_HANG_MS } from '../../../scripts/lib/test-hang.ts';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../examples/measure-triage.ts', import.meta.url));

test('the baseline refuses an invalid or over-90-minute deadline before contacting a model', () => {
  for (const deadline of ['0', '-1', '5400001', 'NaN']) {
    const result = spawnSyncHang(process.execPath, [script, 'baseline', '--endpoint', 'http://127.0.0.1:1/v1', '--model', 'test-model', '--deadline-ms', deadline], { encoding: 'utf8', timeout: TEST_HANG_MS });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /positive integer no greater than 5400000/);
  }
});

test('the baseline checkpoints completed requests and preserves a deadline failure', async () => {
  const out = mkdtempSync(join(tmpdir(), 'triage-checkpoint-'));
  let requests = 0;
  let firstCheckpoint: { items: { id: string }[] } | undefined;
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain the request */ }
    requests++;
    if (requests > 1) {
      try { firstCheckpoint = JSON.parse(readFileSync(join(out, 'outputs.json'), 'utf8')); } catch { /* asserted below */ }
      // Leave this request unanswered; the benchmark must stop it at its deadline.
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: 'requester: Dana <dana@example.test>\ncategory: billing\nurgency: high\nlabel: Billing\nmove: none\nsuspicious: no\nreply:\nThanks.' } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const child = spawn(process.execPath, [script, 'baseline', '--out', out, '--endpoint', `http://127.0.0.1:${address.port}/v1`, '--model', 'test-model', '--limit', '3', '--deadline-ms', '2000'], { stdio: 'ignore' });
  const watchdog = childHangTimer(child,'baseline exit after its product deadline');
  try {
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    assert.equal(code, 1, 'a deadline is a failed benchmark');
    assert.deepEqual(firstCheckpoint?.items.map((i) => i.id), ['m01']);
    const output = JSON.parse(readFileSync(join(out, 'outputs.json'), 'utf8'));
    assert.equal(requests, 2, 'no request starts after the deadline');
    assert.equal(output.items.length, 2);
    assert.equal(output.items[0].reply, 'Thanks.');
    assert.match(output.items[1].error, /deadline/i);
    assert.match(output.arm.note, /deadline/i);
  } finally {
    clearTimeout(watchdog);
    child.kill();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(out, { recursive: true, force: true });
  }
});
