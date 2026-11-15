import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {exportHome,importHome,type ImportApi} from '../src/composition/backup.ts';

for(const legacy of [false,true])test(`backup preserves archived projects; older missing state restores active (legacy=${legacy})`,async t=>{
  const root=mkdtempSync(join(tmpdir(),'project-backup-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const home=join(root,'source'),to=join(root,'export'),target=join(root,'target');mkdirSync(home);mkdirSync(target);
  const name='Archived '+ 'x'.repeat(300);
  await exportHome({home,projects:[{id:'p',name,kind:'folder',archived:true}],threads:[],documents:()=>[],versionPath:()=>'',receipts:async()=>[],secrets:async()=>[]},{to});
  const path=join(to,'projects/p001/project.json'),meta=JSON.parse(readFileSync(path,'utf8'));assert.equal(meta.archived,true);
  if(legacy){delete meta.archived;const data=JSON.stringify(meta);writeFileSync(path,data);const manifest=JSON.parse(readFileSync(join(to,'manifest.json'),'utf8'));manifest.version=3;manifest.files['projects/p001/project.json']=createHash('sha256').update(data).digest('hex');writeFileSync(join(to,'manifest.json'),JSON.stringify(manifest));}
  const updates:unknown[]=[],created:{name:string}[]=[];
  const api:ImportApi={call:(async(method:string,args:unknown)=>{
    if(method==='projects.list'||method==='threads.list')return [];
    if(method==='memory.get')return {entries:[],proposed:[],instructions:{person:'',project:''},skills:[]};
    if(method==='projects.update')updates.push(args);
    if(method==='projects.create')created.push(args as {name:string});
    return {ok:true,value:{id:'made'}};
  }) as ImportApi['call'],addDocument:async()=>({ok:true,value:{} as never}),proposeSkill:async()=>({ok:true,value:{} as never}),importMemory:async()=>({ok:true,value:{added:0}}),hasSkills:()=>false};
  await importHome({from:to,home:target,api});assert.equal(created[0].name,name);assert.deepEqual(updates,legacy?[]:[{id:'made',patch:{archived:true}}]);
});
