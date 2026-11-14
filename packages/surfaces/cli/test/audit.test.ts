import { TEST_HANG_MS, hangDetector } from '../../../../scripts/lib/test-hang.ts';
import { CoreLink } from '../../../platform/src/composition/core.ts';
import { childHangTimer } from '../../../../scripts/lib/test-child.ts';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { readAudit, verifyAudit } from '@backbone-next/platform/audit';
import { createHost, hostClosed, removeDataHome } from '@backbone-next/platform/composition';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { parse } from '../src/commands.ts';

const homes: string[] = [], folders: string[] = [];
after(async () => { for (const home of homes) await removeDataHome(home); for (const folder of folders) rmSync(folder, { recursive: true, force: true }); });
const period = ['--since', '2000-01-01T00:00:00Z', '--until', '2100-01-01T00:00:00Z'];
function run(home: string | undefined, args: string[]) {
  return new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, BACKBONE_KEYS: 'plaintext', BACKBONE_HARNESS: 'stub' };
    if (home) env.BACKBONE_HOME = home; else delete env.BACKBONE_HOME;
    const c = spawn(process.execPath, [join(import.meta.dirname, '../src/main.ts'), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = childHangTimer(c, 'audit.test: child completion/shutdown');
    c.stdout.on('data', bytes => out += bytes); c.stderr.on('data', bytes => err += bytes);
    c.once('error', reject); c.once('close', code => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}
function files(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (path: string, rel = '') => { for (const name of readdirSync(path)) {
    const file = join(path, name), st = lstatSync(file), key = join(rel, name);
    if (st.isDirectory()) visit(file, key);
    else if (st.isFile()) result[key] = `${st.mode}:${st.mtimeMs}:${createHash('sha256').update(readFileSync(file)).digest('hex')}`;
  } };
  visit(root); return result;
}

test('audit parse requires period and a home only for export; flags stay with their command', () => {
  assert.equal(parse(['audit', 'verify', 'record.jsonl'], {}).usage, undefined);
  assert.match(parse(['audit','verify'],{}).usage!,/needs a file/);
  assert.match(parse(['audit', 'export', '--home', '/tmp/disposable'], {}).usage!, /since/);
  assert.equal(parse(['audit', 'export', '-', ...period, '--home', '/tmp/disposable', '--include-content'], {}).options.includeContent, true);
  assert.equal(parse(['audit','export',...period,'--home','/tmp/disposable','--limit','3'],{}).options.limit,3);
  assert.ok(parse(['audit','export',...period,'--home','/tmp/disposable','--limit','0'],{}).usage);
  assert.equal(parse(['audit','export',...period,'--home','/tmp/disposable','--scratch-root','/tmp/private'],{}).options.scratchRoot,'/tmp/private');
  assert.ok(parse(['now', '--home', '/tmp/disposable', '--include-content'], {}).usage);
  assert.ok(parse(['audit', 'export', ...period, '--home', '/tmp/disposable', '--previous', 'other'], {}).usage);
});

test('CLI exports stdout or a new private file, verifies offline, and leaves the source home byte-for-byte unchanged', { timeout: 90_000 }, async () => {
  const home = freshDataHome('audit-cli'); homes.push(home);
  const host = createHost({ home });
  try { const project = await host.call('projects.create', { name: 'CLI audit', kind: 'folder' }); assert.equal(project.ok, true); }
  finally { host.close(); await hostClosed(home); }
  const before = files(home), dir = mkdtempSync(join(tmpdir(), 'audit-cli-output-')); folders.push(dir);
  const stdout = await run(home, ['audit', 'export', ...period]);
  assert.equal(stdout.code, 0, stdout.err); const read = readAudit(stdout.out); assert.ok(read.events.length > 0);assert.equal(read.header.transport,'direct');assert.equal(read.header.exportedBy.kind,'home-person');
  const file = join(dir, 'record.jsonl');
  const scratch=mkdtempSync('/tmp/as-');folders.push(scratch);
  const saved = await run(home, ['audit', 'export', file, ...period,'--scratch-root',scratch]); assert.equal(saved.code, 0, saved.err);
  assert.equal(lstatSync(file).mode & 0o777, 0o600); assert.equal(verifyAudit(readFileSync(file, 'utf8')).valid, true);
  const checked = await run(undefined, ['audit', 'verify', file, '--json']);
  assert.equal(checked.code, 0, checked.err); assert.equal(JSON.parse(checked.out).assurance, 'internal-consistency-only');
  const repeated = await run(home, ['audit', 'export', file, ...period]); assert.equal(repeated.code, 1); assert.match(repeated.err, /EEXIST/);
  const inside = join(home, 'forbidden.jsonl');
  assert.equal((await run(home, ['audit', 'export', inside, ...period])).code, 1); assert.equal(existsSync(inside), false);
  writeFileSync(file, stdout.out.slice(0, -10));
  assert.equal((await run(undefined, ['audit', 'verify', file])).code, 1);
  assert.deepEqual(files(home), before, 'audit creates no holder, grants, vault changes, recovery state or cursor in the source home');
});


// Whole-case guard detects a hang; the product's no-progress watchdog is exercised below.
test('an export above 64 KiB drains through a real pipe to a slow reader; a broken pipe is non-zero', { timeout: TEST_HANG_MS * 2 }, async t => {
  const home = freshDataHome('audit-pipe'); homes.push(home);
  // This case grades export transport and receipt coverage, not chat execution. Commit real
  // Core tasks: 512 receipts span several audit pages and fill the real pipe without 40
  // model/material workflows or repeated threads.get crossings. No ledger rows are fabricated.
  let receipts=0;const setupStarted=performance.now();
  const link=await hangDetector(CoreLink.open({home}),'audit pipe fixture opens Core');
  try {
    await hangDetector((async()=>{for(;receipts<512;receipts++)assert.ok(await link.createTask(`Pipe activity ${receipts}`));})(),
      'audit pipe fixture commits its history',{diagnostic:()=>`${receipts}/512 task receipts committed`});
    assert.equal(receipts,512,'the complete history is committed before export');
  } finally { await hangDetector(link.close(),'audit pipe fixture closes Core'); }
  const setupMs=performance.now()-setupStarted;
  const piped = async (mode:'slow'|'broken'|'stalled') => {
    const c = spawn(process.execPath, [join(import.meta.dirname, '../src/main.ts'), 'audit', 'export', ...period], {
      env: {...process.env, BACKBONE_HOME: home, BACKBONE_KEYS:'plaintext'}, stdio: ['ignore','pipe','pipe'] });
    let out='',err='',chunks=0,reader='starting';const started=performance.now();
    const exited=new Promise<number|null>((resolve,reject)=>{c.once('exit',resolve);c.once('error',reject);});
    const closed=new Promise<void>(resolve=>c.once('close',()=>resolve()));
    const stderrEnded=new Promise<void>((resolve,reject)=>{c.stderr.once('end',resolve);c.stderr.once('error',reject);});
    c.stderr.on('data',chunk=>err+=chunk);
    // No stdout observer may drain the paused case. Its exit and flowing stderr EOF are the
    // completion events; close alone would wait for the intentionally unread stdout pipe.
    c.stdout.pause();
    const reading=mode==='stalled'?Promise.resolve():(async()=>{
      reader='reading';
      for await(const chunk of c.stdout){
        out+=chunk;chunks++;
        if(mode==='broken'){reader='reader closed';break;}
        // Deliberately slow the consumer. This is fixture input, never a latency assertion.
        await new Promise<void>(resolve=>setTimeout(resolve,10));
      }
      if(mode==='slow')reader='EOF';
    })();
    if(mode==='stalled')reader='paused';
    const diagnostic=()=>JSON.stringify({mode,reader,receipts,chunks,stdoutBytes:Buffer.byteLength(out),stdoutTail:out.slice(-2000),stderr:err,exitCode:c.exitCode,signal:c.signalCode});
    try {
      const [code]=await hangDetector(Promise.all([exited,stderrEnded,reading]),`audit ${mode} pipe exit, reader and stderr`,{diagnostic});
      return {code,out,err,chunks,elapsedMs:performance.now()-started};
    } finally {
      if(c.exitCode===null&&c.signalCode===null)c.kill('SIGKILL');
      c.stdout.destroy();
      await hangDetector(closed,`audit ${mode} pipe closes its descriptors`,{diagnostic});
    }
  };
  const complete = await piped('slow');
  assert.equal(complete.code,0,complete.err); assert.ok(Buffer.byteLength(complete.out)>65536);
  assert.ok(verifyAudit(complete.out).count>=200);
  t.diagnostic(JSON.stringify({receipts,bytes:Buffer.byteLength(complete.out),verifiedEvents:verifyAudit(complete.out).count,slowReaderChunks:complete.chunks,setupMs,slowPipeMs:complete.elapsedMs}));
  const full=readAudit(complete.out),dir=mkdtempSync(join(tmpdir(),'audit-backlog-'));folders.push(dir);
  const limit=Math.ceil(Number(full.header.sourceHead!.sequence)/3);let after:string|undefined,previous:string|undefined;const union:unknown[]=[];
  const facts=(file:string)=>readAudit(file).events.map(({previousHash,...event})=>event);
  for(let i=0;i<3;i++){
    const file=join(dir,`batch-${i}.jsonl`),result=await run(home,['audit','export',file,...period,'--limit',String(limit),...(after?['--after',after]:[])]);
    assert.equal(result.code,0,result.err);const bytes=readFileSync(file,'utf8'),record=readAudit(bytes,previous?readFileSync(previous,'utf8'):undefined);
    const verified=await run(undefined,['audit','verify',file,...(previous?['--previous',previous]:[])]);assert.equal(verified.code,0,verified.err);
    union.push(...facts(bytes));after=record.trailer.cursor!.id;previous=file;
  }
  assert.deepEqual(union,facts(complete.out));assert.equal(after,full.trailer.cursor!.id);

  const broken=await piped('broken');assert.notEqual(broken.code,0);assert.match(broken.err,/not written whole/);
  const stalled=await piped('stalled');
  assert.equal(stalled.code,1,stalled.err);assert.match(stalled.err,/No audit output progress.*not written whole/);
  t.diagnostic(JSON.stringify({brokenPipeMs:broken.elapsedMs,stalledPipeMs:stalled.elapsedMs}));

});

test('offline CLI distinguishes changed digest keys from a forked history',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'audit-key-verify-'));folders.push(folder);
  const file=(key:string)=>{
    const header={schema:'backbone.audit.v1',type:'header',homeId:'00000000-0000-0000-0000-000000000001',transport:'direct',exportedBy:{kind:'home-person',personId:'00000000-0000-0000-0000-000000000002'},createdAt:'2026-11-10T00:00:00.000Z',period:{since:'2000-01-01T00:00:00.000Z',until:'2100-01-01T00:00:00.000Z'},tool:{name:'fixture',version:'1'},includeContent:false,digestKey:{id:key.repeat(32),derivation:'hkdf-master-sha256'},receiptHashMode:'keyed-hmac-sha256',count:0,after:null,sourceHead:null,scanThrough:null,completeness:'committed-through-scan-through',gaps:[]};
    const first=JSON.stringify(header)+'\n';return first+JSON.stringify({schema:'backbone.audit.v1',type:'trailer',count:0,eventsSha256:createHash('sha256').digest('hex'),lastHash:createHash('sha256').update(first).digest('hex'),cursor:null})+'\n';
  };
  const previous=join(folder,'previous.jsonl'),changed=join(folder,'changed.jsonl');writeFileSync(previous,file('a'));writeFileSync(changed,file('b'));
  assert.equal((await run(undefined,['audit','verify',previous])).code,0);assert.equal((await run(undefined,['audit','verify',changed])).code,0);
  const joined=await run(undefined,['audit','verify',changed,'--previous',previous]);assert.equal(joined.code,1);assert.match(joined.err,/these files were digested under different keys .*each verifies alone/);
});
