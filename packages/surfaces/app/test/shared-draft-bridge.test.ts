import { observeChild } from '../../../../scripts/lib/test-child.ts';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { request } from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { removeDataHome } from '@backbone-next/platform/composition';

test('ordinary drafts refuse a late body and preserve a revisioned tombstone', async () => {
  const home = freshDataHome('late-project-draft');
  const bridge = fileURLToPath(new URL('../server/bridge.ts', import.meta.url));
  const env: NodeJS.ProcessEnv = { BACKBONE_HOME: home, BACKBONE_USER_HOME: home, BACKBONE_KEYS: 'plaintext', BACKBONE_HARNESS: 'harness-stub', PORT: '0' };
  // Preserve the runner's explicit Linux evaluation admission in this otherwise isolated child.
  for (const key of ['PATH', 'TMPDIR', 'BACKBONE_TEST_PG', 'BACKBONE_EXPERIMENTAL_LINUX_HOME_LOCK']) if (process.env[key]) env[key] = process.env[key];
  const child = spawn(process.execPath, [bridge], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = observeChild(child, 'draft bridge');
  try {
    await output.waitForOutput(/127\.0\.0\.1:(\d+)/);
    const port = Number(output.stdout.match(/127\.0\.0\.1:(\d+)/)![1]);
    const url = `http://127.0.0.1:${port}/api`;
    const api = async (method: string, args: unknown) => {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, args }) });
      assert.equal(response.ok, true);
      return response.json() as Promise<any>;
    };
    // Leave the first POST's JSON body incomplete so the real bridge cannot dispatch it yet.
    const body = JSON.stringify({ method: 'drafts.put', args: { key: 'composer:synthetic', text: 'old attempt', clientKey: 'old', baseRevision: 0 } });
    const old = request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } });
    const oldResponse = new Promise<any>((resolve, reject) => { old.once('response', (response) => { let data = ''; response.on('data', chunk => data += chunk); response.once('end', () => resolve(JSON.parse(data))); }); old.once('error', reject); });
    old.write(body.slice(0, 12));
    const later = await api('drafts.put', { key: 'composer:synthetic', text: 'newer marker', clientKey: 'new', baseRevision: 0 });
    assert.equal(later.ok, true);
    assert.equal((await api('drafts.get', { key: 'composer:synthetic' })).text, 'newer marker');
    const clear = await api('drafts.put', { key: 'composer:synthetic', text: '', clientKey: 'clear', baseRevision: 1 });
    assert.equal(clear.ok, true);
    assert.equal((await api('drafts.get', { key: 'composer:synthetic' })).revision, 2);
    old.end(body.slice(12));
    const stale = await oldResponse;
    assert.equal(stale.ok, false);
    assert.equal(stale.reason, 'STALE_BASE');
    const final = await api('drafts.get', { key: 'composer:synthetic' });
    assert.equal(final.text, '');
    assert.equal(final.revision, 2);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    }
    await removeDataHome(home);
  }
});

test('a bridge signal waits for the terminal stop ladder and its saved clean-close outcome', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { createHash } = await import('node:crypto');
  const home = freshDataHome('terminal-bridge-close');
  const bridge = fileURLToPath(new URL('../server/bridge.ts', import.meta.url));
  const env: NodeJS.ProcessEnv = { BACKBONE_HOME: home, BACKBONE_USER_HOME: home, BACKBONE_KEYS: 'plaintext', BACKBONE_HARNESS: 'harness-stub', PORT: '0' };
  for (const key of ['PATH', 'TMPDIR', 'BACKBONE_TEST_PG', 'BACKBONE_EXPERIMENTAL_LINUX_HOME_LOCK']) if (process.env[key]) env[key] = process.env[key];
  const args = process.env.TERMINAL_BRIDGE_BASELINE ? ['--import', process.env.TERMINAL_BRIDGE_BASELINE, bridge] : [bridge];
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = observeChild(child, 'terminal bridge');
  let group: number | undefined, commandPid: number | undefined, birth = '';
  const identity = (pid: number) => execFileSync('/bin/ps', ['-o', 'pgid=,lstart=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    await output.waitForOutput(/127\.0\.0\.1:(\d+)/);
    const url = `http://127.0.0.1:${output.stdout.match(/127\.0\.0\.1:(\d+)/)![1]}/api`;
    const api = async (method: string, args: unknown) => {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, args }) });
      assert.equal(response.ok, true); return response.json() as Promise<any>;
    };
    const project = await api('projects.create', { name: 'Bridge close', kind: 'folder' }); assert.equal(project.ok, true);
    const projectId = project.value.id;
    const started = await api('terminal.start', { projectId, command: 'trap "" INT TERM; echo ready:$$; while :; do sleep 1; done', clientKey: 'bridge-close' }); assert.equal(started.ok, true);
    let view: any;
    const deadline = Date.now() + 12_000;
    do {
      view = await api('terminal.list', { projectId }); assert.equal(view.ok, true);
      if (view.value.commands[0].output.includes('ready')) break;
      assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 20));
    } while (true);
    const file = join(home, 'terminal', createHash('sha256').update(projectId).digest('hex') + '.json');
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    group = saved.processes[started.value.id].group;
    commandPid = Number(view.value.commands[0].output.match(/ready:(\d+)/)[1]);
    birth = identity(commandPid);
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill('SIGTERM'); await exited;
    const block = JSON.parse(readFileSync(file, 'utf8')).commands[0];
    let alive = true;
    try { process.kill(-group!, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; alive = false; }
    assert.deepEqual({ status: block.status, detail: block.detail, signals: block.signals, alive }, { status: 'failed', detail: 'Stopped: the app closed', signals: ['SIGINT', 'SIGTERM', 'SIGKILL'], alive: false });
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill('SIGTERM'); await exited; }
    if (commandPid && group && birth) try { if (identity(commandPid) === birth) process.kill(-group, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH' && (error as { status?: number }).status !== 1) throw error; }
    await removeDataHome(home);
  }
});
