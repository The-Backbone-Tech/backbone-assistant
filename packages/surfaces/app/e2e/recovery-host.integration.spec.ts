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
for (const scenario of ['write.custodied', 'write.begun', 'stop-during-keep']) test(`actual damaged recovery through HTTP/UI: ${scenario}`, async ({ page }) => {
  const point = scenario === 'stop-during-keep' ? 'write.custodied' : scenario;
  const home = freshDataHome('recovery-ui');
  const crash = spawn(process.execPath, [resolve('../../../packages/platform/test/crash-document.ts'), home, fixture, 'ui-recovery.md', 'pending-new'], {
    env: { ...process.env, BACKBONE_HARNESS: 'harness-codex', BACKBONE_CODEX_MODEL: 'controlled', BACKBONE_CRASH_AT: point, BACKBONE_CRASH_OCCURRENCE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = ''; crash.stdout.on('data', d => stdout += d); crash.stderr.on('data', d => stderr += d);
  const timer = childHangTimer(crash, 'recovery crash fixture completion');
  const result = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => { crash.on('error', reject); crash.on('exit', (code, signal) => resolve({code, signal})); }); clearTimeout(timer);
  expect(result.signal, stderr).toBe('SIGKILL');
  const { projectId } = JSON.parse(stdout.trim().split('\n')[0]);
  const path = join(home, 'threads', readdirSync(join(home, 'threads')).find(f => f.endsWith('.json'))!);
  const stored = JSON.parse(readFileSync(path, 'utf8')); const threadId = stored.summary.id, turnId = stored.turns[0].id;
  const checkpoint = join(home, 'checkpoints', `${turnId}.json`); const damaged = `{ invalid checkpoint ${point} Ω`; writeFileSync(checkpoint, damaged); const checkpointBefore = readFileSync(checkpoint);
  const launcher = join(scratch, `bridge-${scenario}.mjs`);
  const blocked = join(scratch, 'repair-read-blocked'), release = join(scratch, 'repair-read-release');
  const delay = scenario === 'stop-during-keep' ? `import { CoreLink } from ${JSON.stringify(pathToFileURL(resolve('../../../packages/platform/src/composition/core.ts')).href)}; import { existsSync, writeFileSync } from 'node:fs'; const originalRead = CoreLink.prototype.read; CoreLink.prototype.read = async function(actor, sql, params) { if (sql.includes("SELECT id, piece_id AS piece, agent_id AS agent FROM app.runs")) { writeFileSync(${JSON.stringify(blocked)}, 'blocked'); while (!existsSync(${JSON.stringify(release)})) await new Promise(r => setTimeout(r, 20)); } return originalRead.call(this, actor, sql, params); };` : '';
  writeFileSync(launcher, `import { PIECES } from ${JSON.stringify(pathToFileURL(resolve('../../../packages/platform/src/composition/pieces.ts')).href)}; PIECES['harness-codex'].dir = ${JSON.stringify(fixture)}; ${delay} await import(${JSON.stringify(pathToFileURL(resolve('server/bridge.ts')).href)});`);
  const startBridge = async () => {
    const child = spawn(process.execPath, [launcher], { env: { ...process.env, BACKBONE_HOME: home, BACKBONE_HARNESS: 'harness-codex', BACKBONE_CODEX_MODEL: 'controlled', PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = ''; child.stderr.on('data', d => err += d); let out = ''; let address = '';
    for await (const chunk of child.stdout) { out += chunk; const m = out.match(/backbone bridge on (http:\/\/127[.]0[.]0[.]1:[0-9]+)/); if (m) { address = m[1]; break; } }
    expect(address, err).toBeTruthy(); return { child, address };
  };
  let { child: bridge, address: url } = await startBridge();
  const call = async <M extends Method>(method: M, args: Args<M>): Promise<Result<M>> => { const response = await fetch(url + '/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, args }) }); if (!response.ok) throw new Error(await response.text()); return response.json() as Promise<Result<M>>; };
  try {
    const prefs = await call('viewer.get', {}); await call('viewer.put', { prefs: { ...prefs, selectedProjectId: projectId, selectedThreadId: threadId } });
    await page.goto(url);
    const notice=page.getByTestId('recovery-hold'); await expect(notice).toContainText('Saved recovery data needs inspection');
    const input=page.getByPlaceholder(/Ask .* anything/); await input.fill('A draft to preserve'); await expect(page.getByRole('button',{name:'Send',exact:true})).toBeDisabled();
    const startsBefore = readFileSync(observations, 'utf8').trim().split('\n').filter(line => JSON.parse(line).event === 'start').length;
    await notice.getByRole('button',{name:'Keep recovery data'}).click();
    const uiResult=page.getByTestId('keep-recovery-result');
    if (scenario === 'stop-during-keep') {
      await expect.poll(() => existsSync(blocked)).toBe(true);
      await expect(notice).toContainText('Saved work is being reconciled.');
      const copiesBefore = (await call('material.list', {projectId, includeHidden: true})).filter((x: any) => x.recovery);
      expect(copiesBefore.length).toBeGreaterThan(0);
      const copyBytes = await Promise.all(copiesBefore.map(async (entry: any) => { const r = await call('material.read', {id: entry.id}); if (!r.ok) throw new Error(r.detail); return {id: entry.id, text: r.value.text, base64: r.value.base64}; }));
      expect(copyBytes.some((entry: any) => entry.text === damaged)).toBe(true);
      await expect(page.getByRole('button', {name: 'Stop', exact: true})).toBeVisible();
      const stopResponse = page.waitForResponse(response => { try { return response.request().method() === 'POST' && JSON.parse(response.request().postData() ?? '{}').method === 'turns.stop'; } catch { return false; } });
      await page.getByRole('button', {name: 'Stop', exact: true}).click();
      const receipt = await (await stopResponse).json(); expect(receipt.ok && receipt.value.stopped).toBe(true);
      const journal = JSON.parse(readFileSync(path, 'utf8'));
      expect(journal.turns.find((turn: any) => turn.id === turnId)?.stopRequested, 'acknowledged Stop must be journaled even when checkpoint is malformed').toBe(true);
      writeFileSync(release, 'release');
      await expect(uiResult).toContainText('This attempt did not clear recovery.', {timeout: TEST_HANG_MS});
      await expect(input).toHaveValue('A draft to preserve');
      await expect.poll(async () => (await call('drafts.get', {key: `composer:${threadId}`}))?.text).toBe('A draft to preserve');
      await page.close(); bridge.kill('SIGTERM'); await new Promise<void>(resolve => bridge.once('exit', () => resolve()));
      ({child: bridge, address: url} = await startBridge());
      const reopened = await call('threads.get', {id: threadId}); if (!reopened.ok) throw new Error(reopened.detail);
      expect(reopened.value.turns.find((turn: any) => turn.id === turnId)?.stopRequested, 'Stop survives a cold Host reopen').toBe(true);
      expect(readFileSync(checkpoint)).toEqual(checkpointBefore);
      const reopenedPage = await page.context().newPage();
      try { await reopenedPage.goto(url); await expect(reopenedPage.getByTestId('recovery-hold')).toBeVisible(); await expect(reopenedPage.getByPlaceholder(/Ask .* anything/)).toHaveValue('A draft to preserve'); } finally { await reopenedPage.close(); }
      for (const before of copyBytes) { const after = await call('material.read', {id: before.id}); if (!after.ok) throw new Error(after.detail); expect({text: after.value.text, base64: after.value.base64}).toEqual({text: before.text, base64: before.base64}); }
    } else if (point === 'write.custodied') {
      await expect(uiResult).toContainText('That recovery was cleared.', {timeout:TEST_HANG_MS}); await expect(notice).toHaveCount(0); await expect(input).toHaveValue('A draft to preserve');
      const thread=await call('threads.get',{id:threadId}); if (!thread.ok) throw new Error(thread.detail); expect(thread.value.summary.recoveryHold).toBeUndefined();
      const copies=(await call('material.list',{projectId,includeHidden:true})).filter(x=>x.recovery); expect(copies.length).toBeGreaterThanOrEqual(1);
      const reads=await Promise.all(copies.map(x=>call('material.read',{id:x.id}))); expect(reads.some(r=>r.ok && r.value.text===damaged)).toBe(true); expect(existsSync(checkpoint)).toBe(false);
      await expect(page.getByRole('button',{name:'Send',exact:true})).toBeEnabled();
      await uiResult.locator('button').first().click();
      await expect(page.getByTestId('recovery-copy-notice')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeDisabled();
      await expect(page.getByRole('button', { name: /^(Save|Keep|Allow in later work|Bring back)$/ })).toHaveCount(0);
    } else {
      await expect(uiResult).toContainText('This attempt did not clear recovery.', {timeout:TEST_HANG_MS}); await expect(notice).toBeVisible(); await expect(input).toHaveValue('A draft to preserve');
      expect(readFileSync(checkpoint,'utf8')).toBe(damaged); const thread=await call('threads.get',{id:threadId}); if(!thread.ok) throw new Error(thread.detail); expect(thread.value.summary.recoveryHold?.kind).toBe('inspection');
    }
    expect(readFileSync(observations, 'utf8').trim().split('\n').filter(line => JSON.parse(line).event === 'start').length).toBe(startsBefore);
  } finally { if (scenario === 'stop-during-keep') writeFileSync(release, 'release'); if (!page.isClosed()) await page.close(); if (bridge.exitCode === null && bridge.signalCode === null) { bridge.kill('SIGTERM'); await new Promise<void>(resolve => bridge.once('exit', () => resolve())); } await removeDataHome(home); }
});
