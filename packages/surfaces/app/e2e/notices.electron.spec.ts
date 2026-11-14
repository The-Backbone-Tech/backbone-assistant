import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeDataHome } from '@backbone-next/platform/composition';
import { appDir } from './journey';

test('read every bundled notice from Settings in the installed product', async () => {
  const root = mkdtempSync(join(tmpdir(), 'app-notices-'));
  const installed = process.env.BACKBONE_APP_EXECUTABLE;
  const env = { ...process.env, BACKBONE_HOME: join(root, 'data'), BACKBONE_USER_HOME: join(root, 'person'), BACKBONE_HARNESS: 'harness-stub' };
  const app = await electron.launch(installed ? { executablePath: installed, args: [], env } : { args: [appDir], env });
  try {
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(!!installed);
    const page = await app.firstWindow();
    await expect(page.locator('[data-ready=true]')).toBeVisible();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    await settings.getByRole('button', { name: 'Licences and notices', exact: true }).click();
    await settings.getByRole('searchbox', { name: 'Search bundled pieces' }).fill('react-dom');
    await settings.getByRole('button', { name: /^react-dom / }).click();
    await expect(settings.getByTestId('notice-text')).toContainText('Permission is hereby granted');
    await settings.getByRole('button', { name: 'All bundled pieces', exact: true }).click();
    const network: string[] = [];
    await page.route(/^https?:/, route => { network.push(route.request().url()); return route.abort(); });
    await settings.getByRole('searchbox', { name: 'Search bundled pieces' }).fill('Chromium');
    await settings.getByRole('button', { name: /^Chromium and Electron third parties / }).click();
    const chromium = settings.frameLocator('iframe');
    await expect(chromium.locator('body')).toContainText('Chromium');
    expect(await chromium.locator('a[href^=http],script,link,img,iframe,form').count()).toBe(0);
    expect(network).toEqual([]);
    // Read and verify every entry through the same IPC bridge, not a source list.
    const entries = await page.evaluate(async () => {
      const entries = await window.backbone!.listNotices!();
      for (const entry of entries) { const notice = await window.backbone!.readNotice!(entry.id); if (!notice.text.trim()) throw new Error(`Empty notice ${entry.id}`); }
      return entries;
    });
    expect(entries.find(entry => entry.name === 'Electron')?.version).toBe(await app.evaluate(() => process.versions.electron));
    for (const name of ['supports-color', 'mlly', 'get-tsconfig', 'resolve-pkg-maps', 'Electron', '@earendil-works/pi-coding-agent', '@backbone-next/harness-codex', '@backbone-next/mcp']) expect(entries.some(e => e.name === name)).toBe(true);
    const coverage = await app.evaluate(({ app }) => {
      // The main-process evaluation context is ESM; use Node's builtin lookup in either mode.
      const fs = process.getBuiltinModule('node:fs');
      const path = process.getBuiltinModule('node:path');
      const crypto = process.getBuiltinModule('node:crypto');
      const output = path.join(app.getAppPath(), 'dist');
      const index = JSON.parse(fs.readFileSync(path.join(output, 'notices/index.json'), 'utf8'));
      const entries = new Map(index.entries.map((entry: { id: string }) => [entry.id, entry]));
      const artifacts = new Map(index.artifacts.map((entry: { path: string }) => [entry.path, entry]));
      const problems: string[] = [];
      const visit = (directory: string, prefix: string) => {
        for (const child of fs.readdirSync(directory, { withFileTypes: true })) {
          const file = path.join(directory, child.name), local = `${prefix}/${child.name}`;
          if (child.isDirectory()) { visit(file, local); continue; }
          const record = artifacts.get(local) as { sha256: string; packages: string[] } | undefined;
          if (!record || !record.packages.length || record.packages.some(id => !entries.has(id))) { problems.push(local); continue; }
          if (crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== record.sha256) problems.push(`Changed ${local}`);
          if (child.name === 'package.json' && local.includes('/node_modules/')) {
            const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (!entries.has(`${pkg.name}@${pkg.version}`)) problems.push(`Missing package ${pkg.name}@${pkg.version}`);
          }
        }
      };
      for (const name of ['electron', 'renderer', 'pieces', 'node_modules']) visit(path.join(output, name), name);
      const resources = app.isPackaged ? process.resourcesPath : output;
      for (const name of ['postgres', 'bin']) visit(path.join(resources, name), name);
      return problems;
    });
    expect(coverage).toEqual([]);
  } finally { await app.close(); await removeDataHome(env.BACKBONE_HOME); rmSync(root, { recursive: true, force: true }); }
});
