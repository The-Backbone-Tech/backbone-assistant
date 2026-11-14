import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { inspectExecutable, verifyExecutableAccess } from '../src/executable-identity.ts';
import { freshAcpExecutableDirectory } from '../src/testing/acp.ts';

test('changed ACL snapshots are retried without accepting a newly unsafe executable ancestor', async t => {
  const home = freshAcpExecutableDirectory('acp-acl-race-', t), parent = join(home, 'bin'); mkdirSync(parent);
  const command = join(parent, 'agent'); writeFileSync(command, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const identity = inspectExecutable(command);
  if (process.platform !== 'darwin') {
    await verifyExecutableAccess(identity); chmodSync(parent, 0o777);
    await assert.rejects(verifyExecutableAccess(identity)); return;
  }
  const original = childProcess.execFile;
  let change: (() => void) | undefined = () => writeFileSync(join(parent, 'unrelated'), 'a new directory entry');
  let snapshots = 0;
  t.mock.method(childProcess, 'execFile', (...args: unknown[]) => {
    const callback = args.at(-1) as (...values: unknown[]) => void;
    const complete = (...values: unknown[]) => {
      if (args[0] === '/bin/ls' && (args[1] as string[]).at(-1) === parent) {
        snapshots++;
        const act = change; change = undefined; act?.();
      }
      callback(...values);
    };
    return Reflect.apply(original, childProcess, [...args.slice(0, -1), complete]);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await verifyExecutableAccess(identity);
  assert.ok(snapshots >= 2, 'a changed snapshot must be inspected again');
  // Invalidate the cached snapshot, then grant a foreign write after the next actual ACL read.
  writeFileSync(join(parent, 'another-entry'), 'invalidate the directory snapshot');
  change = () => childProcess.execFileSync('/bin/chmod', ['+a', 'everyone allow write', parent]);
  try { await assert.rejects(verifyExecutableAccess(identity)); }
  finally { childProcess.execFileSync('/bin/chmod', ['-a', 'everyone allow write', parent]); }
});
