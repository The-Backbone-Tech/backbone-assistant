import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { formatVersion, versionLine } from '../src/version.ts';

const app = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', "import {PRODUCT_VERSION as v} from './scripts/lib/product-version.mjs'; console.log(JSON.stringify(v))"], { cwd: new URL('../../../..', import.meta.url).pathname, encoding: 'utf8' }));

test('formatVersion names the revision and marks uncommitted changes', () => {
  assert.equal(formatVersion({ version: '1.2.3', revision: '67401177f5de0123', dirty: false }), '1.2.3 (67401177f5de)');
  assert.equal(formatVersion({ version: '1.2.3', revision: '67401177f5de0123', dirty: true }), '1.2.3 (67401177f5de, uncommitted changes)');
  assert.equal(formatVersion({ version: '1.2.3', revision: null, dirty: null }), '1.2.3');
});

test('a packed command prints the version and revision it was packed with', t => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-version-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'build.json');
  writeFileSync(file, JSON.stringify({ version: '9.8.7', revision: 'abcdef0123456789', dirty: true }));
  assert.equal(versionLine(pathToFileURL(file)), '9.8.7 (abcdef012345, uncommitted changes)');
});

test('a source checkout prints the shared product version and says it is a checkout', () => {
  const line = versionLine();
  assert.match(line, new RegExp(`^${app.replace(/\./g, '\\.')} \\(source checkout(, [0-9a-f]{12})?(, uncommitted changes)?\\)$`));
});

test('without Git or a product file it still prints something and does not throw', t => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-version-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(versionLine(pathToFileURL(join(dir, 'none.json')), pathToFileURL(join(dir, 'none2.json')), dir), 'unknown version (source checkout)');
});

test('the command prints the same line', () => {
  const out = execFileSync(process.execPath, [new URL('../src/main.ts', import.meta.url).pathname, '--version'], { encoding: 'utf8' });
  assert.equal(out.trim(), versionLine());
});
