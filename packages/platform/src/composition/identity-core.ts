// Admission is held outside the home lock. An exclusive revoker waits for earlier
// requests; subsequent requests re-read their membership after that revoker commits.
import { createHash } from 'node:crypto';
import type pg from 'pg';
import {IDENTITY_PAUSED,IDENTITY_RUNTIME_PROFILE,type IdentityRuntimeStatus} from '@backbone/core/db';
import type { WorkspacePerson } from '../api-identity.ts';
import type { AutomationIdentity } from '../api-identity.ts';
import type { AdmissionLane } from './admission-lanes.ts';

export interface PersonContext { workspace: string; person: string; system: string; agent: string; mandate: string; pieceMandates?: Record<string, string>; automationId?: string }
export const identityTokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
export class IdentityRefused extends Error {
  readonly reason:'NOT_FOUND'|'NOT_AVAILABLE';
  constructor(reason:'NOT_FOUND'|'NOT_AVAILABLE'='NOT_AVAILABLE') { super('This identity or project permission is no longer available. Sign in again or contact an administrator.'); this.name = 'IdentityRefused';this.reason=reason; }
}
export class SharedEngineRequired extends IdentityRefused {
  constructor(){super();this.message='The workspace owner must select a shareable engine. On the owner computer, stop the daemon, run backbone engine pi, configure its model, and start the shared daemon again.';this.name='SharedEngineRequired';}
}
export class IdentityUnavailable extends Error {
  readonly reason='paused';
  readonly availability={...IDENTITY_PAUSED};
  constructor(){super('Team features are paused on this Mac. Your work is safe; export it from Settings › Backup.');this.name='IdentityUnavailable';}
}
/** A trusted sole-device home can keep its old surface while C1 stays paused. */
export class LegacyIdentityUnavailable extends IdentityUnavailable {
  constructor(){super();this.name='LegacyIdentityUnavailable';}
}
export class IdentityCore {
  private readonly status:IdentityRuntimeStatus;
  private connect: (lane?: AdmissionLane) => Promise<pg.PoolClient>;
  private runtimeConnect: () => Promise<pg.PoolClient>;
  private device: PersonContext;
  private current: () => PersonContext;
  private scope: <T>(person: PersonContext, work: () => Promise<T>) => Promise<T>;
  constructor(connect: (lane?: AdmissionLane) => Promise<pg.PoolClient>, device: PersonContext, current: () => PersonContext, scope: <T>(person: PersonContext, work: () => Promise<T>) => Promise<T>, runtimeConnect = connect,status:IdentityRuntimeStatus={...IDENTITY_PAUSED}) {
    this.status=Object.freeze({...status});this.connect = connect; this.runtimeConnect = runtimeConnect; this.device = device; this.current = current; this.scope = scope;
  }
  requireReady():void{if(this.status.state!=='verified'||this.status.profile!==IDENTITY_RUNTIME_PROFILE)throw new IdentityUnavailable();}
  get availability():Readonly<IdentityRuntimeStatus>{return {...this.status};}
  get devicePerson(): string { return this.device.person; }
  private async client(runtime = false, lane: AdmissionLane = 'request') {
    this.requireReady();
    const client = await (runtime ? this.runtimeConnect() : this.connect(lane));
    try {
      await client.query(`SELECT set_config('backbone.workspace',$1,false),set_config('backbone.principal','',false),set_config('backbone.run','',false),set_config('backbone.secret','',false)`, [this.device.workspace]);
      return client;
    } catch (error) { client.release(true); throw error; }
  }
  async resolve(token: string | undefined): Promise<WorkspacePerson> {
    const client = await this.client();
    try { return await this.person(client, token); } finally { client.release(); }
  }
  private async person(client: pg.PoolClient, token: string | undefined): Promise<WorkspacePerson> {
    const rows = token === undefined
      ? (await client.query(`SELECT id,name,role,status FROM app.principals WHERE id=$1 AND kind='person' AND status='active'`, [this.device.person])).rows
      : (await client.query(`SELECT principal AS id,name,role,'active' AS status FROM gov.identity_session($1)`, [identityTokenHash(token)])).rows;
    if (rows.length !== 1) throw new IdentityRefused();
    return rows[0] as WorkspacePerson;
  }
  async asPerson<T>(person: string, work: () => Promise<T>, piece?: string | null): Promise<T> {
    this.requireReady();
    const current = this.current();
    const context: PersonContext = current.person === person ? current : { ...this.device, person, agent: '00000000-0000-0000-0000-000000000000', mandate: '00000000-0000-0000-0000-000000000000', pieceMandates: {} };
    return this.scope(context, async () => {
      if (piece !== undefined && person !== this.device.person) {
        const client = await this.client(true);
        try {
          await client.query(`SELECT set_config('backbone.principal',$1,false)`, [person]);
          const runtime = (await client.query('SELECT * FROM gov.identity_runtime($1)', [piece])).rows[0];
          if (!runtime) throw new IdentityRefused();
          context.agent = runtime.agent; context.mandate = runtime.mandate;
          context.pieceMandates = piece ? { [piece]: runtime.mandate } : {};
        } finally { client.release(); }
      }
      return work();
    });
  }
  async admit<T>(token: string | undefined, work: (person: WorkspacePerson) => Promise<T>, piece?: string | null, lane: AdmissionLane = 'request'): Promise<T> {
    const client = await this.client(false, lane);
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await client.query("SET LOCAL lock_timeout='5s'");
      await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('identity:'||$1,17))", [this.device.workspace]);
      const person = await this.person(client, token);
      const value = await this.asPerson(person.id, () => work(person), piece);
      await client.query('COMMIT');
      return value;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }
  async admitPerson<T>(principal: string, work: () => Promise<T>): Promise<T> {
    const client = await this.client();
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await client.query("SET LOCAL lock_timeout='5s'");
      await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('identity:'||$1,17))", [this.device.workspace]);
      if (!(await client.query(`SELECT id FROM app.principals WHERE id=$1 AND kind='person' AND status='active'`,[principal])).rows.length) throw new IdentityRefused();
      const result = await this.asPerson(principal,work); await client.query('COMMIT'); return result;
    } catch (error) { await client.query('ROLLBACK').catch(()=>{}); throw error; }
    finally { client.release(); }
  }
  async asAutomation<T>(automation: AutomationIdentity, work: () => Promise<T>): Promise<T> {
    const invoker=this.current().person;
    return this.admitPerson(automation.person,async () => {
      const client=await this.client(true);
      try {
        await client.query("SELECT set_config('backbone.principal',$1,false)",[invoker]);
        const active=(await client.query('SELECT * FROM gov.identity_automations()')).rows.find(row=>row.id===automation.id&&!row.revoked&&row.person===automation.person&&row.mandate===automation.mandate&&row.project===automation.project);
        if (!active) throw new IdentityRefused();
      } finally { client.release(); }
      return this.scope({ ...this.device,person:automation.person,agent:automation.id,mandate:automation.mandate,
        automationId:automation.id,pieceMandates:automation.piece ? {[automation.piece]:automation.mandate} : {} },work);
    });
  }
}
