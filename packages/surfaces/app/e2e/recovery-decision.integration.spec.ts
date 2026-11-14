import { childHangTimer } from '../../../../scripts/lib/test-child.ts';
import { TEST_HANG_MS } from '../../../../scripts/lib/test-hang.ts';
// Assertion deadlines detect hangs; Playwright retains the pending locator/property and last value.
// Actual bridge, built renderer and Host/Core; only the producer is controlled locally.
import { expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { CoreLink } from '../../../platform/src/composition/core.ts';
import { removeDataHome } from '../../../platform/src/composition/host.ts';
import { freshDataHome } from '../../../platform/src/testing/data-home.ts';
import { pieceDigest, pieceFiles } from '../../../platform/src/pieces/digest.ts';
import { PIECE_DIRS } from '../../../platform/src/composition/pieces.ts';
import type { Args, Method, Result } from '../../../platform/src/api.ts';
const scratch = mkdtempSync(join(tmpdir(), 'recovery-ui-'));
const observations = join(scratch, 'outcomes.jsonl');
const fixture = join(scratch, 'producer'); mkdirSync(fixture);
for (const rel of pieceFiles(PIECE_DIRS['harness-codex'])) {
  const to = join(fixture, rel); mkdirSync(dirname(to), { recursive: true }); copyFileSync(join(PIECE_DIRS['harness-codex'], rel), to);
}
writeFileSync(join(fixture, 'src/index.ts'), `
import { appendFileSync } from 'node:fs';
export function createCodexHarness() {
  return {
    specificationVersion: 'v1', id: 'controlled-paths', label: 'Controlled path producer (no model)',
    async listModels() { return [{ id: 'controlled', label: 'Controlled', efforts: [4], permissions: ['full'] }]; },
    start(request, { tools }) {
      const outcome = (async () => {
        const { name, body = 'First result.', ordinary = false, stale = false, connector = false, staleTarget = false, checkpoint = false, twoWithdrawals = false } = request.text.startsWith('{') ? JSON.parse(request.text) : { name: 'reports/recovered.md' };
        appendFileSync(${JSON.stringify(observations)}, JSON.stringify({ event: 'start', name }) + '\\n');
        const source = await tools.read('source.md');
        const second = twoWithdrawals ? await tools.read('second.md') : undefined;
        const target = name === 'source.md' ? source : await tools.read(name);
        const sources = [source, ...(second ? [second] : []), ...(target && target !== source ? [target] : [])].map(f => ({ name: f.name, version: f.version + (stale ? 1 : 0) }));
        if (connector) {
          const tool = tools.connectors().find(tool => tool.tool === 'search');
          const label = 'From notes · search · ' + request.turnId.slice(0, 8) + '-1.md';
          await tools.writeIfVersion(label + '/agent.md', 'Existing agent output.', { targetVersion: null, sources }, new AbortController().signal);
          const result = await tools.callConnector(tool.name, { q: 'launch' }, new AbortController().signal);
          appendFileSync(${JSON.stringify(observations)}, JSON.stringify({ name, result }) + '\\n');
          return { status: 'done', answer: 'Connector result recorded.', usage: { input: 0, output: 0 } };
        }
        const targetVersion = staleTarget ? 1 : target?.version ?? null;
        if (checkpoint) await tools.checkpoint([{ name, body, targetVersion }], sources);
        if (twoWithdrawals) await globalThis.withdrawFirstForFixture();
        const result = ordinary ? await tools.write(name, body, new AbortController().signal)
          : await tools.writeIfVersion(name, body, { targetVersion, sources }, new AbortController().signal);
        appendFileSync(${JSON.stringify(observations)}, JSON.stringify({ name, result }) + '\\n');
        return { status: 'done', answer: JSON.stringify(result), usage: { input: 0, output: 0 } };
      })();
      return { events: (async function* () {})(), outcome, stop() {}, steer() {} };
    },
  };
}
`);
const manifestPath = join(fixture, 'backbone.module.json');
writeFileSync(manifestPath, JSON.stringify({ ...JSON.parse(readFileSync(manifestPath, 'utf8')), digest: pieceDigest(fixture) }));


test.afterAll(() => rmSync(scratch, { recursive: true, force: true }));

for (const cut of ['write.proposed', 'write.claimed', 'write.begun']) test(`person decides on original ${cut} receipt through real UI`, async ({page}) => {
  const home = freshDataHome('recovery-decision-ui');
  const crash = spawn(process.execPath, [resolve('../../../packages/platform/test/crash-document.ts'),home,fixture,'decision-ui.md','pending-new'], {env:{...process.env,BACKBONE_HARNESS:'harness-codex',BACKBONE_CODEX_MODEL:'controlled',BACKBONE_CRASH_AT:cut,BACKBONE_CRASH_OCCURRENCE:'1'},stdio:['ignore','pipe','pipe']});
  let stdout='', stderr=''; crash.stdout.on('data', d => stdout += d); crash.stderr.on('data', d => stderr += d);
  const timer = childHangTimer(crash, 'recovery crash fixture completion');
  const crashResult=await new Promise<{code:number|null;signal:string|null}>((resolve,reject)=>{crash.on('error',reject);crash.on('exit',(code,signal)=>resolve({code,signal}));}); clearTimeout(timer); expect(crashResult.signal,stderr).toBe('SIGKILL');
  const {projectId}=JSON.parse(stdout.trim().split('\n')[0]); const path=join(home,'threads',readdirSync(join(home,'threads')).find(f=>f.endsWith('.json'))!);
  const stored=JSON.parse(readFileSync(path,'utf8')); const threadId=stored.summary.id, turnId=stored.turns[0].id;
  const run=(Object.values(stored.writeCustody.writes)[0] as {run:string}).run; const checkpoint=join(home,'checkpoints',`${turnId}.json`); const raw=readFileSync(checkpoint);
  const starts=()=>readFileSync(observations,'utf8').trim().split('\n').filter(line=>JSON.parse(line).event==='start').length; const beforeStarts=starts();
  const failed=join(scratch,`initial-${cut}`), launcher=join(scratch,`decision-${cut}.mjs`);
  writeFileSync(launcher,`import { PIECES } from ${JSON.stringify(pathToFileURL(resolve('../../../packages/platform/src/composition/pieces.ts')).href)}; import { CoreLink } from ${JSON.stringify(pathToFileURL(resolve('../../../packages/platform/src/composition/core.ts')).href)}; import { writeFileSync } from 'node:fs'; PIECES['harness-codex'].dir=${JSON.stringify(fixture)}; const original=CoreLink.prototype.read; let failed=false; CoreLink.prototype.read=async function(actor,sql,params){ if(!failed && sql.includes("SELECT run_id AS run, idempotency_key AS key FROM app.effects WHERE run_id = $1")){failed=true;writeFileSync(${JSON.stringify(failed)},'one transient custody reconciliation read failure');throw new Error('Controlled transient custody reconciliation read failure');} return original.call(this,actor,sql,params);}; await import(${JSON.stringify(pathToFileURL(resolve('server/bridge.ts')).href)});`);
  const bridge=spawn(process.execPath,[launcher],{env:{...process.env,BACKBONE_HOME:home,BACKBONE_HARNESS:'harness-codex',BACKBONE_CODEX_MODEL:'controlled',PORT:'0'},stdio:['ignore','pipe','pipe']});
  let errors='';bridge.stderr.on('data',d=>errors+=d); let out='',url='';for await (const chunk of bridge.stdout){out+=chunk;const m=out.match(/backbone bridge on (http:\/\/127[.]0[.]0[.]1:[0-9]+)/);if(m){url=m[1];break;}} expect(url,errors).toBeTruthy();
  const call=async <M extends Method>(method:M,args:Args<M>):Promise<Result<M>>=>{const response=await fetch(url+'/api',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method,args})});if(!response.ok)throw new Error(await response.text());return response.json() as Promise<Result<M>>;};
  const link=await CoreLink.open({home});
  const effects=async()=> (await link.read<{id:string;status:string}>(link.system(),"SELECT id, status FROM app.effects WHERE run_id = $1 AND operation = 'workspace.write_document'",[run])).rows;
  try {
    await expect.poll(()=>existsSync(failed),{timeout:TEST_HANG_MS}).toBe(true);
    await expect.poll(async()=>{const t=await call('threads.get',{id:threadId});return t.ok && !t.value.summary.running && t.value.summary.recoveryHold?.kind==='awaiting-decision';},{timeout:TEST_HANG_MS}).toBe(true);
    const before=await effects(); expect(before).toHaveLength(1); expect(before[0].status).toBe(cut==='write.begun'?'unknown':cut==='write.claimed'?'claimed':'allowed');
    const prefs=await call('viewer.get',{});await call('viewer.put',{prefs:{...prefs,selectedProjectId:projectId,selectedThreadId:threadId}});await page.goto(url);
    const notice=page.getByTestId('recovery-hold');await expect(notice).toContainText('waiting for your decision');await expect(notice).toContainText('cancels unsent work');await expect(notice).toContainText('never resumes or sends');await expect(notice).not.toContainText('original run closed');
    const draft=page.getByPlaceholder(/Ask .* anything/);await draft.fill('Keep this unsent draft');await expect(page.getByRole('button',{name:'Send',exact:true})).toBeDisabled();
    expect(await effects()).toEqual(before); expect(readFileSync(checkpoint)).toEqual(raw);expect(starts()).toBe(beforeStarts);
    const keepResponse=page.waitForResponse(response=>{try{return response.request().method()==='POST' && JSON.parse(response.request().postData() ?? '{}').method==='turns.keepRecovery';}catch{return false;}},{timeout:TEST_HANG_MS});
    await notice.getByRole('button',{name:'Keep recovery data'}).click();
    const keepReceipt=await (await keepResponse).json(); expect(keepReceipt.ok).toBe(true);
    const result=page.getByTestId('keep-recovery-result');
    if(cut==='write.begun'){
      expect(keepReceipt.value.cleared).toBe(false);
      await expect(result).toContainText('This attempt did not clear recovery.', {timeout:TEST_HANG_MS});await expect(notice).toBeVisible();expect(await effects()).toEqual(before);expect(readFileSync(checkpoint)).toEqual(raw);
      const copies=(await call('material.list',{projectId,includeHidden:true})).filter(entry=>entry.recovery);expect(copies.length).toBeGreaterThan(0);
      const reads=await Promise.all(copies.map(entry=>call('material.read',{id:entry.id})));expect(reads.some(r=>r.ok && r.value.text===raw.toString('utf8'))).toBe(true);
    } else {
      expect(keepReceipt.value.cleared).toBe(true);
      await expect(result).toContainText('That recovery was cleared.',{timeout:TEST_HANG_MS});await expect(notice).toHaveCount(0);
      const after=await effects();expect(after).toEqual([{id:before[0].id,status:'cancelled'}]);expect(existsSync(checkpoint)).toBe(false);
      const copies=(await call('material.list',{projectId,includeHidden:true})).filter(entry=>entry.recovery);expect(copies.length).toBeGreaterThan(0);
      const reads=await Promise.all(copies.map(entry=>call('material.read',{id:entry.id})));expect(reads.some(r=>r.ok && r.value.text===raw.toString('utf8'))).toBe(true);
      await result.locator('button').first().click();await expect(page.getByTestId('recovery-copy-notice')).toBeVisible();await expect(page.getByRole('button',{name:'Edit',exact:true})).toBeDisabled();
    }
    await expect(draft).toHaveValue('Keep this unsent draft'); expect(starts()).toBe(beforeStarts);
  } finally {await page.close();await link.release();if(bridge.exitCode===null && bridge.signalCode===null){bridge.kill('SIGTERM');await new Promise<void>(resolve=>bridge.once('exit',()=>resolve()));}await removeDataHome(home);}
});
