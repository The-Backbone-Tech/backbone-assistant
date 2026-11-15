import { assertHomeWriteAdmission } from '@backbone-next/platform/composition/home-lock';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { secureChannelsHome } from './home.ts';
import { DatabaseSync } from 'node:sqlite';

export type Provider = 'slack' | 'telegram' | 'discord' | 'teams';
export interface Inbound { provider: Provider; id: string; conversation: string; sender: string; text: string; bindingVersion?: number; direct?: boolean }
export interface DeliveryAuthority { sender:string; generation:number }
export interface Outgoing { id:string;provider:Provider;conversation:string;text:string;sender:string|null;generation:number|null }
const hash = (s: string) => createHash('sha256').update(s).digest('hex');

/** This surface's local journal. SQLite transactions serialize the daemon and the person's CLI. */
export class Ledger {
  private db: DatabaseSync;
  private home:string;
  private admit(){assertHomeWriteAdmission(this.home,join(this.home,'channels'));}
  constructor(home: string) {
    this.home=home;
    assertHomeWriteAdmission(home,join(home,'channels'));
    const dir = secureChannelsHome(home);
    this.db = new DatabaseSync(join(dir, 'journal.sqlite'));
    chmodSync(join(dir, 'journal.sqlite'), 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS invitations (digest TEXT PRIMARY KEY, expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS bindings (provider TEXT NOT NULL, sender TEXT NOT NULL, active INTEGER NOT NULL, PRIMARY KEY(provider,sender));
      CREATE TABLE IF NOT EXISTS binding_events (seq INTEGER PRIMARY KEY, provider TEXT NOT NULL, sender TEXT NOT NULL, active INTEGER NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS intake (seq INTEGER PRIMARY KEY, provider TEXT NOT NULL, external_id TEXT NOT NULL, conversation TEXT NOT NULL, sender TEXT NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', thread_id TEXT, turn_id TEXT, UNIQUE(provider,external_id));
      CREATE TABLE IF NOT EXISTS delivery_attempts (id TEXT NOT NULL, attempt INTEGER NOT NULL, state TEXT NOT NULL, PRIMARY KEY(id,attempt));
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, provider TEXT NOT NULL, conversation TEXT NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);
    `);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!this.db.prepare('PRAGMA table_info(intake)').all().some(c=>c.name==='binding_version')) this.db.exec('ALTER TABLE intake ADD COLUMN binding_version INTEGER NOT NULL DEFAULT 0');
      if (!this.db.prepare('PRAGMA table_info(intake)').all().some(c=>c.name==='direct')) this.db.exec('ALTER TABLE intake ADD COLUMN direct INTEGER NOT NULL DEFAULT 0');
      for(const [name,type] of [['refusals','INTEGER NOT NULL DEFAULT 0'],['reason','TEXT'],['detail','TEXT']]) if(!this.db.prepare('PRAGMA table_info(intake)').all().some(c=>c.name===name)) this.db.exec(`ALTER TABLE intake ADD COLUMN ${name} ${type}`);
      for(const [name,type] of [['wait_refusals','INTEGER NOT NULL DEFAULT 0'],['wait_detail','TEXT']]) if(!this.db.prepare('PRAGMA table_info(intake)').all().some(c=>c.name===name)) this.db.exec(`ALTER TABLE intake ADD COLUMN ${name} ${type}`);
      for(const [name,type] of [['sender','TEXT'],['generation','INTEGER'],['blocked','INTEGER NOT NULL DEFAULT 0']]) if(!this.db.prepare('PRAGMA table_info(deliveries)').all().some(c=>c.name===name)) this.db.exec(`ALTER TABLE deliveries ADD COLUMN ${name} ${type}`);
      this.db.exec('COMMIT');
    } catch(e) { this.db.exec('ROLLBACK'); this.db.close(); throw e; }
    // An old unscoped Slack binding cannot authorize a team-scoped identity after upgrade.
    for (const row of this.db.prepare("SELECT sender FROM bindings WHERE provider='slack' AND active=1 AND instr(sender,':')=0").all()) this.unbind('slack',String(row.sender));
  }
  invite(now = Date.now()): string {this.admit();
    const code = randomBytes(24).toString('hex');
    this.db.prepare('INSERT INTO invitations(digest,expires) VALUES (?,?)').run(hash(code), now + 600_000);
    return code;
  }
  pair(provider: Provider, sender: string, code: string, now = Date.now()): boolean {this.admit();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const changed = this.db.prepare('UPDATE invitations SET used=1 WHERE digest=? AND used=0 AND expires>?').run(hash(code), now).changes;
      if (changed) {
        this.db.prepare('INSERT INTO bindings VALUES (?,?,1) ON CONFLICT(provider,sender) DO UPDATE SET active=1').run(provider, sender);
        this.db.prepare('INSERT INTO binding_events(provider,sender,active,at) VALUES (?,?,1,?)').run(provider,sender,now);
      }
      this.db.exec('COMMIT');
      return !!changed;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  bindingVersion(provider: Provider, sender: string): number {
    return Number((this.db.prepare('SELECT max(seq) AS version FROM binding_events WHERE provider=? AND sender=?').get(provider,sender) as { version: number | null }).version ?? 0);
  }
  bound(provider: Provider, sender: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM bindings WHERE provider=? AND sender=? AND active=1').get(provider,sender);
  }
  unbind(provider: Provider, sender: string): void {this.admit();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE bindings SET active=0 WHERE provider=? AND sender=?').run(provider,sender);
      this.db.prepare('INSERT INTO binding_events(provider,sender,active,at) VALUES (?,?,0,?)').run(provider,sender,Date.now());
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  unbindAll(provider?: Provider): number {this.admit();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.db.prepare('SELECT provider,sender FROM bindings WHERE active=1').all() as {provider: Provider; sender: string}[];
      const selected=rows.filter(row=>!provider||row.provider===provider);
      for (const row of selected) {
        this.db.prepare('UPDATE bindings SET active=0 WHERE provider=? AND sender=?').run(row.provider,row.sender);
        this.db.prepare('INSERT INTO binding_events(provider,sender,active,at) VALUES (?,?,0,?)').run(row.provider,row.sender,Date.now());
      }
      this.db.exec('UPDATE invitations SET used=1; COMMIT'); return selected.length;
    } catch(e) { this.db.exec('ROLLBACK'); throw e; }
  }
  receive(m: Inbound): boolean {this.admit();
    return !!this.db.prepare('INSERT OR IGNORE INTO intake(provider,external_id,conversation,sender,text,binding_version,direct) VALUES (?,?,?,?,?,?,?)').run(m.provider,m.id,m.conversation,m.sender,m.text,this.bindingVersion(m.provider,m.sender),m.direct?1:0).changes;
  }
  intakeCount(): number { return Number(this.db.prepare('SELECT count(*) AS n FROM intake').get()!.n); }
  /** The text of every recorded message in the order the journal recorded it, whatever became of it since. */
  arrivals(): string[] { return this.db.prepare('SELECT text FROM intake ORDER BY seq').all().map(row=>String(row.text)); }
  pending(): (Inbound & { seq: number })[] {
    return this.db.prepare("SELECT seq,provider,external_id AS id,conversation,sender,text,binding_version AS bindingVersion,direct FROM intake WHERE state='pending' ORDER BY seq").all().map(row=>({...row,direct:row.direct===1})) as unknown as (Inbound & { seq: number })[];
  }
  pendingConversations(): {provider: Provider; conversation: string}[] {
    return this.db.prepare("SELECT provider,conversation FROM intake WHERE state='pending' GROUP BY provider,conversation ORDER BY min(seq)").all() as unknown as {provider: Provider; conversation: string}[];
  }
  pendingHead(provider: Provider, conversation: string): (Inbound & {seq: number}) | undefined {
    const row=this.db.prepare("SELECT seq,provider,external_id AS id,conversation,sender,text,binding_version AS bindingVersion,direct FROM intake WHERE state='pending' AND provider=? AND conversation=? ORDER BY seq LIMIT 1").get(provider,conversation);
    return row&&{...row,direct:row.direct===1} as unknown as (Inbound & {seq:number})|undefined;
  }
  createDelivery(id: string, provider: Provider, conversation: string, text: string, authority?:DeliveryAuthority): boolean {this.admit();
    return !!this.db.prepare("INSERT OR IGNORE INTO deliveries(id,provider,conversation,text,state,attempts,sender,generation) VALUES (?,?,?,?,'pending',0,?,?)").run(id,provider,conversation,text,authority?.sender??null,authority?.generation??null).changes;
  }
  outgoingMessage(id:string):Outgoing|undefined{return this.db.prepare('SELECT id,provider,conversation,text,sender,generation FROM deliveries WHERE id=?').get(id) as unknown as Outgoing|undefined;}
  blockDelivery(id:string):void{this.admit();this.db.prepare("UPDATE deliveries SET state=CASE WHEN state='unknown' THEN state ELSE 'failed' END,blocked=1 WHERE id=? AND state IN ('pending','failed','unknown')").run(id);}
  beginDelivery(id: string): boolean {this.admit();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const changed = !!this.db.prepare("UPDATE deliveries SET state='sending',attempts=attempts+1 WHERE id=? AND blocked=0 AND ((state='pending' AND attempts=0) OR (state='failed' AND attempts=1) OR (state IN ('unknown','failed') AND attempts<3 AND sender IS NOT NULL AND (id LIKE 'intake-refused:%' OR id LIKE 'intake-waiting:%') AND EXISTS (SELECT 1 FROM delivery_attempts a WHERE a.id=deliveries.id AND a.state='unknown')))").run(id).changes;
      if (changed) this.db.prepare("INSERT INTO delivery_attempts SELECT id,attempts,'sending' FROM deliveries WHERE id=?").run(id);
      this.db.exec('COMMIT'); return changed;
    } catch(e) { this.db.exec('ROLLBACK'); throw e; }
  }
  finishDelivery(id: string, state: 'delivered' | 'failed' | 'unknown'): void {this.admit();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("UPDATE delivery_attempts SET state=? WHERE id=? AND state='sending'").run(state,id);
      this.db.prepare("UPDATE deliveries SET state=? WHERE id=? AND state='sending'").run(state,id);
      this.db.exec('COMMIT');
    } catch(e) { this.db.exec('ROLLBACK'); throw e; }
  }
  attempts(id: string): string[] { return this.db.prepare('SELECT state FROM delivery_attempts WHERE id=? ORDER BY attempt').all(id).map(row=>String(row.state)); }
  delivery(id: string): { state: string; attempts: number } | undefined {
    const row = this.db.prepare('SELECT state, attempts FROM deliveries WHERE id=?').get(id) as { state: string; attempts: number } | undefined;
    return row && { state: row.state, attempts: row.attempts };
  }
  /** Called once by the exclusive service owner, before accepting new deliveries. */
  recoverDeliveries(): void {this.admit(); this.db.exec("BEGIN IMMEDIATE; UPDATE deliveries SET state='unknown' WHERE state='sending'; UPDATE delivery_attempts SET state='unknown' WHERE state='sending'; COMMIT;"); }
  finishIntake(seq: number): void {this.admit(); this.db.prepare("UPDATE intake SET state='done' WHERE seq=? AND state='pending'").run(seq); }
  intakeStatus(provider:Provider,id:string):{state:string;refusals:number;reason:string|null;detail:string|null}|undefined {
    const row=this.db.prepare('SELECT state,refusals,reason,detail FROM intake WHERE provider=? AND external_id=?').get(provider,id);
    return row&&{...row} as ReturnType<Ledger['intakeStatus']>;
  }
  /** Only definitive, permanent Host refusals count. Terminal intake and its notice commit together. */
  refuseIntake(m:Inbound,reason:string,detail:string):boolean {this.admit();
    this.db.exec('BEGIN IMMEDIATE');
    try{
      this.db.prepare("UPDATE intake SET refusals=refusals+1,reason=?,detail=? WHERE provider=? AND external_id=? AND state='pending'").run(reason,detail,m.provider,m.id);
      // Mapping recovery happens before this call. INVALID is final here; other
      // permanent refusals retain their three durable attempts.
      const terminal=reason==='INVALID'||(this.intakeStatus(m.provider,m.id)?.refusals??0)>=3;
      if(terminal){
        this.db.prepare("UPDATE intake SET state='refused' WHERE provider=? AND external_id=?").run(m.provider,m.id);
        this.createDelivery(`intake-refused:${m.provider}:${m.id}`,m.provider,m.conversation,`This message could not be taken: ${detail}`,{sender:m.sender,generation:m.bindingVersion!});
      }
      this.db.exec('COMMIT');return terminal;
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  /** Three NOT_AVAILABLE receipts warrant a waiting notice, not terminal rejection.
   * The message's pending lifetime is one streak; its stable delivery ID survives restart. */
  waitIntake(m:Inbound,detail:string,text=`This message is kept and will run when the cause clears: ${detail}`):boolean {this.admit();
    this.db.exec('BEGIN IMMEDIATE');
    try{
      this.db.prepare("UPDATE intake SET wait_refusals=wait_refusals+1,wait_detail=? WHERE provider=? AND external_id=? AND state='pending'").run(detail,m.provider,m.id);
      const row=this.db.prepare("SELECT wait_refusals FROM intake WHERE provider=? AND external_id=? AND state='pending'").get(m.provider,m.id);
      const created=!!row&&Number(row.wait_refusals)>=3&&this.createDelivery(`intake-waiting:${m.provider}:${m.id}`,m.provider,m.conversation,text,{sender:m.sender,generation:m.bindingVersion!});
      this.db.exec('COMMIT');return created;
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  get<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key) as { value: string } | undefined;
    return row && JSON.parse(row.value) as T;
  }
  set(key: string, value: unknown): void { assertHomeWriteAdmission(this.home,join(this.home,'channels'));this.db.prepare('INSERT INTO metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value)); }
  outgoing(): Outgoing[] {
    return this.db.prepare("SELECT id,provider,conversation,text,sender,generation FROM deliveries WHERE blocked=0 AND (state='pending' OR (state='failed' AND attempts=1) OR (state IN ('unknown','failed') AND attempts<3 AND sender IS NOT NULL AND (id LIKE 'intake-refused:%' OR id LIKE 'intake-waiting:%') AND EXISTS (SELECT 1 FROM delivery_attempts a WHERE a.id=deliveries.id AND a.state='unknown'))) ORDER BY rowid").all() as unknown as Outgoing[];
  }
  close(): void { this.db.close(); }
}
