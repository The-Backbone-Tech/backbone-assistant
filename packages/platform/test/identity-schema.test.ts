import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import { startTestPostgres } from '@backbone/core/testing';
import { serviceClient } from '@backbone/core/db';

test('Core membership roles and workspace separation hold in the current qualified schema', async () => {
  const postgres = await startTestPostgres();
  const database = `identity_${randomUUID().replaceAll('-', '')}`;
  await postgres.clone(database);
  const operator = new pg.Client({ connectionString: postgres.operatorUrl(database) });
  const service = await serviceClient(postgres.appUrl(database));
  try {
    await operator.connect();
    const make = async (name: string) => (await operator.query(
      'SELECT * FROM operator.create_workspace($1, $2, $3, $4)', [name, 'team', 'Owner', 'owner@example.invalid'],
    )).rows[0] as { workspace_id: string; owner_id: string };
    const first = await make('First'), second = await make('Second');
    const as = async (workspace: string, person: string, sql: string, params: unknown[] = []) => {
      await service.query('BEGIN');
      try {
        await service.query(`SELECT set_config('backbone.workspace', $1, true), set_config('backbone.principal', $2, true)`, [workspace, person]);
        const result = await service.query(sql, params);
        await service.query('COMMIT');
        return result.rows;
      } catch (error) { await service.query('ROLLBACK'); throw error; }
    };
    const owner = (sql: string, params: unknown[] = []) => as(first.workspace_id, first.owner_id, sql, params);
    const [{ id: admin }] = await owner('SELECT gov.identity_add_person($1, $2, $3) AS id', ['Admin', 'admin@example.invalid', 'admin']);
    const [{ id: member }] = await as(first.workspace_id, admin, 'SELECT gov.identity_add_person($1, $2, $3) AS id', ['Member', 'member@example.invalid', 'member']);
    const [{ id: guest }] = await owner('SELECT gov.identity_add_person($1, $2, $3) AS id', ['Guest', 'guest@example.invalid', 'guest']);
    assert.equal((await as(first.workspace_id, member, 'SELECT sec.current_principal() AS id'))[0].id, member);
    await assert.rejects(as(first.workspace_id, member, 'SELECT gov.identity_add_person($1, $2, $3)', ['No', null, 'admin']), /role:/);
    await assert.rejects(as(first.workspace_id, admin, 'SELECT gov.identity_change_role($1, $2)', [member, 'owner']), /role:/);
    await assert.rejects(as(first.workspace_id, guest, 'SELECT gov.create_agent($1, $2)', ['Worker', 'worker']), /role:/);
    const [{ id: privateTask }] = await owner('SELECT gov.create_task($1, $1, $2, NULL, NULL) AS id', [first.owner_id, 'Private']);
    const [{ id: sharedTask }] = await owner('SELECT gov.create_task($1, $1, $2, NULL, $3) AS id', [first.owner_id, 'Shared', 'workspace']);
    assert.deepEqual((await as(first.workspace_id, member, 'SELECT id FROM app.tasks')).map(row => row.id), [sharedTask]);
    assert.equal((await as(first.workspace_id, member, 'SELECT gov.rewrite_task($1, $2, NULL, NULL) AS changed', [privateTask, 'Hidden']))[0].changed, 0);
    assert.deepEqual(await as(second.workspace_id, second.owner_id, 'SELECT id FROM app.tasks WHERE id = ANY($1::uuid[])', [[privateTask, sharedTask]]), []);
    assert.equal((await as(second.workspace_id, member, 'SELECT sec.current_principal() AS id'))[0].id, null);
    await assert.rejects(as(second.workspace_id, member, 'SELECT gov.create_agent($1, $2)', ['Foreign', 'worker']), /no_identity:/);
  } finally {
    await service.end();
    await operator.end();
    await postgres.drop(database);
    await postgres.stop();
  }
});
