// Installs the pinned kernel into an empty database and makes its three logins. Roles belong to a
// cluster, so a cluster holds one v0.8 kernel, never beside the core (both name a backbone_app).
// Passwords are made here and returned only inside the URLs; the caller keeps them (a data home's
// vault, or a test's memory). The admin URL is the cluster superuser's and is never kept by this.
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { kernelSql } from './sql.ts';

export interface KernelLogins {
  /** backbone_app: the kernel's application role. */
  appUrl: string;
  /** A login holding planes_observer, the door's role. */
  observerUrl: string;
  /** A login holding planes_identity, the only role that mints a person's session. */
  identityUrl: string;
}

export const OBSERVER_LOGIN = 'backbone_door';
export const IDENTITY_LOGIN = 'backbone_identity';

/** Apply the pinned SQL to the database at `adminUrl` (a superuser's, on an empty database) and make the logins. */
export async function provisionKernel(adminUrl: string, names = { observer: OBSERVER_LOGIN, identity: IDENTITY_LOGIN }): Promise<KernelLogins> {
  const statements = kernelSql();
  const secret = () => randomBytes(18).toString('hex');
  const app = secret(); const observer = secret(); const identity = secret();
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    for (const { sql } of statements) await c.query(sql);
    const ident = (name: string) => c.escapeIdentifier(name);
    await c.query(`ALTER ROLE backbone_app PASSWORD ${c.escapeLiteral(app)}`);
    await c.query(`CREATE ROLE ${ident(names.observer)} LOGIN NOINHERIT PASSWORD ${c.escapeLiteral(observer)}`);
    await c.query(`GRANT planes_observer TO ${ident(names.observer)}`);
    await c.query(`CREATE ROLE ${ident(names.identity)} LOGIN NOINHERIT PASSWORD ${c.escapeLiteral(identity)}`);
    await c.query(`GRANT planes_identity TO ${ident(names.identity)}`);
  } finally {
    await c.end();
  }
  const url = new URL(adminUrl);
  const as = (user: string, password: string) => {
    const u = new URL(url);
    u.username = user;
    u.password = password;
    return u.toString();
  };
  return { appUrl: as('backbone_app', app), observerUrl: as(names.observer, observer), identityUrl: as(names.identity, identity) };
}
