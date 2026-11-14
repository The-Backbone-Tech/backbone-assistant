import { childHangTimer } from '../../../../scripts/lib/test-child.ts';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { readAudit, verifyAudit } from '@backbone-next/platform/audit';
import { createHost, hostClosed, removeDataHome } from '@backbone-next/platform/composition';
import { exportAuditHome } from '@backbone-next/platform/composition/audit-home';
import { DAEMON_READY, observeChild } from '../../../../scripts/lib/test-child.ts';
import { attachApi } from '@backbone-next/platform/doors/api-line';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';

const homes: string[] = [], dirs: string[] = [], children: ChildProcess[] = [];
async function stop(c: ChildProcess) {
  if (c.exitCode !== null || c.signalCode !== null) return;
  const exited = new Promise<void>(r => c.once('exit', () => r()));
  c.kill('SIGTERM'); const timer = childHangTimer(c, 'audit-daemon.test: child completion/shutdown');
  try { await exited; } finally { clearTimeout(timer); }
}
after(async () => { for (const c of children) await stop(c); for (const h of homes) await removeDataHome(h); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const period = { since: '2000-01-01T00:00:00Z', until: '2100-01-01T00:00:00Z' };
function run(home: string, person: string, args: string[]) {
  const env = { ...process.env, HOME: person, XDG_CONFIG_HOME: person, BACKBONE_USER_HOME: person,
    BACKBONE_HOME: home, BACKBONE_KEYS: 'plaintext', BACKBONE_HARNESS: 'stub' };
  const child = spawn(process.execPath, [join(import.meta.dirname, '../src/main.ts'), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  const output = observeChild(child, 'audit daemon');
  const seen = { get out() { return output.stdout; }, get err() { return output.stderr; } };
  const done = new Promise<{ code: number | null; out: string; err: string }>(r => child.once('close', code => r({ code, ...seen })));
  return { child, seen, done, output };
}

test('the CLI exports the held daemon home through its API line and verifies the JSONL offline', { timeout: 300_000 }, async () => {
  const home = freshDataHome('audit-daemon'); homes.push(home);
  const person = mkdtempSync(join(tmpdir(), 'audit-daemon-person-')); dirs.push(person);
  const host = createHost({ home });
  try { assert.equal((await host.call('projects.create', { name: 'Before daemon', kind: 'folder' })).ok, true); }
  finally { host.close(); await hostClosed(home); }
  const daemon = run(home, person, ['daemon', 'run']);
  try {
    await daemon.output.waitForOutput(DAEMON_READY);
    const pid = JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8')).pid;
    assert.equal(pid, daemon.child.pid);
    await assert.rejects(exportAuditHome(home, period, async()=>{}), /live owner/, 'standalone bypass stays closed while the daemon owns the home');
    const exported = await run(home, person, ['audit', 'export', '--since', period.since, '--until', period.until]).done;
    assert.equal(exported.code, 0, exported.err); assert.ok(verifyAudit(exported.out).count > 0);
    const header=readAudit(exported.out).header;assert.equal(header.includeContent,false);assert.equal(header.transport,'api-line');
    assert.deepEqual(header.exportedBy,{kind:'same-user-process',uid:process.getuid?.()??null});
    const content = await run(home, person, ['audit', 'export', '--since', period.since, '--until', period.until, '--include-content']).done;
    assert.equal(content.code,1);assert.match(content.err,/Content can be exported only by a command/);assert.equal(content.out,'');
    assert.equal(daemon.child.exitCode, null); assert.ok(existsSync(join(home, 'daemon.json')));
    const line = await attachApi(home); assert.ok(line); try { assert.equal((await line.call('projects.list', {})).length, 1); } finally { line.close(); }
  } finally { await stop(daemon.child); await daemon.done; }
});
