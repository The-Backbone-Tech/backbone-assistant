// Doctor attached to a live read-only holder must not turn inspection into master creation.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {createHost,hostClosed,removeDataHome} from '@backbone-next/platform/composition';
import {serveApiLine} from '@backbone-next/platform/composition/api-line';
import {freshDataHome} from '@backbone-next/platform/testing/data-home';
import {Vault} from '@backbone-next/platform/keys';
for(const master of [false,true])test(`doctor through a held home's line preserves vault bytes with master=${master}`,async()=>{
  const home=freshDataHome('audit-doctor-held'),original=readFileSync(join(home,'keys','vault.json'));
  const seed=createHost({home,harness:'harness-stub'});try{await seed.call('projects.list',{});}finally{seed.close();await hostClosed(home);}
  writeFileSync(join(home,'keys','vault.json'),original);Vault.forget(home);
  const vault=await Vault.open(home);if(master)await vault.masterKey();
  const path=join(home,'keys','vault.json'),before=readFileSync(path),host=createHost({home,readOnly:true,harness:'harness-stub'});
  let server:Awaited<ReturnType<typeof serveApiLine>>|undefined;
  try{
    await host.call('projects.list',{});server=await serveApiLine({home,call:host.call});
    const env:NodeJS.ProcessEnv={...process.env,BACKBONE_HARNESS:'stub'};delete env.BACKBONE_KEYS;
    const child=spawn(process.execPath,[new URL('../src/main.ts',import.meta.url).pathname,'doctor','--home',home,'--json'],{env,stdio:['ignore','pipe','pipe']});
    let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
    assert.equal(await new Promise(resolve=>child.once('close',resolve)),0,err);
    const report=JSON.parse(out);assert.ok(report.checks.some((c:{name:string;detail:string})=>c.name==='holder'&&/line/.test(c.detail)));
    assert.equal(readFileSync(path).equals(before),true);
  }finally{await server?.close();host.close();await hostClosed(home);await removeDataHome(home);}
});
