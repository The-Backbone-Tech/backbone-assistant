import pg from 'pg';
import {parse,toClientConfig} from 'pg-connection-string';
import {PersonalReadRefusal} from './personal-readonly.ts';

const readOnlyRefusal=()=>new PersonalReadRefusal('connection-options','This home has unsupported database connection settings; nothing was opened.');
type StartupClient=pg.Client&{connectionParameters:Record<string,unknown>;getStartupConf():Record<string,unknown>};

/** Inspect the driver's effective startup values, including inherited environment/defaults. */
function validateReadOnlyStartup(client:pg.Client):void {
  const startup=client as StartupClient;
  const fields=['options','application_name','fallback_application_name','user','database','replication'];
  const values=[...Object.values(startup.getStartupConf()),...fields.map(field=>startup.connectionParameters[field])];
  if(values.some(value=>typeof value==='string'&&/\p{Cc}/u.test(value)))throw readOnlyRefusal();
}

async function verifyReadOnlyConnection(client:pg.Client):Promise<void> {
  try{
    const defaults=await client.query('SHOW default_transaction_read_only');
    const transaction=await client.query('SHOW transaction_read_only');
    if(defaults.rows.length!==1||defaults.rows[0].default_transaction_read_only!=='on'||transaction.rows.length!==1||transaction.rows[0].transaction_read_only!=='on')throw readOnlyRefusal();
  }catch{
    throw readOnlyRefusal();
  }
}

/** pg-pool uses this client's callback only after both admission layers succeed. */
export class ReadOnlyClient extends pg.Client {
  private async connectVerified():Promise<pg.Client>{
    try{
      try{validateReadOnlyStartup(this);}catch{throw readOnlyRefusal();}
      await super.connect();
      await verifyReadOnlyConnection(this);
      return this;
    }catch(error){await this.end().catch(()=>{});throw error;}
  }
  override connect():Promise<pg.Client>;
  override connect(callback:Parameters<pg.Client['connect']>[0]):void;
  override connect(callback?:Parameters<pg.Client['connect']>[0]):Promise<pg.Client>|void{
    const pending=this.connectVerified();
    if(callback){
      const complete=callback as (error:Error|null,client?:pg.Client)=>void;
      void pending.then(client=>complete(null,client),error=>complete(error));
      return;
    }
    return pending;
  }
}

/** Parse exactly once, then narrow startup options before pg can expose any connection. */
export function readOnlyConnectionConfig(connectionString:string):pg.ClientConfig {
  let config:pg.ClientConfig;
  try{
    const parsed=parse(connectionString);config=toClientConfig(parsed);
    // pg also accepts legacy SSL strings, which the typed converter otherwise drops.
    if(typeof parsed.ssl==='string')config.ssl=parsed.ssl==='no-verify'?{rejectUnauthorized:false}:Boolean(parsed.ssl);
  }
  catch{throw readOnlyRefusal();}
  // Unknown URL parameters are retained by the parser. Never let one request a second parse.
  delete config.connectionString;
  const options=config.options || process.env.PGOPTIONS || '';
  // PostgreSQL drops an unmatched final escape when splitting startup switches. Preserve
  // that behavior before adding a separator, so it cannot become an escaped value suffix.
  const trailingEscapes=options.match(/\\+$/)?.[0].length ?? 0;
  const complete=trailingEscapes%2 ? options.slice(0,-1) : options;
  // PostgreSQL processes switches in order; the final setting belongs to the reader.
  const narrowed={...config,options:`${complete}  -c default_transaction_read_only=on`};
  try{validateReadOnlyStartup(new pg.Client(narrowed));}catch{throw readOnlyRefusal();}
  return narrowed;
}

/** Who a session acts as. Empty: no workspace, no principal, no run. */
export interface Actor {
  readonly workspace?: string;
  readonly principal?: string;
  /** A claimed run, named with the secret its claim returned. */
  readonly run?: { readonly id: string; readonly secret: string };
}

/**
 * Open a transaction that acts as `actor`. The crossings derive identity from these settings
 * (sec.current_workspace, sec.current_principal, sec.current_run) and trust nothing else.
 */
export async function enter(client: pg.ClientBase, actor: Actor): Promise<void> {
  await client.query('BEGIN');
  await client.query(
    `SELECT set_config('backbone.workspace', $1, true), set_config('backbone.principal', $2, true),
            set_config('backbone.run', $3, true), set_config('backbone.secret', $4, true)`,
    [actor.workspace ?? '', actor.principal ?? '', actor.run?.id ?? '', actor.run?.secret ?? ''],
  );
}

/** The reasons a crossing states as the first word of its refusal (`reason: detail`). */
export const STATED_REASONS = new Set([
  'not_found', 'denied', 'no_identity', 'not_in_run', 'stale', 'invalid', 'conflict', 'not_claimable', 'workers_only',
  'empty_session_only', 'own_proposal', 'not_by_runs', 'someone_else', 'not_independent', 'role', 'verifier_only',
  'verifier_proof', 'different_proposal', 'not_open', 'exceeds_parent', 'revoked', 'mandate_holder', 'system_dispatches',
  'window', 'too_late', 'reconciler', 'reused_key', 'frozen', 'budget', 'already_rejected', 'not_undoable', 'not_verbatim',
  'self_evidence', 'system_records', 'not_member', 'not_registered', 'other_piece', 'unsettled', 'paused',
]);

/** What PostgreSQL itself refuses, by SQLSTATE: grants and row-level security, uniqueness, checks. */
const BY_CODE: Record<string, string> = {
  '42501': 'denied',
  '23505': 'conflict',
  '23514': 'invalid',
  '23502': 'invalid',
  '23503': 'not_found',
  '22P02': 'invalid',
  '22023': 'invalid',
  '22003': 'invalid',
  '22007': 'invalid',
  '22008': 'invalid',
};

/** Why a database error refused, in the core's words; `unclassified` when it is none of them. */
export function reasonOf(error: { code?: string; message?: string }): string {
  const stated = /^([a-z_]+): /.exec(error.message ?? '')?.[1];
  if (stated && STATED_REASONS.has(stated)) return stated;
  return BY_CODE[error.code ?? ''] ?? 'unclassified';
}

/**
 * Connect as the service, and refuse to run as a role that is a superuser or may bypass
 * row-level security (I-2): the walls would not hold for it.
 */
export interface ServiceClientLimits {
  connectionTimeoutMillis?: number;
  query_timeout?: number;
  statement_timeout?: number;
  lock_timeout?: number;
  /** Narrow the dedicated connection to read-only transactions from startup. */
  readOnly?: boolean;
}
export async function serviceClient(connectionString: string, limits?: ServiceClientLimits): Promise<pg.Client> {
  // Copy only native limits and the narrowing read-only setting; optional configuration
  // cannot replace identity or credentials.
  const timeouts = { connectionTimeoutMillis: limits?.connectionTimeoutMillis, query_timeout: limits?.query_timeout,
    statement_timeout: limits?.statement_timeout, lock_timeout: limits?.lock_timeout };
  if (Object.values(timeouts).some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647)))
    throw new Error('Service timeouts must be positive integer milliseconds within the native timer range.');
  const client = limits?.readOnly === true ? new ReadOnlyClient({...timeouts,...readOnlyConnectionConfig(connectionString)}) : new pg.Client({connectionString,...timeouts});
  try {
    await client.connect();
    const { rows } = await client.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT rolsuper, rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = current_user',
    );
    if (!rows[0] || rows[0].rolsuper || rows[0].rolbypassrls)
      throw new Error('the service refuses to run as a superuser or a role that bypasses row-level security');
    return client;
  } catch (error) {
    // Until return, the caller has no client to close. This includes connect and posture failures.
    await client.end().catch(() => {});
    throw error;
  }
}
