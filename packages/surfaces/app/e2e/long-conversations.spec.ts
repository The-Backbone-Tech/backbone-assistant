import { removeDataHome } from '@backbone-next/platform/composition';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { startScriptedModel } from '@backbone-next/platform/testing';
import type { Thread } from '@backbone-next/platform';
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBridge, stopBridge } from './bridge';
import { api } from './journey';
import { longConversationStep } from './fixtures/long-conversation-model';

test('a person continues past the context limit and reopens linked compacted history after reload', async ({ page: browserPage }, testInfo) => {
  test.setTimeout(180_000);
  const contextWindow = 200_000;
  const model = await startScriptedModel('long-conversation-model', longConversationStep, { before: messages => JSON.stringify(messages).length / 4 > contextWindow ? { status: 400, message: 'Scripted model context limit exceeded' } : undefined });
  const installed = process.env.BACKBONE_APP_EXECUTABLE;
  const home = installed ? mkdtempSync(join(tmpdir(), 'long-conversation-installed-')) : freshDataHome('long-conversation');
  const env = { BACKBONE_HARNESS: 'harness-pi', BACKBONE_MODEL_ENDPOINT: model.url, BACKBONE_MODEL_ID: model.model, BACKBONE_PI_CONTEXT_WINDOW: String(contextWindow) };
  const app = installed ? await electron.launch({ executablePath: installed, args: [], env: { ...process.env, ...env, BACKBONE_HOME: home } }) : undefined;
  let bridge: Awaited<ReturnType<typeof startBridge>> | undefined;
  let page = browserPage;
  try {
    if (app) { expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true); page = await app.firstWindow(); }
    else {
      bridge = await startBridge(home, env);
      await page.goto(bridge.url);
    }
    await expect(page.locator('[data-ready=true]')).toBeVisible({ timeout: 60_000 });
    const project = await api<{ value: { id: string } }>(page, 'projects.create', { name: 'Long ledger', kind: 'folder' });
    await page.reload();
    await page.getByRole('navigation').getByRole('button', { name: 'Long ledger', exact: true }).click();
    const settings = { permission: 'full', model: 'stub', effort: 3, runsOn: 'this-computer', mode: 'chat' };
    let threadId: string | undefined, thread: Thread | undefined;
    // Use the same explicit character-count estimate as the scripted provider's hard limit.
    const originalContext = () => thread!.turns.reduce((total, turn) => total + turn.user.text.length + (turn.answer?.text.length ?? 0), 0) / 4;
    for (let i = 0; i < 18; i++) {
      const sent = await api<{ value: { threadId: string } }>(page, 'turns.send', { projectId: project.value.id, threadId, text: i === 0 ? 'Start the amber ledger' : `Add ledger evidence ${i}`, attachments: [], settings, clientKey: `ledger-${i}` });
      threadId = sent.value.threadId;
      await expect.poll(async () => { thread = (await api<{ value: Thread }>(page, 'threads.get', { id: threadId })).value; return thread.summary.running; }, { intervals: [20, 50, 100], timeout: 20_000 }).toBe(false);
      expect(thread!.turns.at(-1)!.status).toBe('done');
      if (originalContext() > contextWindow && thread!.turns.some(turn => turn.work.compactions?.some(record => record.status === 'completed'))) break;
    }
    expect(thread!.turns.some(turn => turn.work.compactions?.some(record => record.status === 'completed'))).toBe(true);
    expect(originalContext()).toBeGreaterThan(contextWindow);
    await api(page, 'turns.send', { projectId: project.value.id, threadId, text: 'Continue after compaction', attachments: [], settings, clientKey: 'ledger-continue' });
    await expect.poll(async () => (await api<{ value: Thread }>(page, 'threads.get', { id: threadId })).value.summary.running, { timeout: 20_000 }).toBe(false);
    await page.reload();
    await page.getByRole('navigation').getByText('Start the amber ledger', { exact: true }).click();
    await expect(page.getByTestId('answer').last()).toContainText('Continued using the amber decision');
    const compacted = page.getByTestId('compaction').first();
    await compacted.locator('summary').click();
    await expect(compacted).toContainText('The ledger decision is amber');
    await expect(compacted).toContainText('input');
    const original = compacted.getByRole('link', { name: 'Earlier turn 1', exact: true });
    expect(await original.getAttribute('href')).toBe(`#turn-${thread!.turns[0].id}`);
    await original.click();
    await expect(page.locator(`#turn-${thread!.turns[0].id}`)).toContainText('Ledger evidence remains readable');
    await expect(page.locator(`#turn-${thread!.turns[0].id}`)).toBeInViewport();
  } finally {
    // Retain request shape/phase evidence for both routes without copying conversation text or headers.
    const requests = model.requests.filter(request => request.body).map(request => {
      const messages = (JSON.parse(request.body) as { messages?: { role: string; content?: unknown }[] }).messages ?? [];
      const content = messages.findLast(message => message.role === 'user')?.content;
      return { contentKind: Array.isArray(content) ? 'text-parts' : typeof content, summary: JSON.stringify(messages).includes('<conversation>'), continuation: JSON.stringify(content).includes('Continue after compaction'), estimatedContext: JSON.stringify(messages).length / 4 };
    });
    const observations = testInfo.outputPath('model-observations.json');
    writeFileSync(observations, JSON.stringify({ installed: !!installed, contextWindow, requests }, null, 2));
    await testInfo.attach('long-conversation-model-observations', { path: observations, contentType: 'application/json' });
    if (app) await app.close();
    if (bridge) await stopBridge(bridge.proc);
    await removeDataHome(home);
    await model.close();
  }
});
