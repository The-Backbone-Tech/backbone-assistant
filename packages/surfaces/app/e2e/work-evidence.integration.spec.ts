// Actual renderer/HTTP/SSE/Host/material/core, synthetic owned data and a loopback controlled model.
import { expect, test } from '@playwright/test';
import type { MaterialEntry, Receipt, Thread, ThreadSummary } from '@backbone-next/platform';
import { removeDataHome } from '@backbone-next/platform/composition';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { startScriptedModel, type ScriptedModel } from '@backbone-next/platform/testing';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startBridge, stopBridge } from './bridge';
import { api, repoRoot } from './journey';

let model: ScriptedModel;
const oldEnv = new Map<string, string | undefined>();
test.beforeAll(async () => {
  model = await startScriptedModel();
  for (const [key, value] of Object.entries({ BACKBONE_MODEL_ENDPOINT: model.url, BACKBONE_MODEL_ID: model.model, BACKBONE_HARNESS: 'harness-pi' })) {
    oldEnv.set(key, process.env[key]); process.env[key] = value;
  }
});
test.afterAll(async () => {
  for (const [key, value] of oldEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await model?.close();
});
const value = <T,>(r: Receipt<T>): T => { if (!r.ok) throw new Error(`${r.reason}: ${r.detail}`); return r.value; };

for (const harness of ['harness-pi', 'harness-stub']) {
  test(`${harness}: real recorded versions and access history survive Save and cold reopen`, async ({ page }) => {
    page.setDefaultTimeout(15_000);
    const home = freshDataHome('work-evidence-integration');
    // This file runs sequentially; the child takes a private copy of the selected route's environment.
    process.env.BACKBONE_HARNESS = harness;
    let bridge: Awaited<ReturnType<typeof startBridge>> | undefined;
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const dir = join(repoRoot, 'evidence', 'work-evidence-integration', harness);
    mkdirSync(dir, { recursive: true });
    try {
      bridge = await startBridge(home);
      await page.goto(bridge.url);
      await expect(page.locator('[data-ready=true]')).toBeVisible();
      await page.getByRole('button', { name: 'New project' }).click();
      await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Recorded evidence');
      await page.getByRole('button', { name: 'Create project', exact: true }).click();
      const chooser = page.waitForEvent('filechooser');
      await page.getByRole('button', { name: 'Add', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Add files…' }).click();
      await (await chooser).setFiles([{ name: 'note.md', mimeType: 'text/markdown', buffer: Buffer.from('# Source\nOwner review is due Friday.\n') }]);
      await page.getByRole('button', { name: /^Permissions:/ }).click();
      await page.getByRole('menuitemradio', { name: /Auto-review/ }).click();
      await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Write an editable brief from the attached note');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(page.getByTestId('work-block')).toHaveText(/Worked for/);
      const threads = await api<ThreadSummary[]>(page, 'threads.list', {});
      expect(threads).toHaveLength(1);
      const threadId = threads[0].id;
      const projectId = threads[0].projectId;
      const initial = value(await api<Receipt<Thread>>(page, 'threads.get', { id: threadId }));
      const turn = initial.turns.at(-1)!;
      expect(turn.status).toBe('done');
      const entries = await api<MaterialEntry[]>(page, 'material.list', { projectId });
      const source = entries.find((e) => e.name === 'note.md')!;
      const output = entries.find((e) => e.name === 'brief.md')!;
      expect(source.class).toBe('original');
      expect(output.current).toBe(1);
      expect(turn.effects.some((e) => e.outcome === 'DONE')).toBe(true);
      await page.getByTestId('work-block').click();
      const evidence = page.getByTestId('work-evidence');
      // Every harness binds a read when it happens (the stand-ins since 9e10505), so the record is complete on both.
      expect(turn.reads?.some((r) => r.id === source.id && r.version === 1)).toBe(true);
      await expect(evidence).not.toContainText('source record is incomplete');
      const mine = '# PERSON_VERSION_2\nThis wording belongs to the person.\n';
      const saved = value(await api<Receipt<MaterialEntry>>(page, 'material.save', { id: output.id, text: mine, baseVersion: 1 }));
      expect(saved.current).toBe(2);
      expect(saved.versions.at(-1)?.by).toBe('person');
      // There is no interception: the real Host's SSE event refreshes the still-open view.
      await expect(evidence).toContainText('Recorded v1; current is v2.');
      await evidence.getByRole('button', { name: /^brief\.md\s*v1$/ }).click();
      await expect(page.getByTestId('reader')).not.toContainText('PERSON_VERSION_2');
      await expect(page.getByTestId('reader')).toContainText('Edit this document');
      const current = value(await api<Receipt<{ entry: MaterialEntry; text: string }>>(page, 'material.read', { id: output.id }));
      expect(current.text).toBe(mine);
      expect(current.entry.current).toBe(2);
      const withdrawn = value(await api<Receipt<MaterialEntry>>(page, 'material.lifecycle', { id: source.id, version: 1, lifecycle: 0, state: 'withdrawn' }));
      await expect(evidence).toContainText('Withdrawn from later work.');
      await expect(evidence.getByRole('button', { name: /note\.md\s*v1/ })).toHaveCount(0);
      value(await api<Receipt<MaterialEntry>>(page, 'material.lifecycle', { id: source.id, version: 1, lifecycle: withdrawn.lifecycle, state: 'current' }));
      await expect(evidence).toContainText('Access changed since this turn, even if restored.');
      await page.screenshot({ path: join(dir, 'before-reopen.png') });
      await expect.poll(async () => (await api<{ selectedThreadId?: string }>(page, 'viewer.get', {})).selectedThreadId).toBe(threadId);
      await page.goto('about:blank');
      await stopBridge(bridge.proc);
      bridge = await startBridge(home);
      await page.goto(bridge.url);
      await expect(page.getByTestId('work-block')).toHaveText(/Worked for/);
      await page.getByTestId('work-block').click();
      await expect(evidence).toContainText('Recorded v1; current is v2.');
      await expect(evidence).toContainText('Access changed since this turn, even if restored.');
      const reopened = value(await api<Receipt<Thread>>(page, 'threads.get', { id: threadId }));
      expect(reopened.turns[0].reads).toEqual(turn.reads);
      const retained = value(await api<Receipt<{ entry: MaterialEntry; text: string }>>(page, 'material.read', { id: output.id }));
      expect(retained.text).toBe(mine);
      await page.screenshot({ path: join(dir, 'after-reopen.png') });
      expect(errors).toEqual([]);
      writeFileSync(join(dir, 'observation.json'), JSON.stringify({ harness, turnId: turn.id, recordedReads: turn.reads, outputRecordedVersion: 1, outputCurrentVersion: retained.entry.current, sourceWithdrawalHistory: (await api<MaterialEntry[]>(page, 'material.list', { projectId })).find((e) => e.id === source.id)?.withdrawals, sourceBindingsSurviveReopen: true, pageErrors: errors, transport: 'actual HTTP + SSE', model: harness === 'harness-pi' ? 'controlled loopback, not live AI' : 'no model' }, null, 2));
    } finally {
      await page.goto('about:blank').catch(() => {});
      if (bridge && bridge.proc.exitCode === null && bridge.proc.signalCode === null) await stopBridge(bridge.proc);
      await removeDataHome(home);
    }
  });
}
