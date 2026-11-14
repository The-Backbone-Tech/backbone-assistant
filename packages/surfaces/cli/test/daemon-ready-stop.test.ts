import assert from 'node:assert/strict';
import { test } from 'node:test';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { removeDataHome } from '@backbone-next/platform/composition';
import { runDaemon } from '../src/daemon.ts';

test('announcing daemon readiness means an immediate Stop is already handled', async t => {
  const home = freshDataHome('daemon-ready-stop'); t.after(() => removeDataHome(home));
  const before = { keys: process.env.BACKBONE_KEYS, harness: process.env.BACKBONE_HARNESS };
  process.env.BACKBONE_KEYS = 'plaintext'; process.env.BACKBONE_HARNESS = 'stub';
  t.after(() => { if (before.keys === undefined) delete process.env.BACKBONE_KEYS; else process.env.BACKBONE_KEYS = before.keys; if (before.harness === undefined) delete process.env.BACKBONE_HARNESS; else process.env.BACKBONE_HARNESS = before.harness; });
  const priorTerm = new Set(process.listeners('SIGTERM')), priorInt = new Set(process.listeners('SIGINT'));
  t.after(() => { for (const fn of process.listeners('SIGTERM')) if (!priorTerm.has(fn)) process.off('SIGTERM', fn); for (const fn of process.listeners('SIGINT')) if (!priorInt.has(fn)) process.off('SIGINT', fn); });
  let ready = false, armed = false;
  await runDaemon(home, line => {
    if (!line.startsWith('daemon: serving')) return;
    ready = true; armed = process.listeners('SIGTERM').some(fn => !priorTerm.has(fn));
    if (armed) process.emit('SIGTERM');
    else setImmediate(() => process.emit('SIGTERM')); // Let the old implementation finish so its failure is reviewable.
  });
  assert.ok(ready); assert.ok(armed, 'readiness was announced before the Stop handler was installed');
  assert.deepEqual(process.listeners('SIGTERM'), [...priorTerm]); assert.deepEqual(process.listeners('SIGINT'), [...priorInt]);
});
