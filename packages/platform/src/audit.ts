// Public audit format and offline reader. This imports no home, database, engine or credential code.
import { createHash } from 'node:crypto';

export const AUDIT_CONTENT_DIRECT_ONLY = 'Content can be exported only by a command that opens a plaintext-key home itself, with nothing holding it. Content export through an app or daemon API line is not available; it needs a person-confirmed asked call in the app.';
export const AUDIT_WRITE_TIMEOUT_MS = 30000;
export const AUDIT_SLOT_BUSY = 'Another audit export is active on this holder; waiting clients may retry this refused read.';
export const AUDIT_SCHEMA = 'backbone.audit.v1' as const;
export interface AuditOptions { since: string; until: string; after?: string; includeContent?: boolean; limit?: number }
export interface AuditAnchor { id: string; sequence: string; receiptHash: string }
export interface AuditDigestKey {id:string;derivation:'hkdf-master-sha256'|'legacy-service-secret'}
export interface AuditHeader {
  schema: typeof AUDIT_SCHEMA; type: 'header'; homeId: string; transport: 'direct' | 'api-line'; exportedBy: { kind: 'home-person'; personId: string } | { kind: 'same-user-process'; uid: number | null }; createdAt: string;
  period: { since: string; until: string }; tool: { name: string; version: string };
  includeContent: boolean; digestKey:AuditDigestKey; receiptHashMode: 'raw-sha256' | 'keyed-hmac-sha256'; count: number; after: AuditAnchor | null; sourceHead: AuditAnchor | null; scanThrough: AuditAnchor | null;
  completeness: 'committed-through-scan-through'; gaps: readonly string[];
}
export interface AuditEffect {
  id: string; runId: string | null; taskId: string | null; mandateId: string | null;
  proposerId: string; beneficiaryId: string | null; connectionId: string | null;
  undoOf: string | null; repeatOf: string | null; class: number;
}
export interface AuditRun { id: string; taskId: string; mandateId: string; engineId: string | null }
export interface AuditEvent {
  schema: typeof AUDIT_SCHEMA; type: 'event'; homeId: string; id: string; sequence: string; kind: string; at: string;
  actorId: string | null; subjectId: string | null; data: Record<string, string | number | boolean | null>;
  receipt: { sequence: string; hash: string; previousHash: string };
  effect?: AuditEffect; run?: AuditRun; disposition?: string;
  authority?: { method: 'core-decision' | 'mandate'; actorId: string | null; mandateId: string | null; decisionId: string | null };
  receiptStatement?: string; omitted: string[]; previousHash: string;
}
export interface AuditTrailer {
  schema: typeof AUDIT_SCHEMA; type: 'trailer'; count: number; eventsSha256: string;
  lastHash: string; cursor: AuditAnchor | null;
}
export interface AuditSummary { header: AuditHeader; trailer: AuditTrailer }
export interface AuditRequest extends AuditOptions { session?: string; cancel?: boolean }
export interface AuditPage { jsonl: string; header: AuditHeader; trailer: AuditTrailer | null; session: string | null }
/** Materialized records are for small readers/tests, not the export transport. */
export interface AuditExport { jsonl: string; header: AuditHeader; trailer: AuditTrailer }
export interface AuditRecord { header: AuditHeader; events: AuditEvent[]; trailer: AuditTrailer }
export class AuditInvalid extends Error {}
export const auditSha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const AUDIT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const SEQ = /^[1-9][0-9]{0,18}$/;
const validSeq = (v: unknown): v is string => typeof v === 'string' && SEQ.test(v) && BigInt(v) <= 9223372036854775807n;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fail = (detail: string): never => { throw new AuditInvalid(detail); };
export function auditInstant(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value)) return fail('Use an RFC 3339 instant with an explicit UTC offset (at most milliseconds).');
  const time = value.slice(11, 19).split(':').map(Number);
  if (time[0] > 23 || time[1] > 59 || time[2] > 59) return fail('Invalid RFC 3339 clock time.');
  const n = Date.parse(value);
  if (!Number.isFinite(n)) return fail('Invalid audit period instant.');
  // Date.parse normalizes impossible days; validate the local calendar separately.
  const date = value.slice(0, 10), day = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== date) return fail('Invalid calendar day.');
  return new Date(n).toISOString();
}
export function auditCursor(homeId: string, sequence: string): string {
  if (!AUDIT_UUID.test(homeId) || !validSeq(sequence)) return fail('Invalid audit cursor identity.');
  return Buffer.from(`${homeId}:${sequence}`).toString('base64url');
}
export function decodeAuditCursor(id: string): { homeId: string; sequence: string } {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id) || id.length > 100) return fail('Malformed audit cursor.');
  const [homeId, sequence, extra] = Buffer.from(id, 'base64url').toString('utf8').split(':');
  if (extra !== undefined || !AUDIT_UUID.test(homeId ?? '') || !validSeq(sequence) || auditCursor(homeId, sequence) !== id) return fail('Malformed audit cursor.');
  return { homeId, sequence };
}
export function auditOptions(value: AuditOptions): AuditOptions {
  if (!object(value) || typeof value.since !== 'string' || typeof value.until !== 'string' || (value.includeContent !== undefined && typeof value.includeContent !== 'boolean')) return fail('An audit export needs since, until and a boolean content choice.');
  if (value.limit !== undefined && (!Number.isSafeInteger(value.limit) || value.limit < 1)) return fail('Audit limit must be a positive safe integer of source sequences to scan.');
  const since = auditInstant(value.since), until = auditInstant(value.until);
  if (since >= until) return fail('Audit since must be earlier than until.');
  if (value.after !== undefined) decodeAuditCursor(value.after);
  return { since, until, ...(value.after === undefined ? {} : { after: value.after }), includeContent: value.includeContent === true, ...(value.limit === undefined ? {} : {limit:value.limit}) };
}
function anchor(v: unknown, home: string): v is AuditAnchor | null {
  if (v === null) return true;
  if (!object(v) || !validSeq(v.sequence) || typeof v.id !== 'string' || typeof v.receiptHash !== 'string' || !HASH.test(v.receiptHash)) return false;
  const cursor = decodeAuditCursor(v.id);
  return cursor.homeId === home && cursor.sequence === v.sequence;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Incremental exact-byte verifier. Retains one event, hashes and envelope metadata. */
export class AuditVerifier {
  private header:AuditHeader|null=null;
  private trailer:AuditTrailer|null=null;
  private previousHash='';private receiptHash='';private sequence=0n;private count=0;
  private digest=createHash('sha256');
  accept(line:string):AuditEvent|null{
    if(!line||line.includes('\r')||line.includes('\n')||line.startsWith('\uFEFF'))return fail('Audit file needs JSON Lines without blank lines, CR or BOM.');
    if(this.trailer)return fail('Bytes follow the audit trailer.');
    let value:unknown;try{value=JSON.parse(line);}catch{return fail('Invalid JSON in audit file.');}
    if(!this.header){
      const h=value;
      if(!object(h)||h.schema!==AUDIT_SCHEMA||h.type!=='header'||typeof h.homeId!=='string'||!AUDIT_UUID.test(h.homeId)||!object(h.exportedBy)||!['direct','api-line'].includes(h.transport as string)||typeof h.includeContent!=='boolean'||!Number.isSafeInteger(h.count)||(h.count as number)<0||!object(h.period)||!object(h.tool)||typeof h.tool.name!=='string'||typeof h.tool.version!=='string'||h.completeness!=='committed-through-scan-through'||!Array.isArray(h.gaps)||!h.gaps.every(x=>typeof x==='string'))return fail('Invalid audit header or unsupported schema.');
      if(h.transport==='direct'?h.exportedBy.kind!=='home-person'||typeof h.exportedBy.personId!=='string'||!AUDIT_UUID.test(h.exportedBy.personId):h.exportedBy.kind!=='same-user-process'||(h.exportedBy.uid!==null&&!Number.isSafeInteger(h.exportedBy.uid))||h.includeContent)return fail('Audit attribution or content policy contradicts its transport.');
      if(auditInstant(h.createdAt)!==h.createdAt)return fail('Audit creation time is not canonical UTC.');
      const period=auditOptions(h.period as unknown as AuditOptions);
      if(period.since!==h.period.since||period.until!==h.period.until||!anchor(h.after,h.homeId)||!anchor(h.sourceHead,h.homeId)||!anchor(h.scanThrough,h.homeId))return fail('Invalid audit period or source anchor.');
      if(!object(h.digestKey)||typeof h.digestKey.id!=='string'||!/^[0-9a-f]{32}$/.test(h.digestKey.id)||!['hkdf-master-sha256','legacy-service-secret'].includes(h.digestKey.derivation as string))return fail('Invalid audit digest key identifier.');
      if(h.receiptHashMode!==(h.includeContent?'raw-sha256':'keyed-hmac-sha256'))return fail('Audit receipt hash mode contradicts its content policy.');
      const header=h as unknown as AuditHeader;
      if(header.scanThrough&&(!header.sourceHead||BigInt(header.scanThrough.sequence)>BigInt(header.sourceHead.sequence)))return fail('Audit scan boundary exceeds the snapshot head.');
      if(header.after&&(!header.scanThrough||BigInt(header.after.sequence)>BigInt(header.scanThrough.sequence)))return fail('Audit scan boundary precedes its cursor.');
      this.header=header;this.sequence=BigInt(header.after?.sequence??'0');this.receiptHash=header.after?.receiptHash??'';this.previousHash=auditSha256(line+'\n');return null;
    }
    const h=this.header,v=value;
    if(object(v)&&v.type==='trailer'){
      if(v.schema!==AUDIT_SCHEMA||!Number.isSafeInteger(v.count)||v.count!==h.count||v.count!==this.count||!same(v.cursor,h.scanThrough))return fail('Audit trailer, event count or cursor does not match.');
      const cursor=h.scanThrough?{id:h.scanThrough.id,sequence:h.scanThrough.sequence,receiptHash:h.scanThrough.receiptHash}:null;
      const canonical={schema:AUDIT_SCHEMA,type:'trailer',count:v.count,eventsSha256:v.eventsSha256,lastHash:v.lastHash,cursor};
      if(JSON.stringify(canonical)!==line)return fail('Audit trailer is not in canonical form.');
      if(h.scanThrough&&this.sequence===BigInt(h.scanThrough.sequence)&&this.receiptHash!==h.scanThrough.receiptHash)return fail('Final Core receipt does not match the scan boundary.');
      if(v.lastHash!==this.previousHash||v.eventsSha256!==this.digest.digest('hex'))return fail('Audit event digest or final hash does not match.');
      this.trailer=v as unknown as AuditTrailer;return null;
    }
    if(!object(v)||v.schema!==AUDIT_SCHEMA||v.type!=='event'||v.homeId!==h.homeId||!validSeq(v.sequence)||v.id!==auditCursor(h.homeId,v.sequence)||typeof v.kind!=='string'||!/^[a-z][a-z0-9_.]*$/.test(v.kind)||v.previousHash!==this.previousHash||!object(v.data)||!object(v.receipt)||v.receipt.sequence!==v.sequence||typeof v.receipt.hash!=='string'||!HASH.test(v.receipt.hash)||typeof v.receipt.previousHash!=='string'||(v.receipt.previousHash!==''&&!HASH.test(v.receipt.previousHash))||!Array.isArray(v.omitted)||!v.omitted.every(x=>typeof x==='string'))return fail(`Invalid event or broken hash chain at line ${this.count+2}.`);
    const current=BigInt(v.sequence);
    if(current<=this.sequence||!h.scanThrough||current>BigInt(h.scanThrough.sequence))return fail('Audit events are out of source sequence order.');
    if(current===this.sequence+1n&&v.receipt.previousHash!==this.receiptHash)return fail('Adjacent Core receipts do not chain.');
    const at=auditInstant(v.at);
    if(at!==v.at||at<h.period.since||at>=h.period.until)return fail('Audit event is outside its period or not UTC.');
    if((v.actorId!==null&&(typeof v.actorId!=='string'||!AUDIT_UUID.test(v.actorId)))||(v.subjectId!==null&&(typeof v.subjectId!=='string'||!AUDIT_UUID.test(v.subjectId))))return fail('Invalid audit actor or subject.');
    if(v.disposition!==undefined&&!(typeof v.disposition==='string'&&['held','refused','approved','dispatch-started','succeeded','failed','unknown','cancelled'].includes(v.disposition)))return fail('Invalid disposition enumeration.');
    if(!h.includeContent&&['args_hash','proposal_hash','intent_hash'].some(key=>Object.prototype.hasOwnProperty.call(v.data,key)))return fail('Unkeyed content digest contradicts the audit header.');
    if(v.receiptStatement!==undefined&&(!h.includeContent||typeof v.receiptStatement!=='string'||!object(v.effect)))return fail('Receipt content contradicts the audit header.');
    this.previousHash=auditSha256(line+'\n');this.digest.update(line+'\n');this.sequence=current;this.receiptHash=v.receipt.hash;this.count++;
    return v as unknown as AuditEvent;
  }
  finish():AuditSummary{if(!this.header||!this.trailer)return fail('Audit header or trailer is missing.');return{header:this.header,trailer:this.trailer};}
}
export function auditJoin(current:AuditSummary,previous:AuditSummary){
  if(previous.header.homeId!==current.header.homeId||!same(previous.header.period,current.header.period)||previous.header.includeContent!==current.header.includeContent)return fail('Audit files do not join at the same source cursor, home, period and content policy.');
  if(previous.header.digestKey.id!==current.header.digestKey.id)return fail("these files were digested under different keys (the home's keys changed between them); each verifies alone");
  if(!same(previous.trailer.cursor,current.header.after))return fail('Audit files do not join at the same source cursor, home, period and content policy.');
}
export function auditVerification(record:AuditSummary,joined:boolean){
  return{valid:true as const,homeId:record.header.homeId,count:record.trailer.count,cursor:record.trailer.cursor,joined,assurance:'internal-consistency-only' as const};
}
/** Materialized small-reader API. The CLI uses the same verifier incrementally from a file. */
export function readAudit(jsonl:string,previous?:string):AuditRecord{
  if(!jsonl.endsWith('\n'))return fail('Audit file needs a final LF.');
  const verifier=new AuditVerifier(),events:AuditEvent[]=[];
  for(const line of jsonl.slice(0,-1).split('\n')){const event=verifier.accept(line);if(event)events.push(event);}
  const summary=verifier.finish();if(previous!==undefined)auditJoin(summary,readAudit(previous));return{...summary,events};
}
export function verifyAudit(jsonl:string,previous?:string){return auditVerification(readAudit(jsonl,previous),previous!==undefined);}
