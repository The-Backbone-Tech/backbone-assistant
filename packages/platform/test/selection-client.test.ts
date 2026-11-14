import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexCheck, claudeCheck } from '../src/composition/doctor.ts';
import { inventory } from '../src/selection/inventory.ts';
import { choose } from '../src/selection/choose.ts';

test('client discovery distinguishes subscription, API-key and unknown billing without returning account output', () => {
  const bin = mkdtempSync(join(tmpdir(), 'selection-client-'));
  const prior = process.env.PATH;
  process.env.PATH = `${bin}:${prior ?? ''}`;
  try {
    for (const [output, billing] of [['Logged in using ChatGPT', 'plan'], ['Logged in using an API key', 'metered'], ['Signed in', 'unknown']]) {
      writeFileSync(join(bin, 'codex'), `#!/bin/sh\nprintf '%s\\n' '${output}'\n`, { mode: 0o700 });
      const result = codexCheck();
      assert.equal(result.billing, billing);
      assert.equal(result.status, 'ok');
      assert.ok(!result.detail.includes(output));
    }
  } finally { if (prior === undefined) delete process.env.PATH; else process.env.PATH = prior; rmSync(bin, { recursive: true, force: true }); }
});

test('version-only client discovery reuses a bounded status cache', () => {
  const bin = mkdtempSync(join(tmpdir(), 'selection-client-cache-'));
  const prior = process.env.PATH;
  process.env.PATH = bin;
  const count = join(bin, 'calls');
  try {
    writeFileSync(join(bin, 'claude'), `#!/bin/sh\nprintf x >> '${count.replaceAll("'", "'\\''")}'\nprintf 'Claude client\\n'\n`, { mode: 0o700 });
    assert.equal(claudeCheck().status, 'ok');
    assert.equal(claudeCheck().status, 'ok');
    assert.equal(readFileSync(count, 'utf8'), 'x');
  } finally { if (prior === undefined) delete process.env.PATH; else process.env.PATH = prior; rmSync(bin, { recursive: true, force: true }); }
});

test('Codex billing is probed again after sign-in changes without changing its executable', () => {
  const bin = mkdtempSync(join(tmpdir(), 'selection-client-login-'));
  const prior = process.env.PATH;
  process.env.PATH = bin;
  const status = join(bin, 'status');
  try {
    writeFileSync(status, 'Logged in using ChatGPT\n');
    writeFileSync(join(bin, 'codex'), `#!/bin/sh\nwhile IFS= read -r line; do printf '%s\\n' "$line"; done < '${status.replaceAll("'", "'\\''")}'\n`, { mode: 0o700 });
    const select = () => choose(inventory({ codex: codexCheck(), claude: { status: 'warn', detail: 'not checked' }, local: { runtimes: [] }, settings: { own: null, gateway: null, hint: null, harness: 'Codex', active: { kind: 'native', label: 'Codex', model: 'chat-model', fingerprint: 'a'.repeat(64) } } }), { needs: ['model'], network: true, spend: 'plan' });
    assert.equal(codexCheck().billing, 'plan');
    assert.equal(select().choice?.route.spends, 'plan');
    writeFileSync(status, 'Logged in using an API key\n');
    assert.equal(codexCheck().billing, 'metered');
    assert.equal(select().choice, null, 'a plan-only task cannot be admitted after API-key re-login');
  } finally { if (prior === undefined) delete process.env.PATH; else process.env.PATH = prior; rmSync(bin, { recursive: true, force: true }); }
});
