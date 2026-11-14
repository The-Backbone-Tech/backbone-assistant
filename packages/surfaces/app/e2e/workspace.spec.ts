// A complete UI journey through the real platform/Files owners with the existing controlled
// harness. Delayed draft transport discriminates retained editors from a remount that loses input.
import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { removeDataHome } from '@backbone-next/platform/composition';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { startBridge, stopBridge } from './bridge';
import { api, expectDocumentInfo, phase1Home, phase2ProjectAndAttach, phase3Brief, repoRoot } from './journey';

test('workspace retains an unacknowledged file edit across tools, readers and pane closure, then saves once', async ({ page }, info) => {
  page.setDefaultTimeout(15_000);
  const home = freshDataHome('reference-workspace');
  const bridge = await startBridge(home);
  const evidence = join(repoRoot, 'evidence', 'app-reference-20261027', 'header-implementation', 'browser', info.project.name);
  mkdirSync(evidence, { recursive: true });
  let releaseDraft = () => {};
  const heldDraft = new Promise<void>((resolve) => { releaseDraft = resolve; });
  let draftObserved = false;
  try {
    // A catalog may expose a non-contiguous effort set; the surface must not invent levels.
    await page.route('**/api', async (route) => {
      if (route.request().postDataJSON().method === 'models.list') await route.fulfill({ json: [{ id: 'stub', label: 'Controlled model', efforts: [2, 4] }] });
      else await route.continue();
    });
    await page.goto(bridge.url);
    await phase1Home(page);
    const message = page.getByRole('textbox', { name: 'Message', exact: true });
    await message.fill('Keep this draft while choosing effort.');
    // Medium is not on offer here; the composer moves to the nearest effort the model takes.
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: /^Model and effort:/ }).click();
    await expect(page.getByRole('menuitemradio')).toHaveText(['Low', 'High']);
    await page.getByRole('menuitemradio', { name: 'Low', exact: true }).click();
    await expect(message).toHaveValue('Keep this draft while choosing effort.');
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
    await message.fill('');
    await page.screenshot({ path: join(evidence, 'home.png') });
    const projectId = await phase2ProjectAndAttach(page);
    await phase3Brief(page);
    await page.screenshot({ path: join(evidence, 'conversation.png') });
    await page.keyboard.press('ControlOrMeta+p');
    await page.getByTestId('file-row').filter({ hasText: 'brief.md' }).click();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const editor = page.getByRole('textbox', { name: 'Edit brief.md' });
    await expect(editor).toBeVisible();
    // A second title/summary/toolbar would push content below the shared row.
    const conversationBar = await page.getByTestId('conversation-bar').boundingBox();
    const workspaceBar = await page.getByTestId('workspace-bar').boundingBox();
    const transcript = await page.getByRole('list', { name: 'Transcript' }).boundingBox();
    const editing = await editor.boundingBox();
    expect(Math.abs(conversationBar!.y - workspaceBar!.y)).toBeLessThan(2);
    expect(conversationBar!.height).toBeLessThanOrEqual(48);
    expect(workspaceBar!.height).toBeLessThanOrEqual(48);
    expect(transcript!.y - conversationBar!.y - conversationBar!.height).toBeLessThanOrEqual(32);
    expect(editing!.y - workspaceBar!.y - workspaceBar!.height).toBeLessThanOrEqual(16);
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Document options', exact: true })).toHaveCount(1);

    await page.screenshot({ path: join(evidence, 'workspace-before-probe.png') });
    const material = await api<{ id: string; name: string }[]>(page, 'material.list', { projectId });
    const brief = material.find((m) => m.name === 'brief.md')!;
    const acknowledged = '# Earlier acknowledged draft';
    await editor.fill(acknowledged);
    await expect.poll(async () => (await api<{ text?: string }>(page, 'drafts.get', { key: `edit:${brief.id}` }))?.text).toBe(acknowledged);
    const words = '# Harbor plan\n\nHuman wording: preserve this exact unacknowledged edit.\n';
    await page.route('**/api', async (route) => {
      const body = route.request().postDataJSON();
      if (body.method === 'drafts.put' && body.args.key === `edit:${brief.id}` && body.args.text === words) {
        draftObserved = true;
        await heldDraft;
      }
      await route.continue();
    });
    await editor.fill(words);
    await expect.poll(() => draftObserved, { message: 'newer draft transport is held' }).toBe(true);
    await api(page, 'drafts.put', { key: 'workspace-event-probe', text: 'unrelated update', clientKey: crypto.randomUUID() });
    await expect(editor).toContainText('Human wording: preserve this exact unacknowledged edit.');
    const paneTabs = page.getByRole('tablist', { name: 'Pane tabs' });
    await paneTabs.getByRole('tab', { name: 'Files', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Document options', exact: true })).toHaveCount(0);
    await page.getByTestId('file-row').filter({ hasText: 'note.md' }).click();
    await expect(page.getByTestId('reader').filter({ visible: true })).toBeVisible();
    await paneTabs.getByRole('tab', { name: 'brief.md', exact: true }).click();
    await expect(editor, 'a reader switch must not reconstruct stale saved text').toContainText('Human wording: preserve this exact unacknowledged edit.');
    await page.getByRole('button', { name: 'Hide side pane', exact: true }).click();
    await page.getByRole('button', { name: 'Show side pane', exact: true }).click();
    await expect(editor, 'closing a view must preserve the unacknowledged editor').toContainText('Human wording: preserve this exact unacknowledged edit.');
    releaseDraft();
    await page.unrouteAll({ behavior: 'wait' });
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expectDocumentInfo(page, 'v2 · saved by you');
    const saved = await api<{ ok: boolean; value: { entry: { current: number }; text: string } }>(page, 'material.read', { id: brief.id });
    expect(saved.ok).toBe(true);
    expect(saved.value.text).toBe(words);
    expect(saved.value.entry.current).toBe(2);
    const resize = page.getByRole('separator', { name: 'Resize conversation and workspace' });
    await expect(resize).toBeVisible();
    const before = await page.getByTestId('pane').boundingBox();
    await resize.focus();
    await expect(resize).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect.poll(async () => (await page.getByTestId('pane').boundingBox())!.width, { message: 'keyboard resizing changes the workspace width' }).not.toBe(before!.width);
    await expect(editor).toContainText('Human wording: preserve this exact unacknowledged edit.');
    await page.screenshot({ path: join(evidence, 'workspace-saved.png') });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
    await page.screenshot({ path: join(evidence, 'settings.png') });
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeFocused();
    await expect(editor).toContainText('Human wording: preserve this exact unacknowledged edit.');
    await page.keyboard.press('Control+`');
    await expect(page.getByRole('textbox', { name: 'Terminal command' })).toBeFocused();
    await page.getByRole('button', { name: 'Hide side pane', exact: true }).click();
    await page.getByRole('textbox', { name: 'Message', exact: true }).focus();
    await page.keyboard.press('Control+`');
    await expect(page.getByRole('textbox', { name: 'Terminal command' })).toBeFocused();
    await expect(page.getByRole('searchbox', { name: 'Filter files' })).toHaveCount(0);
    await paneTabs.getByRole('tab', { name: 'brief.md', exact: true }).click();
    const pending = '# Local edit based on v2';
    await editor.fill(pending);
    await expect.poll(async () => (await api<{ text?: string }>(page, 'drafts.get', { key: `edit:${brief.id}` }))?.text).toBe(pending);
    const external = '# Concurrent writer owns v3';
    const advanced = await api<{ ok: boolean }>(page, 'material.save', { id: brief.id, text: external, baseVersion: 2 });
    expect(advanced.ok).toBe(true);
    await paneTabs.getByRole('tab', { name: 'Files', exact: true }).click();
    await page.getByTestId('file-row').filter({ hasText: 'note.md' }).click();
    await paneTabs.getByRole('tab', { name: 'brief.md', exact: true }).click();
    await expect(editor).toContainText(pending);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText('brief.md is at v3; this edit started from v2.');
    const current = await api<{ ok: boolean; value: { entry: { current: number }; text: string } }>(page, 'material.read', { id: brief.id });
    expect(current.value.entry.current).toBe(3);
    expect(current.value.text).toBe(external);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
  } finally {
    releaseDraft();
    try {
      if (!page.isClosed()) await page.unrouteAll({ behavior: 'wait' });
    } finally {
      await stopBridge(bridge.proc);
      await removeDataHome(home);
    }
  }
});

test('source labels do not turn an original version label into authorship', async ({page}) => {
  const home=freshDataHome('file-original-label');const bridge=await startBridge(home);
  try {
    await page.goto(bridge.url);await expect(page.locator('[data-ready=true]')).toBeVisible();
    const project=await api<{ok:boolean;value:{id:string}}>(page,'projects.create',{name:'Sources',kind:'folder'});
    const material=await api<{ok:boolean;value:{id:string}}>(page,'material.attach',{projectId:project.value.id,name:'source.md',mediaType:'text/markdown',base64:Buffer.from('# Source').toString('base64')});
    const prefs=await api<Record<string,unknown>>(page,'viewer.get',{});
    await api(page,'viewer.put',{prefs:{...prefs,selectedProjectId:project.value.id,pane:{open:true,tabs:[{id:`file:${material.value.id}`,kind:'file',materialId:material.value.id}],active:`file:${material.value.id}`}}});
    let scenario:'person'|'agent'|'restored'|'document'='person';
    await page.route('**/api',async route=>{
      const req=route.request(), body=req.method()==='POST' ? req.postDataJSON() : null;
      if(body?.method==='material.read' && body.args.id===material.value.id){
        const response=await route.fetch(), data=await response.json();
        if(data.ok){data.value.entry.class=scenario==='document'?'accepted':'original';data.value.entry.projection='managed';data.value.entry.versions[0].by=scenario==='agent'?'agent':'person';if(scenario==='restored'){data.value.entry.versions.push({...data.value.entry.versions[0],n:2});data.value.entry.current=2;}}
        await route.fulfill({response,json:data});return;
      }
      await route.continue();
    });
    for (scenario of ['person','agent','restored','document'] as const) {
      await page.reload();await expect(page.getByRole('button',{name:'Document options',exact:true})).toBeVisible();
      await page.getByRole('button',{name:'Document options',exact:true}).click();
      const version=page.getByTestId('file-version');
      if(scenario==='document') await expect(version).toHaveText('v1 · saved by you');
      else {await expect(version).toHaveText(`${scenario==='restored'?'v2':'v1'} · original source`);await expect(version).not.toContainText('saved by you');}
      await page.keyboard.press('Escape');
    }
  } finally {await page.close();await stopBridge(bridge.proc);await removeDataHome(home);}
});
