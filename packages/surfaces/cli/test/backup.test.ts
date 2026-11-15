// backbone export and backbone restore, as a person runs them: the real bin, one process per
// command. A home with a killed write is exported, and restored into a new home after a dry run, as
// the person would add the work themselves: no live chat, receipt or grant comes with it. A home that
// holds work, a folder that is not empty and a folder that is not an export are refused, changing nothing.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { removeDataHome } from '@backbone-next/platform/composition';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { EXIT } from '../src/commands.ts';

const main = join(dirname(fileURLToPath(import.meta.url)), '../src/main.ts');
const homes: string[] = [];
const dirs: string[] = [];
after(async () => {
  for (const h of homes) await removeDataHome(h);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function home(): string {
  const h = freshDataHome('cli-backup');
  homes.push(h);
  return h;
}
function folder(): string {
  const d = mkdtempSync(join(tmpdir(), 'backbone-cli-export-'));
  dirs.push(d);
  return d;
}
interface Ran { code: number | null; signal: NodeJS.Signals | null; out: string; err: string }
function run(h: string, args: string[], env: Record<string, string> = {}): Promise<Ran> {
  const proc = spawn(process.execPath, [main, ...args], { env: { ...process.env, BACKBONE_HOME: h, BACKBONE_KEYS: 'plaintext', BACKBONE_HARNESS: 'stub', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const seen = { out: '', err: '' };
  proc.stdout.on('data', (d) => (seen.out += String(d)));
  proc.stderr.on('data', (d) => (seen.err += String(d)));
  return new Promise((r) => proc.once('close', (code, signal) => r({ code, signal, ...seen })));
}
/** A killed process's lock goes stale; until then the home reads as held. */
async function settled(h: string, args: string[]): Promise<Ran> {
  for (;;) {
    const r = await run(h, args);
    if (r.code !== EXIT.BUSY) return r;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

test('export, a dry run, then restore into a new home: the work comes in as the person would add it, nothing live', async () => {
  const h = home();
  assert.equal((await run(h, ['projects', 'create', 'One'])).code, EXIT.OK);
  assert.equal((await run(h, ['send', 'Write a brief about the quarter'])).code, EXIT.OK);
  const killed = await run(h, ['send', 'Write a brief about it'], { BACKBONE_CRASH_AT: 'write.begun' });
  assert.equal(killed.signal, 'SIGKILL');
  assert.equal((await settled(h, ['projects', 'list'])).code, EXIT.OK);

  const to = join(folder(), 'export');
  const made = await run(h, ['export', to]);
  assert.equal(made.code, EXIT.OK, made.err);
  assert.match(made.out, /Never in it:/);
  assert.match(made.out, /Authority: No grant/);
  assert.ok(existsSync(join(to, 'manifest.json')));
  assert.ok(!existsSync(join(to, 'database')), 'no database rows');
  assert.match(readFileSync(join(to, 'history', 'receipts.md'), 'utf8'), /UNRESOLVED/);

  const fresh = join(folder(), 'new-home');
  const dry = await run(fresh, ['restore', to, '--dry-run']);
  assert.equal(dry.code, EXIT.OK, dry.err);
  assert.match(dry.out, /Dry run, nothing changed/);
  assert.ok(!existsSync(fresh), 'the dry run made nothing');

  const restored = await run(fresh, ['restore', to]);
  homes.push(fresh);
  assert.equal(restored.code, EXIT.OK, restored.err);
  // Human-readable output uses the glossary; the warning must still deny imported authority and execution.
  assert.match(restored.out, /Nothing in it gives permission or runs by itself/);
  const projects = JSON.parse((await run(fresh, ['projects', 'list', '--json'])).out) as { name: string }[];
  assert.deepEqual(projects.map((p) => p.name).sort(), ['One', 'Restored history']);
  assert.deepEqual(JSON.parse((await run(fresh, ['threads', 'list', '--json'])).out), [], 'chats are history documents');
  const files = JSON.parse((await run(fresh, ['files', '--project', 'One', '--json'])).out) as { path: string }[];
  assert.ok(files.some((f) => f.path === 'brief.md'));
  assert.ok(files.some((f) => f.path.startsWith('Chat history - ')));
  assert.match((await run(fresh, ['files', '--project', 'Restored history'])).out, /Receipts when exported\.md/);
});

test('a home that holds work, a folder that is not empty and a folder that is not an export are refused', async () => {
  const h = home();
  assert.equal((await run(h, ['projects', 'create', 'Mine'])).code, EXIT.OK);
  const taken = folder();
  writeFileSync(join(taken, 'keep.txt'), 'keep');
  const over = await run(h, ['export', taken]);
  assert.equal(over.code, EXIT.REFUSED, over.err);
  assert.match(over.err, /not empty/);
  assert.deepEqual(readdirSync(taken), ['keep.txt']);

  const to = join(folder(), 'export');
  assert.equal((await run(h, ['export', to])).code, EXIT.OK);
  const other = home();
  assert.equal((await run(other, ['projects', 'create', 'Theirs'])).code, EXIT.OK);
  const refused = await run(other, ['restore', to]);
  assert.equal(refused.code, EXIT.REFUSED, refused.out + refused.err);
  assert.match(refused.err, /not a new, empty data folder/);
  assert.deepEqual((JSON.parse((await run(other, ['projects', 'list', '--json'])).out) as { name: string }[]).map((p) => p.name), ['Theirs'], 'left as it is');
  assert.equal((await run(other, ['restore', to, '--replace'])).code, EXIT.USAGE, 'no replacing');

  const notOne = folder();
  mkdirSync(join(notOne, 'stuff'));
  const wrong = await run(home(), ['restore', notOne]);
  assert.equal(wrong.code, EXIT.REFUSED);
  assert.match(wrong.err, /not a data folder export/);
  assert.equal((await run(h, ['export'])).code, EXIT.USAGE);
  assert.equal((await run(h, ['export', to, '--dry-run'])).code, EXIT.USAGE);
});
