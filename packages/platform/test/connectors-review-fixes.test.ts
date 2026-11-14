import assert from 'node:assert/strict';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test,type TestContext} from 'node:test';
import {CoreLink} from '../src/composition/core.ts';
import {inActiveHomeLockScope} from '../src/composition/home-lock.ts';
import {McpSession,canonicalDefinitionDigest,type ListedTool} from '../src/connectors/client.ts';
import {blocked,ConnectorService,kindOf,legacyDefinitionOf} from '../src/connectors/service.ts';
import {defaultToolEnv} from '../src/tools/places.ts';
import {freshDir,freshHome,value} from './helpers.ts';
const id='claude-code:notes';
const tool=(name='draft_note',readOnlyHint=false):ListedTool=>({name,description:'Fixture definition.',inputSchema:{type:'object',properties:{text:{type:'string'},limit:{type:'number'}}},annotations:{readOnlyHint,destructiveHint:false}});
async function fixture(t:TestContext,original=tool(),legacy:boolean|'full'=false){
 const home=freshHome(),person=freshDir('connector-review-'),control=join(person,'tools.json'),log=join(person,'calls.jsonl');
 const list=(definition:ListedTool)=>writeFileSync(control,JSON.stringify([definition]));list(original);
 writeFileSync(join(person,'.claude.json'),JSON.stringify({mcpServers:{notes:{command:process.execPath,args:[join(import.meta.dirname,'fake-mcp-kind-server.ts')],env:{FAKE_KIND_CONTROL:control,FAKE_KIND_LOG:log}}}}));
 const link=await CoreLink.open({home});t.after(()=>link.close());
 const service=new ConnectorService({home,env:()=>defaultToolEnv({HOME:person,PATH:process.env.PATH}),link:async()=>link,callTimeoutMs:3_000});t.after(()=>service.close());
 const file=join(home,'connectors','mcp.json'),record=()=>JSON.parse(readFileSync(file,'utf8'));
 const offered=()=>service.offered().find(t=>t.tool===original.name)!;
 const sign=()=>{const view=service.toolView(id,original.name)!;return service.set(id,{seal:view.seal,tool:{name:original.name,standing:{stamp:view.stamp}}});};
 // Build the released shape through product mutations. No lock, seal or connector record is written by this helper.
 const tools=McpSession.prototype.tools;
 const oldShape=legacy?t.mock.method(McpSession.prototype,'tools',async function(this:McpSession,...args:Parameters<McpSession['tools']>){
  return (await tools.apply(this,args)).map(t=>legacy==='full'?{...t,definitionDigest:t.previousDefinitionDigest,definitionDigestVersion:undefined}:{name:t.name,...(t.title?{title:t.title}:{}),description:t.description,inputSchema:t.inputSchema,annotations:t.annotations});
 }):undefined;
 try{
  value(await service.refresh(id));value(await service.set(id,{enabled:true}));value(await service.set(id,{tool:{name:original.name,enabled:true}}));
  value(await service.set(id,{egress:true,seal:service.doorSeal(id)!}));
  if(!original.annotations.readOnlyHint)value(await sign());
  if(legacy){const stored=record().servers[id].tools[original.name];assert.equal(stored.listed.definitionDigestVersion,undefined);if(legacy===true){assert.equal(stored.listed.definitionDigest,undefined);assert.equal(stored.definition,legacyDefinitionOf(stored.listed));}else assert.equal(stored.definition,stored.listed.previousDefinitionDigest);}
 }finally{oldShape?.mock.restore();}
 let n=0,reads=0;
 const core={readObserved:async(request)=>{reads++;await request.perform();return {outcome:'READ',text:'ran',status:'complete'};}} as import('../src/connectors/service.ts').ConnectorCore;
 const call=(args:Record<string,unknown>={},offer=offered())=>service.call(offer,args,core,{threadId:'review',turnId:`review-${++n}`,seq:n},new AbortController().signal);
 const calls=()=>existsSync(log)?readFileSync(log,'utf8').trim().split('\n').map(l=>JSON.parse(l)):[];
 const ledger=async()=>(await link.read<{entry_type:string;payload:Record<string,unknown>;subject:string}>(link.person(),"SELECT entry_type,payload,subject FROM app.ledger ORDER BY seq")).rows;
 return {home,service,link,list,record,offered,sign,call,calls,ledger,reads:()=>reads};
}
const examples:[string,'effect'|'read',boolean][]=[
 ['send_email','effect',true],
 ['post_message','effect',true],
 ['order_item','effect',true],
 ['email_send','effect',true],
 ['get_post','read',true],
 ['list_orders','read',true],
 ['postpone','effect',true],
 ['get_and_send','effect',true],
 ['list_then_delete','effect',true],
 ['read_post_and_publish','effect',true],
 ['get_share','read',true],
 ['search_payments','read',true],
 ['describe_charge','read',true],
 ['read_invites','read',true],
 ['fetch_replies','read',false],
 ['find_purchases','read',true],
 ['count_refunds','read',true],
 ['show_tweets','read',true],
 ['view_broadcasts','read',true],
 ['lookup_forwards','read',true],
 ['email_post','effect',true],
 ['posts','effect',true],
 ['charge_card','effect',true],
 ['reply_all','effect',true],
 ['get_delete','effect',true],
 ['get_transfer','effect',true],
 ['getPost','read',true],
 ['listOrders','read',true],
 ['email.send','effect',true],
 ['SEND_email','effect',true],
 ['remove-item','effect',true],
 ['payment_status','effect',true],
 ['sendemail','effect',true],
 ['postmessage','effect',true],
 ['reorder','effect',true],
 ['buynow','effect',true],
 ['chargecard','effect',true],
 ['search_replies','read',false],
 ['getPayments','read',true],
 ['show_share','read',true],
 ['get_refund','read',true],
 ['fetch_and_forward','effect',true],
 ['read_and_reply','effect',true],
 ['list_then_post','effect',true],
 ['show_share_now','effect',true],
 ['lookup_charge_card','effect',true],
 ['get_refund_and_pay','effect',true],
 ['getPost2Send','effect',true],
 ['get_publi_share','effect',true],
 ['get_post_post','effect',true],
 ['get2_post','effect',true],
 ['get_post2','effect',true],
 ['resend_invoice','effect',true],
 ['autosend','effect',true],
 ['sends','effect',true],
 ['sending','effect',true],
 ['deleteall','effect',true],
 ['bulkdelete','effect',true],
 ['deletes','effect',true],
 ['removeall','effect',true],
 ['unpublish','effect',true],
 ['redeploy','effect',true],
 ['resubmit','effect',true],
 ['payinvoice','effect',true],
 ['repay','effect',true],
 ['wipeout','effect',true],
 ['withdrawal','effect',true],
 ['get_and_post','effect',true],
 ['get_then_post','effect',true],
 ['get_to_post','effect',true],
 ['get_with_post','effect',true],
 ['get_or_post','effect',true],
 ['get_plus_post','effect',true],
];
test('every contract example follows word rules; unannotated tools still default to effect',()=>{
 const contract=readFileSync(new URL('../../../docs/contracts/connectors.md',import.meta.url),'utf8');
 assert.deepEqual([...contract.matchAll(/^\| `([^`]+)` \| `(read|effect)` \| `(true|false)` \|$/gm)].map(m=>[m[1],m[2],m[3]==='true']),examples,'every documented row is tested');
 for(const [name,kind,sendBlocked] of examples){
  assert.equal(kindOf(tool(name,true)),kind,name);assert.equal(blocked(name),sendBlocked,`${name}: effect-name list membership`);
  assert.equal(kindOf({...tool(name),annotations:{}}),'effect',`${name}: unannotated`);
 }
});
test('look-alike, mixed-script and invalid names cannot become reads through hints or overrides',async t=>{
 for(const name of ['sеnd_email','ѕend_email','get_pоst','search\u200bnotes','read notes','read/notes','read📝']){
  for(const override of [undefined,'read','effect'] as const)assert.equal(kindOf(tool(name,true),override),'effect',name);
 }
 const p=await fixture(t,tool('sеnd_email',true));assert.equal((await p.call()).outcome,'HELD');assert.equal(p.reads(),0);assert.equal(p.calls().length,0);
});
for(const entry of ['refresh','call'] as const)test(`legacy matching pin upgrades locally through ${entry} without ending its signature`,async t=>{
 const p=await fixture(t,tool(),true),before=p.record().servers[id].tools.draft_note,history=await p.ledger();
 const crossing=p.link.call.bind(p.link),signatureCalls:string[]=[];
 p.link.call=(async(...args:Parameters<CoreLink['call']>)=>{assert.equal(inActiveHomeLockScope(p.home),false);if(/gov\.(give|end)_connector_signature/.test(String(args[1])))signatureCalls.push(String(args[1]));return crossing(...args);}) as CoreLink['call'];
 if(entry==='refresh')value(await p.service.refresh(id));else assert.equal((await p.call()).outcome,'SENT');
 const after=p.record().servers[id].tools.draft_note;
 assert.ok(after.listed.definitionDigest);assert.equal(after.definition,after.listed.definitionDigest);assert.equal(after.enabled,true);
 assert.equal(after.standing.id,before.standing.id);assert.equal(after.standing.definition,after.definition);assert.equal(after.rev,before.rev);
 assert.equal(p.record().pendingEnds,undefined);assert.deepEqual(signatureCalls,[]);
 assert.deepEqual((await p.ledger()).filter(r=>r.entry_type.startsWith('signature.')),history.filter(r=>r.entry_type.startsWith('signature.')));
 if(entry==='refresh'){assert.deepEqual(await p.ledger(),history,'representation-only refresh records nothing in Core');assert.equal((await p.call()).outcome,'SENT');}assert.equal(p.calls().length,1);
});
for(const entry of ['refresh','call'] as const)test(`legacy changed pin retires through ${entry} with definition_changed`,async t=>{
 const p=await fixture(t,tool(),true),signature=p.record().servers[id].tools.draft_note.standing.id;
 p.list({...tool(),description:'A different definition.'});
 if(entry==='refresh')value(await p.service.refresh(id));else assert.notEqual((await p.call()).outcome,'SENT');
 assert.equal(p.record().servers[id].tools.draft_note.standing,undefined);assert.equal(p.offered(),undefined);assert.equal(p.calls().length,0);
 assert.deepEqual((await p.ledger()).find(r=>r.entry_type==='signature.ended'&&r.subject===signature)?.payload,{signature,reason:'definition_changed'});
});
test('a legacy read pin upgrades without dispatching as an effect',async t=>{
 const p=await fixture(t,tool('search',true),true);assert.equal((await p.call({post:5})).outcome,'READ');
 assert.equal(p.record().servers[id].tools.search.definition,p.record().servers[id].tools.search.listed.definitionDigest);
 assert.equal(p.service.list().held.length,0);assert.equal(p.reads(),1);
});
const reverseKeys=(v:unknown):unknown=>Array.isArray(v)?v.map(reverseKeys):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).reverse().map(([k,v])=>[k,reverseKeys(v)])):v;
test('reordered definition keys preserve the pin and signature; nested value changes retire it',async t=>{
 const original={...tool(),outputSchema:{type:'object',properties:{status:{type:'string'},count:{type:'number'}}},_meta:{a:1,b:{c:'same',d:true}}};
 const p=await fixture(t,original),before=p.record().servers[id].tools.draft_note;
 p.list(reverseKeys(original) as ListedTool);value(await p.service.refresh(id));
 assert.equal(p.offered().definition,before.definition);assert.equal(p.record().servers[id].tools.draft_note.standing.id,before.standing.id);
 assert.equal((await p.call()).outcome,'SENT');
 const changed={...original,_meta:{a:1,b:{c:'different',d:true}}};p.list(changed);value(await p.service.refresh(id));
 assert.equal(p.offered(),undefined);assert.equal(p.record().servers[id].tools.draft_note.standing,undefined);
});
test('an end between local approval and Core answer cancels with a fixed ledger reason',async t=>{
 const p=await fixture(t),call=p.link.call.bind(p.link);let ended=false;
 p.link.call=(async(...args:Parameters<CoreLink['call']>)=>{
  if(!ended&&String(args[1]).includes('answer_decision_with_basis')){
   ended=true;const end=p.link.call;
   p.link.call=(async(...inner:Parameters<CoreLink['call']>)=>{if(String(inner[1]).includes('end_connector_signature'))throw Error('retain pending end');return call(...inner);}) as CoreLink['call'];
   await assert.rejects(p.service.set(id,{tool:{name:'draft_note',standing:false}}),/signature end could not be confirmed/);p.link.call=end;
  }
  return call(...args);
 }) as CoreLink['call'];
 assert.notEqual((await p.call()).outcome,'SENT');assert.equal(ended,true);assert.equal(p.calls().length,0);
 const history=await p.ledger();assert.ok(history.some(r=>r.entry_type==='decision.answered'&&(r.payload.basis as {method?:string})?.method==='standing_signature'));
 const cancelled=history.find(r=>r.entry_type==='effect.cancelled');assert.ok(cancelled);
 // Core's released ledger stores a keyed digest; its effect record retains the readable reason.
 const reason=(await p.link.read<{cancel_reason:string}>(p.link.person(),'SELECT cancel_reason FROM app.effects WHERE id=$1',[cancelled.subject])).rows[0].cancel_reason;
 assert.equal(reason,'The standing signature ended before sending. Nothing was sent.');
 assert.match(String(cancelled.payload.reason),/^[a-f0-9]{64}$/);
 assert.equal(reason.includes('draft_note'),false);assert.equal(reason.includes('notes'),false);
 p.link.call=call;await p.service.ready();
});

test('a re-sign overtaken after Core give leaves the old local signature unusable in Core',async t=>{
 const p=await fixture(t),before=p.record().servers[id].tools.draft_note.standing.id,call=p.link.call.bind(p.link);let overtaken=false;
 p.link.call=(async(...args:Parameters<CoreLink['call']>)=>{
  const result=await call(...args);
  if(!overtaken&&String(args[1]).includes('give_connector_signature')){overtaken=true;value(await p.service.set(id,{tool:{name:'draft_note',enabled:true}}));}
  return result;
 }) as CoreLink['call'];
 assert.equal((await p.sign()).ok,false);assert.equal(overtaken,true);
 assert.equal(p.record().servers[id].tools.draft_note.standing.id,before,'local file still has the old signature');
 assert.ok((await p.ledger()).some(r=>r.entry_type==='signature.ended'&&r.subject===before&&r.payload.reason==='superseded'));
 assert.equal((await p.call()).outcome,'HELD');assert.equal(p.calls().length,0,'Core refuses the old local signature');
});

test('canonical digests ignore key order but retain each JSON value, type and array order',()=>{
 const original={label:'one',limit:1,ready:true,missing:null,sequence:['a','b'],nested:{a:1,b:2}};
 const digest=canonicalDefinitionDigest(original);assert.equal(canonicalDefinitionDigest(reverseKeys(original)),digest);
 for(const changed of [{...original,label:'two'},{...original,limit:2},{...original,ready:false},{...original,missing:false},{...original,limit:'1'},{...original,sequence:['b','a']},{...original,nested:{a:1,b:3}},{...original,extra:null}])
  assert.notEqual(canonicalDefinitionDigest(changed),digest);
 const {missing,...removed}=original;assert.notEqual(canonicalDefinitionDigest(removed),digest);
});
test('a legacy held standing approval is re-pinned without replacing its signature or resending',async t=>{
 const p=await fixture(t,tool(),true),call=p.link.call.bind(p.link),tools=McpSession.prototype.tools;
 const old=t.mock.method(McpSession.prototype,'tools',async function(this:McpSession,...args:Parameters<McpSession['tools']>){
  return (await tools.apply(this,args)).map(t=>({name:t.name,description:t.description,inputSchema:t.inputSchema,annotations:t.annotations}));
 });
 p.link.call=(async(...args:Parameters<CoreLink['call']>)=>{if(String(args[1]).includes('answer_decision_with_basis'))throw Error('before answer');return call(...args);}) as CoreLink['call'];
 assert.equal((await p.call()).outcome,'HELD');old.mock.restore();p.link.call=call;
 const held=p.record().held[0],signature=held.approval.signature.id;
 const answer=value(await p.service.decide(held.effect,held.argsHash,'release'));assert.equal(answer.state,'sent');
 const stored=p.record();assert.equal(stored.held[0].approval.signature.id,signature);
 assert.equal(stored.held[0].definition,stored.servers[id].tools.draft_note.definition);
 assert.equal(stored.held[0].approval.signature.definition,stored.held[0].definition);
 assert.equal(stored.servers[id].tools.draft_note.standing.id,signature);assert.equal(stored.pendingEnds,undefined);
 // 10 November 2026, security-review direction: the old standing effect is cancelled; the person gets a fresh receipt.
 assert.equal(p.calls().length,1);assert.equal(value(await p.service.decide(held.effect,held.argsHash,'release')).state,'released');assert.equal(p.calls().length,1);
 assert.notEqual(answer.effect,held.effect);assert.equal(value(await p.service.decide(answer.effect,answer.argsHash,'release')).state,'sent');assert.equal(p.calls().length,1);
 assert.equal((await p.ledger()).filter(r=>r.entry_type==='signature.ended').length,0);
});

test('a pre-canonical full pin upgrades only when the complete previous digest matches',async t=>{
 const original={...tool(),_meta:{revision:1}};
 const p=await fixture(t,original,'full'),before=p.record().servers[id].tools.draft_note,history=await p.ledger();
 value(await p.service.refresh(id));const after=p.record().servers[id].tools.draft_note;
 assert.equal(after.listed.definitionDigestVersion,1);assert.equal(after.standing.id,before.standing.id);assert.equal(after.definition,after.listed.definitionDigest);
 assert.deepEqual(await p.ledger(),history);assert.equal((await p.call()).outcome,'SENT');
});
test('an old full pin cannot use the five-field legacy comparison to hide a metadata change',async t=>{
 const original={...tool(),_meta:{revision:1}};
 const p=await fixture(t,original,'full'),changed={...original,_meta:{revision:2}};
 p.list(changed);value(await p.service.refresh(id));assert.equal(p.offered(),undefined);
 assert.equal(p.record().servers[id].tools.draft_note.standing,undefined);assert.equal(p.calls().length,0);
});

test('all twenty reviewed joined and inflected names retain the released block and classification floor',()=>{
 const names=['sendemail','resend_invoice','autosend','sends','sending','deleteall','bulkdelete','deletes','removeall','unpublish','redeploy','resubmit','payinvoice','repay','buynow','wipeout','withdrawal','postmessage','chargecard','reorder'];
 for(const name of names){assert.equal(blocked(name),true,name);for(const override of [undefined,'read','effect'] as const)assert.equal(kindOf(tool(name,true),override),'effect',`${name}/${override}`);}
});
test('all six connectives prevent the read exemption, even with a stored read override',()=>{
 for(const connective of ['and','then','to','with','or','plus']){
  const name=`get_${connective}_post`;assert.equal(blocked(name),true,name);
  for(const override of [undefined,'read','effect'] as const)assert.equal(kindOf(tool(name,true),override),'effect',name);
 }
});
test('the read exemption needs the server annotation, one final noun and no other released hit',()=>{
 for(const name of ['get_post','list_orders','getPayments']){
  assert.equal(blocked(name),true);assert.equal(kindOf(tool(name,true)),'read');assert.equal(kindOf(tool(name,true),'effect'),'effect');
  assert.equal(kindOf(tool(name,false),'read'),'effect');assert.equal(kindOf({...tool(name,true),annotations:{readOnlyHint:true,destructiveHint:true}},'read'),'effect');
 }
 for(const name of ['get_publi_share','get_send_post','get_post_post','get2_post','get_post2','lookup_charge_card','show_share_now','getPost2Send']){
  assert.equal(blocked(name),true,name);assert.equal(kindOf(tool(name,true),'read'),'effect',name);
 }
});
test('a noun read exemption narrowed to effect waits for a person or ordinary signature',async t=>{
 const p=await fixture(t,tool('get_post',true));assert.equal((await p.call({post:5})).outcome,'READ');assert.equal(p.calls().length,1);
 value(await p.service.set(id,{tool:{name:'get_post',override:'effect'}}));assert.equal((await p.call()).outcome,'HELD');
 // 10 November 2026, owner direction: a send is a signed tool like any other; narrowing to effect retains ordinary approval.
 const held=p.service.list().held[0];assert.equal(value(await p.service.decide(held.effect,held.argsHash,'release')).state,'sent');
 assert.equal(p.calls().length,2);assert.equal((await p.sign()).ok,true,'an ordinary signature releases this effect');
 const view=p.service.toolView(id,'get_post')!;value(await p.service.set(id,{seal:view.seal,tool:{name:'get_post',standing:{stamp:view.stamp,blockedToo:true}}}));
 assert.equal((await p.call()).outcome,'SENT');assert.equal(p.calls().length,3);
});
