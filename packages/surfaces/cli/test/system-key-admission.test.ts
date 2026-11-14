import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { HomeWriteUnavailable } from '@backbone-next/platform/composition/home-lock';
import { withHome } from '../src/session.ts';
import { runDaemon } from '../src/daemon.ts';

for (const entry of ['session', 'daemon']) test(`${entry} admits keys storage before earlier initialization`, async (t) => {
  const home = fs.mkdtempSync(join(tmpdir(), 'backbone-caller-admission-')), keys = join(home, 'keys');
  fs.mkdirSync(keys); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const real = fs.statfsSync;
  t.mock.method(fs, 'statfsSync', ((path: fs.PathLike) => ({ ...real(path), type: String(path) === keys ? 0x6969 : real(path).type })) as typeof fs.statfsSync);
  const open = () => entry === 'session' ? withHome(home, 'test', async () => {}, { create: true }) : runDaemon(home, () => {});
  await assert.rejects(open(), (e: unknown) => e instanceof HomeWriteUnavailable && e.code === 'filesystem');
  assert.deepEqual(fs.readdirSync(home), ['keys']); assert.deepEqual(fs.readdirSync(keys), []);
});
