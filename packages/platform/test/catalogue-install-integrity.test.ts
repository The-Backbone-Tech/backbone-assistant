import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { installPinnedGithubArchive, verifiedBinaryDigest } from '../src/connectors/catalogue-install.ts';
import { removeGoogleInstallation } from '../src/connectors/catalogue-revocation.ts';
import { installCatalogueGoogle } from '../src/connectors/catalogue-google-install.ts';

test('the installer refuses an incorrect archive pin and an oversized body before writing a binary', async () => {
  const home = mkdtempSync(join(tmpdir(), 'catalogue-integrity-'));
  const server = createServer((_req, res) => res.end('untrusted archive'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/archive`;
  try {
    await assert.rejects(installPinnedGithubArchive(home, new AbortController().signal, { url, sha256: '0'.repeat(64) }), /digest/);
    await assert.rejects(installPinnedGithubArchive(home, new AbortController().signal, { url, sha256: createHash('sha256').update('untrusted archive').digest('hex'), maxBytes: 4 }), /size/);
    assert.equal(existsSync(join(home, 'connectors', 'bin')), false);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(home, { recursive: true, force: true }); }
});

test('Google installation uses an explicit uv executable and enforces the full hashed wheel set', async () => {
  const home = mkdtempSync(join(tmpdir(), 'catalogue-uv-')), log = join(home, 'uv-calls.jsonl'), uv = join(home, 'fixture-uv');
  // A fixture-native uv, never a PATH shadow. It records arguments and stages inert files only.
  writeFileSync(uv, `#!${process.execPath}\nconst fs=require('node:fs'),p=require('node:path');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');if(args.includes('venv')){fs.mkdirSync(p.join(args.at(-1),'bin'),{recursive:true});}else{const bin=p.dirname(args[args.indexOf('--python')+1]);fs.writeFileSync(p.join(bin,'workspace-mcp'),'fixture installed executable');}\n`, { mode: 0o700 });
  try {
    const installed = await installCatalogueGoogle(home, '10000000-0000-4000-8000-000000000001', new AbortController().signal, uv);
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]);
    assert.ok(calls.every(args => args.includes('--no-config')));
    assert.ok(calls[1].includes('--require-hashes')); assert.ok(calls[1].includes('--only-binary')); assert.ok(calls[1].includes(':all:'));
    const requirements = readFileSync(calls[1].at(-1)!, 'utf8');
    for (const line of requirements.trim().split('\n')) assert.ok(line.includes('==') && line.includes('--hash=sha256:'));
    assert.equal(readFileSync(installed.path, 'utf8'), 'fixture installed executable');
    await assert.rejects(installCatalogueGoogle(home, 'unused', new AbortController().signal, 'uv'), /absolute/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('a pinned local archive installs only its executable and MIT notice', async () => {
  const root = mkdtempSync(join(tmpdir(), 'catalogue-archive-'));
  writeFileSync(join(root, 'github-mcp-server'), 'fixture executable'); writeFileSync(join(root, 'LICENSE'), 'MIT License fixture');
  const archive = execFileSync('tar', ['-czf', '-', '-C', root, 'github-mcp-server', 'LICENSE']);
  const server = createServer((_req, res) => res.end(archive));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    const result = await installPinnedGithubArchive(join(root, 'home'), new AbortController().signal, { url: `http://127.0.0.1:${address.port}`, sha256: createHash('sha256').update(archive).digest('hex') });
    assert.equal(readFileSync(result.path, 'utf8'), 'fixture executable');
    assert.equal(result.digest, createHash('sha256').update('fixture executable').digest('hex'));
    assert.ok(readFileSync(result.path + '.LICENSE', 'utf8').includes('MIT License'));
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); }
});


test('sealing uses the extraction digest and refuses an executable replaced after extraction', () => {
  const home = mkdtempSync(join(tmpdir(), 'catalogue-extracted-pin-'));
  const path = join(home, 'executable');
  try {
    writeFileSync(path, 'verified archive member');
    const digest = createHash('sha256').update('verified archive member').digest('hex');
    assert.equal(verifiedBinaryDigest({ path, digest }, path), digest);
    writeFileSync(path, 'replacement between extraction and sealing');
    assert.throws(() => verifiedBinaryDigest({ path, digest }, path), /executable changed/);
    assert.throws(() => verifiedBinaryDigest({ path, digest }, join(home, 'another-executable')), /executable changed/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});


test('Google interpreter cleanup refuses traversal and a bin directory replaced by a link', () => {
  const home = mkdtempSync(join(tmpdir(), 'catalogue-interpreter-cleanup-'));
  const instance = '10000000-0000-4000-8000-000000000001';
  try {
    const foreign = join(home, 'unrelated'), install = join(foreign, `google-${instance}`);
    mkdirSync(install, { recursive: true }); writeFileSync(join(install, 'keep'), 'person-owned');
    mkdirSync(join(home, 'connectors')); symlinkSync(foreign, join(home, 'connectors', 'bin'), 'dir');
    assert.throws(() => removeGoogleInstallation(home, '../../unrelated'), /installation/);
    assert.throws(() => removeGoogleInstallation(home, instance), /folder changed/);
    assert.equal(readFileSync(join(install, 'keep'), 'utf8'), 'person-owned');
  } finally { rmSync(home, { recursive: true, force: true }); }
});
