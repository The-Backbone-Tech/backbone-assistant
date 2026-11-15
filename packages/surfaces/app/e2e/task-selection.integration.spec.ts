// Actual renderer and public Host/core/gateway, with an IPC-shaped test transport and owned loopback models.
// This observes the destination that received requests; it does not qualify a real account or native route.
import { expect, test } from '@playwright/test';
import * as integratedComposition from '@backbone-next/platform/composition';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { startScriptedModel } from '@backbone-next/platform/testing';
import type { Method, Receipt } from '@backbone-next/platform';
import { createServer, type ViteDevServer } from 'vite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
// A bounded candidate can be checked without editing its owning worktree. Production has no switch.
const composition: typeof integratedComposition = process.env.BACKBONE_APP_TEST_COMPOSITION
  ? await import(pathToFileURL(process.env.BACKBONE_APP_TEST_COMPOSITION).href) : integratedComposition;
const { createHost, hostClosed, removeDataHome } = composition;
let server: ViteDevServer; let url: string;
test.beforeAll(async () => { server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), server: { host: '127.0.0.1', port: 0 } }); await server.listen(); url = server.resolvedUrls!.local[0]; });
test.afterAll(async () => { await server?.close(); });
const value = <T,>(r: Receipt<T>): T => { if (!r.ok) throw new Error(r.detail); return r.value; };

for (const attached of [false, true]) test(`selected route, written versions, follow-up and cold fork preserve ${attached ? 'attached sources' : 'a plain task'}`, async ({ page }, info) => {
  const home = freshDataHome('app-selection');
  const chosen = await startScriptedModel('selected-small');
  const chosenCalls = () => chosen.requests.filter((r) => r.body.trim()).map((r) => JSON.parse(r.body) as { model?: string; messages?: unknown[] }).filter((r) => Array.isArray(r.messages));
  const configured = await startScriptedModel('configured-other');
  const old = { endpoint: process.env.BACKBONE_MODEL_ENDPOINT, model: process.env.BACKBONE_MODEL_ID, harness: process.env.BACKBONE_HARNESS };
  process.env.BACKBONE_HARNESS = 'harness-pi';
  process.env.BACKBONE_MODEL_ENDPOINT = configured.url; process.env.BACKBONE_MODEL_ID = configured.model;
  const userHome = join(home, 'isolated-user'); mkdirSync(userHome);
  const options = { home, harness: 'harness-pi' as const, memory: { userHome }, localModels: { ports: { ollama: Number(new URL(chosen.url).port), lmstudio: 0, llamacpp: 0, vllm: 0 } } };
  let host = createHost(options); let off = () => {};
  let hostGeneration = 0;
  let hostPhase: 'open' | 'closing' | 'closed' = 'open';
  const calls: { method: Method; generation: number; phase: string; result: string; settledPhase?: string }[] = [];
  const errors: string[] = []; page.on('pageerror', (e) => errors.push(e.message));
  try {
    const projectId = value(await host.call('projects.create', { name: 'Route proof', kind: 'folder' })).id;
    const prefs = await host.call('viewer.get', {}); await host.call('viewer.put', { prefs: { ...prefs, selectedProjectId: projectId } });
    const observed: Method[] = [];
    await page.exposeFunction('selectionCall', async (method: Method, args: unknown) => {
      observed.push(method);
      const currentHost = host;
      const call: typeof calls[number] = { method, generation: hostGeneration, phase: hostPhase, result: 'in-flight' };
      calls.push(call);
      try {
        const result = await currentHost.call(method, args as never);
        const receipt = result as { ok?: boolean; reason?: string; outcome?: string } | null;
        call.result = receipt?.ok === false ? `receipt: ${receipt.reason ?? 'unspecified'} / ${receipt.outcome ?? 'unspecified'}` : 'returned';
        return result;
      } catch (error) {
        call.result = error instanceof Error ? `threw: ${error.message}` : `threw: ${String(error)}`;
        throw error;
      } finally {
        call.settledPhase = currentHost === host ? hostPhase : 'replaced';
      }
    });
    await page.addInitScript(() => {
      const api = window as any;
      api.backbone = { platform: 'linux', setTheme() {}, call: (m: string, a: unknown) => api.selectionCall(m, a), onEvent(listener: (e: unknown) => void) { const receive = (e: Event) => listener((e as CustomEvent).detail); window.addEventListener('platform-event', receive); return () => window.removeEventListener('platform-event', receive); } };
    });
    const listen = () => host.on((e) => { void page.evaluate((event) => window.dispatchEvent(new CustomEvent('platform-event', { detail: event })), e).catch(() => {}); });
    off = listen(); await page.goto(url);
    await expect(page.locator('[data-ready=true]')).toBeVisible();
    const modelBefore = await host.call('settings.model.get', {});
    await page.getByRole('button', { name: /^Model and effort:/ }).click();
    // Pi offers its configured model, not a native Codex catalogue to reselect.
    await expect(page.getByRole('menuitemradio', { name: configured.model, exact: true })).toHaveCount(0);
    await page.getByRole('menuitem', { name: 'Model connections…' }).click();
    const connections = page.getByRole('dialog', { name: 'Settings', exact: true });
    await expect(connections.getByTestId('model-active')).toContainText(configured.model);
    await expect(connections.getByTestId('model-active')).toContainText('Pi');
    expect(await host.call('settings.model.get', {})).toEqual(modelBefore);
    expect(observed.filter((method) => method === 'settings.model.put')).toEqual([]);
    // Discovery is setup-only. The person's explicit Settings choice authorizes this destination.
    // The model forms open on demand since Settings shows the engine, your model and shared work as one page.
    await connections.getByText('Change your model', { exact: true }).click();
    const selectedLocal = connections.getByRole('region', { name: 'Local models', exact: true }).getByRole('button', { name: chosen.model, exact: true });
    await selectedLocal.click();
    await expect(selectedLocal).toHaveAttribute('aria-pressed', 'true');
    await expect(connections.getByTestId('model-active')).toContainText(chosen.model);
    expect((await host.call('settings.model.get', {})).local).toEqual({ provider: 'ollama', baseUrl: chosen.url, model: chosen.model });
    expect(observed.filter((method) => method === 'settings.model.put')).toEqual(['settings.model.put']);
    await page.keyboard.press('Escape');

    if (attached) {
      await page.getByTestId('attach-input').setInputFiles([{ name: 'note.md', mimeType: 'text/markdown', buffer: Buffer.from('# Source\nPreserve this source in the brief.\n') }, { name: 'context.md', mimeType: 'text/markdown', buffer: Buffer.from('# Context\nRetain both attached sources.\n') }]);
      await expect(page.getByTestId('attachment-chip')).toHaveText(['note.md', 'context.md']);
    }
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Write an editable brief');
    await page.getByRole('button', { name: /^Model and effort:/ }).click();
    await page.getByRole('menuitem', { name: 'Choose route for this task…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Choose a route for this task' });
    await dialog.getByLabel('Model connection').selectOption('false'); await dialog.getByLabel('Spending category').selectOption('none');
    await dialog.getByRole('button', { name: 'Compare available routes' }).click();
    await expect(dialog.getByRole('region', { name: 'Route comparison' })).toContainText('selected-small');
    await dialog.getByRole('button', { name: 'Choose again and run' }).click();
    await expect(page.getByTestId('work-block')).toContainText('Worked for');
    const threads = await host.call('threads.list', {}); expect(threads).toHaveLength(1);
    const threadId = threads[0].id; const thread = value(await host.call('threads.get', { id: threadId }));
    const selection = thread.turns[0].selection!;
    expect(thread.turns[0].user.attachments).toHaveLength(attached ? 2 : 0);
    if (attached) expect(thread.turns[0].reads?.some((r) => r.name === 'note.md')).toBe(true);
    expect(selection.routeId).toBe('local:ollama:selected-small'); expect(selection.pinned.model).toBe('selected-small'); expect(selection.ran).toEqual(selection.pinned);
    expect(selection.task).toEqual({ needs: ['model', 'files'], network: false, spend: 'none' });
    expect(chosenCalls().length).toBeGreaterThan(0); expect(configured.requests.length).toBe(0);
    const output = thread.turns[0].answer!.files.find((f) => f.name === 'brief.md')!; expect(output).toBeTruthy();
    expect(thread.turns[0].effects.some((e) => e.outcome === 'DONE')).toBe(true);
    await page.getByTestId('turn-selection').locator('summary').first().click(); await expect(page.getByTestId('turn-selection')).toContainText('Route recorded for execution');
    await page.getByRole('button', { name: 'Check written file versions' }).click();
    await expect(page.getByRole('region', { name: 'Written version checks' })).toContainText('Recorded files passed basic checks.');
    expect(observed).toContain('solutions.verify');
    await page.getByRole('button', { name: 'brief.md v1', exact: true }).click();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByRole('textbox', { name: 'Edit brief.md' }).fill('# Human retained\n\nKeep this later edit exactly.');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(async () => value(await host.call('material.read', { id: output.materialId })).entry.current).toBe(2);
    await page.getByRole('button', { name: 'Check written file versions' }).click();
    await expect(page.getByRole('region', { name: 'Written version checks' })).toContainText('edited since by');

    // Check acknowledged draft and view with the real Host before and after a reload.
    const liveComposer = page.getByRole('textbox', { name: 'Message', exact: true });
    await liveComposer.fill('Draft retained by real Host');
    await expect.poll(async () => (await host.call('drafts.get', { key: `composer:${threadId}` }))?.text).toBe('Draft retained by real Host');
    await expect.poll(async () => (await host.call('viewer.get', {})).selectedThreadId).toBe(threadId);
    await page.reload();
    await expect(liveComposer).toHaveValue('Draft retained by real Host');
    expect((await host.call('drafts.get', { key: `composer:${threadId}` }))?.text).toBe('Draft retained by real Host');
    await liveComposer.fill('');
    await expect.poll(async () => (await host.call('drafts.get', { key: `composer:${threadId}` }))?.text).toBe('');
    await page.screenshot({ path: info.outputPath('selected-local-route.png'), fullPage: true });
    await page.goto('about:blank'); off(); hostPhase = 'closing'; host.close();
    // Probe both read and write through the same renderer binding after close starts.
    const closeProbe = await page.evaluate(async () => {
      const call = (window as any).selectionCall;
      const attempt = async (method: string, args: unknown) => {
        try { await call(method, args); return 'unexpected success'; }
        catch (error) { return String(error); }
      };
      return {
        read: await attempt('drafts.get', { key: 'close-probe' }),
        write: await attempt('drafts.put', { key: 'close-probe', text: 'must not persist', clientKey: 'close-probe', baseRevision: 0 }),
      };
    });
    expect(closeProbe.read).toContain('This app is closing');
    expect(closeProbe.write).toContain('This app is closing');
    await hostClosed(home); hostPhase = 'closed'; host = createHost(options); hostGeneration++; hostPhase = 'open'; off = listen();
    expect(await host.call('drafts.get', { key: 'close-probe' })).toBeNull();
    await page.goto(url);
    await expect(page.getByTestId('turn-selection')).toContainText('Route recorded for execution');
    const reopened = value(await host.call('threads.get', { id: threadId })); expect(reopened.turns[0].selection).toEqual(selection);
    const read = value(await host.call('material.read', { id: output.materialId, version: output.version })); expect(read.text).toContain('# Brief');
    const current = value(await host.call('material.read', { id: output.materialId })); expect(current.entry.current).toBe(2); expect(current.text).toContain('Human retained');
    // Ordinary composing on a selected thread must inherit its route; warning text is not a control.
    const beforeFollowup = chosenCalls().length;
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('What does the brief say now?');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(async () => value(await host.call('threads.get', { id: threadId })).turns.length).toBe(2);
    await expect.poll(async () => value(await host.call('threads.get', { id: threadId })).turns.at(-1)?.status).toBe('done');
    await expect.poll(() => chosenCalls().length).toBeGreaterThan(beforeFollowup);
    await expect(page.getByTestId('turn')).toHaveCount(2);
    await expect(page.getByTestId('work-block').last()).toContainText('Worked for');
    const continued = value(await host.call('threads.get', { id: threadId }));
    expect(continued.turns).toHaveLength(2);
    expect(configured.requests.length, 'ordinary follow-up must not reach the configured fallback').toBe(0);
    expect(continued.turns[1].selection?.task).toEqual(selection.task);
    expect(continued.turns[1].selection?.ran?.model).toBe('selected-small');
    await page.getByRole('button', { name: 'Branch from here', exact: true }).last().click();
    await expect.poll(async () => (await host.call('threads.list', {})).length).toBe(2);
    const forkId = (await host.call('threads.list', {})).find((t) => t.id !== threadId)!.id;
    await expect.poll(async () => (await host.call('viewer.get', {})).selectedThreadId).toBe(forkId);
    await page.goto('about:blank'); off(); hostPhase = 'closing'; host.close(); await hostClosed(home); hostPhase = 'closed'; host = createHost(options); hostGeneration++; hostPhase = 'open'; off = listen(); await page.goto(url);
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
    const forkTurns = value(await host.call('threads.get', { id: forkId })).turns.length;
    const beforeFork = chosenCalls().length;
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Describe the brief in this branch');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(async () => value(await host.call('threads.get', { id: forkId })).turns.length).toBe(forkTurns + 1);
    await expect.poll(async () => value(await host.call('threads.get', { id: forkId })).turns.at(-1)?.status).toBe('done');
    await expect.poll(() => chosenCalls().length).toBeGreaterThan(beforeFork);
    await expect(page.getByTestId('turn')).toHaveCount(forkTurns + 1);
    await expect(page.getByTestId('work-block').last()).toContainText('Worked for');
    const fork = value(await host.call('threads.get', { id: forkId }));
    expect(fork.turns.at(-1)?.selection?.task).toEqual(selection.task);
    expect(fork.turns.at(-1)?.selection?.ran?.model).toBe('selected-small');
    const retainedHuman = value(await host.call('material.read', { id: output.materialId, version: 2 }));
    expect(retainedHuman.text).toBe(current.text);

    expect(chosenCalls().map((r) => r.model)).toEqual(Array(chosenCalls().length).fill(chosen.model));
    expect(configured.requests.length).toBe(0); expect(errors).toEqual([]);
    writeFileSync(info.outputPath('selection-consumer.json'), JSON.stringify({
      attachedSources: thread.turns[0].user.attachments.map((a) => ({ name: a.name, version: a.version })),
      task: selection.task, selected: selection.pinned, initial: selection.ran,
      followup: continued.turns[1].selection?.ran, coldFork: fork.turns.at(-1)?.selection?.ran,
      modelCalls: { initial: beforeFollowup, afterFollowup: beforeFork, afterColdFork: chosenCalls().length },
      requestedModels: [...new Set(chosenCalls().map((r) => r.model))], configuredRequests: configured.requests.length,
      agentVersion: output.version, humanVersion: current.entry.current, retainedHumanVersion: retainedHuman.text === current.text,
    }, null, 2) + '\n');
  } finally {
    // Stop the renderer issuing reads before closing and deleting its owned home.
    await page.close(); off(); hostPhase = 'closing'; host.close(); await hostClosed(home); hostPhase = 'closed';
    await info.attach('host-call-observation', { body: JSON.stringify({ calls, errors }, null, 2), contentType: 'application/json' });
    await removeDataHome(home); await chosen.close(); await configured.close();
    if (old.endpoint === undefined) delete process.env.BACKBONE_MODEL_ENDPOINT; else process.env.BACKBONE_MODEL_ENDPOINT = old.endpoint;
    if (old.model === undefined) delete process.env.BACKBONE_MODEL_ID; else process.env.BACKBONE_MODEL_ID = old.model;
    if (old.harness === undefined) delete process.env.BACKBONE_HARNESS; else process.env.BACKBONE_HARNESS = old.harness;
  }
});

test('shared model settings save a separate route through the existing local controls', async ({ page }) => {
  const home = freshDataHome('app-shared-model');
  const shared = await startScriptedModel('shared-settings-model');
  const personal = await startScriptedModel('personal-settings-model');
  const prior = { endpoint: process.env.BACKBONE_MODEL_ENDPOINT, model: process.env.BACKBONE_MODEL_ID, engine: process.env.BACKBONE_HARNESS };
  process.env.BACKBONE_MODEL_ENDPOINT = personal.url; process.env.BACKBONE_MODEL_ID = personal.model; process.env.BACKBONE_HARNESS = 'harness-pi';
  const host = createHost({ home, harness: 'harness-pi', localModels: { ports: { ollama: Number(new URL(shared.url).port), lmstudio: 0, llamacpp: 0, vllm: 0 } } });
  const changes: unknown[] = [];
  try {
    await host.call('projects.create', { name: 'Shared model settings', kind: 'folder' });
    await page.exposeFunction('sharedSettingsCall', async (method: Method, args: unknown) => {
      if (method === 'settings.model.put') changes.push(args);
      return host.call(method, args as never);
    });
    await page.addInitScript(() => {
      const surface = window as any;
      surface.backbone = { platform: 'linux', setTheme() {}, call: (method: string, args: unknown) => surface.sharedSettingsCall(method, args), onEvent() { return () => {}; } };
    });
    await page.goto(url);
    await expect(page.locator('[data-ready=true]')).toBeVisible();
    await page.getByRole('button', { name: /^Model and effort:/ }).click();
    await page.getByRole('menuitem', { name: 'Model connections…' }).click();
    const section = page.getByTestId('shared-model-route');
    await expect(section).toContainText('Not configured');
    await section.getByText('Configure shared work', { exact: true }).click();
    const select = section.getByRole('button', { name: shared.model, exact: true });
    await select.click();
    await expect(select).toHaveAttribute('aria-pressed', 'true');
    await expect(section).toContainText(`Pi · Ollama · ${shared.model}`);
    await expect(page.getByTestId('model-active')).toContainText(personal.model);
    const settings = await host.call('settings.model.get', {});
    expect(settings.active?.model).toBe(personal.model);
    expect(settings.shared?.local).toEqual({ provider: 'ollama', baseUrl: shared.url, model: shared.model });
    expect(changes).toEqual([{ change: { route: 'shared', change: { route: 'local', provider: 'ollama', baseUrl: shared.url, model: shared.model } } }]);
  } finally {
    host.close(); await hostClosed(home); await removeDataHome(home); await shared.close(); await personal.close();
    for (const [key, old] of [['BACKBONE_MODEL_ENDPOINT', prior.endpoint], ['BACKBONE_MODEL_ID', prior.model], ['BACKBONE_HARNESS', prior.engine]] as const) { if (old === undefined) delete process.env[key]; else process.env[key] = old; }
  }
});
