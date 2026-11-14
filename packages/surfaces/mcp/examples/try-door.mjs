// Try the MCP door end to end, the way a client does: host, grant, serve over stdio, use, revoke.
//   node packages/surfaces/mcp/examples/try-door.mjs
// Everything happens in a temporary data home that is removed at the end, database included. The
// door holds no secret: it relays to the one process holding the home's keys, which for a real home
// is the app and for this throwaway one is `backbone-mcp host`.
// The embedded PostgreSQL listens on 127.0.0.1: a sandbox that blocks local listening fails at step 1
// with `listen EPERM`. Exit 0 means every step behaved as described; any mismatch exits 1.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { removeDataHome } from '@backbone-next/platform/composition';

const main = join(dirname(fileURLToPath(import.meta.url)), '../src/main.ts');
const home = mkdtempSync(join(tmpdir(), 'backbone-try-door-'));
const say = (step, text) => console.log(`${step}. ${text}`);
// A throwaway home keeps its keys in plain text, by this explicit choice; the app keeps a real
// home's in the Keychain, and refuses this one.
const person = { ...process.env, BACKBONE_KEYS: 'plaintext' };
let client;
let host;

// The person's own commands: never through MCP.
function cli(...args) {
  const r = spawnSync(process.execPath, [main, ...args, '--home', home], { encoding: 'utf8', env: person });
  if (r.status !== 0) throw new Error(`"${args[0]}" failed (exit ${r.status}): ${r.stderr.trim()}`);
  return r.stdout.trim();
}
// The process that holds the home's keys and carries every door's calls, until it is stopped.
async function startHost() {
  host = spawn(process.execPath, [main, 'host', '--home', home], { env: person, stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  host.stdout.on('data', (d) => (out += String(d)));
  for (let i = 0; i < 600 && !out.includes('\n'); i++) {
    if (host.exitCode !== null) throw new Error(`"host" failed (exit ${host.exitCode})`);
    await new Promise((r) => setTimeout(r, 50));
  }
  return out.trim().replace(home, '<home>');
}
// One tool call: the receipt (or refusal) is in structuredContent; isError says whether the call failed.
async function call(name, args) {
  const r = await client.callTool({ name, arguments: args });
  return { isError: r.isError === true, ...r.structuredContent };
}

try {
  say(1, `Host: ${await startHost()}`);
  say(2, `Grant: ${cli('grant', '--name', 'try-door', '--operations', 'outbox.write', '--ceiling', '3')}`);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [main, 'serve', '--home', home, '--grant', 'try-door'],
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', TMPDIR: process.env.TMPDIR ?? tmpdir() },
    stderr: 'inherit',
  });
  client = new Client({ name: 'try-door', version: '0.0.0' });
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, ['effect_status', 'list_goals', 'list_projects', 'list_receipts', 'list_schedules', 'list_threads', 'propose_effect', 'read_thread', 'recall_knowledge', 'search_memory', 'search_threads', 'solutions_options', 'solutions_run', 'solutions_verify']);
  say(3, `Connected over stdio (protocol ${client.getNegotiatedProtocolVersion()}); tools: ${tools.join(', ')}.`);

  const proposed = await call('propose_effect', {
    operation: 'outbox.write',
    args: { name: 'hello.txt', content: 'hello from try-door' },
    description: 'Leave a note in the outbox.',
    idempotencyKey: 'try-door-1',
  });
  assert.equal(proposed.isError, false, JSON.stringify(proposed));
  assert.equal(proposed.value?.outcome, 'DONE', JSON.stringify(proposed));
  say(4, `propose_effect outbox.write: receipt ${proposed.value.effect}, outcome ${proposed.value.outcome}.`);

  const file = join(home, 'outbox/hello.txt');
  assert.ok(existsSync(file), 'the outbox file is missing');
  assert.equal(readFileSync(file, 'utf8'), 'hello from try-door');
  say(5, `The file landed: outbox/hello.txt holds "${readFileSync(file, 'utf8')}".`);

  const status = await call('effect_status', { idempotencyKey: 'try-door-1' });
  assert.equal(status.value?.outcome, 'DONE', JSON.stringify(status));
  assert.equal(status.value?.effect, proposed.value.effect);
  say(6, `effect_status by idempotency key: ${status.value.outcome}, the same receipt.`);

  const receipts = await call('list_receipts', {});
  assert.equal(receipts.value?.length, 1, JSON.stringify(receipts));
  say(7, `list_receipts: ${receipts.value.length} receipt, outcome ${receipts.value[0].outcome}.`);

  // Reads go to the host's api line, not through the grant: same-user reads, and no send.
  const projects = await call('list_projects', {});
  assert.equal(projects.isError, false, JSON.stringify(projects));
  assert.ok(Array.isArray(projects.value), JSON.stringify(projects));
  say(8, `list_projects, read through the host's api line: ${projects.value.length} project(s).`);

  say(9, cli('revoke', '--name', 'try-door'));
  const refused = await call('propose_effect', {
    operation: 'outbox.write',
    args: { name: 'later.txt', content: 'too late' },
    description: 'Leave another note.',
    idempotencyKey: 'try-door-2',
  });
  assert.equal(refused.isError, true, JSON.stringify(refused));
  assert.equal(refused.reason, 'NO_MANDATE', JSON.stringify(refused));
  assert.ok(!existsSync(join(home, 'outbox/later.txt')), 'a refused call wrote a file');
  say(10, `After revoke the same door is refused: ${refused.reason}, and nothing was written.`);
  console.log('OK: host, grant, receipt, file, status, read, revoke and refusal all behaved as documented.');
} catch (error) {
  console.error(`FAILED: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally {
  await client?.close().catch(() => {});
  if (host && host.exitCode === null) await new Promise((r) => (host.once('exit', r), host.kill('SIGTERM')));
  await removeDataHome(home).catch(() => {});
}
