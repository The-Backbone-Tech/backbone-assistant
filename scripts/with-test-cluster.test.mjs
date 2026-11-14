import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { waitFor } from './lib/test-hang.ts';

const launcher = fileURLToPath(new URL('./with-test-cluster.mjs', import.meta.url));
const root = fileURLToPath(new URL('..', import.meta.url));
const scratch = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'cluster-test-'));
  scratch.push(dir);
  return dir;
};
after(() => scratch.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('the command reaches the run\'s cluster, its status is kept, and the cluster goes with it', () => {
  const dir = tmp();
  // The command connects as the installer and exits 7: the status must come back unchanged.
  const reach = `const pg = require('pg'); const t = JSON.parse(process.env.BACKBONE_TEST_PG);
    const c = new pg.Client({ connectionString: 'postgres://postgres:' + t.admin + '@127.0.0.1:' + t.port + '/postgres' });
    c.connect().then(() => c.query('SELECT datname FROM pg_database')).then((r) => { console.log(r.rows.map((x) => x.datname).join()); return c.end(); }).then(() => process.exit(7));`;
  const run = spawnSync(process.execPath, [launcher, process.execPath, '-e', reach], { cwd: root, env: { ...process.env, TMPDIR: dir }, encoding: 'utf8' });
  assert.equal(run.status, 7, run.stderr);
  assert.match(run.stdout, /backbone_template/);
  assert.deepEqual(readdirSync(dir), [], 'the cluster\'s folder is removed');
});

test('a launcher that is killed outright still takes its cluster down', async () => {
  const dir = tmp();
  const hold = `console.log(process.pid); setInterval(() => {}, 1000);`;
  const launched = spawn(process.execPath, [launcher, process.execPath, '-e', hold], { cwd: root, env: { ...process.env, TMPDIR: dir }, stdio: ['ignore', 'pipe', 'inherit'] });
  const held = Number(await new Promise((resolve) => launched.stdout.once('data', (chunk) => resolve(String(chunk).trim()))));
  const cluster = readdirSync(dir).find((name) => name.startsWith('backbone-pg-'));
  assert.ok(cluster, 'the cluster is running while the command runs');
  const server = Number(readFileSync(join(dir, cluster, 'data', 'postmaster.pid'), 'utf8').split('\n')[0]);
  assert.ok(alive(server));
  launched.kill('SIGKILL');
  process.kill(held, 'SIGKILL');
  // These joins detect hung cleanup; no product promises a 20-second teardown under load.
  const diagnostic = () => JSON.stringify({ server, alive: alive(server), folder: join(dir, cluster), entries: readdirSync(dir) });
  await waitFor(() => !alive(server), 'killed cluster owner: guard stops PostgreSQL', { diagnostic });
  assert.equal(alive(server), false, 'the server was stopped by the guard');
  await waitFor(() => !existsSync(join(dir, cluster)), 'killed cluster owner: guard removes folder', { diagnostic });
  assert.equal(existsSync(join(dir, cluster)), false, 'and its folder removed');
});

test('an owner killed after Ctrl-C already stopped the server still has its folder removed', async () => {
  const dir = tmp();
  const hold = `console.log(process.pid); setInterval(() => {}, 1000);`;
  const launched = spawn(process.execPath, [launcher, process.execPath, '-e', hold], { cwd: root, env: { ...process.env, TMPDIR: dir }, stdio: ['ignore', 'pipe', 'inherit'] });
  const held = Number(await new Promise((resolve) => launched.stdout.once('data', (chunk) => resolve(String(chunk).trim()))));
  const cluster = readdirSync(dir).find((name) => name.startsWith('backbone-pg-'));
  const server = Number(readFileSync(join(dir, cluster, 'data', 'postmaster.pid'), 'utf8').split('\n')[0]);
  // The terminal's SIGINT stops the server first; a runner that does not wait for its teardown (vitest) dies after it.
  process.kill(server, 'SIGINT');
  const diagnostic = () => JSON.stringify({ server, alive: alive(server), folder: join(dir, cluster), entries: readdirSync(dir) });
  await waitFor(() => !alive(server), 'interrupted cluster stops PostgreSQL', { diagnostic });
  assert.equal(alive(server), false);
  assert.ok(existsSync(join(dir, cluster)), 'the owner has not cleaned up');
  launched.kill('SIGKILL');
  process.kill(held, 'SIGKILL');
  await waitFor(() => !existsSync(join(dir, cluster)), 'interrupted owner: guard removes folder', { diagnostic });
  assert.equal(existsSync(join(dir, cluster)), false, 'the guard removed the folder');
});

test('Ctrl-C stops the command, then the cluster, and reports the interrupt', async () => {
  const dir = tmp();
  // A group of its own stands in for the terminal's foreground group, which Ctrl-C signals as a whole.
  const launched = spawn(process.execPath, [launcher, process.execPath, '-e', 'console.log("up"); setInterval(() => {}, 1000);'], {
    cwd: root,
    env: { ...process.env, TMPDIR: dir },
    stdio: ['ignore', 'pipe', 'inherit'],
    detached: true,
  });
  await new Promise((resolve) => launched.stdout.once('data', resolve));
  const exited = new Promise((resolve) => launched.once('exit', (code, signal) => resolve({ code, signal })));
  process.kill(-launched.pid, 'SIGINT');
  assert.deepEqual(await exited, { code: 130, signal: null });
  assert.deepEqual(readdirSync(dir), [], 'the cluster is gone');
});
