import { TEST_HANG_MS, hangDetector } from '../../../scripts/lib/test-hang.ts';
import { childHangTimer } from '../../../scripts/lib/test-child.ts';
// The data home's descriptor-owned cross-process lock: a lock another process has just
// made, before it wrote anything into it, is waited for, never taken for stale; and two processes
// taking it over and over are never inside at the same time.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertHomeWriteAdmission, HomeWriteUnavailable, withHomeLock } from '../src/composition/home-lock.ts';
import {observeNativeHomeLocks,replaceHeldHomeLock} from './native-lock-observation.ts';
import {canonicalHome} from '../src/doors/protocol.ts';

const homes: string[] = [];
after(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));
const home = () => {
  const h = mkdtempSync(join(tmpdir(), 'backbone-lock-'));
  homes.push(h);
  return h;
};

test('a lock just made by another process, still empty, is waited for and never taken for stale', async t => {
  const h = home();
  // Another process holds the empty inode; file existence alone is not ownership.
  const contender = fileURLToPath(new URL('./lock-contender.ts', import.meta.url));
  const child = spawn(process.execPath,[contender,h,'hold'],{stdio:['pipe','pipe','inherit']});
  const exited = once(child,'exit');
  t.after(async()=>{if(!child.stdin.writableEnded&&!child.stdin.destroyed)child.stdin.end('release\n');const kill=childHangTimer(child,'lock holder shutdown');try{await exited;}finally{clearTimeout(kill);}});
  let output='';
  await Promise.race([
    new Promise<void>(resolve=>child.stdout.on('data',(bytes:Buffer)=>{output+=bytes.toString();if(output.includes('held\n'))resolve();})),
    exited.then(()=>{throw new Error('The contender exited before holding the empty lock.');}),
  ]);
  let entered = false;
  const taking = withHomeLock(h, async () => {
    entered = true;
  });
  await new Promise((r) => setTimeout(r, 1_000));
  assert.equal(entered, false, 'it waits');
  child.stdin.end('release\n');
  await taking;
  assert.equal(entered, true, 'and enters once the other lets go');
});

test('two processes taking the lock over and over are never inside at the same time', async () => {
  const h = home();
  const contender = fileURLToPath(new URL('./lock-contender.ts', import.meta.url));
  const children = [0, 1].map(() => spawn(process.execPath, [contender, h, '40'], { stdio: ['ignore', 'pipe', 'inherit'] }));
  const outputs = children.map((c) => {
    let out = '';
    c.stdout.on('data', (d: Buffer) => (out += d.toString()));
    return once(c, 'exit').then(([code]) => ({ code, out }));
  });
  for (const r of await Promise.all(outputs)) {
    assert.equal(r.code, 0);
    assert.equal(r.out.trim(), '0', 'no overlap');
  }
});


test('a nested holder observes the same loss as its outer home-lock scope', async () => {
  const h = home();
  await withHomeLock(h, async outer => {
    await withHomeLock(h, async inner => {
      const observed = await replaceHeldHomeLock(h);
      assert.ok(observed === outer, 'the real observer notified the actual outer scope');
      assert.equal(outer.aborted, true);
      assert.equal(inner.aborted, true, 'nested callers must stop when the actual home holder loses its lock');
    });
  });
});

test('real integrity loss refuses all later local admissions including nested entries until restart',async()=>{
 const h=home();let ran=false;
 const other=await import(new URL('../src/composition/home-lock.ts?loss-copy-control',import.meta.url).href) as typeof import('../src/composition/home-lock.ts');
 const unsafe=(error:unknown)=>error instanceof HomeWriteUnavailable&&error.code==='unsafe-lock';
 await withHomeLock(h,async signal=>{
  await replaceHeldHomeLock(h);assert.equal(signal.aborted,true);
  await assert.rejects(withHomeLock(h,async()=>{ran=true;}),unsafe);
  assert.throws(()=>assertHomeWriteAdmission(h),unsafe);
 });
 await assert.rejects(withHomeLock(h,async()=>{ran=true;}),unsafe);assert.equal(ran,false);
 await assert.rejects(other.withHomeLock(h,async()=>{ran=true;}),unsafe);assert.equal(ran,false,'another bundled copy shares the process refusal');
});

test('case and Unicode spellings of an existing home share its process-wide integrity refusal',async()=>{
 const parent=home(),h=join(parent,'Home-Caf\u00e9'),alias=join(parent,'home-cafe\u0301');mkdirSync(h,{mode:0o700});
 // Case/normalization-sensitive filesystems use a real symlink instead; no platform is skipped.
 if(!existsSync(alias))symlinkSync(h,alias,'dir');
 assert.equal(statSync(alias).ino,statSync(h).ino,'both spellings really name the same home');
 assert.equal(canonicalHome(alias),canonicalHome(h),'identity must normalize existing filesystem spellings');
 const other=await import(new URL('../src/composition/home-lock.ts?spelling-loss-copy',import.meta.url).href) as typeof import('../src/composition/home-lock.ts');
 let ran=false;await withHomeLock(h,async()=>{await replaceHeldHomeLock(h);});
 await assert.rejects(other.withHomeLock(alias,async()=>{ran=true;},0),error=>error instanceof HomeWriteUnavailable&&error.code==='unsafe-lock');
 assert.equal(ran,false);assert.throws(()=>other.assertHomeWriteAdmission(alias),HomeWriteUnavailable);
});

test('a home first created under another spelling is refused under both keys after integrity loss',async()=>{
 const parent=home(),h=join(parent,'not-created'),actual=join(parent,'Created-Home');let ran=false;
 // The queue yields after choosing a missing-tail key. Materialize a real alias before mkdir.
 const pending=withHomeLock(h,async signal=>{
  renameSync(join(h,'.lock'),join(h,'retained-lock'));writeFileSync(join(h,'.lock'),'',{mode:0o600});
  await hangDetector(once(signal,'abort'),'real home integrity notification');
  assert.equal(signal.aborted,true);
 });
 mkdirSync(actual,{mode:0o700});symlinkSync(actual,h,'dir');await pending;
 await assert.rejects(withHomeLock(actual,async()=>{ran=true;},0),error=>error instanceof HomeWriteUnavailable&&error.code==='unsafe-lock');
 assert.equal(ran,false);assert.throws(()=>assertHomeWriteAdmission(h),HomeWriteUnavailable);
});

test('an async context outliving its holder reacquires the lock instead of bypassing a later owner', async () => {
  const h = home();
  let resumeEscaped!: () => void, releaseLater!: () => void, laterEntered!: () => void, attempted!: () => void;
  const resume = new Promise<void>(r => { resumeEscaped = r; });
  const release = new Promise<void>(r => { releaseLater = r; });
  const entered = new Promise<void>(r => { laterEntered = r; });
  const attempt = new Promise<void>(r => { attempted = r; });
  let escaped: Promise<void> | undefined, overlapped = false, enteredAfter = false, laterOwns = false;
  await withHomeLock(h, async () => {
    escaped = (async () => {
      await resume;
      attempted();
      await withHomeLock(h, async () => { overlapped = laterOwns; enteredAfter = true; });
    })();
  });
  const later = withHomeLock(h, async () => { laterOwns = true; laterEntered(); await release; laterOwns = false; });
  try {
    await entered; resumeEscaped(); await attempt;
    await new Promise<void>(r => setImmediate(r));
    assert.equal(enteredAfter, false, 'an inherited async-local marker is not proof that its lock is still held');
  } finally { resumeEscaped(); releaseLater(); await later; await escaped; }
  assert.equal(overlapped, false);
  assert.equal(enteredAfter, true);
});

test('aborting an in-progress physical acquisition joins its release and leaves the lock usable', { timeout: TEST_HANG_MS }, async t => {
  const h = home();
  const contender = fileURLToPath(new URL('./lock-contender.ts', import.meta.url));
  const child = spawn(process.execPath, [contender, h, 'hold'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const exited = once(child, 'exit');
  let taking: Promise<unknown> | undefined;
  t.after(async () => {
    if (!child.stdin.writableEnded && !child.stdin.destroyed) child.stdin.end('release\n');
    const kill = childHangTimer(child,'lock holder shutdown'); kill.unref();
    try { await exited; await taking; } finally { clearTimeout(kill); }
  });
  let output = '';
  await Promise.race([
    new Promise<void>(resolve => child.stdout.on('data', (bytes: Buffer) => { output += bytes.toString(); if (output.includes('held\n')) resolve(); })),
    exited.then(() => { throw new Error('The lock contender exited before holding the lock.'); }),
  ]);
  let began!: () => void;
  const acquiring = new Promise<void>(resolve => { began = resolve; });
  observeNativeHomeLocks(t,h,began);
  const admission = new AbortController();
  let ran = false, settled = false;
  taking = withHomeLock(h, async () => { ran = true; }, 5_000, admission.signal)
    .then(() => { settled = true; return null; }, error => { settled = true; return error; });
  await acquiring; admission.abort();
  await new Promise<void>(resolve => setImmediate(resolve));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'an already-started physical acquisition must be joined before cancellation returns');
  child.stdin.end('release\n');
  const [code] = await exited; assert.equal(code, 0);
  const refusal = await taking;
  assert.ok(refusal instanceof Error && refusal.name === 'AbortError');
  assert.equal(ran, false, 'the cancelled function never runs after the other process releases');
  await hangDetector(withHomeLock(h, async () => {}),'following holder acquiring the released lock');
});
