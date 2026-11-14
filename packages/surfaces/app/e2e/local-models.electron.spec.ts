// Real desktop settings and turns, on fake servers at the runtimes' default loopback ports.
import type { ModelSettings, Receipt, Thread } from '@backbone-next/platform';
import { removeDataHome } from '@backbone-next/platform/composition';
import { startScriptedModel } from '@backbone-next/platform/testing';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { api, appDir } from './journey';

const value = <T>(r: Receipt<T>): T => { if (!r.ok) throw new Error(r.detail); return r.value; };
async function runtime(port: number, name: string) {
  const model = await startScriptedModel(name, () => ({ text: `Answer from ${name}.` }));
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const response = await fetch(`${model.url}${req.url!.slice('/v1'.length)}`, { method: req.method, headers: { 'content-type': 'application/json', ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}) }, ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) });
      res.writeHead(response.status, { 'content-type': response.headers.get('content-type')! });
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch { res.writeHead(503); res.end(); }
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  } catch (error) { await model.close(); throw error; }
  let closed = false;
  return { model, close: async () => {
    if (closed) return; closed = true;
    await new Promise<void>(resolve => server.close(() => resolve())); await model.close();
  } };
}

test('detect Ollama and LM Studio, choose a keyless model, continue after restart and refuse a stopped server', async () => {
  test.setTimeout(240_000);
  const home = mkdtempSync(join(tmpdir(), 'local-models-app-'));
  let ollama: Awaited<ReturnType<typeof runtime>> | undefined;
  const absent: Server[] = [];
  let studio: Awaited<ReturnType<typeof runtime>> | undefined, app: ElectronApplication | undefined;
  const installed = process.env.BACKBONE_APP_EXECUTABLE;
  const launch = async () => {
    const env = { ...process.env, BACKBONE_HOME: home, BACKBONE_HARNESS: 'harness-pi' };
    // Neither an ambient endpoint nor a person's Keychain is part of this fixture.
    for (const key of ['BACKBONE_MODEL_ENDPOINT', 'BACKBONE_MODEL_ID', 'BACKBONE_CODEX_MODEL', 'BACKBONE_USER_HOME']) delete env[key as keyof typeof env];
    app = await electron.launch(installed ? { executablePath: installed, args: [], env } : { args: [appDir], env });
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(!!installed);
    const page = await app.firstWindow();
    await expect(page.locator('[data-ready=true]')).toBeVisible({ timeout: 60_000 });
    return page;
  };
  const quit = async () => { if (app) { await app.close(); app = undefined; } };
  try {
    ollama = await runtime(11434, 'ollama-owned-model');
    studio = await runtime(1234, 'studio-owned-model');
    // Discovery also probes these existing optional runtimes. Reserve their defaults
    // with owned refusals so this fixture cannot inspect a person's other model server.
    for (const port of [8080, 8000]) {
      const server = createServer((_req, res) => res.writeHead(404).end());
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
      absent.push(server);
    }
    let page = await launch();
    const project = value(await api<Receipt<{ id: string }>>(page, 'projects.create', { name: 'Local model work', kind: 'folder' }));
    await api(page, 'viewer.put', { prefs: { ...await api<object>(page, 'viewer.get', {}), selectedProjectId: project.id } });
    await page.reload(); await expect(page.locator('[data-ready=true]')).toBeVisible();
    const choose = async (model: string) => {
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
      await settings.getByRole('button', { name: 'AI and models', exact: true }).click();
      const local = settings.getByRole('region', { name: 'Local models', exact: true });
      await local.getByRole('button', { name: 'Look again', exact: true }).click();
      await expect(local.getByRole('button', { name: 'ollama-owned-model', exact: true })).toBeVisible();
      await expect(local.getByRole('button', { name: 'studio-owned-model', exact: true })).toBeVisible();
      await local.getByRole('button', { name: model, exact: true }).click();
      await expect(local.getByRole('button', { name: model, exact: true })).toHaveAttribute('aria-pressed', 'true');
      await expect(settings.getByTestId('model-active')).toContainText(model);
      await settings.getByRole('button', { name: 'Done', exact: true }).click();
    };
    const send = async (text: string, status: 'done' | 'stopped' = 'done') => {
      await page.getByRole('textbox', { name: 'Message', exact: true }).fill(text);
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(page.getByTestId('turn').last()).toContainText(text);
      await expect.poll(async () => {
        const threads = await api<{ id: string }[]>(page, 'threads.list', {});
        return threads.length ? value(await api<Receipt<Thread>>(page, 'threads.get', { id: threads[0].id })).turns.at(-1)?.status : 'missing';
      }).toBe(status);
    };
    await choose('ollama-owned-model');
    await send('Hello from local Ollama');
    await expect(page.getByTestId('turn').last()).toContainText('Answer from ollama-owned-model.');
    await choose('studio-owned-model');
    await send('Hello from local LM Studio');
    await expect(page.getByTestId('turn').last()).toContainText('Answer from studio-owned-model.');
    const originalThreads = await api<{ id: string }[]>(page, 'threads.list', {});
    expect(originalThreads).toHaveLength(1);
    await quit(); page = await launch();
    const settings = await api<ModelSettings>(page, 'settings.model.get', {});
    expect(settings.local?.model).toBe('studio-owned-model'); expect(settings.active?.kind).toBe('endpoint');
    expect(settings.own).toBeNull(); expect(settings.gateway).toBeNull();
    await send('Continue after reopening');
    await expect(page.getByTestId('turn').last()).toContainText('Answer from studio-owned-model.');
    expect((await api<{ id: string }[]>(page, 'threads.list', {})).map(thread => thread.id)).toEqual([originalThreads[0].id]);
    expect(value(await api<Receipt<Thread>>(page, 'threads.get', { id: originalThreads[0].id })).turns).toHaveLength(3);
    const continued = studio.model.requests.filter(request => request.body.includes('"messages"')).at(-1)!;
    expect(continued.body).toContain('Hello from local Ollama'); expect(continued.body).toContain('Hello from local LM Studio');
    const before = ollama.model.requests.length;
    await studio.close();
    await send('The selected server has stopped', 'stopped');
    const stopped = value(await api<Receipt<Thread>>(page, 'threads.get', { id: originalThreads[0].id })).turns.at(-1)!;
    expect(stopped.failure?.detail).toMatch(/local model.*studio-owned-model.*unavailable/i);
    expect(stopped.failure?.detail).toMatch(/no other route/i);
    await expect(page.getByTestId('turn').last()).toContainText(/local model.*studio-owned-model.*unavailable/i);
    await expect(page.getByTestId('turn').last()).toContainText(/no other route/i);
    expect(ollama.model.requests.length).toBe(before);
    expect((await api<ModelSettings>(page, 'settings.model.get', {})).local?.model).toBe('studio-owned-model');
    const chats = [...ollama.model.requests, ...studio.model.requests].filter(r => r.body.includes('"messages"'));
    expect(chats.length).toBeGreaterThanOrEqual(3);
    expect(chats.every(r => !r.headers.authorization || r.headers.authorization === 'Bearer none')).toBe(true);
  } finally {
    await quit(); await studio?.close(); await ollama?.close();
    for (const server of absent) await new Promise<void>(resolve => server.close(() => resolve()));
    await removeDataHome(home);
  }
});
