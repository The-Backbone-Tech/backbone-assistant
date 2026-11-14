import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { createServer } from 'vite';
import { waitFor } from '../../../../scripts/lib/test-hang.ts';

// Packaging writes these configs while other app journeys keep their renderer open.
// Observe Vite's reload messages, rather than asserting a particular ignore-pattern spelling.
test('packaged module configuration changes cannot reload an open dev renderer', async t => {
  const app = fileURLToPath(new URL('..', import.meta.url));
  // Each server owns its watched source tree: another test's positive control is not our reload.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'app-build-watcher-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pieces = join(root, 'dist', 'pieces');
  await mkdir(pieces, { recursive: true });
  const own = await mkdtemp(join(pieces, 'selection-watcher-'));
  const source = join(root, 'src');
  await mkdir(source);
  await writeFile(join(source, 'main.ts'), 'export const fixture = true;');
  const control = join(source, 'tsconfig.json');
  await writeFile(control, '{"compilerOptions":{"target":"ES2022"}}');
  const config = join(own, 'tsconfig.json');
  await writeFile(config, '{"compilerOptions":{"target":"ES2022"}}');
  let ready = false;
  const server = await createServer({ root, configFile: join(app, 'vite.config.ts'), logLevel: 'silent', server: { host: '127.0.0.1', port: 0, watch: { usePolling: true, interval: 25 } }, plugins: [{ name: 'watcher-readiness', configureServer(server) { server.watcher.once('ready', () => { ready = true; }); } }] });
  let reloads = 0, lastReload = 0;
  let client: WebSocket | undefined;
  try {
    await server.listen();
    await waitFor(() => ready, 'dev watcher finishes its initial directory scan', { hangMs: 10_000 });
    const url = new URL(server.resolvedUrls!.local[0]);
    url.protocol = 'ws:'; url.searchParams.set('token', server.config.webSocketToken);
    client = new WebSocket(url, 'vite-hmr');
    client.addEventListener('message', event => { if (JSON.parse(String(event.data)).type === 'full-reload') { reloads++; lastReload = performance.now(); } });
    await waitFor(() => client?.readyState === WebSocket.OPEN, 'renderer hot-reload connection opens', { hangMs: 10_000 });
    // A real TS transform initializes the same configuration watcher as the renderer.
    await server.transformRequest('/src/main.ts');
    await waitFor(() => server.watcher.getWatched()[source]?.includes('tsconfig.json') ?? false, 'source configuration watcher starts', { hangMs: 10_000 });
    await writeFile(control, '{"compilerOptions":{"target":"ES2021"}}');
    await waitFor(() => reloads > 0, 'source config change still reloads the renderer', { hangMs: 10_000 });
    // This Vite version sends path '*' for tsconfig reloads. Drain late/duplicate control
    // messages before taking a baseline; resetting on the first message races their delivery.
    await waitFor(() => performance.now() - lastReload >= 1_000, 'source reload messages become quiet', { hangMs: 10_000 });
    const baseline = reloads;
    await writeFile(config, '{"compilerOptions":{"target":"ES2021"}}');
    await new Promise(resolve => setTimeout(resolve, 750));
    assert.equal(reloads - baseline, 0, 'building a packaged module must not discard the active dialog or draft DOM');
  } finally { client?.close(); await server.close(); }
});
