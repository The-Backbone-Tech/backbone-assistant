import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHost, hostClosed, removeDataHome } from '@backbone-next/platform/composition';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { CoreLink } from '../../../platform/src/composition/core.ts';
import { PIECE_DIRS } from '../../../platform/src/composition/pieces.ts';
import { pieceDigest, pieceFiles } from '../../../platform/src/pieces/digest.ts';
import { appDir } from './journey';

async function snapshot(home: string) {
  const link = await CoreLink.open({ home });
  try {
    const pieces = await link.read(link.person(), 'SELECT * FROM app.pieces ORDER BY id');
    const mandates = await link.read(link.person(), 'SELECT * FROM app.mandates ORDER BY id');
    return JSON.stringify([pieces.rows, mandates.rows]);
  } finally { await link.release(); }
}

test('quit withdraws an update question and asks again without changing registrations or permissions', async () => {
  test.setTimeout(120_000);
  const home = freshDataHome('quit-upgrade');
  const old = mkdtempSync(join(tmpdir(), 'backbone-old-piece-'));
  let app: ElectronApplication | undefined;
  try {
    const source = PIECE_DIRS['harness-pi'];
    for (const file of pieceFiles(source)) { mkdirSync(dirname(join(old, file)), { recursive: true }); cpSync(join(source, file), join(old, file)); }
    symlinkSync(realpathSync(join(source, 'node_modules')), join(old, 'node_modules'));
    const manifestPath = join(old, 'backbone.module.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.version = '0.0.1';
    writeFileSync(manifestPath, JSON.stringify(manifest));
    manifest.digest = pieceDigest(old);
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const host = createHost({ home, harness: 'harness-pi', pieceDirs: { 'harness-pi': old } });
    await host.call('projects.list', {}); host.close(); await hostClosed(home);
    const before = await snapshot(home);
    for (let attempt = 0; attempt < 2; attempt++) {
      app = await electron.launch({ args: [appDir], env: { ...process.env, BACKBONE_HOME: home, BACKBONE_KEYS: 'plaintext', BACKBONE_HARNESS: 'harness-pi' } as Record<string, string> });
      await expect.poll(() => app!.windows().some(window => window.url().startsWith('data:text/html')), { timeout: 30_000 }).toBe(true);
      const question = app.windows().find(window => window.url().startsWith('data:text/html'))!;
      await expect(question.getByText(/Allow its new engine/)).toBeVisible();
      const exited = new Promise<number | null>(resolve => app!.process().once('exit', resolve));
      await app.evaluate(({ app }) => { setTimeout(() => app.quit(), 0); });
      expect(await Promise.race([exited, new Promise(resolve => setTimeout(() => resolve('timeout'), 5_000))])).toBe(0);
      app = undefined;
      expect(await snapshot(home)).toBe(before);
    }
    app = await electron.launch({ args: [appDir], env: { ...process.env, BACKBONE_HOME: home, BACKBONE_KEYS: 'plaintext', BACKBONE_HARNESS: 'harness-pi' } as Record<string, string> });
    await expect.poll(() => app!.windows().some(window => window.url().startsWith('data:text/html')), { timeout: 30_000 }).toBe(true);
    const question = app.windows().find(window => window.url().startsWith('data:text/html'))!;
    await question.getByRole('link', { name: 'Allow', exact: true }).click();
    const main = await app.firstWindow();
    await expect(main.locator('[data-ready=true]')).toBeVisible({ timeout: 30_000 });
    const exited = new Promise<number | null>(resolve => app!.process().once('exit', resolve));
    await app.evaluate(({ app }) => { setTimeout(() => app.quit(), 0); });
    expect(await Promise.race([exited, new Promise(resolve => setTimeout(() => resolve('timeout'), 10_000))])).toBe(0);
    app = undefined;
    expect(await snapshot(home)).not.toBe(before);
  } finally { if (app) await app.close(); await removeDataHome(home); rmSync(old, { recursive: true, force: true }); }
});
