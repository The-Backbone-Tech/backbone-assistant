// The embedded PostgreSQL 18 primitives every cluster here starts from: the core's personal and test
// clusters and the v0.8 kernel's. They know nothing of any schema.
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, readFileSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/**
 * Where the embedded PostgreSQL 18 binaries are: `binDir`'s parent when stated (a packaged app ships
 * them), otherwise the embedded-postgres package's build for this machine. Install scripts are off
 * (docs/adr/0001), so the package's library symlinks are restored here.
 */
export function binaries(native?: string): { initdb: string; postgres: string } {
  if (!native) {
    const require = createRequire(import.meta.url);
    const root = dirname(require.resolve('embedded-postgres'));
    native = join(dirname(createRequire(join(root, 'index.js')).resolve(`@embedded-postgres/${process.platform}-${process.arch}`)), '..', 'native');
  }
  const links = join(native, 'pg-symlinks.json');
  if (existsSync(links)) {
    for (const { source, target } of JSON.parse(readFileSync(links, 'utf8')) as { source: string; target: string }[]) {
      const at = join(native, '..', target);
      if (existsSync(at)) continue;
      try {
        symlinkSync(relative(dirname(at), join(native, '..', source)), at);
      } catch (error) {
        // Another process restoring the same link first is the same result.
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
  }
  return { initdb: join(native, 'bin/initdb'), postgres: join(native, 'bin/postgres') };
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))));
    });
  });
}

/** Wait until the server at `url` accepts connections, or the child exits. */
export async function ready(url: string, child?: ChildProcess, log = () => ''): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const c = new pg.Client({ connectionString: url });
    try {
      await c.connect();
      await c.end();
      return;
    } catch (error) {
      await c.end().catch(() => {});
      if (attempt > 150 || (child && child.exitCode !== null)) throw new Error(`postgres did not start: ${(error as Error).message}\n${log()}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

/** Stop `server` and remove `dir` if this process dies without stopping them (cluster-guard.mjs). */
export function guardCluster(server: ChildProcess, dir: string): void {
  spawn(process.execPath, [fileURLToPath(new URL('./cluster-guard.mjs', import.meta.url)), String(process.pid), String(server.pid), dir], { detached: true, stdio: 'ignore' }).unref();
}
