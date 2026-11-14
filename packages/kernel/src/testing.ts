// One disposable PostgreSQL 18 holding the pinned kernel, for tests: its own cluster, apart from the
// core's, because roles belong to a cluster. fsync is off; stop() ends the server and removes its
// folder, and a guard does both if the test process dies first.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { binaries, freePort, guardCluster, ready } from './cluster.ts';
import { type KernelLogins, provisionKernel } from './provision.ts';

export interface KernelCluster extends KernelLogins {
  /** The superuser on the kernel's database, for test fixtures that write rows directly. */
  adminUrl: string;
  stop(): Promise<void>;
}

export async function startKernelCluster(): Promise<KernelCluster> {
  const { initdb, postgres } = binaries();
  const dir = mkdtempSync(join(tmpdir(), 'backbone-kernel-'));
  let child: ChildProcess | undefined;
  const stop = async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child?.once('exit', resolve));
      child.kill('SIGINT');
      await exited;
    }
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    const admin = randomBytes(18).toString('hex');
    const port = await freePort(); const data = join(dir, 'data'); const database = `kernel_${randomBytes(4).toString('hex')}`;
    writeFileSync(join(dir, 'pw'), admin);
    const init = spawnSync(initdb, ['-D', data, '-U', 'postgres', '--auth=scram-sha-256', `--pwfile=${join(dir, 'pw')}`, '-E', 'UTF8', '--locale=C'], { encoding: 'utf8' });
    rmSync(join(dir, 'pw'));
    if (init.status !== 0) throw new Error(`initdb failed: ${init.stderr}`);
    child = spawn(postgres, ['-D', data, '-p', String(port), '-c', 'unix_socket_directories=', '-c', 'listen_addresses=127.0.0.1', '-c', 'fsync=off', '-c', 'log_parameter_max_length=0'], { stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr?.resume();
    guardCluster(child, dir);
    const url = (db: string) => `postgres://postgres:${admin}@127.0.0.1:${port}/${db}`;
    await ready(url('postgres'), child);
    const first = new pg.Client({ connectionString: url('postgres') });
    await first.connect();
    await first.query(`CREATE DATABASE ${database}`);
    await first.end();
    const logins = await provisionKernel(url(database));
    return { ...logins, adminUrl: url(database), stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
