// Personal mode keeps no password of its own in the clear: the caller says where its cluster's
// passwords are kept, and PostgreSQL is only ever given SCRAM verifiers, so no statement, server
// log or file carries a password.
import fs, { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { type ClusterPasswords, keptPasswords, openPersonalDatabase, rolePasswordSql, scramVerifier } from '../src/db/personal.ts';
import { startTestPostgres } from '../src/db/testing.ts';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('passwords reach PostgreSQL only as SCRAM verifiers', () => {
  it('a verifier made here lets the role log in with its password, and the statement that sets it carries no password', async () => {
    const postgres = await startTestPostgres();
    const password = `canary-${Math.random().toString(16).slice(2)}-password`;
    const verifier = scramVerifier(password);
    expect(verifier).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(verifier).not.toContain(password);
    const role = `scram_probe_${process.pid}`;
    const sql = rolePasswordSql(role, password, 'CREATE ROLE %I LOGIN');
    expect(sql).not.toContain(password);
    const stated = /'(SCRAM-SHA-256\$[^']+)'/.exec(sql)?.[1];
    expect(stated).toBeTruthy();
    const admin = new pg.Client({ connectionString: postgres.adminUrl('postgres') });
    await admin.connect();
    try {
      await admin.query(sql);
      const { rows } = await admin.query('SELECT rolpassword FROM pg_authid WHERE rolname = $1', [role]);
      expect(rows[0].rolpassword).toBe(stated);
      const url = new URL(postgres.adminUrl('postgres'));
      const as = (secret: string) => new pg.Client({ host: url.hostname, port: Number(url.port), database: 'postgres', user: role, password: secret });
      const ok = as(password);
      await ok.connect();
      expect((await ok.query('SELECT current_user AS who')).rows).toEqual([{ who: role }]);
      await ok.end();
      const wrong = as(`${password}x`);
      await expect(wrong.connect()).rejects.toThrow(/password authentication failed/);
      await wrong.end().catch(() => {});
    } finally {
      await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
      await admin.end();
    }
  });
});

describe('passwords a cluster kept in the clear before keepers', () => {
  it('move to the keeper with cluster.json made durable before the old file goes, the removal made durable too, and a stray pw removed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'backbone-legacy-pg-'));
    dirs.push(dir);
    const old = { admin: 'a'.repeat(36), app: 'b'.repeat(36), operator: 'c'.repeat(36) };
    writeFileSync(join(dir, 'secrets.json'), JSON.stringify({ ...old, port: 54321 }), { mode: 0o600 });
    writeFileSync(join(dir, 'pw'), old.admin, { mode: 0o600 });
    let kept: ClusterPasswords | null = null;
    const keeper = { read: async () => kept, write: async (p: ClusterPasswords) => void (kept = p) };
    const log: { op: string; path: string; to?: string }[] = [];
    const fds = new Map<number, string>();
    const real = { openSync: fs.openSync, fsyncSync: fs.fsyncSync, renameSync: fs.renameSync, rmSync: fs.rmSync, unlinkSync: fs.unlinkSync };
    Object.assign(fs, {
      openSync: (path: string, flags?: string, mode?: number) => {
        const fd = real.openSync(path, flags, mode);
        fds.set(fd, String(path));
        return fd;
      },
      fsyncSync: (fd: number) => (log.push({ op: 'fsync', path: fds.get(fd) ?? '?' }), real.fsyncSync(fd)),
      renameSync: (from: string, to: string) => (log.push({ op: 'rename', path: String(from), to: String(to) }), real.renameSync(from, to)),
      rmSync: (path: string, o?: fs.RmOptions) => (log.push({ op: 'remove', path: String(path) }), real.rmSync(path, o)),
      unlinkSync: (path: string) => (log.push({ op: 'remove', path: String(path) }), real.unlinkSync(path)),
    });
    syncBuiltinESMExports();
    let moved: Awaited<ReturnType<typeof keptPasswords>>;
    try {
      moved = await keptPasswords(dir, keeper);
    } finally {
      Object.assign(fs, real);
      syncBuiltinESMExports();
    }
    expect(moved).toEqual({ passwords: old, port: 54321 });
    expect(kept).toEqual(old);
    expect(readdirSync(dir).sort()).toEqual(['cluster.json']);
    const i = (p: (e: (typeof log)[number]) => boolean) => log.findIndex(p);
    const named = i((e) => e.op === 'rename' && e.to === join(dir, 'cluster.json'));
    const gone = i((e) => e.op === 'remove' && e.path === join(dir, 'secrets.json'));
    expect(named, JSON.stringify(log)).toBeGreaterThanOrEqual(0);
    expect(gone).toBeGreaterThan(named);
    expect(log.slice(0, named).some((e) => e.op === 'fsync' && e.path === log[named].path), 'cluster.json synced before it takes its name').toBe(true);
    expect(log.slice(named, gone).some((e) => e.op === 'fsync' && e.path === dir), 'its folder synced before the old file goes').toBe(true);
    expect(log.slice(gone).some((e) => e.op === 'fsync' && e.path === dir), 'the removal synced').toBe(true);
    expect(log.some((e) => e.op === 'remove' && e.path === join(dir, 'pw'))).toBe(true);
  });
});

describe('a cluster of its own', () => {
  it('is never made without a keeper for its passwords, and nothing is written in the clear', async () => {
    const home = mkdtempSync(join(tmpdir(), 'backbone-no-keeper-'));
    dirs.push(home);
    await expect(openPersonalDatabase({ dir: join(home, 'pg'), baselineSql: 'SELECT 1' })).rejects.toThrow(/keeper/);
    expect(existsSync(join(home, 'pg', 'secrets.json'))).toBe(false);
    expect(existsSync(join(home, 'pg', 'data'))).toBe(false);
    expect(existsSync(join(home, 'pg')) ? readdirSync(join(home, 'pg')) : []).toEqual([]);
  });
});
