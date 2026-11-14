import { spawnSyncHang, TEST_HANG_MS } from '../../../scripts/lib/test-hang.ts';
// Loader-level evidence: a fresh process observes every ESM resolution, without timing assertions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshHome } from './helpers.ts';

const composition = new URL('../src/composition/telemetry.ts', import.meta.url).href;
function offProcess(deny: boolean) {
  const home = freshHome();
  return spawnSyncHang(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    const resolved = [];
    registerHooks({ resolve(specifier, context, next) {
      resolved.push(specifier);
      if (${deny} && (specifier === '@backbone-next/telemetry-otel' || specifier.startsWith('@opentelemetry/'))) {
        const error = new Error('Optional telemetry package unavailable in this process');
        error.code = 'ERR_MODULE_NOT_FOUND'; throw error;
      }
      return next(specifier, context);
    }});
    const { startConfiguredTelemetry } = await import(${JSON.stringify(composition)});
    const result = await startConfiguredTelemetry({}, ${JSON.stringify(home)});
    assert.equal(result.status, 'off');
    await result.close();
    assert.ok(!resolved.some(name => name === '@backbone-next/telemetry-otel' || name.startsWith('@opentelemetry/')));
    console.log('off; no telemetry or SDK module in the resolution graph');
  `], { encoding: 'utf8', timeout: TEST_HANG_MS });
}

test('composition imports and stays off when a loader makes the optional module unresolvable', () => {
  const result = offProcess(true);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /off; no telemetry or SDK module/);
});

test('without an endpoint, a fresh process never resolves the telemetry package or OpenTelemetry SDK', () => {
  const result = offProcess(false);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /off; no telemetry or SDK module/);
});

test('configured telemetry reports fixed off, on and misconfigured reason classes', async () => {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { startConfiguredTelemetry, inspectTelemetryStatus } = await import('../src/composition/telemetry.ts');
  const { plaintextKeys } = await import('../src/keys/vault.ts');
  const { putTelemetryEndpoint, putTelemetryHeaders } = await import('../src/credentials/telemetry.ts');
  const home = freshHome(), marker = 'PRIVATE_CONFIGURATION_DETAIL';
  const host = { on: () => () => {} } as unknown as Parameters<typeof startConfiguredTelemetry>[0];
  assert.equal((await startConfiguredTelemetry(host, home)).status, 'off');
  writeFileSync(join(home, 'settings.json'), marker);
  assert.deepEqual(await inspectTelemetryStatus(home), { status: 'misconfigured', reason: 'settings' });
  const badSettings = await startConfiguredTelemetry(host, home);
  assert.equal(badSettings.status, 'misconfigured');
  assert.ok(!JSON.stringify(badSettings).includes(marker));
  await assert.doesNotReject(badSettings.close());
  writeFileSync(join(home, 'settings.json'), '{}');
  await putTelemetryEndpoint(home, 'http://127.0.0.1:4318/v1/traces');
  const on = await startConfiguredTelemetry(host, home);
  assert.equal(on.status, 'on'); await on.close();
  await putTelemetryHeaders(home, { authorization: marker }, plaintextKeys());
  writeFileSync(join(home, 'credentials', 'telemetry.json'), JSON.stringify({ authorization: `cred_00000000-0000-0000-0000-000000000000` }));
  assert.deepEqual(await inspectTelemetryStatus(home), { status: 'on', storedHeaders: 1 }); // Shape is valid; inspection never resolves the missing handle.
  const badHeaders = await startConfiguredTelemetry(host, home);
  assert.equal(badHeaders.status, 'misconfigured'); assert.ok(!JSON.stringify(badHeaders).includes(marker));
  await assert.doesNotReject(badHeaders.close());
  writeFileSync(join(home, 'credentials', 'telemetry.json'), '{}');
  const startup = await startConfiguredTelemetry({ on() { throw new Error(marker); } } as unknown as typeof host, home);
  assert.equal(startup.status, 'misconfigured'); assert.ok('reason' in startup && startup.reason === 'startup');
  await assert.doesNotReject(startup.close());
});

test('enabled configuration reports module unavailability without failing composition', () => {
  const home = freshHome();
  const result = spawnSyncHang(process.execPath, ['--input-type=module', '-e', `
    import { registerHooks } from 'node:module';
    import { writeFileSync } from 'node:fs';
    import assert from 'node:assert/strict';
    writeFileSync(${JSON.stringify(home + '/settings.json')}, JSON.stringify({telemetry:{endpoint:'http://127.0.0.1:4318/v1/traces'}}));
    registerHooks({resolve(specifier, context, next) {
      if(specifier === '@backbone-next/telemetry-otel') throw new Error('PRIVATE_MODULE_FAILURE');
      return next(specifier, context);
    }});
    const {startConfiguredTelemetry, inspectTelemetryStatus} = await import(${JSON.stringify(composition)});
    assert.deepEqual(await inspectTelemetryStatus(${JSON.stringify(home)}), {status:'misconfigured', reason:'module'});
    const result = await startConfiguredTelemetry({}, ${JSON.stringify(home)});
    assert.equal(result.status,'misconfigured'); assert.equal(result.reason,'module');
    assert.ok(!JSON.stringify(result).includes('PRIVATE_MODULE_FAILURE')); await result.close();
  `], { encoding: 'utf8', timeout: TEST_HANG_MS });
  assert.equal(result.status, 0, result.stderr);
});

test('inspection counts only valid header-index metadata and never opens the vault', async t => {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { Vault } = await import('../src/keys/vault.ts');
  const { inspectTelemetryStatus } = await import('../src/composition/telemetry.ts');
  const { putTelemetryEndpoint } = await import('../src/credentials/telemetry.ts');
  const home = freshHome(), marker = 'PRIVATE_INSPECTION_INDEX_DETAIL';
  const vault = t.mock.method(Vault, 'open', async () => { throw new Error(marker); });
  await putTelemetryEndpoint(home, 'https://collector.invalid/v1/traces');
  mkdirSync(join(home, 'credentials'), { recursive: true });
  const index = join(home, 'credentials', 'telemetry.json');
  const entries = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`x-header-${i}`, 'cred_00000000-0000-0000-0000-000000000000']));
  for (const count of [0, 2, 32]) {
    writeFileSync(index, JSON.stringify(entries(count)));
    assert.deepEqual(await inspectTelemetryStatus(home), { status: 'on', storedHeaders: count });
  }
  for (const malformed of [[], null, { authorization: marker }, { host: 'cred_00000000-0000-0000-0000-000000000000' }, entries(33)]) {
    writeFileSync(index, JSON.stringify(malformed));
    const result = await inspectTelemetryStatus(home);
    assert.deepEqual(result, { status: 'misconfigured', reason: 'credentials' });
    assert.ok(!JSON.stringify(result).includes(marker));
  }
  assert.equal(vault.mock.callCount(), 0);
});

test('subscriber schedule reads leave an unused home eligible for import', async () => {
  const { open } = await import('./helpers.ts');
  const { BackupRefused } = await import('../src/composition/backup.ts');
  const { join } = await import('node:path');
  const { home, host } = open();
  const view = await host.call('schedules.get', {});
  assert.ok(Array.isArray(view.runs));
  await assert.rejects(host.importExport(join(home, 'missing-export')), error => error instanceof BackupRefused && error.reason === 'NOT_FOUND');
  const seed = open();await seed.host.call('projects.list',{});seed.host.close();
  const {hostClosed}=await import('../src/composition/host.ts');await hostClosed(seed.home);
  const readonly = open(seed.home, { readOnly: true });
  assert.ok(Array.isArray((await readonly.host.call('schedules.get', {})).runs));
});
