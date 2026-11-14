import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve('scripts/linux-install-smoke.sh');
test('install smoke rejects arguments before making resources', () => {
  const r = spawnSync(script, ['unexpected'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage:/);
});
test('install smoke removes its temporary directory after an export failure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'smoke-test-'));
  try {
    const bin = join(dir, 'bin'); mkdirSync(bin);
    writeFileSync(join(bin, 'git'), '#!/bin/sh\ncase "$*" in *rev-parse*) pwd;; *) exit 1;; esac\n', { mode: 0o755 });
    writeFileSync(join(bin, 'docker'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const r = spawnSync(script, [], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: dir }, encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.deepEqual(readdirSync(dir), ['bin']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
