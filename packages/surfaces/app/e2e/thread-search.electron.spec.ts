// Runs on either the development app or a DMG-installed executable. Channels use real intake
// adapters against loopback fake providers; all conversations and keys belong to this test.
import type { Receipt, Thread, ThreadHit, ThreadSummary, TurnSettings } from '@backbone-next/platform';
import { removeDataHome } from '@backbone-next/platform/composition';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { startScriptedModel } from '@backbone-next/platform/testing';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startChannels } from '../../channels/src/index.ts';
import { fakeProvider } from '../../channels/test/fake-providers.ts';
import { slackMessage, telegramMessage } from '../../channels/test/messages.ts';
import { api, appDir } from './journey';

const settings: TurnSettings = { permission: 'ask', model: 'search-script', effort: 3, runsOn: 'this-computer', mode: 'chat' };
function value<T>(receipt: Receipt<T>): T {
  if (!receipt.ok) throw new Error(`${receipt.reason}: ${receipt.detail}`);
  return receipt.value;
}

test('thread search: ranked words, every result, archived titles and channel conversations survive a cold start', async () => {
  test.setTimeout(240_000);
  const installed = process.env.BACKBONE_APP_EXECUTABLE;
  const home = installed ? mkdtempSync(join(tmpdir(), 'backbone-thread-search-installed-')) : freshDataHome('thread-search-electron');
  const channelHome = mkdtempSync(join(tmpdir(), 'backbone-search-channels-'));
  const model = await startScriptedModel('search-script', messages => {
    const content = messages.findLast(m => m.role === 'user')?.content;
    const asked = typeof content === 'string' ? content : (content ?? []).map(p => p.text ?? '').join('');
    return { text: asked.includes('incidental') ? `quasar ${'unrelated material '.repeat(200)}` : 'quasar quasar orbit' };
  });
  let app: ElectronApplication | undefined;
  const launch = async () => {
    const runtime = { env: { ...process.env, BACKBONE_HOME: home, BACKBONE_HARNESS: 'harness-pi', BACKBONE_MODEL_ENDPOINT: model.url, BACKBONE_MODEL_ID: model.model } as Record<string, string> };
    app = await electron.launch(installed ? { ...runtime, executablePath: installed, args: [] } : { ...runtime, args: [appDir] });
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(!!installed);
    const page = await app.firstWindow();
    await expect(page.locator('[data-ready=true]')).toBeVisible({ timeout: 60_000 });
    return page;
  };
  const quit = async () => {
    if (!app) return;
    const closed = app.waitForEvent('close', { timeout: 30_000 });
    await app.evaluate(({ app }) => app.quit());
    await closed;
    app = undefined;
  };
  try {
    let page = await launch();
    const call = async <T>(method: string, args: unknown) => value(await api<Receipt<T>>(page, method, args));
    const project = await call<{ id: string }>('projects.create', { name: 'Search history', kind: 'folder' });
    const settled = async (id: string) => {
      await expect.poll(async () => (await call<Thread>('threads.get', { id })).summary.running, { timeout: 30_000 }).toBe(false);
      expect((await call<Thread>('threads.get', { id })).turns.at(-1)?.status).toBe('done');
    };
    const send = async (text: string) => {
      const sent = await call<{ threadId: string }>('turns.send', { projectId: project.id, text, settings, attachments: [], clientKey: crypto.randomUUID() });
      await settled(sent.threadId);
      return sent.threadId;
    };
    const focused = await send('A focused answer');
    // Forks are durable ordinary conversations, with no additional model calls.
    for (let i = 0; i < 55; i++) await call('threads.fork', { id: focused, clientKey: `search-copy-${i}` });
    const incidental = await send('An incidental mention');
    await call('threads.update', { id: focused, patch: { archived: true, title: 'CAFÉ: launch-plan' } });

    // Actual Slack and Telegram intake, replies and binding, entirely on local fake endpoints.
    for (const provider of ['slack', 'telegram'] as const) {
      const fake = await fakeProvider(provider);
      let channel: Awaited<ReturnType<typeof startChannels>> | undefined;
      try {
        channel = await startChannels({ call: (method, args) => api(page, method, args), on: () => () => {} }, {
          home: channelHome, projectId: project.id, settings,
          [provider]: provider === 'slack' ? { token: 'fake', signingSecret: 'test-signing', apiUrl: `${fake.url}/api/` } : { token: 'fake', secret: 'test-signing', apiUrl: fake.url },
        });
        const active = channel;
        fake.events(request => active.webhook(provider, request));
        expect(active.ledger.pair(provider, provider === 'slack' ? 'T1:U1' : '7', active.ledger.invite())).toBe(true);
        const payload = provider === 'slack' ? slackMessage : telegramMessage;
        expect((await fake.emit(payload(1, `${provider} prism handover`))).ok).toBe(true);
        await active.idle();
        const threads = await api<ThreadSummary[]>(page, 'threads.list', {});
        const fromChannel = threads.find(t => t.title.includes(`${provider} prism handover`));
        expect(fromChannel).toBeDefined();
        await settled(fromChannel!.id);
        await active.idle();
        expect(fake.posts().length, 'the local channel received its reply').toBeGreaterThan(0);
      } finally { await channel?.close(); await fake.close(); }
    }

    await quit();
    page = await launch();
    const search = async (query: string) => {
      await page.getByRole('button', { name: 'Search chats', exact: true }).click();
      await page.getByRole('combobox').fill(query);
      return page.getByTestId('search-hit');
    };
    const all = await api<ThreadHit[]>(page, 'threads.search', { query: 'quasar' });
    expect(new Set(all.map(h => h.threadId)).size).toBe(59);
    expect(all[0].threadId).not.toBe(incidental);
    expect(all.at(-1)?.threadId).toBe(incidental);
    const hits = await search('quasar');
    await expect(hits).toHaveCount(all.length);
    await expect(hits.last()).toContainText('An incidental mention');
    await hits.last().click();
    await expect(page.getByRole('region', { name: 'An incidental mention', exact: true })).toBeVisible();

    // A title-only archived hit uses the host's accent/punctuation/prefix matching directly.
    const title = await search('cafe launch pla');
    await expect(title).toHaveCount(1);
    await title.click();
    await expect(page.getByRole('tab', { name: 'CAFÉ: launch-plan', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('turn').first()).toContainText('A focused answer');
    expect((await call<Thread>('threads.get', { id: focused })).summary.archived, 'opening a result preserves the archive choice').toBe(true);
    for (const provider of ['slack', 'telegram']) {
      const channelHits = await search(`prism ${provider}`);
      await expect(channelHits.first()).toContainText(`${provider} prism handover`);
      await channelHits.first().click();
      await expect(page.getByRole('tab', { name: `${provider} prism handover`, exact: true })).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByTestId('turn').first()).toContainText(`${provider} prism handover`);
    }
    await search('no-such-conversation');
    await expect(page.getByTestId('search-hit')).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: 'Search', exact: true }).locator('[cmdk-empty]')).toBeVisible();
  } finally {
    await quit();
    await model.close();
    await removeDataHome(home);
    rmSync(channelHome, { recursive: true, force: true });
  }
});
