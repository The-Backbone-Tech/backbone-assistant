import { spawnSyncHang, TEST_HANG_MS } from '../../../../scripts/lib/test-hang.ts';
// Writable CLI entries refuse before local initialization; pure help/planning need no addon.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test,type TestContext} from 'node:test';
import {fileURLToPath} from 'node:url';
import {exportHome} from '@backbone-next/platform/composition/backup';
import {HomeWriteUnavailable,withHomeLock} from '@backbone-next/platform/composition/home-lock';
import {runDaemon} from '../src/daemon.ts';
import {withHome} from '../src/session.ts';

function context(t:TestContext){const at=fs.mkdtempSync(join(tmpdir(),'cli-admission-'));t.after(()=>fs.rmSync(at,{recursive:true,force:true}));return at;}
const refused=(error:unknown)=>error instanceof HomeWriteUnavailable&&error.code==='filesystem';

for(const entry of ['session','daemon'] as const)test(`${entry} refuses unsupported storage before creating a holder, home or host`,async t=>{
 const at=context(t),home=join(at,'unmade'),real=fs.statfsSync;let calls=0;
 t.mock.method(fs,'statfsSync',((path:fs.PathLike)=>({...real(path),type:0x6969})) as typeof fs.statfsSync);
 const work=()=>entry==='session'?withHome(home,'synthetic-admission',async()=>{calls++;},{create:true}):runDaemon(home,()=>{calls++;});
 await assert.rejects(work(),refused);assert.equal(calls,0);assert.equal(fs.existsSync(home),false);assert.deepEqual(fs.readdirSync(at),[]);
});

function withoutBackend(at:string,args:string[]){
 const entry=fileURLToPath(new URL('../src/main.ts',import.meta.url)),marker=join(at,'native-attempt');
 const script=`import fs from 'node:fs';import Module from 'node:module';import {pathToFileURL} from 'node:url';const real=Module._resolveFilename;Module._resolveFilename=function(name,...rest){if(name==='fs-native-extensions'){fs.writeFileSync(${JSON.stringify(marker)},'attempted');throw new Error('Synthetic unavailable native package');}return real.call(this,name,...rest);};process.argv=[process.execPath,${JSON.stringify(entry)},...${JSON.stringify(args)}];await import(pathToFileURL(${JSON.stringify(entry)}).href);`;
 // Keep the runner's explicit Linux evaluation opt-in so this reaches the missing-backend guard.
 const env={PATH:process.env.PATH,HOME:at,XDG_CONFIG_HOME:join(at,'config'),CODEX_HOME:join(at,'codex'),CLAUDE_CONFIG_DIR:join(at,'claude'),BACKBONE_KEYS:'plaintext',BACKBONE_HARNESS:'harness-stub',BACKBONE_EXPERIMENTAL_LINUX_HOME_LOCK:process.env.BACKBONE_EXPERIMENTAL_LINUX_HOME_LOCK};
 return {result:spawnSyncHang(process.execPath,['--input-type=module','-e',script],{env,encoding:'utf8',timeout: TEST_HANG_MS}),attempted:()=>fs.existsSync(marker)};
}

test('real restore refuses a missing backend before mkdir even on a nonexistent target',t=>{
 const at=context(t),home=join(at,'unmade'),run=withoutBackend(at,['restore',join(at,'export-not-read'),'--home',home]);
 assert.equal(run.result.signal,null,run.result.stderr);assert.notEqual(run.result.status,0);
 assert.match(run.result.stderr,/local data-home lock is unavailable/);assert.equal(run.attempted(),true);assert.equal(fs.existsSync(home),false);
});

test('help and a valid restore dry-run never load the unavailable native backend or create a home',async t=>{
 const at=context(t),source=join(at,'source'),from=join(at,'export'),home=join(at,'unmade');fs.mkdirSync(source);
 await withHomeLock(source,async()=>exportHome({home:source,projects:[],documents:()=>[],versionPath:()=>{throw Error('No exported document');},threads:[],receipts:async()=>[],secrets:async()=>[]},{to:from}));
 for(const args of [['--help'],['restore',from,'--home',home,'--dry-run']]){
  const run=withoutBackend(at,args);assert.equal(run.result.status,0,run.result.stderr||run.result.stdout);assert.equal(run.attempted(),false);assert.equal(fs.existsSync(home),false);
 }
});
