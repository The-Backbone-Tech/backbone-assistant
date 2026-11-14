import { observeChild } from '../../../../scripts/lib/test-child.ts';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { removeDataHome } from '@backbone-next/platform/composition';

test('ordinary drafts refuse a late body and preserve a revisioned tombstone', async () => {
  const home = freshDataHome('late-project-draft');
  const bridge = fileURLToPath(new URL('../server/bridge.ts', import.meta.url));
  const env: NodeJS.ProcessEnv = { BACKBONE_HOME: home, BACKBONE_USER_HOME: home, BACKBONE_KEYS: 'plaintext', BACKBONE_HARNESS: 'harness-stub', PORT: '0' };
  // Preserve the runner's explicit Linux evaluation admission in this otherwise isolated child.
  for (const key of ['PATH', 'TMPDIR', 'BACKBONE_TEST_PG', 'BACKBONE_EXPERIMENTAL_LINUX_HOME_LOCK']) if (process.env[key]) env[key] = process.env[key];
  const child = spawn(process.execPath, [bridge], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = observeChild(child, 'draft bridge');
  try {
    await output.waitForOutput(/127\.0\.0\.1:(\d+)/);
    const port = Number(output.stdout.match(/127\.0\.0\.1:(\d+)/)![1]);
    const url = `http://127.0.0.1:${port}/api`;
    const api = async (method: string, args: unknown) => {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, args }) });
      assert.equal(response.ok, true);
      return response.json() as Promise<any>;
    };
    // Leave the first POST's JSON body incomplete so the real bridge cannot dispatch it yet.
    const body = JSON.stringify({ method: 'drafts.put', args: { key: 'composer:synthetic', text: 'old attempt', clientKey: 'old', baseRevision: 0 } });
    const old = request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } });
    const oldResponse = new Promise<any>((resolve, reject) => { old.once('response', (response) => { let data = ''; response.on('data', chunk => data += chunk); response.once('end', () => resolve(JSON.parse(data))); }); old.once('error', reject); });
    old.write(body.slice(0, 12));
    const later = await api('drafts.put', { key: 'composer:synthetic', text: 'newer marker', clientKey: 'new', baseRevision: 0 });
    assert.equal(later.ok, true);
    assert.equal((await api('drafts.get', { key: 'composer:synthetic' })).text, 'newer marker');
    const clear = await api('drafts.put', { key: 'composer:synthetic', text: '', clientKey: 'clear', baseRevision: 1 });
    assert.equal(clear.ok, true);
    assert.equal((await api('drafts.get', { key: 'composer:synthetic' })).revision, 2);
    old.end(body.slice(12));
    const stale = await oldResponse;
    assert.equal(stale.ok, false);
    assert.equal(stale.reason, 'STALE_BASE');
    const final = await api('drafts.get', { key: 'composer:synthetic' });
    assert.equal(final.text, '');
    assert.equal(final.revision, 2);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    }
    await removeDataHome(home);
  }
});
