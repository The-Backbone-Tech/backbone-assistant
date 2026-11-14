import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { TurnRequest, TurnContext } from '@backbone-next/platform/ports';
import { createAcpHarness } from '../src/index.ts';
import { Session } from '../src/session.ts';
import { sweepRetired, removeRetiredTree } from '../src/storage.ts';
const fixture = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url));
const request: TurnRequest = { threadId: 'cleanup-report', turnId: 'one', text: 'ready', history: [], attachments: [], effort: 3, resumed: false };
const context: TurnContext = { tools: { list: async () => [], read: async () => null, write: async () => ({ outcome: 'REFUSED', detail: 'no grant' }) }, route: { kind: 'agent', provider: 'acp:fake', baseUrl: '', model: 'chosen-by-agent', label: 'fake', credential: null }, credential: async () => { throw new Error('No credential'); } };
function refuseRemoval(leaf: string) {
  const unlink = fs.unlink, spawn = cp.spawn;
  fs.unlink = (async (path: Parameters<typeof unlink>[0]) => { if (String(path).includes('.retired-') && String(path).endsWith(leaf)) throw Object.assign(new Error('Injected unlink refusal'), { code: 'EPERM' }); return unlink(path); }) as typeof unlink;
  cp.spawn = ((...args: Parameters<typeof spawn>) => ['/usr/bin/find', '/bin/rm'].includes(String(args[0])) ? spawn('/usr/bin/false', [], args[2]) : spawn(...args)) as typeof spawn;
  syncBuiltinESMExports();
  return () => { fs.unlink = unlink; cp.spawn = spawn; syncBuiltinESMExports(); };
}
test('a failed sweep reports its folder in operator output across later completed turns and harness restarts', async () => {
  const storageDir = await fs.mkdtemp(join(tmpdir(), 'acp-sweep-report-'));
  const options = { acceptsProcessVisibility: true, command: process.execPath, args: [fixture], environment: 'person-rights' as const, storageDir };
  const seed = await Session.create(options, request.threadId), parent = dirname(seed.root); await seed.close(true);
  const stuck = join(parent, `.retired-${randomUUID()}`), other = join(parent, `.retired-${randomUUID()}`);
  await fs.mkdir(stuck); await fs.mkdir(other); await fs.writeFile(join(stuck, 'blocked'), 'old state');
  const restore = refuseRemoval('blocked'), h = createAcpHarness(options), stderr = process.stderr.write, reports: string[] = [];
  let second: ReturnType<typeof createAcpHarness> | undefined;
  process.stderr.write = ((chunk: string | Uint8Array) => { reports.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    const warnings = await sweepRetired(parent); assert.equal(warnings.length, 1); assert.equal(reports.length, 1, 'one failed sweep logs its tree once'); assert.match(warnings[0], /native state cleanup failed \(EPERM\)/);
    await fs.access(stuck); await assert.rejects(fs.access(other));
    const outcome = await h.start(request, context).outcome;
    assert.equal(outcome.status, 'done'); assert.match(outcome.error ?? '', /native state cleanup failed \(EPERM\)/);
    assert.ok(reports.some(line => line.includes('retired-state-removal-failed') && line.includes(stuck)), 'the operator can locate the failed tree in daemon output');
    const before = reports.length; await h.close(); second = createAcpHarness(options);
    assert.equal((await second.start({ ...request, turnId: 'two' }, context).outcome).status, 'done');
    assert.ok(reports.slice(before).some(line => line.includes(stuck)), 'a later sweep still reports the leftover after restart');
  } finally { process.stderr.write = stderr; restore(); await h.close(); await second?.close(); await removeRetiredTree(storageDir); }
});
test('a next turn affected by unconfirmed cleanup receives that reason, rather than installation or sign-in advice', async () => {
  const storageDir = await fs.mkdtemp(join(tmpdir(), 'acp-cleanup-reason-'));
  const options = { acceptsProcessVisibility: true, command: process.execPath, args: [fixture], environment: 'person-rights' as const, storageDir, env: { ACP_FAKE_MODE: 'poison-wait' } };
  const restore = refuseRemoval('native-canary'), h = createAcpHarness(options);
  try {
    const first = h.start(request, context), stream = (async () => { for await (const event of first.events) if (event.type === 'text') first.stop(); })();
    const failed = await first.outcome; await stream; assert.match(failed.error ?? '', /native state cleanup failed \(EPERM\)/);
    options.env.ACP_FAKE_MODE = 'normal';
    const next = await h.start({ ...request, turnId: 'two' }, context).outcome;
    assert.equal(next.status, 'failed'); assert.match(next.error ?? '', /native state cleanup is unconfirmed/); assert.doesNotMatch(next.error ?? '', /installation|sign-in/);
  } finally { restore(); await h.close(); await removeRetiredTree(storageDir); }
});
