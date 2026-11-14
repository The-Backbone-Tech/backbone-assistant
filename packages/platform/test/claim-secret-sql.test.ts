import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { CoreLink } from '../src/composition/core.ts';
import { freshHome } from './helpers.ts';

test('a synthetic claim secret is carried as a parameter, never in SQL text', async (t) => {
  const link = await CoreLink.open({ home: freshHome() }); t.after(() => link.close());
  const canary = 'SYNTHETIC-CLAIM-SECRET-2e424f80'; let inSqlText = false;
  const pool = pg.Pool.prototype as unknown as { connect: (...args: unknown[]) => Promise<{ query: (...args: unknown[]) => unknown }> };
  const originalConnect = pool.connect;
  pool.connect = async function (...args) {
    const client = await originalConnect.apply(this, args); const originalQuery = client.query;
    client.query = function (...queryArgs) {
      const query = queryArgs[0]; const text = typeof query === 'string' ? query : typeof query === 'object' && query && 'text' in query ? String(query.text) : '';
      inSqlText ||= text.includes(canary);
      return originalQuery.apply(this, queryArgs);
    };
    return client;
  };
  try { await link.read(link.runOf({ run: '00000000-0000-4000-8000-000000000001', fence: 1, secret: canary }), 'SELECT 1'); }
  finally { pool.connect = originalConnect; }
  assert.equal(inSqlText, false, 'the claim secret must not be interpolated into a SQL statement');
});

test('a connection with unsafe logging is discarded before the claim is sent', async (t) => {
  const link = await CoreLink.open({ home: freshHome() }); t.after(() => link.close());
  const pool = pg.Pool.prototype as unknown as { connect: (...args: unknown[]) => Promise<{ query: (...args: unknown[]) => unknown; release: (...args: unknown[]) => unknown }> };
  const originalConnect = pool.connect; let sent = false; let discarded = false;
  pool.connect = async function (...args) {
    const client = await originalConnect.apply(this, args); const query = client.query; const release = client.release;
    client.query = function (...queryArgs) {
      const sql = queryArgs[0];
      if (typeof sql === 'string' && sql.includes("current_setting('log_parameter_max_length')")) {
        return Promise.resolve({ rows: [{ parameters: '-1', errors: '0', plans: null, plan_duration: null, debug_plan: 'off', audit: null }] });
      }
      sent = true; return query.apply(this, queryArgs);
    };
    client.release = function (...args) { discarded = args[0] === true; return release.apply(this, args); };
    return client;
  };
  try {
    await assert.rejects(link.read(link.runOf({ run: '00000000-0000-4000-8000-000000000001', fence: 1, secret: 'SYNTHETIC-SECRET' }), 'SELECT 1'), /may log secret parameters/);
  } finally { pool.connect = originalConnect; }
  assert.equal(sent, false); assert.equal(discarded, true);
});
