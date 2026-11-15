import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {test} from 'node:test';
import {freshDataHome} from '@backbone-next/platform/testing/data-home';
import {createHost,removeDataHome} from '@backbone-next/platform/composition';
import {ApiLineProjectBudget,serveApiLine} from '@backbone-next/platform/composition/api-line';
import {childHangTimer} from '../../../../scripts/lib/test-child.ts';

function run(home:string,args:string[],environment:NodeJS.ProcessEnv={}) {
  return new Promise<{code:number|null;out:string;err:string}>(resolve=>{
    const child=spawn(process.execPath,[new URL('../src/main.ts',import.meta.url).pathname,...args],{env:{...process.env,BACKBONE_HOME:home,BACKBONE_KEYS:'plaintext',BACKBONE_HARNESS:'stub',...environment},stdio:['ignore','pipe','pipe']});
    const timer=childHangTimer(child,'project actions CLI');let out='',err='';
    child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
    child.once('close',code=>{clearTimeout(timer);resolve({code,out,err});});
  });
}
for(const mode of ['standalone','line'] as const)test(`projects rename, archive and restore through the real ${mode} Host/Core`,async()=>{
  const home=freshDataHome('cli-project-actions');let host:ReturnType<typeof createHost>|undefined,server:Awaited<ReturnType<typeof serveApiLine>>|undefined;
  try{
    const made=await run(home,['projects','create','Original','--json']);assert.equal(made.code,0,made.err);const project=JSON.parse(made.out);
    if(mode==='line'){host=createHost({home});server=await serveApiLine({home,projectCreation:true,projectCreationBudget:new ApiLineProjectBudget(),call:(method,args)=>host!.call(method,args)});}
    for(const command of ['rename','archive','restore']){
      const result=await run(home,['projects',command,project.id,...(command==='rename'?['New project name']:[])]);assert.equal(result.code,0,result.err);
      assert.match(result.out,command==='rename'?/Renamed New project name/:command==='archive'?/Archived New project name/:/Restored New project name/);
      const list=await run(home,['projects','list','--json']);assert.equal(list.code,0,list.err);
      const current=JSON.parse(list.out)[0];assert.equal(current.name,'New project name');assert.equal(!!current.archived,command==='archive');
    }
  }finally{await server?.close();host?.close();await removeDataHome(home);}
});
for(const outcome of ['REFUSED','UNKNOWN','lost'] as const)test(`project commands retain ${outcome} outcomes without resending`,async()=>{
  const home=freshDataHome('cli-project-unknown');let calls=0;
  const server=await serveApiLine({home,projectCreation:true,projectCreationBudget:new ApiLineProjectBudget(),call:async()=>{calls++;if(outcome==='lost')throw new Error('private detail');return {ok:false,reason:'NOT_AVAILABLE',outcome,detail:'Only the project owner may change this project.'} as never;}});
  try{
    for(const command of ['rename','archive','restore']){
      const result=await run(home,['projects',command,'project-id',...(command==='rename'?['New name']:[])]);
      assert.equal(result.code,outcome==='REFUSED'?1:4,result.err);assert.equal(result.out,'');assert.match(result.err,outcome==='REFUSED'?/Only the project owner/:/Unknown outcome/);assert.doesNotMatch(result.err,/private detail/);
    }
    assert.equal(calls,3);
  }finally{await server.close();await removeDataHome(home);}
});

 test('standalone project changes and creation leave an interrupted turn untouched',async()=>{
  const {startScriptedModel}=await import('@backbone-next/platform/testing');
  const {hostClosed}=await import('@backbone-next/platform/composition');
  const model=await startScriptedModel();const home=freshDataHome('cli-project-interrupted');
  const environment={BACKBONE_MODEL_ENDPOINT:model.url,BACKBONE_MODEL_ID:model.model,BACKBONE_HARNESS:'harness-pi'};
  try{
    const killed=await new Promise<{threadId:string;projectId:string}>((resolve,reject)=>{
      const child=spawn(process.execPath,[new URL('../../../platform/test/crash-turn.ts',import.meta.url).pathname,home],{env:{...process.env,...environment,BACKBONE_CRASH_AT:'write.begun'},stdio:['ignore','pipe','pipe']});
      const timer=childHangTimer(child,'interrupted project fixture');let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
      child.once('close',()=>{clearTimeout(timer);try{resolve(JSON.parse(out.trim().split('\n')[0]));}catch{reject(new Error(err||out));}});
    });
    const before=model.requests.length;
    for(const command of ['rename','archive','restore','create']){
      const args=command==='create'?['projects','create','Another project']:['projects',command,killed.projectId,...(command==='rename'?['Renamed']:[])];
      const result=await run(home,args,environment);assert.equal(result.code,0,result.err);
      const host=createHost({home,harness:'harness-pi',readOnly:true});
      try{const current=await host.call('threads.get',{id:killed.threadId});assert.ok(current.ok);assert.equal(current.value.turns.at(-1)?.status,'running');}
      finally{host.close();await hostClosed(home);}
      assert.equal(model.requests.length,before,'a project property request starts no model work');
    }
  }finally{await model.close();await removeDataHome(home);}
 });
