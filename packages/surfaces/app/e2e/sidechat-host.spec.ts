import { TEST_HANG_MS } from '../../../../scripts/lib/test-hang.ts';
// Assertion deadlines detect hangs; Playwright retains the pending locator/property and last value.
// Real renderer, Host, Core and Pi; the endpoint and lost acknowledgement are controlled locally.
import { expect, test } from '@playwright/test';
import { createHost, hostClosed, removeDataHome } from '@backbone-next/platform/composition';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { startScriptedModel } from '@backbone-next/platform/testing';
import type { Method, Receipt } from '@backbone-next/platform';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const value = <T,>(receipt: Receipt<T>): T => { if (!receipt.ok) throw new Error(receipt.detail); return receipt.value; };

test('lost side acknowledgement is recovered with the original identity through Host', async ({ page }) => {
  const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  let releaseSide!: () => void;
  const heldSide = new Promise<void>((resolve) => { releaseSide = resolve; });
  const model = await startScriptedModel('side-ui', () => ({ text: 'Controlled answer' }), {
    async before(messages) { if (JSON.stringify(messages).includes('Stop this side question')) await heldSide; },
  });
  const home = freshDataHome('side-ui-host');
  const old = { endpoint: process.env.BACKBONE_MODEL_ENDPOINT, model: process.env.BACKBONE_MODEL_ID };
  process.env.BACKBONE_MODEL_ENDPOINT = model.url; process.env.BACKBONE_MODEL_ID = model.model;
  const host = createHost({ home, harness: 'harness-pi' });
  let off = () => {};
  const pendingCalls = new Set<Promise<unknown>>();
  try {
    const projectId = value(await host.call('projects.create', { name: 'Side UI', kind: 'folder' })).id;
    const sent = value(await host.call('turns.send', { projectId, text: 'Main question', attachments: [], settings: { permission: 'ask', model: 'stub', effort: 3, runsOn: 'this-computer', mode: 'chat' }, clientKey: 'main' }));
    await expect.poll(async () => value(await host.call('threads.get', { id: sent.threadId })).turns[0]?.status, { timeout: TEST_HANG_MS }).toBe('done');
    const prefs = await host.call('viewer.get', {});
    await host.call('viewer.put', { prefs: { ...prefs, selectedProjectId: projectId, selectedThreadId: sent.threadId, pane: { open: true, tabs: [{ id: 'side-chat', kind: 'side-chat' }], active: 'side-chat' } } });
    let lose = true; const asks: unknown[] = []; const stops: unknown[] = [];
    await page.exposeFunction('sideHostCall', async (method: Method, args: unknown) => {
      const pending = (async () => {
        if (method === 'sidechat.ask') {
          asks.push(structuredClone(args)); const result = await host.call(method, args as never);
          if (lose) { lose = false; throw new Error('Controlled lost acknowledgement'); }
          return result;
        }
        const result = await host.call(method, args as never);
        if (method === 'sidechat.stop') stops.push(result);
        return result;
      })();
      pendingCalls.add(pending);
      try { return await pending; } finally { pendingCalls.delete(pending); }
    });
    await page.addInitScript(() => { const api = window as any; api.backbone = { platform: 'linux', setTheme() {}, call: (m: string, a: unknown) => api.sideHostCall(m, a), onEvent(listener: (event: unknown) => void) { const receive = (event: Event) => listener((event as CustomEvent).detail); window.addEventListener('platform-event', receive); return () => window.removeEventListener('platform-event', receive); } }; });
    off = host.on((event) => { void page.evaluate((e) => window.dispatchEvent(new CustomEvent('platform-event', { detail: e })), event).catch(() => {}); });
    await page.goto(server.resolvedUrls!.local[0]);
    const input = page.getByRole('textbox', { name: 'Ask the side chat' });
    await expect(input).toBeEnabled();
    const before = model.requests.filter((r) => r.body.includes('"messages"')).length;
    await input.fill('Original side question'); await input.press('Enter');
    await expect(page.getByText(/could not be confirmed/)).toBeVisible({ timeout: TEST_HANG_MS });
    const after = model.requests.filter((r) => r.body.includes('"messages"')).length;
    expect(after).toBeGreaterThan(before);
    await input.fill('Newer draft');
    await expect.poll(async () => (await host.call('drafts.get', { key: `side-chat:${sent.threadId}` }))?.text).toBe('Newer draft');
    await page.reload();
    await expect(input).toHaveValue('Newer draft');
    await page.getByRole('button', { name: 'Retry original question' }).click();
    await expect.poll(() => asks.length).toBe(2);
    expect(asks[1]).toEqual(asks[0]);
    await expect(page.getByRole('button', { name: 'Retry original question' })).toHaveCount(0);
    expect(model.requests.filter((r) => r.body.includes('"messages"')).length).toBe(after);
    await expect(input).toHaveValue('Newer draft');
    expect(value(await host.call('threads.get', { id: sent.threadId })).sideTurns).toHaveLength(1);
    await input.fill('Stop this side question'); await input.press('Enter');
    const stop = page.getByRole('button', { name: 'Stop side question' });
    await expect(stop).toBeVisible({ timeout: TEST_HANG_MS });
    const running = value(await host.call('threads.get', { id: sent.threadId })).sideTurns.find((turn) => turn.status === 'running');
    expect(running).toBeTruthy();
    // The model stays held until Host has acknowledged the Stop. Releasing it at the click raced
    // the Stop's crossing: an answer that finished first was rightly recorded as done.
    await stop.click();
    await expect.poll(() => stops.length, { timeout: TEST_HANG_MS }).toBe(1);
    expect(stops[0]).toEqual({ ok: true, value: { stopped: true } });
    releaseSide();
    await expect.poll(async () => value(await host.call('threads.get', { id: sent.threadId })).sideTurns.find((turn) => turn.id === running!.id)?.status, { timeout: TEST_HANG_MS }).toBe('stopped');
    expect(value(await host.call('threads.get', { id: sent.threadId })).turns[0].status).toBe('done');
  } finally {
    releaseSide();
    await page.close(); off();
    // pagehide can dispatch a draft flush through the exposed bridge. Join those calls before
    // closing the Host and removing its home; otherwise a late lock acquisition can recreate it.
    while (pendingCalls.size) await Promise.allSettled([...pendingCalls]);
    host.close(); await hostClosed(home); await removeDataHome(home); await model.close(); await server.close();
    if (old.endpoint === undefined) delete process.env.BACKBONE_MODEL_ENDPOINT; else process.env.BACKBONE_MODEL_ENDPOINT = old.endpoint;
    if (old.model === undefined) delete process.env.BACKBONE_MODEL_ID; else process.env.BACKBONE_MODEL_ID = old.model;
  }
});
