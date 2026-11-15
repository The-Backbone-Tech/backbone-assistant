// These journeys run against either the development app or a freshly installed executable.
// A local scripted model records exactly what the app gives it; no account or provider is used.
import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MemoryView, Receipt, Skill, Thread } from '@backbone-next/platform';
import { removeDataHome } from '@backbone-next/platform/composition';
import { startScriptedModel, type Message } from '@backbone-next/platform/testing';
import { api, appDir, openMoreView } from './journey';

const words = (m: Message) => typeof m.content === 'string' ? m.content : (m.content ?? []).map(c => c.text ?? '').join('');

async function fixture(withProject = true) {
  const home = mkdtempSync(join(tmpdir(), 'memory-controls-app-'));
  const person = mkdtempSync(join(tmpdir(), 'memory-controls-person-'));
  const inputs: string[] = [];
  const model = await startScriptedModel('memory-controls', messages => {
    if (messages.some(m => words(m).includes('Consolidate this memory.'))) return { text: '{"changes":[]}' };
    inputs.push(words(messages.findLast(m => m.role === 'user')!));
    return { text: 'The task is finished. Check the evidence before reusing the procedure.' };
  });
  let app: ElectronApplication | undefined;
  const quit = async () => {
    if (!app) return;
    const current = app, proc = current.process();
    await Promise.all([current.waitForEvent('close', { timeout: 30_000 }), current.evaluate(({ app }) => { setImmediate(() => app.quit()); })]);
    await expect.poll(() => proc.exitCode).toBe(0);
    app = undefined;
  };
  const launch = async () => {
    const installed = process.env.BACKBONE_APP_EXECUTABLE;
    app = await _electron.launch({ ...(installed ? { executablePath: installed, args: [] } : { args: [appDir] }), env: { ...process.env,
      BACKBONE_HOME: home, BACKBONE_USER_HOME: person, BACKBONE_HARNESS: 'harness-pi', BACKBONE_MODEL_ENDPOINT: model.url, BACKBONE_MODEL_ID: model.model } });
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(!!installed);
    const page = await app.firstWindow();
    await expect(page.locator('[data-ready=true]')).toBeVisible({ timeout: 60_000 });
    return page;
  };
  const page = await launch();
  let projectId = '';
  if (withProject) {
    const created = await api<Receipt<{ id: string }>>(page, 'projects.create', { name: 'Memory controls', kind: 'folder' });
    expect(created.ok).toBe(true); if (!created.ok) throw new Error(created.detail);
    projectId = created.value.id;
    await page.reload();
    await page.getByRole('navigation').getByRole('button', { name: 'Memory controls', exact: true }).click();
  }
  return { page, projectId, inputs, requests: model.requests, launch, quit,
    close: async () => { try { await quit(); } finally { await model.close(); await removeDataHome(home); rmSync(person, { recursive: true, force: true }); } } };
}

async function chat(page: Page, text: string) {
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(text);
  await page.getByRole('textbox', { name: 'Message', exact: true }).press('Enter');
  let completedTurn: string | undefined;
  await expect.poll(async () => {
    const summaries = await api<{ id: string }[]>(page, 'threads.list', {});
    const threads = await Promise.all(summaries.map(s => api<Receipt<Thread>>(page, 'threads.get', { id: s.id })));
    for (const thread of threads) if (thread.ok) {
      const turn = thread.value.turns.find(turn => turn.user.text === text && turn.status === 'done');
      if (turn) { completedTurn = turn.id; return true; }
    }
    return false;
  }, { timeout: 60_000 }).toBe(true);
  // A backend finish can precede the send receipt. Continue only once the person
  // sees this turn and its composer has acknowledged the handoff.
  await expect(page.locator(`#turn-${completedTurn}`)).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('');
}
async function memory(page: Page) { await openMoreView(page, 'Memory'); return page.getByTestId('memory'); }
async function view(page: Page) { return api<MemoryView>(page, 'memory.get', {}); }
async function drafted(f: Awaited<ReturnType<typeof fixture>>) {
  await chat(f.page, 'Prepare the weekly report');
  const threads = await api<{ id: string }[]>(f.page, 'threads.list', {});
  const threadId = threads[0].id;
  await f.page.getByRole('button', { name: 'Chat details', exact: true }).click();
  await f.page.getByRole('menuitem', { name: 'Make a skill from this chat' }).click();
  const pane = await memory(f.page);
  const row = pane.getByTestId('skill').filter({ hasText: 'prepare-the-weekly-report' });
  await expect(row).toHaveAttribute('data-state', 'proposed');
  const t = await api<Receipt<Thread>>(f.page, 'threads.get', { id: threadId });
  expect(t.ok).toBe(true); if (!t.ok) throw new Error(t.detail);
  return { pane, row, threadId, turnId: t.value.turns.at(-1)!.id };
}

test('a person edits and forgets a remembered fact and the next turn uses the current memory', async () => {
  const f = await fixture();
  try {
    await chat(f.page, 'Remember that the launch is Friday.');
    await expect(f.page.getByTestId('turn-memory')).toContainText('Remembered');
    const pane = await memory(f.page), entry = pane.getByTestId('memory-entry');
    await expect(entry).toHaveCount(1);
    await expect(entry).toContainText('launch is Friday');
    await expect(entry).toContainText('From a chat');
    await entry.getByRole('button', { name: 'Edit', exact: true }).click();
    await entry.getByRole('textbox', { name: 'Memory text' }).fill('The launch is Monday.');
    await entry.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(pane.getByTestId('memory-entry')).toContainText('The launch is Monday.');
    await pane.getByRole('button', { name: 'open chat' }).click();
    await chat(f.page, 'What is the launch day?');
    expect(f.inputs.at(-1)).toContain('The launch is Monday.');
    expect(f.inputs.at(-1)).not.toContain('The launch is Friday.');
    const again = await memory(f.page);
    await again.getByTestId('memory-entry').getByRole('button', { name: 'Forget', exact: true }).click();
    await expect(again.getByTestId('memory-entry')).toHaveCount(0);
    const threads = await api<{ id: string }[]>(f.page, 'threads.list', {});
    await f.page.getByRole('navigation').getByText('Remember that the launch is Friday.').first().click();
    await chat(f.page, 'Check the launch day once more.');
    expect(f.inputs.at(-1)).not.toContain('The launch is Monday.');
    const t = await api<Receipt<Thread>>(f.page, 'threads.get', { id: threads[0].id });
    expect(t.ok && t.value.turns.at(-1)!.memory?.used).toEqual([]);
    await f.quit(); const page = await f.launch();
    expect((await view(page)).entries).toHaveLength(0);
  } finally { await f.close(); }
});

test('memory off for one task survives restart and neither reads nor writes memory', async () => {
  const f = await fixture();
  try {
    await api(f.page, 'memory.put', { topic: 'launch', text: 'The private launch marker is cobalt.' });
    await api(f.page, 'memory.instructions.put', { scope: 'person', text: 'Include the private instruction marker vermilion.' });
    await f.page.getByRole('button', { name: 'Use memory for this task' }).click();
    await expect(f.page.getByRole('button', { name: 'Use memory for this task' })).toHaveAttribute('aria-pressed', 'false');
    await f.page.reload();
    await expect(f.page.getByRole('button', { name: 'Use memory for this task' })).toHaveAttribute('aria-pressed', 'false');
    await chat(f.page, 'Remember that my launch marker is saffron.');
    await expect(f.page.getByTestId('turn-memory-off')).toBeVisible();
    const request = JSON.parse(f.requests.at(-1)!.body);
    expect(JSON.stringify(request.messages)).not.toMatch(/cobalt|vermilion/);
    expect(JSON.stringify(request.tools)).not.toMatch(/memory_search|propose_memory/);
    expect((await view(f.page)).entries.map(e => e.text)).toEqual(['The private launch marker is cobalt.']);
    await f.quit(); const page = await f.launch();
    await expect(page.getByTestId('task-memory-off')).toBeVisible();
    await chat(page, 'Remember that my launch marker is ochre.');
    expect((await view(page)).entries).toHaveLength(1);
    expect(JSON.stringify(JSON.parse(f.requests.at(-1)!.body).messages)).not.toMatch(/cobalt|vermilion/);
    await page.getByRole('navigation').getByRole('button', { name: 'New chat', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Use memory for this task' })).toHaveAttribute('aria-pressed', 'true');
    await chat(page, 'What is my launch marker?');
    expect(f.inputs.at(-1)).toContain('cobalt');
    expect((await view(page)).entries).toHaveLength(1);
  } finally { await f.close(); }
});

test('a person reviews a drafted skill with its source turn, edits before accepting and rejects another draft', async () => {
  const f = await fixture();
  try {
    const { row, turnId } = await drafted(f);
    await expect(row.getByTestId('skill-body')).toContainText('Observed in one run');
    await expect(row.getByTestId('skill-source')).toContainText(turnId);
    await row.getByRole('button', { name: 'Open source chat', exact: false }).click();
    await expect(f.page.getByTestId('work-block')).toBeVisible();
    await chat(f.page, 'Prepare another weekly report');
    expect(f.inputs.at(-1)).not.toContain('## Skill:');
    await memory(f.page);
    await row.getByRole('button', { name: 'Edit skill', exact: true }).click();
    const editor = row.getByRole('textbox', { name: 'Skill text' });
    await editor.fill((await editor.inputValue()) + '\nAlways check totals against the source.\n');
    await row.getByRole('button', { name: 'Save skill', exact: true }).click();
    await expect(row).toHaveAttribute('data-state', 'proposed');
    await expect(row.getByTestId('skill-body')).toContainText('check totals');
    await row.getByRole('button', { name: 'Accept', exact: true }).click();
    await expect(row).toHaveAttribute('data-state', 'active');
    await f.quit(); const page = await f.launch();
    const saved = (await view(page)).skills.find(s => s.state === 'active')!;
    expect(saved.body).toContain('check totals'); expect(saved.sourceTurns?.[0].turnId).toBe(turnId);
    await page.getByRole('navigation').getByRole('button', { name: 'New chat', exact: true }).click();
    await chat(page, 'Prepare the weekly report again');
    expect(f.inputs.at(-1)).toContain('Always check totals against the source.');
    const threads = await api<{ id: string }[]>(page, 'threads.list', {});
    const draft = await api<Receipt<Skill>>(page, 'skills.draft', { threadId: threads[0].id });
    expect(draft.ok).toBe(true); if (!draft.ok) throw new Error(draft.detail);
    const p = await memory(page), rejected = p.getByTestId('skill').filter({ hasText: draft.value.name });
    await rejected.getByRole('button', { name: 'Decline', exact: true }).click();
    await expect(p.getByTestId('skill').filter({ hasText: draft.value.name })).toHaveCount(0);
    expect((await view(page)).skills.filter(s => s.state === 'active')).toHaveLength(1);
  } finally { await f.close(); }
});

test('a person undoes an accepted skill edit and a removal after restarting the app', async () => {
  const f = await fixture();
  try {
    const { row } = await drafted(f);
    await row.getByRole('button', { name: 'Accept', exact: true }).click();
    await expect(row).toHaveAttribute('data-state', 'active');
    const original = (await view(f.page)).skills.find(s => s.state === 'active')!;
    await row.getByRole('button', { name: 'Edit skill', exact: true }).click();
    const editor = row.getByRole('textbox', { name: 'Skill text' });
    await editor.fill((await editor.inputValue()) + '\nDouble-check dates.\n');
    await row.getByRole('button', { name: 'Save skill', exact: true }).click();
    await expect(f.page.getByTestId('skill-change')).toHaveCount(1);
    await f.quit(); const page = await f.launch(), pane = await memory(page);
    await pane.getByTestId('skill-change').getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(async () => (await view(page)).skills.find(s => s.state === 'active')?.body).toBe(original.body);
    await pane.getByTestId('skill').filter({ hasText: original.name }).getByRole('button', { name: 'Remove skill', exact: true }).click();
    await expect(pane.getByTestId('skill').filter({ hasText: original.name })).toHaveAttribute('data-state', 'archived');
    await expect(pane.getByTestId('skill-change')).toHaveCount(1);
    await pane.getByTestId('skill-change').getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(pane.getByTestId('skill').filter({ hasText: original.name })).toHaveAttribute('data-state', 'active');
    expect((await view(page)).skills.find(s => s.state === 'active')?.body).toBe(original.body);
    expect((await view(page)).skillChanges).toHaveLength(0);
  } finally { await f.close(); }
});


test('memory off follows a draft into its first project and through saved-draft recovery', async () => {
  const f = await fixture(false);
  try {
    await api(f.page, 'memory.put', { topic: 'reports', text: 'The private report marker is cobalt.' });
    await f.page.getByRole('button', { name: 'Use memory for this task' }).click();
    const input = f.page.getByRole('textbox', { name: 'Message', exact: true });
    await input.fill('Remember that my report marker is saffron.');
    await expect.poll(async () => (await api<{ meta?: { memory?: string } }>(f.page, 'drafts.get', { key: 'composer:home:none' }))?.meta?.memory).toBe('off');
    await f.page.getByRole('button', { name: 'New project', exact: true }).click();
    await f.page.getByRole('textbox', { name: 'Name', exact: true }).fill('Draft controls');
    await f.page.getByRole('button', { name: 'Create project', exact: true }).click();
    await expect(input).toHaveValue('Remember that my report marker is saffron.');
    await expect(f.page.getByRole('button', { name: 'Use memory for this task' })).toHaveAttribute('aria-pressed', 'false');
    await f.page.reload();
    await expect(f.page.getByRole('button', { name: 'Use memory for this task' })).toHaveAttribute('aria-pressed', 'false');
    await chat(f.page, 'Remember that my report marker is saffron.');
    expect(f.inputs.at(-1)).not.toContain('cobalt');
    expect((await view(f.page)).entries).toHaveLength(1);

    const projects = await api<{ id: string }[]>(f.page, 'projects.list', {});
    const key = `composer:home:${projects[0].id}`;
    await test.info().attach('acknowledged-first-project-drafts', {
      body: JSON.stringify({ unassigned: await api(f.page, 'drafts.get', { key: 'composer:home:none' }), project: await api(f.page, 'drafts.get', { key }) }),
      contentType: 'application/json',
    });
    await f.page.getByRole('navigation').getByRole('button', { name: 'New chat', exact: true }).click();
    await expect(f.page.getByRole('button', { name: 'Use memory for this task' })).toHaveAttribute('aria-pressed', 'true');
    // The page clears the sent message's saved draft a moment after the message box empties. Another client's write is
    // made on the revision after that clear; made on the one before, it is rightly refused as stale.
    await expect.poll(async () => (await api<{ text: string } | null>(f.page, 'drafts.get', { key }))?.text ?? '').toBe('');
    const prior = await api<{ revision: number } | null>(f.page, 'drafts.get', { key });
    const external = await api<Receipt<unknown>>(f.page, 'drafts.put', { key, text: 'Remember that my report marker is ochre.', meta: { memory: 'off' }, baseRevision: prior?.revision ?? 0, clientKey: 'off-saved-draft' });
    expect(external.ok, JSON.stringify({ external, prior, now: await api(f.page, 'drafts.get', { key }) })).toBe(true);
    await input.fill('My local report request');
    await f.page.getByRole('button', { name: 'Review saved draft', exact: true }).click();
    await f.page.getByRole('button', { name: 'Use saved draft', exact: true }).click();
    await f.page.getByRole('button', { name: 'Replace my local draft', exact: true }).click();
    await expect(input).toHaveValue('Remember that my report marker is ochre.');
    await expect(f.page.getByRole('button', { name: 'Use memory for this task' })).toHaveAttribute('aria-pressed', 'false');
    await chat(f.page, 'Remember that my report marker is ochre.');
    expect(f.inputs.at(-1)).not.toContain('cobalt');
    expect((await view(f.page)).entries).toHaveLength(1);
  } finally { await f.close(); }
});
