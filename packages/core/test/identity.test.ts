import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { startTestPostgres } from '../src/db/testing.ts';
import { serviceClient } from '../src/db/session.ts';
import { upgradeIdentity, verifyIdentity } from '../src/db/identity.ts';

describe('identity crossings', () => {
  it('binds an invited account once, removes its sessions and running mandates atomically, and limits a viewer to one project', async () => {
    const postgres = await startTestPostgres();
    const database = `identity_${randomUUID().replaceAll('-', '')}`;
    await postgres.clone(database);
    const installer = new pg.Client({ connectionString: postgres.adminUrl(database) });
    const operator = new pg.Client({ connectionString: postgres.operatorUrl(database) });
    const service = await serviceClient(postgres.appUrl(database));
    try {
      await installer.connect(); await operator.connect();
      expect((await upgradeIdentity(installer)).state).toBe('verified');
      expect((await verifyIdentity(service)).state).toBe('verified');
      const made = (await operator.query('SELECT * FROM operator.create_workspace($1,$2,$3,$4)', ['Team', 'team', 'Owner', 'owner@example.invalid'])).rows[0];
      const workspace = made.workspace_id as string, owner = made.owner_id as string;
      const as = async (principal: string | null, sql: string, params: unknown[] = []) => {
        await service.query('BEGIN');
        try {
          await service.query(`SELECT set_config('backbone.workspace',$1,true),set_config('backbone.principal',$2,true),set_config('backbone.run','',true),set_config('backbone.secret','',true)`, [workspace, principal ?? '']);
          const result = await service.query(sql, params); await service.query('COMMIT'); return result.rows;
        } catch (error) { await service.query('ROLLBACK'); throw error; }
      };
      const hash = () => randomBytes(32).toString('hex');
      const invitation = hash(), session = hash();
      await as(owner, 'SELECT gov.identity_invite($1,$2,$3)', [invitation, 'member', new Date(Date.now() + 60_000)]);
      const member = (await as(null, 'SELECT gov.identity_accept($1,$2,$3,$4,$5) AS id', [invitation, 'https://issuer.example.invalid', 'subject-one', 'Second person', session]))[0].id;
      expect((await as(null, 'SELECT * FROM gov.identity_session($1)', [session]))[0].principal).toBe(member);
      await expect(as(null, 'SELECT gov.identity_accept($1,$2,$3,$4,$5)', [invitation, 'https://issuer.example.invalid', 'other-subject', 'Impostor', hash()])).rejects.toThrow(/invitation/);
      await expect(as(member, 'SELECT gov.identity_invite($1,$2,$3)', [hash(), 'admin', new Date(Date.now() + 60_000)])).rejects.toThrow(/role/);
      const project = randomUUID(), other = randomUUID();
      await as(owner, 'SELECT gov.identity_project_create($1)', [project]);
      await as(owner, 'SELECT gov.identity_project_create($1)', [other]);
      await as(owner, 'SELECT gov.identity_project_share($1,$2,$3)', [project, member, 'viewer']);
      expect((await as(member, 'SELECT gov.identity_project_access($1) AS access', [project]))[0].access).toBe('viewer');
      expect((await as(member, 'SELECT gov.identity_project_access($1) AS access', [other]))[0].access).toBe(null);
      await expect(as(member, 'SELECT gov.identity_project_share($1,$2,$3)', [project, member, 'editor'])).rejects.toThrow(/denied/);
      const runtime = (await as(member, 'SELECT * FROM gov.identity_runtime(NULL)'))[0];
      const task = (await as(member, 'SELECT gov.create_task($1,$1,$2,NULL,NULL) AS id', [member, 'Automation']))[0].id;
      const run = (await as(member, 'SELECT gov.queue_run($1,$2,$3,NULL,NULL) AS id', [task, runtime.agent, runtime.mandate]))[0].id;
      const claim = (await as(null, 'SELECT * FROM gov.claim_run($1,$2,$3,$4,NULL)', [run, 'identity-worker', 60_000, 'direct']))[0];
      expect(claim.fence).toBeTruthy();
      await as(owner, 'SELECT gov.identity_remove($1)', [member]);
      expect(await as(null, 'SELECT * FROM gov.identity_session($1)', [session])).toEqual([]);
      // The owner does not acquire the removed person's private task. Inspect the
      // cancelled row through the disposable fixture's catalogue/record observer.
      expect((await installer.query('SELECT status FROM app.runs WHERE id=$1', [run])).rows[0].status).toBe('cancelled');
      expect((await as(member, 'SELECT sec.current_principal() AS id'))[0].id).toBe(null);
      await expect(as(null, 'SELECT gov.identity_sign_in($1,$2,$3)', ['https://issuer.example.invalid', 'subject-one', hash()])).rejects.toThrow(/identity/);
      await expect(as(owner, 'SELECT gov.identity_remove($1)', [owner])).rejects.toThrow(/owner/);
      // Exact native metadata matters independently of a migration receipt.
      await installer.query('GRANT SELECT ON app.identity_sessions TO backbone_app');
      expect((await verifyIdentity(service)).state).toBe('paused');
    } finally {
      await service.end(); await operator.end(); await installer.end();
      await postgres.drop(database); await postgres.stop();
    }
  },30_000);
});
