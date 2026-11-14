// One statement snapshot of Core receipts and its committed ledger head, read as the home's person.
import { governedPolicy, auditDecision } from '../policy/index.ts';
import { createHash, randomUUID } from 'node:crypto';
import {auditDigester, type AuditRedigest, type AuditDigester} from './audit-digest.ts';
import { readFileSync } from 'node:fs';
import type { Receipt } from '../api.ts';
import { AUDIT_SCHEMA, AUDIT_SLOT_BUSY, AUDIT_UUID, AUDIT_CONTENT_DIRECT_ONLY, AuditInvalid, auditCursor, auditOptions, auditSha256, decodeAuditCursor, type AuditAnchor, type AuditEffect, type AuditEvent, type AuditExport, type AuditHeader, type AuditOptions, type AuditRun, type AuditSummary, type AuditPage, type AuditRequest } from '../audit.ts';
import type { CoreLink } from './core.ts';

export const AUDIT_GAPS = [
  'standing-signature-creation-revocation-and-id-not-in-core',
  'human-release-versus-standing-signature-not-structured-in-core',
  'person-sign-in-not-in-tenant-ledger',
  'run-claims-are-not-all-ui-turn-boundaries',
  'pre-receipt-refusals-and-ungated-activity-not-recorded',
  'export-is-not-independently-witnessed',
  'mandate-terms-budgets-and-expiry-not-structured-in-ledger',
  'content-export-on-api-line-needs-person-confirmed-asked-call',
] as const;
export const AUDIT_OMITTED = ['prompt', 'answer', 'document', 'fileName', 'documentTitle', 'connectorArguments', 'connectorResult', 'receiptStatement'] as const;
const TOOL_VERSION = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
export const AUDIT_PAGE_SIZE = 64;
const SQL_UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
export const AUDIT_QUERY = `WITH permitted AS (
  SELECT EXISTS (SELECT FROM app.principals p WHERE p.id = sec.current_principal()
    AND p.kind = 'person' AND p.status = 'active' AND sec.is_admin(p.id)
    AND NOT sec.names_run()) AS allowed
), head AS (
  SELECT seq::text AS sequence, hash AS "receiptHash" FROM app.ledger
  WHERE (SELECT allowed FROM permitted) ORDER BY seq DESC LIMIT 1
), anchor AS (
  SELECT seq::text AS sequence, hash AS "receiptHash" FROM app.ledger
  WHERE (SELECT allowed FROM permitted) AND seq = $1::bigint
), through AS (
  SELECT seq::text AS sequence, hash AS "receiptHash" FROM app.ledger
  WHERE (SELECT allowed FROM permitted) AND seq::numeric <= coalesce($5::numeric,
    least((SELECT sequence::numeric FROM head), $1::numeric + coalesce($7::numeric, (SELECT sequence::numeric FROM head))))
  ORDER BY seq DESC LIMIT 1
), selected AS (
  SELECT l.*, CASE WHEN l.subject ~ '${SQL_UUID}' THEN l.subject::uuid END AS subject_uuid
  FROM app.ledger l WHERE (SELECT allowed FROM permitted) AND l.seq > $1::bigint
    AND l.seq <= (SELECT sequence::bigint FROM through) AND l.at >= $2::timestamptz AND l.at < $3::timestamptz
  ORDER BY l.seq LIMIT $6::integer
), events AS (
  SELECT l.seq::text AS sequence, l.entry_type AS kind, l.actor_id AS "actorId", l.subject AS "subjectId",
    l.at, l.payload AS data, l.hash, l.prev_hash AS "previousReceiptHash",
    CASE WHEN e.id IS NOT NULL THEN jsonb_build_object('id', e.id, 'runId', e.run_id,
      'taskId', e.task_id, 'mandateId', e.mandate_id, 'proposerId', e.proposer_id,
      'beneficiaryId', e.on_behalf_of_id, 'connectionId', e.connection_id,
      'undoOf', e.undo_of, 'repeatOf', e.repeat_of, 'class', e.effect_class) END AS effect,
    CASE WHEN r.id IS NOT NULL THEN jsonb_build_object('id', r.id, 'taskId', r.task_id,
      'mandateId', r.mandate_id, 'engineId', r.piece_id) END AS run,
    CASE WHEN $4::boolean AND e.id IS NOT NULL THEN e.description END AS statement,
    d.subject_kind AS "decisionSubjectKind"
  FROM selected l
  LEFT JOIN app.decisions d ON l.entry_type LIKE 'decision.%' AND d.id = l.subject_uuid
  LEFT JOIN app.effects e ON e.id = CASE WHEN l.entry_type LIKE 'effect.%' THEN l.subject_uuid
    WHEN d.subject_kind = 'effect' THEN d.subject_id END
  LEFT JOIN app.runs r ON r.id = CASE WHEN l.entry_type LIKE 'run.%' THEN l.subject_uuid ELSE e.run_id END
)
SELECT (SELECT allowed FROM permitted) AS allowed,
  (SELECT row_to_json(h) FROM head h) AS head,
  (SELECT row_to_json(a) FROM anchor a) AS anchor,
  (SELECT row_to_json(t) FROM through t) AS through,
  CASE WHEN $5::bigint IS NULL THEN (SELECT count(*)::text FROM app.ledger
    WHERE (SELECT allowed FROM permitted) AND seq > $1::bigint AND seq <= (SELECT sequence::bigint FROM through)
      AND at >= $2::timestamptz AND at < $3::timestamptz) END AS count,
  coalesce((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.sequence::bigint) FROM events e), '[]'::jsonb) AS events`;

export interface SourceEvent {
  sequence: string; kind: string; actorId: string | null; subjectId: string | null; at: string;
  data: Record<string, unknown>; hash: string; previousReceiptHash: string;
  effect: AuditEffect | null; run: AuditRun | null; statement: string | null; decisionSubjectKind: string | null;
}
export interface Snapshot { allowed: boolean; head: Omit<AuditAnchor, 'id'> | null; anchor: Omit<AuditAnchor, 'id'> | null; through: Omit<AuditAnchor,'id'> | null; count: string | null; events: SourceEvent[] }
export interface AuditSource {
  homeId: string; personId: string; digester():AuditDigester;
  /** Must execute the supplied SELECT as this person, outside a run, in one statement snapshot. */
  snapshot(sql: string, values: unknown[]): Promise<Snapshot>;
}
const uuids = new Set(['owner', 'system', 'invited_by', 'parent', 'subject', 'on_behalf_of', 'root', 'task', 'agent', 'mandate', 'run', 'repeat_of', 'undo_of', 'checker', 'dispatcher', 'resolver', 'settled_by', 'for', 'effect', 'document', 'person', 'source', 'episode', 'candidate', 'decision', 'memory', 'to']);
const numbers = new Set(['ms', 'tokens', 'fence', 'cost_micros', 'class', 'tools', 'version', 'generation', 'sequence', 'observed_version']);
const booleans = new Set(['late', 'swept', 'sensitive', 'untrusted', 'imported', 'kept', 'lowers', 'accepted']);
const digests = new Set(['intent_hash', 'args_hash', 'tool_hash', 'description', 'proposal_hash', 'note', 'error', 'scopes', 'title', 'goal', 'ref', 'content', 'tool', 'read_key', 'project', 'material', 'original_sha256', 'transformation', 'episode_sha256', 'prepared_sha256', 'event', 'event_at', 'topic', 'instruction', 'text', 'digest']);
const enums: Record<string, readonly string[]> = {
  kind: ['personal', 'team', 'file', 'document', 'message', 'web', 'mcp', 'instruction', 'reminder', 'group', 'direct'],
  role: ['owner', 'admin', 'member', 'guest', 'worker', 'verifier', 'person', 'agent', 'system'],
  from: ['owner', 'admin', 'member', 'guest'], to: ['owner', 'admin', 'member', 'guest'],
  visibility: ['private', 'workspace'], status: ['queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled', 'open', 'done', 'paused', 'ok', 'error'],
  outcome: ['succeeded', 'failed', 'cancelled', 'unknown'],
  route: ['free', 'allowed', 'allowed_after_window', 'needs_checker', 'denied'],
  verdict: ['approved', 'rejected'], subject_kind: ['effect', 'promotion', 'elevation'], checker_kind: ['person', 'verifier'],
  scope: ['person', 'workspace'], platform: ['slack', 'telegram'], trust: ['trusted', 'untrusted'],
  reason: ['rule_of_two', 'elevation', 'final', 'above_ceiling', 'outside_mandate', 'mandate_revoked', 'mandate_expired', 'budget_exhausted', 'budget_tokens', 'budget_cost', 'budget_duration', 'budget_effects', 'already_rejected', 'repeat_unknown_blocked', 'repeat_pending', 'outside_piece', 'above_piece_ceiling', 'piece_unregistered', 'no_carrier', 'no_mandate', 'mandate revoked', 'piece unregistered'],
};
const unkeyed = ['args_hash', 'proposal_hash', 'intent_hash'] as const;
async function project(data: Record<string, unknown>, includeContent: boolean, redigest: AuditRedigest, kind:string) {
  const kept: AuditEvent['data'] = {}, omitted: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    // Project only the checked finite method, never arbitrary basis text or nested fields.
    if (key === 'basis' && kind === 'decision.answered' && value && typeof value === 'object' && !Array.isArray(value)) {
      const basis = value as Record<string, unknown>;
      if ((basis.method === 'person' && Object.keys(basis).length === 1)
        || (basis.method === 'standing_signature' && Object.keys(basis).length === 2 && typeof basis.signature === 'string' && AUDIT_UUID.test(basis.signature)))
        kept.approval_method = basis.method;
    }
    if (!includeContent && (unkeyed as readonly string[]).includes(key)) continue;
    const safe = value === null || (uuids.has(key) && typeof value === 'string' && AUDIT_UUID.test(value))
      || (numbers.has(key) && typeof value === 'number' && Number.isSafeInteger(value))
      || (booleans.has(key) && typeof value === 'boolean')
      || (digests.has(key) && typeof value === 'string' && /^(?:sha256:)?[0-9a-f]{64}$/.test(value))
      || (key === 'reason' && typeof value === 'string' && /^[0-9a-f]{64}$/.test(value))
      || (key === 'carrier' && typeof value === 'string' && (value === 'direct' || AUDIT_UUID.test(value)))
      || (typeof value === 'string' && enums[key]?.includes(value));
    const publicPieceDigest=key==='digest'&&['piece.registered','piece.unregistered'].includes(kind)&&typeof value==='string'&&/^sha256:[0-9a-f]{64}$/.test(value);
    if (safe) kept[key] = !includeContent && !publicPieceDigest && typeof value === 'string' && /^(?:sha256:)?[0-9a-f]{64}$/.test(value) ? await redigest(value,`payload.${key}`) : value as string | number | boolean | null;
    else omitted.push(`payload.${key}`);
  }
  if (!includeContent) omitted.push(...unkeyed.map(key => `payload.${key}`));
  return { kept, omitted };
}
export const AUDIT_PAYLOAD_KEYS = [...new Set([...uuids,...numbers,...booleans,...digests,...Object.keys(enums),
  'carrier','operation','connection','external_ref','slug','worker','piece','operations','basis'])];
function disposition(row:SourceEvent):string|undefined{
  const {route,verdict,outcome}=row.data;
  if(row.kind==='effect.proposed'&&typeof route==='string'&&enums.route.includes(route))return({needs_checker:'held',denied:'refused',free:'approved',allowed:'approved',allowed_after_window:'approved'} as Record<string,string>)[route];
  if(row.kind==='decision.answered'&&row.decisionSubjectKind==='effect'&&typeof verdict==='string'&&enums.verdict.includes(verdict))return verdict==='approved'?'approved':'refused';
  if(row.kind==='effect.dispatched')return'dispatch-started';
  if(row.kind==='effect.cancelled')return'cancelled';
  if(['effect.observed','effect.reconciled'].includes(row.kind)&&typeof outcome==='string'&&enums.outcome.includes(outcome))return outcome;
}

async function eventOf(source: AuditSource, options: AuditOptions, row: SourceEvent, previousHash: string, redigest:AuditRedigest): Promise<AuditEvent> {
  const { kept, omitted } = await project(row.data, options.includeContent === true, redigest,row.kind), state = disposition(row);
  const event: AuditEvent = { schema: AUDIT_SCHEMA, type: 'event', homeId: source.homeId, id: auditCursor(source.homeId, row.sequence), sequence: row.sequence,
      kind: row.kind, at: new Date(row.at).toISOString(), actorId: row.actorId,
      subjectId: row.subjectId && AUDIT_UUID.test(row.subjectId) ? row.subjectId : null, data: kept,
      receipt: { sequence: row.sequence, hash: options.includeContent ? row.hash : await redigest(row.hash), previousHash: !row.previousReceiptHash ? '' : options.includeContent ? row.previousReceiptHash : await redigest(row.previousReceiptHash) },
      ...(row.effect ? { effect: row.effect } : {}), ...(row.run ? { run: row.run } : {}), ...(state ? { disposition: state } : {}),
      ...(row.effect && ['effect.proposed', 'decision.answered'].includes(row.kind) ? { authority: {
        method: row.kind === 'decision.answered' ? 'core-decision' as const : 'mandate' as const,
        actorId: row.actorId, mandateId: row.effect.mandateId, decisionId: row.kind === 'decision.answered' ? row.subjectId : null,
      } } : {}),
      ...(options.includeContent && row.statement !== null ? { receiptStatement: row.statement } : {}),
      omitted: [...AUDIT_OMITTED.filter(field => field !== 'receiptStatement' || !options.includeContent || row.statement === null), ...omitted,
        ...(!row.subjectId || AUDIT_UUID.test(row.subjectId) ? [] : ['subject']),
        ...(row.kind === 'decision.answered' && row.decisionSubjectKind === 'effect' ? ['approvalMethod', 'signatureId'] : [])], previousHash };
  return event;
}
const anchorOf = async (source: AuditSource, redigest:AuditRedigest, raw: boolean, value: Omit<AuditAnchor,'id'> | null): Promise<AuditAnchor | null> => value ? {id:auditCursor(source.homeId,value.sequence),sequence:value.sequence,receiptHash:raw?value.receiptHash:await redigest(value.receiptHash)} : null;

/** Fixed committed boundary, scalar count, and at most one page of source rows in memory. */
export async function openAuditExport(source: AuditSource, supplied: AuditOptions, transport: 'direct' | 'api-line' = 'direct') {
  const options=auditOptions(supplied), after=options.after ? decodeAuditCursor(options.after) : null;
  if(transport==='api-line'&&options.includeContent)throw new AuditInvalid(AUDIT_CONTENT_DIRECT_ONLY);
  if(after&&after.homeId!==source.homeId)throw new AuditInvalid('This audit cursor belongs to another home.');
  const parameters=(cursor:string,through:string|null)=>[cursor,options.since,options.until,options.includeContent,through,AUDIT_PAGE_SIZE,options.limit??null];
  const first=await source.snapshot(AUDIT_QUERY,parameters(after?.sequence??'0',null));
  if(!first.allowed)throw new AuditInvalid('Audit export requires the home’s active person, outside a run, with the existing owner or admin role.');
  if(after&&!first.anchor)throw new AuditInvalid('The audit cursor has no committed Core receipt in this home.');
  const digester=source.digester(),redigest=digester.redigest;
  const header:AuditHeader={schema:AUDIT_SCHEMA,type:'header',homeId:source.homeId,transport,
    exportedBy:transport==='direct'?{kind:'home-person',personId:source.personId}:{kind:'same-user-process',uid:process.getuid?.()??null},
    createdAt:new Date().toISOString(),period:{since:options.since,until:options.until},tool:{name:'@backbone-next/platform',version:TOOL_VERSION},
    includeContent:options.includeContent===true,digestKey:await digester.keyInfo(),receiptHashMode:options.includeContent?'raw-sha256':'keyed-hmac-sha256',count:Number(first.count),after:await anchorOf(source,redigest,options.includeContent===true,first.anchor),
    sourceHead:await anchorOf(source,redigest,options.includeContent===true,first.head),scanThrough:await anchorOf(source,redigest,options.includeContent===true,first.through),completeness:'committed-through-scan-through',gaps:AUDIT_GAPS};
  let pending:SourceEvent[]|null=first.events, sent=0, cursor=after?.sequence??'0', previousHash='', done=false;
  const digest=createHash('sha256');
  return {header,async next():Promise<AuditPage>{
    if(done)throw new AuditInvalid('This audit export is already complete.');
    const lines:string[]=[];
    if(pending!==null){const line=JSON.stringify(header)+'\n';lines.push(line);previousHash=auditSha256(line);}
    let rows:SourceEvent[];
    if(pending!==null){rows=pending;pending=null;}else{
      const page=await source.snapshot(AUDIT_QUERY,parameters(cursor,header.scanThrough?.sequence??'0'));
      if(!page.allowed)throw new AuditInvalid('The existing owner/admin role no longer permits this audit read.');
      rows=page.events;
    }
    if(rows.length>AUDIT_PAGE_SIZE)throw new AuditInvalid('The audit source exceeded its bounded page size.');
    if(rows.length===0&&sent<header.count)throw new AuditInvalid('The audit source changed before every counted event could be read.');
    for(const row of rows){const line=JSON.stringify(await eventOf(source,options,row,previousHash,redigest))+'\n';lines.push(line);digest.update(line);previousHash=auditSha256(line);cursor=row.sequence;sent++;}
    let trailer:AuditPage['trailer']=null;
    if(sent>=header.count){
      if(sent!==header.count)throw new AuditInvalid('The audit source count changed.');
      trailer={schema:AUDIT_SCHEMA,type:'trailer',count:sent,eventsSha256:digest.digest('hex'),lastHash:previousHash,cursor:header.scanThrough};
      lines.push(JSON.stringify(trailer)+'\n');done=true;
    }
    return {jsonl:lines.join(''),header,trailer,session:null};
  }};
}

/** Production streaming path. The writer is awaited before the next page is fetched. */
export async function exportAudit(source:AuditSource, supplied:AuditOptions, write:(bytes:string)=>Promise<void>, transport:'direct'|'api-line'='direct'):Promise<AuditSummary>{
  const stream=await openAuditExport(source,supplied,transport);
  for(;;){const page=await stream.next();await write(page.jsonl);if(page.trailer)return{header:page.header,trailer:page.trailer};}
}
export function coreAuditSource(link:CoreLink):AuditSource{
  return{homeId:link.id.workspace,personId:link.id.person,digester:()=>auditDigester(link.vault.home,link.id.workspace,link.vault),snapshot:async(sql,values)=>{auditDecision(governedPolicy(link.vault.home),values[3]===true);return(await link.read<Snapshot>(link.person(),sql,values)).rows[0]}};
}
// One process-wide slot: 60 s idle expiry and a fixed two-minute lifetime, never renewed.
let active:{token:string;home:string;stream:Promise<Awaited<ReturnType<typeof openAuditExport>>>;busy:boolean;timer?:NodeJS.Timeout;deadline?:NodeJS.Timeout}|null=null;
function release(){if(active?.timer)clearTimeout(active.timer);if(active?.deadline)clearTimeout(active.deadline);active=null;}
export async function auditReceipt(link:CoreLink,options:AuditRequest,timeouts={idleMs:60000,lifetimeMs:120000}):Promise<Receipt<AuditPage>>{
  try{
    if(options.includeContent)throw new AuditInvalid(AUDIT_CONTENT_DIRECT_ONLY);
    if(options.session){
      if(!active||active.token!==options.session||active.home!==link.id.workspace)throw new AuditInvalid('No such active audit read session.');
      if(active.busy)throw new AuditInvalid('This audit export already has a page in progress.');
      if(options.cancel){const stream=await active.stream;release();return{ok:true,value:{header:stream.header,jsonl:'',trailer:null,session:null}};}
    }else{
      if(active)throw new AuditInvalid(AUDIT_SLOT_BUSY);
      active={token:randomUUID(),home:link.id.workspace,stream:openAuditExport(coreAuditSource(link),options,'api-line'),busy:false};
      const owned=active;owned.deadline=setTimeout(()=>{if(active===owned)release();},timeouts.lifetimeMs);owned.deadline.unref();
    }
    const current=active!;current.busy=true;if(current.timer)clearTimeout(current.timer);
    try{const stream=await current.stream,page=await stream.next();
      if(active!==current)throw new AuditInvalid('The audit session reached its maximum lifetime; restart from the last accepted cursor.');
      if(page.trailer)release();else{current.busy=false;current.timer=setTimeout(()=>{if(active===current)release();},timeouts.idleMs);current.timer.unref();}
      return{ok:true,value:{...page,session:page.trailer?null:current.token}};
    }catch(error){if(active===current)release();throw error;}
  }catch(error){if(error instanceof AuditInvalid)return{ok:false,reason:'INVALID',detail:error.message,outcome:'REFUSED'};throw error;}
}
