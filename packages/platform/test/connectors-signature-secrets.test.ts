// Blocked plugin data never enters a removal receipt or an early Core failure.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test,type TestContext} from 'node:test';
import {discover} from '../src/connectors/discover.ts';
import {ConnectorService,definitionOf} from '../src/connectors/service.ts';
import {assertHomeWriteAdmission,withHomeLock} from '../src/composition/home-lock.ts';
import {defaultToolEnv} from '../src/tools/places.ts';
import {freshDir,freshHome} from './helpers.ts';
const secret='opaque-connector-fixture-credential-93';
async function fixture(t:TestContext,pending=true){
 const home=freshHome(),user=freshDir('blocked-signature-'),dir=join(user,'.claude','plugins','cache','market','m','1.0.0');
 mkdirSync(join(dir,'.claude-plugin'),{recursive:true});
 writeFileSync(join(dir,'.mcp.json'),JSON.stringify({mcpServers:{[secret]:{command:'node',args:['unused.js',secret],env:{TOKEN:secret}}}}));
 writeFileSync(join(user,'.claude','settings.json'),JSON.stringify({enabledPlugins:{'m@market':true}}));
 writeFileSync(join(user,'.claude','plugins','installed_plugins.json'),JSON.stringify({version:2,plugins:{'m@market':[{scope:'user',installPath:dir,version:'1.0.0'}]}}));
 const env=defaultToolEnv({HOME:user,PATH:process.env.PATH}),d=discover(home,env,['claude-plugin'])[0];let links=0;
 const service=new ConnectorService({home,reconcileOnOpen:false,env:()=>env,sources:['claude-plugin'],credentials:async()=>[secret],
  link:async()=>{links++;throw Error(`Core failed for ${secret}`);}});t.after(()=>service.close());
 await service.ready();
 const listed={name:'old_tool',description:secret,inputSchema:{type:'object'},annotations:{readOnlyHint:false}};
 const record={servers:{[d.server.id]:{enabled:true,egress:true,fingerprint:d.server.fingerprint,listedAt:'now',problem:secret,
  tools:{old_tool:{enabled:true,definition:definitionOf(listed),listed}}}},held:[],...(pending?{pendingEnds:[{id:randomUUID(),reason:'person_revoked'}]}:{})};
 const file=join(home,'connectors','mcp.json');
 await withHomeLock(home,async()=>{assertHomeWriteAdmission(home,join(home,'connectors'));mkdirSync(join(home,'connectors'),{recursive:true});
  assertHomeWriteAdmission(home,join(home,'connectors'));writeFileSync(file,JSON.stringify(record));});
 return {home,service,raw:d.server.id,file,links:()=>links};
}
test('blocked missing-tool and signing refusals precede pending-end/Core work by either id',async t=>{
 const p=await fixture(t),shown=p.service.list().servers[0].id;
 for(const id of [p.raw,shown])for(const patch of [{tool:{name:'missing',enabled:false}},{tool:{name:'__proto__',enabled:false}},{tool:{name:'missing',standing:{stamp:'unused'}}}]){
  const answer=await p.service.set(id,patch);assert.equal(answer.ok,false);
  assert.match(answer.ok?'':answer.detail,/credential/);assert.equal(JSON.stringify(answer).includes(secret),false);
 }
 assert.equal(p.links(),0,'blocked refusal comes before obtaining Core or draining its pending end');
});
test('blocked local removal succeeds without exposing stale tool metadata or stored problems',async t=>{
 const p=await fixture(t);
 assert.equal(JSON.stringify(p.service.list()).includes(secret),false,'blocked listing contains no stale third-party tool text');
 const answer=await p.service.set(p.raw,{tool:{name:'old_tool',enabled:false}});
 assert.equal(answer.ok,true);assert.equal(JSON.stringify(answer).includes(secret),false);
 const record=JSON.parse(readFileSync(p.file,'utf8'));assert.equal(record.servers[p.raw].tools.old_tool.enabled,false);
 assert.equal(record.pendingEnds.length,1,'unavailable Core leaves the end queued');
});
test('a local removal with no signature work never starts an unnecessary Core open',async t=>{
 const p=await fixture(t,false),answer=await p.service.set(p.raw,{tool:{name:'old_tool',enabled:false}});
 assert.equal(answer.ok,true);assert.equal(p.links(),0);
 assert.equal(JSON.stringify(answer).includes(secret),false);
});

test('a previously held call is redacted after its plugin becomes blocked, including terminal receipts',async t=>{
 const p=await fixture(t,false),effect=randomUUID(),record=JSON.parse(readFileSync(p.file,'utf8'));
 record.held=[{effect,serverId:p.raw,serverName:secret,tool:secret,args:{env:secret},argsHash:'hash',statement:secret,at:'now',state:'sent',detail:secret}];
 await withHomeLock(p.home,async()=>{
  assertHomeWriteAdmission(p.home,join(p.home,'connectors'));writeFileSync(p.file,JSON.stringify(record));
 });
 const shown=p.service.list().held[0];assert.equal(shown.effect,effect);assert.equal(shown.serverId,p.service.list().servers[0].id);
 assert.equal(JSON.stringify(shown).includes(secret),false);assert.deepEqual(shown.args,{});
 const answer=await p.service.decide(effect,'hash','release');assert.equal(answer.ok,true);assert.equal(JSON.stringify(answer).includes(secret),false);
 assert.equal(p.links(),0,'terminal redaction needs no Core');
});
test('an old offered tool cannot disclose a newly blocked server in a call refusal',async t=>{
 const p=await fixture(t,false);
 const offered={serverId:p.raw,serverName:secret,tool:secret} as import('../src/connectors/service.ts').OfferedTool;
 const answer=await p.service.call(offered,{},{} as import('../src/connectors/service.ts').ConnectorCore,
  {threadId:'fixture',turnId:'blocked',seq:1},new AbortController().signal);
 assert.equal(answer.outcome,'REFUSED');assert.equal(JSON.stringify(answer).includes(secret),false);assert.equal(p.links(),0);
});
