import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from '../src/commands.ts';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
const effect = '10000000-0000-4000-8000-000000000001', hash = 'a'.repeat(64);
for (const answer of ['happened', 'did_not_happen', 'keep_closed']) test(`connector resolution parses ${answer} as a separate asked command`, () => {
  const p = parse(['connectors', 'resolve', effect, '--args-hash', hash, '--answer', answer, '--home', '/unused']);
  assert.equal(p.usage, undefined); assert.equal(p.name, 'connectors resolve'); assert.equal(p.options.argsHash, hash); assert.equal(p.options.connectorAnswer, answer);
});
test('connector resolution rejects missing or invalid fields', () => {
  for (const args of [[], ['--answer', 'success'], ['--args-hash', hash], ['--args-hash', 'bad', '--answer', 'happened']])
    assert.ok(parse(['connectors', 'resolve', effect, '--home', '/unused', ...args]).usage);
});

test('without the running app CLI refuses without opening a home or choosing keys', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'connector-cli-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const child = spawn(process.execPath, [join(import.meta.dirname, '../src/main.ts'), 'connectors', 'resolve', effect, '--args-hash', hash, '--answer', 'happened', '--home', dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = ''; child.stderr.on('data', b => { err += b; });
  const code = await new Promise(resolve => child.on('exit', resolve));
  assert.equal(code, 1); assert.match(err, /open the app.*Permissions remain paused/);
  assert.deepEqual(readdirSync(dir), []);
});
