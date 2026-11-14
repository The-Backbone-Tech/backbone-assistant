import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { removeDataHome } from '@backbone-next/platform/composition';
import { withHomeLock } from '@backbone-next/platform/composition/home-lock';
import { plaintextKeys, Vault } from '@backbone-next/platform/keys';
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
for (const stamp of [true, false]) test(`legacy guidance recovers actual product work and keys, kernel stamp=${stamp}`, { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'backbone-legacy-recovery-')), home = join(root, 'home'), store = new FakeSystemStore();
  try {
    passed(await cli(home, ['projects', 'create', 'Before the vault'], store, 'plaintext'));
    const vault = await Vault.open(home, plaintextKeys()), master = await vault.masterKey(), passwords = await vault.passwords().read();
    assert.ok(passwords);
    const { port } = JSON.parse(readFileSync(join(home, 'pg', 'cluster.json'), 'utf8'));
    // Preserve the real product's keys and work in the historical layout, as the platform key tests do.
    await withHomeLock(home, () => withHomeLock(join(home, 'keys'), async () => {
      writeFileSync(join(home, 'keys', 'master.key'), master, { mode: 0o600 });
      writeFileSync(join(home, 'pg', 'secrets.json'), JSON.stringify({ ...passwords, port }), { mode: 0o600 });
      rmSync(join(home, 'keys', 'vault.json')); rmSync(join(home, 'pg', 'cluster.json'));
      if (!stamp) rmSync(join(home, 'kernel.json'));
    })); Vault.forget(home);
    const before = snapshot(home);
    for (const choice of [undefined, 'plaintext']) for (const args of [['projects', 'list'], ['doctor', '--json']]) {
      const result = await cli(home, args, store, choice);
      assert.equal(result.code, 1);
      const detail = args[0] === 'doctor' ? JSON.stringify(JSON.parse(result.out).checks) : result.err;
      assert.match(detail, /legacy plaintext keys.*no vault/);
      assert.match(detail, /read-only command cannot migrate/);
      assert.match(detail, /also creates a project with the name given.*existing projects are kept/);
      assert.ok((args[0] === 'doctor' ? JSON.parse(result.out).checks.map((c: {detail:string}) => c.detail).join(' ') : result.err).includes(`BACKBONE_KEYS=plaintext backbone projects create "My project" --home ${JSON.stringify(home)}`));
      assert.deepEqual(snapshot(home), before); assert.equal(store.writes, 0);
    }
    passed(await cli(home, ['projects', 'create', 'My project'], store, 'plaintext'));
    const projects = await cli(home, ['projects', 'list', '--json'], store); passed(projects);
    assert.deepEqual(JSON.parse(projects.out).map((project: { name: string }) => project.name).sort(), ['Before the vault', 'My project']);
    const migrated = await Vault.open(home, plaintextKeys());
    assert.deepEqual(await migrated.masterKey(), master); assert.deepEqual(await migrated.passwords().read(), passwords);
    assert.equal(existsSync(join(home, 'keys', 'master.key')), false);
    assert.equal(existsSync(join(home, 'pg', 'secrets.json')), false); assert.equal(store.probes, 0);
  } finally { await removeDataHome(home); rmSync(root, { recursive: true, force: true }); }
});

test('a product home whose vault was lost points to a backup restore into a different home', { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'backbone-vault-recovery-')), home = join(root, 'home'), recovered = join(root, 'recovered'), backup = join(root, 'backup'), store = new FakeSystemStore();
  try {
    passed(await cli(home, ['projects', 'create', 'Kept work'], store, 'plaintext'));
    passed(await cli(home, ['export', backup], store));
    await withHomeLock(home, () => withHomeLock(join(home, 'keys'), async () => { rmSync(join(home, 'keys', 'vault.json')); })); Vault.forget(home);
    const before = snapshot(home);
    for (const args of [['projects', 'list'], ['projects', 'create', 'Retry'], ['doctor', '--json']]) {
      const result = await cli(home, args, store);
      assert.equal(result.code, 1);
      assert.match(result.out + result.err, /has data but no vault/);
      assert.match(result.out + result.err, /no legacy keys/);
      assert.match(result.out + result.err, /if it used one/);
      assert.match(result.out + result.err, /backbone restore <backup-folder> --home <new-empty-home>/);
      assert.doesNotMatch(result.out + result.err, /finish it with: backbone projects create/i);
      assert.deepEqual(snapshot(home), before); assert.equal(store.probes, 0);
    }
    // The recommended restore command recovers work, not replacement credentials for the damaged home.
    passed(await cli(recovered, ['restore', backup], store));
    assert.match((await cli(recovered, ['projects', 'list'], store)).out, /Kept work/);
    assert.deepEqual(snapshot(home), before);
  } finally { await removeDataHome(home); await removeDataHome(recovered); rmSync(root, { recursive: true, force: true }); }
});
