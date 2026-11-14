import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { CatalogueApp, CatalogueId } from '../api-catalogue.ts';
import { assertHomeWriteAdmission } from '../composition/home-lock.ts';
export type CatalogueRevocation = 'revoked' | 'unknown' | 'not-needed';
export type RevocationEndpoints = Partial<Record<'google' | 'github' | 'slack', string>>;
export const googleCachePath = (home: string, instance: string) => {
  if (!/^[0-9a-f-]{36}$/.test(instance)) throw new Error('Invalid catalogue installation.');
  return join(realpathSync(home), 'connectors', 'google', instance);
};
/** Each component is checked without following links before any cache read, write or deletion. */
export function googleCache(home: string, instance: string, create = false): string {
  googleCachePath(home, instance); // Validate before joining or inspecting any component.
  let path = realpathSync(home);
  for (const part of ['connectors', 'google', instance]) {
    path = join(path, part);
    try { const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) throw new Error('The Google credential folder changed.'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!create) return googleCachePath(realpathSync(home), instance);
      assertHomeWriteAdmission(home, path); mkdirSync(path, { mode: 0o700 });
    }
    if (create && part !== 'connectors') { assertHomeWriteAdmission(home, path); chmodSync(path, 0o700); }
  }
  return path;
}
function googleCredentials(home: string, instance: string): Record<string, unknown>[] {
  const path = googleCache(home, instance);
  let files: string[];
  try { files = readdirSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const credentials: Record<string, unknown>[] = [];
  for (const name of files.filter(name => name.endsWith('.json'))) {
    const fd = openSync(join(path, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('Google credential data needs inspection.');
      const data = JSON.parse(readFileSync(fd, 'utf8')) as Record<string, unknown>;
      if (data && typeof data === 'object' && !Array.isArray(data)) credentials.push(data);
    } finally { closeSync(fd); }
  }
  return credentials;
}
export function googleTokens(home: string, instance: string): string[] {
  return [...new Set(googleCredentials(home, instance).map(data =>
    typeof data.refresh_token === 'string' && data.refresh_token || data.token).filter((token): token is string => typeof token === 'string' && !!token))];
}
/** Empty caches are expected before consent; any issued token needs confirmed, narrowed scopes. */
export function assertGoogleScopes(home: string, instance: string, scopes: string) {
  const allowed = new Set(scopes.split(/\s+/));
  for (const data of googleCredentials(home, instance)) {
    if (!data.token && !data.refresh_token) continue; // Upstream may also persist OAuth state.
    if (!Array.isArray(data.scopes) || !data.scopes.length || data.scopes.some(scope => typeof scope !== 'string' || !allowed.has(scope))) {
      throw new Error('The provider returned unconfirmed or broader OAuth scopes.');
    }
  }
}
/** Called after the server stops, under the home lock. Never follow a replaced bin directory. */
export function removeGoogleInstallation(home: string, instance: string) {
  googleCachePath(home, instance);
  let path = realpathSync(home);
  for (const part of ['connectors', 'bin', `google-${instance}`]) {
    path = join(path, part);
    try {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) throw new Error('The Google installation folder changed.');
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  }
  assertHomeWriteAdmission(home, path); rmSync(path, { recursive: true, force: true });
}
export function removeGoogleCache(home: string, instance: string) {
  const path = googleCache(home, instance);
  if (resolve(path) !== resolve(googleCachePath(realpathSync(home), instance))) throw new Error('The Google credential folder changed.');
  assertHomeWriteAdmission(home, path); rmSync(path, { recursive: true, force: true });
}
/** A single bounded provider request. A dropped or rejected answer stays UNKNOWN, never retried. */
export async function revokeCatalogueToken(id: CatalogueId, app: CatalogueApp, token: string, endpoints: RevocationEndpoints = {}): Promise<CatalogueRevocation> {
  try {
    let url: string, init: RequestInit;
    if (id === 'calendar' || id === 'drive') {
      url = endpoints.google ?? 'https://oauth2.googleapis.com/revoke';
      init = { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }) };
    } else if (id === 'github') {
      url = endpoints.github ?? `https://api.github.com/applications/${encodeURIComponent(app.clientId)}/token`;
      init = { method: 'DELETE', headers: { Authorization: `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString('base64')}`, 'Content-Type': 'application/json', Accept: 'application/vnd.github+json' }, body: JSON.stringify({ access_token: token }) };
    } else {
      url = endpoints.slack ?? 'https://slack.com/api/auth.revoke';
      init = { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: '' };
    }
    const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(20_000) });
    if (id === 'github') return response.status === 204 ? 'revoked' : 'unknown';
    if (id === 'calendar' || id === 'drive') return response.status === 200 ? 'revoked' : 'unknown';
    const text = await response.text();
    const result = text.length < 16384 ? JSON.parse(text) as { ok?: boolean; revoked?: boolean } : undefined;
    return response.ok && result?.ok === true && result.revoked === true ? 'revoked' : 'unknown';
  } catch { return 'unknown'; }
}
