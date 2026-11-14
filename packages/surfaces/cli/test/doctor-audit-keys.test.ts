import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {after,test} from 'node:test';
import {createHost,hostClosed,removeDataHome} from '@backbone-next/platform/composition';
import {Vault} from '@backbone-next/platform/keys';
import {freshDataHome} from '@backbone-next/platform/testing/data-home';
const homes:string[]=[];
after(async()=>{for(const home of homes)await removeDataHome(home);});
for(const master of [false,true])test(`doctor preserves plaintext vault bytes with master=${master}, including telemetry inspection`,async()=>{
  const home=freshDataHome('doctor-audit');homes.push(home);
  // Finish the fixture before the baseline: doctor must never finish a partial first run.
  const original=readFileSync(join(home,'keys','vault.json'));
  const host=createHost({home,harness:'harness-stub'});
  try {await host.call('projects.list',{});} finally {host.close();await hostClosed(home);}
  // Finished legacy fixture without a master; doctor must neither initialize nor prepare it.
  writeFileSync(join(home,'keys','vault.json'),original);Vault.forget(home);
  const vault=await Vault.open(home);if(master)await vault.masterKey();
  const path=join(home,'keys','vault.json'),before=readFileSync(path);const env:NodeJS.ProcessEnv={...process.env,BACKBONE_HARNESS:'stub'};delete env.BACKBONE_KEYS;
  assert.equal(env.BACKBONE_SYSTEM_STORE_UNAVAILABLE,'1');
  const child=spawn(process.execPath,[new URL('../src/main.ts',import.meta.url).pathname,'doctor','--home',home,'--json'],{env,stdio:['ignore','pipe','pipe']});
  let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);const code=await new Promise(resolve=>child.once('close',resolve));
  assert.equal(code,0,err);const report=JSON.parse(out);
  assert.ok(report.checks.some((c:{name:string;detail:string})=>c.name==='telemetry'&&c.detail.startsWith('off')));
  assert.ok(report.checks.some((c:{name:string;status:string})=>c.name==='holder'&&c.status==='ok'));
  assert.ok(readFileSync(path).equals(before),'doctor changed vault bytes');
});
