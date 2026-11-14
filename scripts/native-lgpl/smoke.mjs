// Exercise the exact staged or extracted payload, never the checkout's default cluster.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { validateBuild } from './payload.mjs';
const native = resolve(process.argv[2] ?? 'packages/surfaces/app/dist/postgres/native');
validateBuild(native, { recordFile: 'lgpl-build.json' });
const root = mkdtempSync(join(tmpdir(), 'lgpl-postgres-'));
const env = { ...process.env, LC_ALL: 'C' };
const run = (name, args) => execFileSync(join(native, 'bin', name), args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
let started = false;
const client = new pg.Client({ host: root, database: 'postgres', user: process.env.USER });
try {
  run('initdb', ['-D', join(root, 'data'), '-A', 'trust', '-E', 'UTF8', '--locale=C']);
  // Unix socket in a private directory; TCP is disabled and no shared port is claimed.
  run('pg_ctl', ['-D', join(root, 'data'), '-l', join(root, 'postgres.log'), '-o', `-k ${root} -c listen_addresses=''`, '-w', 'start']); started = true;
  await client.connect();
  await client.query("SET lc_messages = 'es_ES.UTF-8'");
  const conversion = await client.query("SELECT encode(convert_to('ñ','LATIN1'),'hex') AS converted");
  assert.equal(conversion.rows[0].converted, 'f1');
  assert.equal((await client.query('SHOW lc_messages')).rows[0].lc_messages, 'es_ES.UTF-8');
  await assert.rejects(client.query('SELECT * FROM lgpl_missing_relation'), error => error.code === '42P01');
  console.log('Packaged PostgreSQL: initdb, UTF8 → LATIN1 = f1, lc_messages = es_ES.UTF-8, message-locale session and missing-relation error passed.');
  await client.query("SELECT XMLPARSE(DOCUMENT '<proof>ñ</proof>')");
  const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  const loaded = execFileSync('lsof', ['-p', String(pid), '-Fn'], { encoding: 'utf8' });
  assert.ok(loaded.includes(`${native}/lib/libiconv.2.dylib`), 'Server did not load packaged libiconv');
  console.log('lsof confirmed the replaced libiconv loaded through PostgreSQL libxml2.');
  // This provider's PostgreSQL imports no gettext functions and ships no message catalogs. Exercise
  // the shipped libintl itself with a disposable catalog instead of claiming NLS support.
  const locale = join(root, 'locale/es/LC_MESSAGES'); mkdirSync(locale, { recursive: true });
  const catalog = Buffer.alloc(55);
  [0x950412de, 0, 1, 28, 36, 0, 0, 5, 44, 4, 50].forEach((value, i) => catalog.writeUInt32LE(value, i * 4));
  catalog.write('hello\0hola\0', 44); writeFileSync(join(locale, 'backbone-proof.mo'), catalog);
  const source = join(root, 'translate.c'), executable = join(root, 'translate');
  writeFileSync(source, `#include <dlfcn.h>
#include <locale.h>
#include <stdio.h>
#include <string.h>
int main(int argc, char **argv) {
  void *lib = dlopen(argv[1], RTLD_NOW | RTLD_LOCAL);
  if (!lib) { fprintf(stderr, "%s", dlerror()); return 1; }
  char *(*locale)(int, const char *) = dlsym(lib, "libintl_setlocale");
  if (!locale || !locale(LC_ALL, "es_ES.UTF-8")) return 3;
  char *(*bind)(const char *, const char *) = dlsym(lib, "libintl_bindtextdomain");
  char *(*domain)(const char *) = dlsym(lib, "libintl_textdomain");
  char *(*translate)(const char *) = dlsym(lib, "libintl_gettext");
  if (!bind || !domain || !translate) return 2;
  bind("backbone-proof", argv[2]); domain("backbone-proof");
  const char *result = translate("hello"); puts(result);
  return strcmp(result, "hola") != 0;
}`);
  const sdk = execFileSync('xcrun', ['--show-sdk-path'], { encoding: 'utf8' }).trim();
  execFileSync('xcrun', ['clang', '-isysroot', sdk, source, '-o', executable]);
  const translated = execFileSync(executable, [join(native, 'lib/libintl.8.dylib'), join(root, 'locale')], { encoding: 'utf8', env: { ...env, LC_ALL: 'es_ES.UTF-8', LANGUAGE: 'es' }, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(translated.trim(), 'hola');
  console.log('Packaged libintl dynamically loaded its adjacent libiconv and translated hello → hola.');
} finally {
  await client.end().catch(() => {});
  if (started) run('pg_ctl', ['-D', join(root, 'data'), '-m', 'immediate', '-w', 'stop']);
  rmSync(root, { recursive: true, force: true });
}
