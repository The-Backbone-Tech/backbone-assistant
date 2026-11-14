// The worker thread behind `runSqlSync` (testing.ts): runs one statement on a server and tells the
// waiting thread through a shared flag, so setup code that cannot await can still use a server.
import { parentPort } from 'node:worker_threads';
import pg from 'pg';

parentPort.on('message', async ({ flag, port, url, sql }) => {
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
    await client.query(sql);
    port.postMessage({ ok: true });
  } catch (error) {
    port.postMessage({ ok: false, error: String(error?.message ?? error) });
  } finally {
    await client.end().catch(() => {});
    Atomics.store(flag, 0, 1);
    Atomics.notify(flag, 0);
  }
});
