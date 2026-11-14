import { TEST_HANG_MS } from '../../../scripts/lib/test-hang.ts';
// Whole-case hang guard; product deadlines are asserted separately.
import { enableConnector } from '../src/testing/connectors.ts';
// A whole Host, scripted engine and fake MCP provider. Reconstruction reads app.ledger ONLY.
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {CoreLink} from '../src/composition/core.ts';
import {startScriptedModel,type Message,type Step} from '../src/testing/scripted-model.ts';
import {defaultToolEnv} from '../src/tools/places.ts';
import {freshDir,idle,open,settings,value} from './helpers.ts';
const words=(m:Message)=>typeof m.content==='string'?m.content:(m.content??[]).map(p=>p.text??'').join('');
function script(messages:Message[]):Step {
 const at=messages.findLastIndex(m=>m.role==='user'),text=words(messages[at]);
 if(messages.slice(at+1).some(m=>m.role==='tool'))return {text:'Tool result received.'};
 return text.startsWith('unsigned')?{calls:[{name:'mcp__notes__plain',args:{x:text}}]}:{calls:[{name:'mcp__notes__draft_note',args:{text}}]};
}
type Entry={seq:string;entry_type:string;subject:string;actor_id:string;payload:{signature?:string;connection?:string;subject?:string;kind?:string;reason?:string;outcome?:string;basis?:{method:string;signature?:string}}};
test('ledger alone reconstructs grant, three signed sends, one per-call send, end and a fourth held call', {timeout: TEST_HANG_MS * 2},async t=>{
 const model=await startScriptedModel('scripted-model',script);t.after(()=>model.close());
 process.env.BACKBONE_MODEL_ENDPOINT=model.url;process.env.BACKBONE_MODEL_ID=model.model;
 t.after(()=>{delete process.env.BACKBONE_MODEL_ENDPOINT;delete process.env.BACKBONE_MODEL_ID;});
 const personHome=freshDir('signature-host-person-');writeFileSync(join(personHome,'.claude.json'),JSON.stringify({mcpServers:{notes:{command:process.execPath,args:[join(import.meta.dirname,'fake-mcp-server.ts')]}}}));
 const {home,host}=open(undefined,{harness:'harness-pi',connectors:{env:defaultToolEnv({HOME:personHome,PATH:process.env.PATH}),sources:['claude-code']}});
 const id='claude-code:notes';value(await host.call('connectors.refresh',{serverId:id}));value(await enableConnector(host, id));
 for(const name of ['draft_note','plain'])value(await enableConnector(host, id, name));
 value(await host.openConnectorDoor(id,host.connectorDoorSeal(id)!));const shown=host.connectorToolView(id,'draft_note')!;value(await host.signConnectorTool(id,'draft_note',shown.seal,shown.stamp,false));
 const project=value(await host.call('projects.create',{name:'Ledger reconstruction',kind:'folder'}));
 for(const text of ['signed first','signed second','signed third']){
 const sent=value(await host.call('turns.send',{projectId:project.id,text,attachments:[],settings,clientKey:text}));
 assert.equal((await idle(host,sent.threadId)).turns.at(-1)!.status,'done');
 }
 const unsigned=value(await host.call('turns.send',{projectId:project.id,text:'unsigned tool',attachments:[],settings,clientKey:'unsigned'}));await idle(host,unsigned.threadId);
 // The person gets the statement to release from the surface. It is not an audit input below.
 const held=(await host.call('connectors.list',{})).held.find(h=>h.tool==='plain'&&h.state==='waiting')!;assert.ok(held);
 assert.equal(value(await host.releaseConnectorCall(held.effect,held.argsHash)).state,'sent');
 value(await host.call('connectors.set',{serverId:id,tool:{name:'draft_note',standing:false}}));
 const fourth=value(await host.call('turns.send',{projectId:project.id,text:'signed fourth',attachments:[],settings,clientKey:'fourth'}));await idle(host,fourth.threadId);
 const link=await CoreLink.open({home});t.after(()=>link.release());
 const ledger=(await link.read<Entry>(link.person(),'SELECT seq,entry_type,subject,actor_id,payload FROM app.ledger ORDER BY seq')).rows;
 assert.equal(await link.call(link.person(),'SELECT gov.verify_ledger()'),null);
 // From here on, no connector file, effects, decisions, surface state or provider log is read.
 const given=ledger.filter(e=>e.entry_type==='signature.given');assert.equal(given.length,1);const grant=given[0];
 assert.equal(grant.payload.signature,grant.subject);assert.ok(grant.payload.connection);assert.equal(grant.actor_id,link.id.person);
 const ended=ledger.filter(e=>e.entry_type==='signature.ended');assert.equal(ended.length,1);assert.equal(ended[0].subject,grant.subject);assert.equal(ended[0].payload.reason,'person_revoked');
 const answers=ledger.filter(e=>e.entry_type==='decision.answered'&&e.payload.basis);
 const signed=answers.filter(e=>e.payload.basis?.method==='standing_signature');assert.equal(signed.length,3);
 const personal=answers.filter(e=>e.payload.basis?.method==='person');assert.equal(personal.length,1);
 for(const answer of signed){assert.equal(answer.payload.basis!.signature,grant.subject);assert.equal(answer.actor_id,grant.actor_id);assert.ok(Number(grant.seq)<Number(answer.seq)&&Number(answer.seq)<Number(ended[0].seq));}
 for(const answer of [...signed,...personal]){
 const effect=answer.payload.subject;assert.ok(effect);
 assert.equal(ledger.filter(e=>e.entry_type==='effect.dispatched'&&e.subject===effect).length,1);
 assert.equal(ledger.find(e=>e.entry_type==='effect.observed'&&e.subject===effect)?.payload.outcome,'succeeded');
 }
 const proposedAfterEnd=ledger.filter(e=>e.entry_type==='effect.proposed'&&Number(e.seq)>Number(ended[0].seq));assert.equal(proposedAfterEnd.length,1);
 const waiting=proposedAfterEnd[0];const question=ledger.find(e=>e.entry_type==='decision.asked'&&e.payload.subject===waiting.subject);assert.ok(question);
 assert.equal(ledger.some(e=>e.entry_type==='decision.answered'&&e.subject===question.subject),false);
 assert.equal(ledger.some(e=>e.entry_type==='effect.dispatched'&&e.subject===waiting.subject),false);
});
