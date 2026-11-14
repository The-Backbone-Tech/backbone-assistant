import assert from 'node:assert/strict';
import { test } from 'node:test';
import { kernelPin, kernelSql } from '../src/sql.ts';

test('the vendored SQL is the pinned bytes, in order', () => {
  const files = kernelSql();
  assert.deepEqual(files.map((f) => f.name), ['0000_roles', '0001_core', '0002_services']);
  assert.match(kernelPin.kernelCommit, /^[0-9a-f]{40}$/);
});

test('one changed byte is refused before any database sees it', () => {
  const real = new Map(kernelSql().map((f) => [f.name, f.sql]));
  assert.throws(() => kernelSql((name) => (name === '0001_core' ? `${real.get(name)} ` : (real.get(name) as string))), /0001_core is not the pinned/);
});
