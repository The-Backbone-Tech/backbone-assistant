import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { assertHomeWriteAdmission, withHomeLock } from '@backbone-next/platform/composition/home-lock';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { chooseNativeRoute } from '../electron/native-route.ts';

for (const engine of ['harness-acp', 'harness-pi', 'harness-codex', 'harness-stub']) {
  test(`a saved engine takes precedence over the automatic native default: ${engine}`, t => {
    const home = mkdtempSync(join(tmpdir(), 'app-native-choice-'));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const bin = join(home, 'bin'); mkdirSync(bin);
    writeFileSync(join(bin, 'codex'), 'inert fixture, never executed');
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ harness: engine }));
    const env = { PATH: bin, BACKBONE_CODEX_SNAPSHOT_NODE: process.execPath };
    assert.equal(chooseNativeRoute(home, env), false);
    assert.deepEqual(env, { PATH: bin, BACKBONE_CODEX_SNAPSHOT_NODE: process.execPath });
  });
}

test('an unconfigured home can still select the installed native default without invoking it', t => {
  const home = mkdtempSync(join(tmpdir(), 'app-native-default-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const bin = join(home, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'codex'), 'inert fixture, never executed');
  const env: NodeJS.ProcessEnv = { PATH: bin, BACKBONE_CODEX_SNAPSHOT_NODE: process.execPath };
  assert.equal(chooseNativeRoute(home, env), true);
  assert.equal(env.BACKBONE_HARNESS, 'harness-codex');
});

test('desktop startup preserves saved local routes and engines despite an installed Codex client', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-route-choice-'));
  const bin = join(root, 'bin');
  try {
    await mkdir(bin);
    // A real executable fixture satisfies discovery without consulting or launching a real client.
    await writeFile(join(bin, 'codex'), '#!/bin/sh\nexit 99\n', { mode: 0o700 });
    const cases: { file: string; value?: unknown; raw?: string }[] = [
      { file: 'model-route.json', value: { native: { provider: 'codex', model: 'previous-native-model' }, local: { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'local-only' } } },
      { file: 'model-route.json', value: { local: null } },
      { file: 'model-route.json', value: { local: false } },
      ...['harness-pi', 'harness-codex', 'harness-stub', null].map(harness => ({ file: 'settings.json', value: { harness } })),
      { file: 'model-route.json', value: { own: { credential: 'fake-own' } } },
      { file: 'model-route.json', value: { gateway: { credential: 'fake-gateway' } } },
      { file: 'model-route.json', raw: '{broken' },
      { file: 'settings.json', raw: '{broken' },
    ];
    for (const [index, fixture] of cases.entries()) {
      const home = join(root, String(index)); await mkdir(home);
      await withHomeLock(home, async () => {
        assertHomeWriteAdmission(home);
        await writeFile(join(home, fixture.file), fixture.raw ?? JSON.stringify(fixture.value));
      });
      const env = { PATH: bin, BACKBONE_CODEX_SNAPSHOT_NODE: process.execPath } as NodeJS.ProcessEnv;
      const before = { ...env };
      assert.equal(chooseNativeRoute(home, env), false, JSON.stringify(fixture));
      assert.deepEqual(env, before, 'startup must preserve the chosen route and environment');
    }
    const fresh = join(root, 'fresh'); await mkdir(fresh);
    const env = { PATH: bin, BACKBONE_CODEX_SNAPSHOT_NODE: process.execPath } as NodeJS.ProcessEnv;
    assert.equal(chooseNativeRoute(fresh, env), true, 'the fake client must actually satisfy default discovery');
    assert.equal(env.BACKBONE_HARNESS, 'harness-codex');
    // An empty endpoint is unset, not an invalid explicit route (Stack 25 correction).
    const empty = { PATH: bin, BACKBONE_CODEX_SNAPSHOT_NODE: process.execPath, BACKBONE_MODEL_ENDPOINT: '' } as NodeJS.ProcessEnv;
    assert.equal(chooseNativeRoute(fresh, empty), true);
    assert.equal(empty.BACKBONE_HARNESS, 'harness-codex');
    for (const override of [{ BACKBONE_MODEL_ENDPOINT: 'http://192.168.1.20:11434/v1' }, { BACKBONE_HARNESS: '' }]) {
      const selected = { PATH: bin, BACKBONE_CODEX_SNAPSHOT_NODE: process.execPath, ...override };
      assert.equal(chooseNativeRoute(fresh, selected), false, 'even invalid overrides must reach their refusal path');
      assert.deepEqual(selected, { PATH: bin, BACKBONE_CODEX_SNAPSHOT_NODE: process.execPath, ...override });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const engine of ['harness-codex', 'codex']) test(`a saved ${engine} keeps its qualified snapshot runtime without changing the selected engine`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'saved-native-runtime-'));
  const homedir = os.homedir;
  try {
    const bin = join(root, '.nvm', 'versions', 'node', 'owned-fixture', 'bin');
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, 'node'), 'inert runtime fixture, never executed');
    const home = join(root, 'home'); await mkdir(home);
    await withHomeLock(home, async () => {
      assertHomeWriteAdmission(home);
      await writeFile(join(home, 'settings.json'), JSON.stringify({ harness: engine }));
    });
    os.homedir = () => root; syncBuiltinESMExports();
    const env: NodeJS.ProcessEnv = { PATH: '' };
    assert.equal(chooseNativeRoute(home, env), false);
    assert.equal(env.BACKBONE_HARNESS, undefined, 'the home remains the engine-selection owner');
    assert.equal(env.BACKBONE_CODEX_SNAPSHOT_NODE, join(bin, 'node'));
  } finally { os.homedir = homedir; syncBuiltinESMExports(); await rm(root, { recursive: true, force: true }); }
});
