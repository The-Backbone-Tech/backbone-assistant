import assert from 'node:assert/strict';
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { removeDataHome } from '@backbone-next/platform/composition';
import { plaintextKeys, Vault } from '@backbone-next/platform/keys';
import { systemKeys } from '@backbone-next/platform/system-keys';
import { cli, FakeSystemStore, passed } from './system-key-fixture.ts';

function snapshot(home: string): unknown[] {
  const found: unknown[] = [];
  function visit(path: string) {
    const stat = lstatSync(path);
    found.push([relative(home, path), stat.mode, stat.isFile() ? readFileSync(path).toString('base64') : null]);
    if (stat.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name));
  }
  visit(home); return found;
}
for (const provider of ['system', 'plaintext']) test(`read commands leave a vault-only ${provider} home byte-identical until create finishes it`, { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'backbone-unfinished-')), home = join(root, 'home'), store = new FakeSystemStore();
  try {
    await Vault.open(home, provider === 'system' ? systemKeys(home, store) : plaintextKeys()); Vault.forget(home);
    const before = snapshot(home), writes = store.writes;
    const reads = [['projects', 'list'], ['threads', 'list'], ['threads', 'show', 'absent'], ['now'], ['files'], ['models'], ['export', join(root, 'backup')]];
    for (const args of [...reads, ['doctor', '--json']]) {
      const result = await cli(home, args, store);
      assert.equal(result.code, 1, result.out + result.err);
      assert.match(result.out + result.err, /first run did not finish/);
      const detail = args[0] === 'doctor' ? JSON.parse(result.out).checks.find((c: {name:string}) => c.name === 'home').detail : result.err;
      assert.ok(detail.includes('--home') && detail.includes(home), 'completion command names this same home');
      if (args[0] === 'doctor') assert.equal(JSON.parse(result.out).checks.find((c: {name:string}) => c.name === 'home').status, 'fail');
      assert.deepEqual(snapshot(home), before); assert.equal(store.writes, writes);
    }
    passed(await cli(home, ['projects', 'create', 'Finished'], store));
    passed(await cli(home, ['projects', 'list'], store));
    passed(await cli(home, ['doctor', '--json'], store));
    passed(await cli(home, ['models'], store));
    passed(await cli(home, ['threads', 'list'], store));
    passed(await cli(home, ['now'], store)); passed(await cli(home, ['files'], store));
    // A nonexistent thread remains NOT_FOUND; it now gets past the completeness guard.
    assert.doesNotMatch((await cli(home, ['threads', 'show', 'absent'], store)).err, /first run did not finish/);
    passed(await cli(home, ['export', join(root, 'backup')], store));
    assert.equal(store.writes, writes, 'finishing reuses the existing account and item');
  } finally { await removeDataHome(home); rmSync(root, { recursive: true, force: true }); }
});
