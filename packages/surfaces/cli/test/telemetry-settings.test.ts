import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { removeDataHome } from '@backbone-next/platform/composition';
import { readTelemetrySettings, resolveTelemetryHeaders } from '@backbone-next/platform/credentials/telemetry';
import { plaintextKeys } from '@backbone-next/platform/keys';
import { channelCredentials } from '@backbone-next/platform/credentials/channels';
import { parse } from '../src/commands.ts';

const main = new URL('../src/main.ts', import.meta.url).pathname;
function launch(home: string, args: string[], input = '') {
  const child = spawn(process.execPath, [main, ...args, '--home', home], { env: { ...process.env, BACKBONE_KEYS: 'plaintext' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', chunk => out += String(chunk));
  child.stderr.on('data', chunk => err += String(chunk));
  child.stdin.end(input);
  return new Promise<{ code: number | null; out: string; err: string }>(resolve => child.once('close', code => resolve({ code, out, err })));
}

test('CLI accepts explicit endpoint, sealed stdin headers and off, with no credential in output', async () => {
  const home = freshDataHome('telemetry-cli'), marker = 'collector-cli-secret-marker';
  try {
    const unrelated = await channelCredentials(home, plaintextKeys());
    await unrelated.connect('slack', 'unrelated-cli-token', 'unrelated-cli-verification');
    const endpoint = await launch(home, ['telemetry', 'endpoint', 'http://127.0.0.1:4318/v1/traces']);
    assert.equal(endpoint.code, 0, endpoint.err);
    assert.deepEqual(readTelemetrySettings(home), { endpoint: 'http://127.0.0.1:4318/v1/traces' });
    const header = await launch(home, ['telemetry', 'header'], JSON.stringify({ Authorization: `Bearer ${marker}` }));
    assert.equal(header.code, 0, header.err);
    assert.equal((await resolveTelemetryHeaders(home, plaintextKeys())).authorization, `Bearer ${marker}`);
    assert.ok(!header.out.includes(marker) && !header.err.includes(marker));
    assert.ok(!readFileSync(join(home, 'settings.json'), 'utf8').includes(marker));
    assert.ok(readdirSync(join(home, 'credentials')).some(name => name.startsWith('cred_')));
    const index = join(home, 'credentials', 'telemetry.json');
    const handles = Object.values(JSON.parse(readFileSync(index, 'utf8'))) as string[];
    const invalid = await launch(home, ['telemetry', 'endpoint', `https://example.test/?key=${marker}`]);
    assert.equal(invalid.code, 1);
    assert.ok(!invalid.out.includes(marker) && !invalid.err.includes(marker));
    const badHeader = await launch(home, ['telemetry', 'header'], `invalid ${marker}`);
    assert.equal(badHeader.code, 1);
    assert.ok(!badHeader.out.includes(marker) && !badHeader.err.includes(marker));
    const off = await launch(home, ['telemetry', 'off']);
    assert.equal(off.code, 0, off.err);
    assert.match(off.out, /stored collector headers removed/);
    assert.equal(readTelemetrySettings(home), undefined);
    assert.equal(existsSync(index), false);
    for (const handle of handles) assert.equal(existsSync(join(home, 'credentials', `${handle}.json`)), false);
    assert.deepEqual(await unrelated.resolve('slack'), { token: 'unrelated-cli-token', verification: 'unrelated-cli-verification' });
  } finally { await removeDataHome(home); }
});

test('telemetry CLI command shapes accept no credential arguments', () => {
  const env = { BACKBONE_HOME: '/unused' };
  assert.equal(parse(['telemetry', 'endpoint', 'http://127.0.0.1:4318/v1/traces'], env).name, 'telemetry endpoint');
  assert.equal(parse(['telemetry', 'header'], env).name, 'telemetry header');
  assert.equal(parse(['telemetry', 'off'], env).name, 'telemetry off');
  assert.ok(parse(['telemetry', 'header', 'secret-marker'], env).usage);
});
