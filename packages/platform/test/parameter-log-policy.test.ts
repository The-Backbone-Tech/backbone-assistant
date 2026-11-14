import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import pg from 'pg';
import { binaries, freePort, ready } from '@backbone-next/kernel/cluster';
import { buildBaseline } from '@backbone/core/db';
import { CoreLink } from '../src/composition/core.ts';
import { writePlaintextVault } from '../src/keys/vault.ts';

test('PostgreSQL omits bound parameters under the logging policy, with a positive control', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'backbone-log-policy-'));
  const { initdb, postgres } = binaries();
  const init = spawnSync(initdb, ['-D', dir, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C'], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  const port = await freePort();
  const server = spawn(postgres, ['-D', dir, '-p', String(port), '-c', 'listen_addresses=127.0.0.1',
    '-c', 'unix_socket_directories=', '-c', 'log_statement=all', '-c', 'log_min_duration_statement=0',
    '-c', 'log_parameter_max_length=0', '-c', 'log_parameter_max_length_on_error=0',
    '-c', 'session_preload_libraries=auto_explain', '-c', 'auto_explain.log_min_duration=-1',
    '-c', 'auto_explain.log_parameter_max_length=0'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let log = ''; server.stderr.on('data', chunk => { log += String(chunk); });
  const url = `postgres://postgres@127.0.0.1:${port}/postgres`;
  const client = new pg.Client({ connectionString: url });
  const home = mkdtempSync(join(tmpdir(), 'backbone-log-home-'));
  let link: CoreLink | undefined;
  try {
    await ready(url, server, () => log);
    await client.connect();
    await client.query(buildBaseline().sql);
    mkdirSync(join(home, 'pg'));
    writeFileSync(join(home, 'pg', 'external.json'), JSON.stringify({
      appUrl: `postgres://backbone_app@127.0.0.1:${port}/postgres`,
      operatorUrl: `postgres://backbone_operator@127.0.0.1:${port}/postgres`,
    }));
    writePlaintextVault(home);
    link = await CoreLink.open({ home });
    const actor = link.runOf({ run: '00000000-0000-4000-8000-000000000001', fence: 1, secret: 'SYNTHETIC-CORE-8b324' });
    await link.read(actor, 'SELECT 1');
    await assert.rejects(link.read(actor, 'SELECT 1 / 0'));
    await assert.rejects(link.read(link.runOf({ run: '00000000-0000-4000-8000-000000000001', fence: 1, secret: 'SYNTHETIC-IDENTITY-8b324\u0000' }), 'SELECT 1'));
    await link.close(); link = undefined;
    await client.query('ALTER ROLE backbone_app SET auto_explain.log_min_duration = 0');
    await assert.rejects(CoreLink.open({ home }), /may log secret parameters/);
    await client.query('ALTER ROLE backbone_app RESET auto_explain.log_min_duration');
    await client.query('SELECT $1::text', ['SYNTHETIC-HIDDEN-8b324']);
    await assert.rejects(client.query('SELECT $1::text, 1 / (length($1::text) - length($1::text))', ['SYNTHETIC-ERROR-8b324']));
    await client.query('SET log_parameter_max_length = -1');
    await client.query('SELECT $1::text', ['SYNTHETIC-POSITIVE-8b324']);
    await client.query('SET log_parameter_max_length = 0');
    await client.query('SET auto_explain.log_min_duration = 0');
    await client.query('SET auto_explain.log_verbose = on');
    await client.query('SELECT set_config($1, $2, false)', ['backbone.secret', 'SYNTHETIC-PLAN-POSITIVE-8b324']);
    await client.end();
    server.kill('SIGINT');
    await new Promise<void>(resolve => server.once('exit', () => resolve()));
    assert.match(log, /SYNTHETIC-POSITIVE-8b324/, 'positive control proves parameter logging was captured');
    assert.match(log, /SYNTHETIC-PLAN-POSITIVE-8b324/, 'positive control proves verbose plan logging can expose values');
    assert.doesNotMatch(log, /SYNTHETIC-HIDDEN-8b324|SYNTHETIC-ERROR-8b324|SYNTHETIC-CORE-8b324|SYNTHETIC-IDENTITY-8b324/);
  } finally {
    await link?.close();
    await client.end().catch(() => {});
    if (server.exitCode === null && server.signalCode === null) {
      server.kill('SIGINT');
      await new Promise<void>(resolve => server.once('exit', () => resolve()));
    }
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
