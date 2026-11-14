// Retain queued telemetry calls across real H1 loss; never manipulate a lock file here.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { HomeWriteUnavailable, withHomeLock } from '../src/composition/home-lock.ts';
import { CredentialStore } from '../src/credentials/store.ts';
import { putTelemetryEndpoint, putTelemetryHeaders, readTelemetrySettings, resolveTelemetryHeaders } from '../src/credentials/telemetry.ts';
import { Vault, plaintextKeys } from '../src/keys/vault.ts';
import { freshDir } from './helpers.ts';
import { replaceHeldHomeLock } from './native-lock-observation.ts';

const endpoint = 'https://collector.invalid/v1/traces';
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
function snapshot(home: string): string {
  const walk = (at: string): unknown => fs.readdirSync(at).sort().map(name => {
    const path = join(at, name), stat = fs.lstatSync(path);
    return [name, stat.mode, stat.isDirectory() ? walk(path) : fs.readFileSync(path).toString('base64')];
  });
  return JSON.stringify(walk(home));
}
async function fixture(headers: boolean) {
  const home = freshDir('telemetry-admission-'), keys = plaintextKeys();
  const vault = await Vault.open(home, keys);
  await vault.masterKey(); // Existing, retained vault and master: no first-use write can mask the gap.
  await putTelemetryEndpoint(home, endpoint);
  if (headers) await putTelemetryHeaders(home, { authorization: 'fake-old-collector-header' }, keys);
  return { home, keys };
}

for (const target of ['root', 'credentials'] as const) {
  for (const action of ['empty headers', 'headers', 'endpoint set', 'endpoint off'] as const) {
    test(`queued telemetry ${action} refuses ${target} loss without changing any bytes`, async () => {
      const { home, keys } = await fixture(action !== 'empty headers');
      const entered = deferred(), release = deferred();
      // Start the holder separately so the retained call queues rather than inheriting reentry.
      const holder = withHomeLock(join(home, 'credentials', 'telemetry-settings'), async () => {
        entered.resolve(); await release.promise;
      });
      await entered.promise;
      const pending = action === 'empty headers' ? putTelemetryHeaders(home, {}, keys)
        : action === 'headers' ? putTelemetryHeaders(home, { authorization: 'fake-new-collector-header' }, keys)
        : putTelemetryEndpoint(home, action === 'endpoint set' ? 'https://collector.invalid/other-traces' : undefined);
      void pending.catch(() => {});
      try {
        await replaceHeldHomeLock(target === 'root' ? home : join(home, 'credentials'));
        const before = snapshot(home);
        release.resolve(); await holder;
        const error: unknown = await pending.then(() => undefined, error => error);
        assert.equal(snapshot(home) === before, true, 'no settings, index, handle, vault, mode or folder changes after observed loss');
        assert.ok(error instanceof HomeWriteUnavailable, 'the retained operation must refuse, not report success');
      } finally { release.resolve(); await Promise.allSettled([holder, pending]); }
    });
  }

  test(`telemetry index after an admitted header put refuses later ${target} loss`, async t => {
    const { home, keys } = await fixture(true), put = CredentialStore.prototype.put;
    let before: string | undefined;
    t.mock.method(CredentialStore.prototype, 'put', async function(this: CredentialStore, value: string, label: string) {
      const handle = await put.call(this, value, label); // A real admitted put settles before loss.
      await replaceHeldHomeLock(target === 'root' ? home : join(home, 'credentials'));
      before = snapshot(home);
      return handle;
    });
    await assert.rejects(putTelemetryHeaders(home, { authorization: 'fake-new-collector-header' }, keys), error => error instanceof HomeWriteUnavailable);
    assert.ok(before, 'the control reached the existing await after the admitted put');
    assert.equal(snapshot(home) === before, true, 'the old index and every sealed handle remain unchanged after loss');
  });

  test(`telemetry off index removal rechecks ${target} storage after the last revoke`, async t => {
    const { home } = await fixture(true), revoke = CredentialStore.prototype.revoke, statfs = fs.statfsSync;
    const folder = target === 'root' ? home : join(home, 'credentials');
    let withdrawn = false, before: string | undefined;
    // This branch has no await: inject an unsupported target profile after the real synchronous
    // revoke, rather than fabricating a lock abort or changing H1's observer or persistent files.
    t.mock.method(fs, 'statfsSync', ((path: fs.PathLike) => {
      const actual = statfs(path);
      return withdrawn && String(path) === folder ? { ...actual, type: 0x6969 } : actual;
    }) as typeof fs.statfsSync);
    t.mock.method(CredentialStore.prototype, 'revoke', function(this: CredentialStore, handle: string) {
      revoke.call(this, handle);
      before = snapshot(home); withdrawn = true;
    });
    await assert.rejects(putTelemetryEndpoint(home, undefined), error => error instanceof HomeWriteUnavailable && error.code === 'filesystem');
    assert.ok(before, 'the admitted revoke settled before storage admission was withdrawn');
    assert.equal(snapshot(home) === before, true, 'the index is not removed after admission changes');
    assert.equal(fs.existsSync(join(home, 'credentials', 'telemetry.json')), true);
  });
}

test('telemetry endpoint, header rotation, empty headers and off still work with admission intact', async () => {
  const { home, keys } = await fixture(true);
  const index = join(home, 'credentials', 'telemetry.json');
  const original = Object.values(JSON.parse(fs.readFileSync(index, 'utf8'))) as string[];
  await withHomeLock(home, async () => {
    await withHomeLock(join(home, 'credentials'), async () => {
      await putTelemetryHeaders(home, { 'x-api-key': 'fake-rotated-collector-header' }, keys);
      assert.deepEqual({ ...await resolveTelemetryHeaders(home, keys) }, { 'x-api-key': 'fake-rotated-collector-header' });
      for (const handle of original) assert.equal(fs.existsSync(join(home, 'credentials', `${handle}.json`)), false);
      await putTelemetryHeaders(home, {}, keys);
      assert.deepEqual(await resolveTelemetryHeaders(home, keys), {});
      await putTelemetryHeaders(home, { authorization: 'fake-final-collector-header' }, keys);
      const handles = Object.values(JSON.parse(fs.readFileSync(index, 'utf8'))) as string[];
      await putTelemetryEndpoint(home, 'https://collector.invalid/other-traces');
      assert.deepEqual(readTelemetrySettings(home), { endpoint: 'https://collector.invalid/other-traces' });
      await putTelemetryEndpoint(home, undefined);
      assert.equal(readTelemetrySettings(home), undefined);
      assert.equal(fs.existsSync(index), false);
      for (const handle of handles) assert.equal(fs.existsSync(join(home, 'credentials', `${handle}.json`)), false);
    });
  });
});

// No await separates the off-path writes, so real observer callbacks cannot be scheduled between
// them. Check the individual synchronous boundaries too, including the final index removal.
test('each direct telemetry write has an immediately adjacent root-and-target admission', () => {
  const lines = fs.readFileSync(new URL('../src/credentials/telemetry.ts', import.meta.url), 'utf8').split('\n');
  const writes = lines.flatMap((line, i) => /^\s*(writeDurable|removeDurable)\(/.test(line) ? [{ line, guard: lines[i - 1].trim() }] : []);
  assert.equal(writes.length, 3);
  for (const { line, guard } of writes) {
    assert.match(guard, /^assertHomeWriteAdmission\(home, /, `admission directly before ${line.trim()}`);
    assert.ok(guard.includes("join(home, 'credentials')"), 'check the credentials target before every operation, including off before settings change');
    if (line.includes('writeDurable(path,')) assert.ok(guard.includes('(home, home,'), 'settings.json targets the root directory itself');
  }
});
