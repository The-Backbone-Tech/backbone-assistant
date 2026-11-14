import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keychainKeys, Vault } from '@backbone-next/platform/keys';
import { resolveTelemetryHeaders } from '@backbone-next/platform/credentials/telemetry';
import { configureTelemetry, telemetryView } from '../electron/telemetry-settings.ts';

test('desktop settings seal collector headers with the app keys and never return them', async () => {
  const home = mkdtempSync(join(tmpdir(), 'backbone-telemetry-app-'));
  const marker = 'desktop-collector-secret-marker';
  const keys = keychainKeys({ isAsyncEncryptionAvailable: async () => true, encryptStringAsync: async text => Buffer.from(`test-wrap:${text}`), decryptStringAsync: async bytes => ({ result: bytes.toString().slice('test-wrap:'.length), shouldReEncrypt: false }) });
  try {
    const saved = await configureTelemetry(home, keys, { endpoint: 'https://collector.example/v1/traces', headers: JSON.stringify({ 'x-api-key': marker }) });
    assert.deepEqual(saved, { ok: true });
    assert.deepEqual(telemetryView(home), { endpoint: 'https://collector.example/v1/traces' });
    assert.equal((await resolveTelemetryHeaders(home, keys))['x-api-key'], marker);
    assert.ok(!readFileSync(join(home, 'settings.json'), 'utf8').includes(marker));
    await configureTelemetry(home, keys, { endpoint: 'https://collector.example/v1/traces' });
    assert.equal((await resolveTelemetryHeaders(home, keys))['x-api-key'], marker);
    const index = join(home, 'credentials', 'telemetry.json');
    const handles = Object.values(JSON.parse(readFileSync(index, 'utf8'))) as string[];
    Vault.forget(home);
    const unavailableKeys = { ...keys, wrapKey: async () => { throw new Error('No vault access during disable.'); }, unwrapKey: async () => { throw new Error('No vault access during disable.'); } };
    await configureTelemetry(home, unavailableKeys, { endpoint: '' });
    assert.deepEqual(telemetryView(home), { endpoint: '' });
    assert.equal(existsSync(index), false);
    for (const handle of handles) assert.equal(existsSync(join(home, 'credentials', `${handle}.json`)), false);
    assert.deepEqual(await resolveTelemetryHeaders(home, keys), {});
    await assert.rejects(configureTelemetry(home, keys, { endpoint: 'https://collector.example', headers: marker }), error => error instanceof Error && !error.message.includes(marker));
    assert.deepEqual(telemetryView(home), { endpoint: '' });
  } finally { Vault.forget(home); rmSync(home, { recursive: true, force: true }); }
});

test('the collector header control masks entered values', () => {
  const source = readFileSync(new URL('../src/components/settings/Telemetry.tsx', import.meta.url), 'utf8');
  assert.match(source, /<Input\s+aria-label="Collector headers \(JSON\)"\s+type="password"/);
  assert.doesNotMatch(source, /<textarea\s+aria-label="Collector headers \(JSON\)"/);
});
