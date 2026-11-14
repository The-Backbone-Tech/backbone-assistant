// The adversary is the payload of every Core kind, including fields current fixtures do not use.
import assert from 'node:assert/strict';
import {readdirSync,readFileSync} from 'node:fs';
import {test} from 'node:test';
import {auditSha256,readAudit} from '../src/audit.ts';
import {AUDIT_PAYLOAD_KEYS,type AuditSource,type SourceEvent} from '../src/composition/audit-export.ts';
import {exportAudit} from './fixtures/audit-collect.ts';
const MARKER='AUDIT_PAYLOAD_PRIVATE_7c09';
import {createHmac} from 'node:crypto';
const uuid='00000000-0000-0000-0000-000000000001';
function fakeSource():AuditSource{
  const directory=new URL('../../core/schema/gov/',import.meta.url),kinds=new Set(['future.recorded']);
  for(const name of readdirSync(directory))if(name.endsWith('.sql'))for(const match of readFileSync(new URL(name,directory),'utf8').matchAll(/gov\._append\('([^']+)'/g))kinds.add(match[1]);
  let previous='';
  const rows:SourceEvent[]=[...kinds].sort().map((kind,i)=>{
    const hash=auditSha256(`synthetic receipt ${i}`),row:SourceEvent={sequence:String(i+1),kind,actorId:uuid,subjectId:uuid,at:'2026-11-10T12:00:00Z',
      data:Object.fromEntries([...AUDIT_PAYLOAD_KEYS,'unknown_future_field'].map(key=>[key,`${MARKER}-${kind}-${key}`])),
      hash,previousReceiptHash:previous,effect:null,run:null,statement:null,decisionSubjectKind:'effect'};previous=hash;return row;
  });
  const anchor=(n:number)=>n?{sequence:String(n),receiptHash:rows[n-1].hash}:null;
  return{homeId:uuid,personId:uuid,digester:()=>({redigest:async value=>auditSha256('private fixture key'+value),keyInfo:async()=>({id:'a'.repeat(32),derivation:'hkdf-master-sha256'})}),async snapshot(_sql,args){
    const after=Number(args[0]),through=args[4]===null?Math.min(rows.length,after+Number(args[6]??rows.length)):Number(args[4]);
    return{allowed:true,head:anchor(rows.length),anchor:anchor(after),through:anchor(through),count:args[4]===null?String(through-after):null,
      events:rows.slice(after,through).slice(0,Number(args[5]))};
  }};
}
test('every known and unknown payload key in every Core event kind rejects private free text',async()=>{
  const source=fakeSource(),made=await exportAudit(source,{since:'2000-01-01T00:00:00Z',until:'2100-01-01T00:00:00Z'});
  assert.equal(made.jsonl.includes(MARKER),false,'free payload strings never cross through data, disposition or another field');
  const record=readAudit(made.jsonl);assert.ok(record.events.length>40);
  for(const event of record.events){
    assert.deepEqual(event.data,{},event.kind);
    for(const key of [...AUDIT_PAYLOAD_KEYS,'unknown_future_field'])assert.ok(event.omitted.includes(`payload.${key}`),`${event.kind}: ${key}`);
  }
});

test('private digest values in every admitted field stay keyed; public SHA-256 guesses confirm none',async()=>{
  const source=fakeSource(),original=source.snapshot,guess=auditSha256('known candidate'),redigest=async(value:string,purpose='receipt')=>createHmac('sha256','fixture private key').update(purpose+value).digest('hex');
  const digests=['tool_hash','description','note','error','scopes','title','goal','ref','content','tool','read_key','project','material','original_sha256','transformation','episode_sha256','prepared_sha256','event','event_at','topic','instruction','text','digest','reason'];
  source.digester=()=>({redigest,keyInfo:async()=>({id:'a'.repeat(32),derivation:'hkdf-master-sha256'})});
  source.snapshot=async(sql,args)=>{const page=await original(sql,args);for(const row of page.events)row.data=Object.fromEntries(digests.map(key=>[key,guess]));return page;};
  const made=readAudit((await exportAudit(source,{since:'2000-01-01T00:00:00Z',until:'2100-01-01T00:00:00Z'})).jsonl);
  for(const event of made.events)for(const key of digests){assert.equal(event.data[key],await redigest(guess,`payload.${key}`));assert.notEqual(event.data[key],guess,key);}
});

test('only piece registration facts retain the published piece digest; other digest fields stay keyed',async()=>{
  const source=fakeSource(),original=source.snapshot,published='sha256:'+auditSha256('published module files'),description=auditSha256('same description');
  source.snapshot=async(sql,args)=>{const page=await original(sql,args);for(const row of page.events)row.data={digest:published,description};return page;};
  const record=readAudit((await exportAudit(source,{since:'2000-01-01T00:00:00Z',until:'2100-01-01T00:00:00Z'})).jsonl);
  let publicFacts=0;
  for(const event of record.events){
    if(['piece.registered','piece.unregistered'].includes(event.kind)){assert.equal(event.data.digest,published);publicFacts++;}
    else assert.equal(event.data.digest,await source.digester().redigest(published,'payload.digest'),event.kind);
    assert.notEqual(event.data.description,description);
  }
  assert.equal(publicFacts,2);
});

test('approval export admits only checked finite basis shapes and never arbitrary nested person claims', async () => {
  const cases: [unknown, string | undefined][] = [
    [{ method: 'person' }, 'person'], [{ method: 'standing_signature', signature: uuid }, 'standing_signature'],
    [{ method: 'person', note: MARKER }, undefined], [{ method: 'standing_signature', signature: MARKER }, undefined],
    [{ method: MARKER }, undefined], [MARKER, undefined], [null, undefined],
  ];
  for (const [basis, expected] of cases) {
    const source = fakeSource(), original = source.snapshot;
    source.snapshot = async (sql, args) => { const page = await original(sql, args); for (const row of page.events) row.data = { basis }; return page; };
    const made = await exportAudit(source, { since: '2000-01-01T00:00:00Z', until: '2100-01-01T00:00:00Z' });
    assert.equal(made.jsonl.includes(MARKER), false);
    for (const event of readAudit(made.jsonl).events) assert.equal(event.data.approval_method, event.kind === 'decision.answered' ? expected : undefined);
  }
});
