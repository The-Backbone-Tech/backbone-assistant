// The gate's own protocol, against a gate server alone: no Hermes, no turn, loopback only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mock, test } from 'node:test';
import { GateServer } from '../src/gate.ts';
import { gateRequest } from './fake-hermes.ts';

async function freePort() {
  const { createServer } = await import('node:net');
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address() as { port: number };
  await new Promise((r) => s.close(r));
  return port;
}

// Third review, item 4: the window's edge is strict.
test('the gate refuses a request exactly at the edge of its window, and takes one just inside', async () => {
  const port = await freePort();
  const token = `canary-${randomUUID()}`;
  const server = new GateServer({ host: '127.0.0.1', port, token });
  await server.listen();
  const url = `http://127.0.0.1:${port}`;
  const T = Date.now();
  mock.timers.enable({ apis: ['Date'], now: T });
  try {
    const body = { session_id: 'nobody', failed: 0 };
    assert.equal((await gateRequest(url, token, '/report', body, { time: T - 60_000 })).status, 401, 'exactly 60 s old');
    assert.equal((await gateRequest(url, token, '/report', body, { time: T + 60_000 })).status, 401, 'exactly 60 s ahead');
    assert.equal((await gateRequest(url, token, '/report', body, { time: T - 59_999 })).status, 200, 'just inside');
  } finally {
    mock.timers.reset();
    await server.close();
  }
});
