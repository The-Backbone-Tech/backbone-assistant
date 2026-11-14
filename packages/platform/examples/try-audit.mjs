// Disposable audit readback: an actual CLI export, offline verification and per-line schema check.
// Run through scripts/with-test-cluster.mjs so this example shares the run's temporary PostgreSQL.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHost, hostClosed, removeDataHome } from '../src/composition/host.ts';
import { freshDataHome } from '../src/testing/data-home.ts';
import { readAudit } from '../src/audit.ts';

// The repository already uses Ajv for schema checks; the exporter itself has no Ajv dependency.
const Ajv = createRequire(new URL('../../../package.json', import.meta.url))('ajv');
const home = freshDataHome('audit-guide');
const output = mkdtempSync(join(tmpdir(), 'audit-guide-output-'));
const host = createHost({ home, harness: 'harness-stub' });
try {
  const project = await host.call('projects.create', { name: 'Audit example', kind: 'folder' });
  assert.ok(project.ok);
  const sent = await host.call('turns.send', { projectId: project.value.id, text: 'Write a brief', attachments: [],
    settings: { permission: 'ask', model: 'stub', effort: 3, runsOn: 'this-computer', mode: 'chat' }, clientKey: 'audit-guide' });
  assert.ok(sent.ok);
  let finished = false;
  for (let i = 0; i < 300; i++) {
    const thread = await host.call('threads.get', { id: sent.value.threadId });
    assert.ok(thread.ok);
    if (!thread.value.summary.running) { finished = true; break; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(finished, 'the disposable stub turn finished');
  host.close(); await hostClosed(home);
  const file = join(output, 'record.jsonl');
  const cli = fileURLToPath(new URL('../../surfaces/cli/src/main.ts', import.meta.url));
  const env = { ...process.env, BACKBONE_KEYS: 'plaintext', BACKBONE_HOME: home };
  execFileSync(process.execPath, [cli, 'audit', 'export', file, '--since', '2000-01-01T00:00:00Z', '--until', '2100-01-01T00:00:00Z'], { env });
  const verified = JSON.parse(execFileSync(process.execPath, [cli, 'audit', 'verify', file, '--json'], { encoding: 'utf8' }));
  assert.equal(verified.valid, true);
  const bytes = readFileSync(file, 'utf8'), record = readAudit(bytes);
  assert.ok(record.events.some(event => event.kind === 'effect.proposed'));
  const validate = new Ajv({ allowUnionTypes: true }).compile(JSON.parse(readFileSync(new URL('../../../schemas/audit-export.schema.json', import.meta.url), 'utf8')));
  for (const line of bytes.trimEnd().split('\n')) assert.ok(validate(JSON.parse(line)), JSON.stringify(validate.errors));
  console.log(`Verified and read back ${record.events.length} events; every line matches backbone.audit.v1.`);
} finally {
  host.close(); await hostClosed(home); await removeDataHome(home); rmSync(output, { recursive: true, force: true });
}
