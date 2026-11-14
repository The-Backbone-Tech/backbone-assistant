import { it, expect } from 'vitest';
import pg from 'pg';
import { restoreDeviceAccess } from '../src/db/identity-device-recovery.ts';
import { startTestPostgres } from '../src/db/testing.ts';

it('withdrawal after the recovery crossing rolls back membership and its audit entry before COMMIT', async () => {
  const postgres = await startTestPostgres(); await postgres.clone('recovery_cancel');
  const admin = new pg.Client({ connectionString: postgres.adminUrl('recovery_cancel') });
  const operator = new pg.Client({ connectionString: postgres.operatorUrl('recovery_cancel') });
  try {
    await Promise.all([admin.connect(), operator.connect()]);
    const made = (await admin.query("SELECT * FROM operator.create_workspace('Recovery','team','Device',NULL)")).rows[0];
    await admin.query("UPDATE app.principals SET status='removed',role='guest' WHERE id=$1", [made.owner_id]);
    const before = (await admin.query('SELECT id,status,role FROM app.principals ORDER BY id')).rows;
    const ledger = (await admin.query('SELECT count(*) FROM app.ledger')).rows;
    const quit = new AbortController();
    const query = operator.query.bind(operator);
    operator.query = (async (...args: unknown[]) => {
      const result = await Reflect.apply(query, undefined, args);
      if (args[0] === 'SELECT operator.identity_restore_device_access($1)') quit.abort();
      return result;
    }) as typeof operator.query;
    await expect(Reflect.apply(restoreDeviceAccess, undefined, [operator, made.workspace_id, made.owner_id, quit.signal])).rejects.toMatchObject({ name: 'AbortError' });
    expect((await admin.query('SELECT id,status,role FROM app.principals ORDER BY id')).rows).toEqual(before);
    expect((await admin.query('SELECT count(*) FROM app.ledger')).rows).toEqual(ledger);
  } finally { await Promise.all([admin.end(), operator.end()]); await postgres.drop('recovery_cancel'); await postgres.stop(); }
});
