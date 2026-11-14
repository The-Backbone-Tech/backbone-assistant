import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TEST_HANG_MS } from '../../../scripts/lib/test-hang.ts';
import { WorkspaceStore } from '../src/workspace/store.ts';

test('a workspace deadline crossing during supervisor startup reports time limit and admits no command', { timeout: TEST_HANG_MS }, async t => {
  if (process.platform !== 'darwin') return;
  const root = await realpath(await mkdtemp(join(tmpdir(), 'workspace-deadline-')));
  const store = new WorkspaceStore('owned-deadline-home', { root: join(root, 'storage') });
  try {
    const ready = await store.run('job', { command: 'printf ready', inputs: [] });
    assert.equal(ready.code, 0, ready.stderr);
    const result = await store.use('job', record => {
      const expiresAt = Date.now() - 1;
      // The parent admits just before the deadline; the separate supervisor sees it expired.
      // Restore synchronously: only that admission check uses the controlled clock.
      const clock = t.mock.method(Date, 'now', () => expiresAt - 1);
      try {
        return store.execute({ ...record, expiresAt }, { command: 'echo forbidden > after-deadline', inputs: [] });
      } finally { clock.mock.restore(); }
    });
    assert.equal(result.reason, 'time limit');
    assert.notEqual(result.code, 0);
    const checked = await store.run('job', { command: 'test ! -e after-deadline && printf not-admitted', inputs: [] });
    assert.equal(checked.code, 0, checked.stderr);
    assert.equal(checked.stdout, 'not-admitted');
  } finally {
    await store.remove('job');
    await rm(root, { recursive: true, force: true });
  }
});
