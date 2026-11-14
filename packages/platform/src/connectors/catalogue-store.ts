import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeDurable } from '@backbone-next/kernel/files';
import { catalogueScopes, type CatalogueId, type CatalogueApp, type CataloguePreset } from '../api-catalogue.ts';
import { assertHomeWriteAdmission, withHomeLock } from '../composition/home-lock.ts';
import { Vault, type HomeKeys } from '../keys/vault.ts';
import { CredentialStore } from '../credentials/store.ts';
import { parseJsonc } from '../tools/jsonc.ts';
import { applyEdits, modify } from 'jsonc-parser';
import type { ServerLaunch } from './client.ts';
import { canonicalDefinitionDigest } from './client.ts';
import { catalogueLaunch } from './catalogue.ts';
import { ownServers } from './discover.ts';
import { binaryDigest, verifiedBinaryDigest, installCatalogueGithub } from './catalogue-install.ts';
import { installCatalogueGoogle } from './catalogue-google-install.ts';
import { catalogueRecords, saveCatalogueRecords } from './catalogue-records.ts';
import { googleCache, googleCachePath, googleTokens, assertGoogleScopes, removeGoogleCache, removeGoogleInstallation, revokeCatalogueToken, type CatalogueRevocation, type RevocationEndpoints } from './catalogue-revocation.ts';
import { movesCredentialCache } from './credential-args.ts';
import { catalogueOAuth, GITHUB_OAUTH, SLACK_OAUTH, type CatalogueOAuthEndpoints } from './catalogue-oauth.ts';

export interface CatalogueEnvelope { id: CatalogueId; instance: string; handle: string; configuration: string; preset: CataloguePreset; binaryDigest?: string }
interface Credentials { id: CatalogueId; instance: string; app: CatalogueApp; launchDigest?: string; binaryDigest?: string; preset: CataloguePreset; scopes: string; googleCache?: string; access_token?: string; expiresAt?: number }
const launchDigest = (launch: ServerLaunch) => canonicalDefinitionDigest({ transport: launch.transport, command: launch.command ?? null,
  args: launch.args ?? [], env: launch.env ?? {}, cwd: launch.cwd ?? null, url: launch.url ?? null, headers: launch.headers ?? {} });
/** Trusted constructor seams only; these are never accepted from a renderer or config file. */
export interface CatalogueRuntime {
  launch?(id: CatalogueId, preset: CataloguePreset): Promise<ServerLaunch>;
  revocation?: RevocationEndpoints;
  oauth?: Partial<Record<'github' | 'slack', CatalogueOAuthEndpoints>>;
  googleAuthorizationOrigin?: string;
}
type Config = { mcpServers: Record<string, Record<string, unknown>>; [key: string]: unknown };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export function catalogueEnvelope(value: unknown): value is CatalogueEnvelope {
  return object(value) && ['calendar', 'drive', 'github', 'slack'].includes(value.id as string) && typeof value.instance === 'string' && /^[0-9a-f-]{36}$/.test(value.instance)
    && typeof value.handle === 'string' && /^cred_[0-9a-f-]{36}$/.test(value.handle) && typeof value.configuration === 'string' && /^[0-9a-f]{64}$/.test(value.configuration)
    && ['reads', 'reads-and-effects'].includes(value.preset as string)
    && (value.id !== 'github' || typeof value.binaryDigest === 'string')
    && (value.binaryDigest === undefined || typeof value.binaryDigest === 'string' && /^[0-9a-f]{64}$/.test(value.binaryDigest));
}

export class CatalogueStore {
  private readonly pending = new Map<CatalogueId, AbortController>();
  private readonly home: string;
  private readonly keys?: HomeKeys;
  readonly runtime: CatalogueRuntime;
  constructor(home: string, keys?: HomeKeys, runtime: CatalogueRuntime = {}) { this.home = home; this.keys = keys; this.runtime = runtime; }
  private async credentials() {
    // Deliberately no ambient fallback: catalogue secrets use the Host's exact key provider.
    if (!this.keys) throw new Error('Catalogue sign-in needs the Host key provider.');
    const vault = await Vault.open(this.home, this.keys);
    return new CredentialStore(this.home, () => vault.masterKey());
  }
  private config(): Config {
    const file = ownServers(this.home);
    const config = existsSync(file) ? parseJsonc(readFileSync(file, 'utf8')) : { mcpServers: {} };
    if (!object(config) || !object(config.mcpServers)) throw new Error('The existing connector configuration needs inspection; it was preserved.');
    return config as Config;
  }
  private save(id: CatalogueId, entry: Record<string, unknown> | undefined) {
    const file = ownServers(this.home);
    const original = existsSync(file) ? readFileSync(file, 'utf8') : '{"mcpServers":{}}\n';
    const next = applyEdits(original, modify(original, ['mcpServers', `catalogue-${id}`], entry, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
    assertHomeWriteAdmission(this.home, dirname(file)); mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    assertHomeWriteAdmission(this.home, dirname(file)); writeDurable(file, next);
  }
  cancel(id: CatalogueId) { this.pending.get(id)?.abort(); }
  close() { for (const controller of this.pending.values()) controller.abort(); }
  /** Only this fixed, installation-owned cache move can pass the normal cache-move refusal. */
  ownedGoogleCache(launch: ServerLaunch): boolean {
    const e = launch.catalogue;
    if (!e || !catalogueEnvelope(e) || !['calendar', 'drive'].includes(e.id)) return false;
    const { WORKSPACE_MCP_CREDENTIALS_DIR: cache, ...rest } = launch.env ?? {};
    return cache === googleCachePath(this.home, e.instance) && !movesCredentialCache({ ...launch, env: rest });
  }
  internalExecutable(launch: ServerLaunch): boolean {
    return !!launch.catalogue && catalogueEnvelope(launch.catalogue) && !!launch.command
      && resolve(launch.command).startsWith(resolve(this.home, 'connectors', 'bin') + '/');
  }
  async install(id: CatalogueId, app: CatalogueApp, open: (url: string) => Promise<void>, preset: CataloguePreset = 'reads'): Promise<CatalogueEnvelope> {
    if (!object(app) || typeof app.clientId !== 'string' || !app.clientId || typeof app.clientSecret !== 'string' || !app.clientSecret
      || [app.clientId, app.clientSecret].some(v => v.length > 8192 || /[\r\n\0]/.test(v))
      || !['reads', 'reads-and-effects'].includes(preset)
      || (app.redirectPort !== undefined && (!Number.isInteger(app.redirectPort) || app.redirectPort < 1024 || app.redirectPort > 65535))
      || ((id === 'calendar' || id === 'drive') && (typeof app.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(app.email)))) throw new Error('Choose an OAuth app file with clientId, clientSecret and, for Google, email.');
    if (this.pending.has(id)) throw new Error('This sign-in is already in progress.');
    const controller = new AbortController(); this.pending.set(id, controller);
    const signal = controller.signal, instance = randomUUID(), google = id === 'calendar' || id === 'drive';
    let store: CredentialStore | undefined, issued: string | undefined; const created: string[] = [];
    try {
      store = await this.credentials();
      if (Object.hasOwn(this.config().mcpServers, `catalogue-${id}`) || catalogueRecords(this.home).installs[id]) throw new Error('Disconnect this installation before reconnecting.');
      const scopes = catalogueScopes(id, preset), bundle: Credentials = { id, instance, app, preset, scopes };
      if (id === 'github' || id === 'slack') {
        const endpoints = this.runtime.oauth?.[id] ?? (id === 'github' ? GITHUB_OAUTH : SLACK_OAUTH);
        const tokens = await catalogueOAuth(app, { ...endpoints, scope: scopes }, open, signal);
        issued = bundle.access_token = tokens.access_token;
        const requested = new Set(scopes.split(/\s+/));
        if (!tokens.scope || tokens.scope.split(/[\s,]+/).filter(Boolean).some(scope => !requested.has(scope))) throw new Error('The provider returned unconfirmed or broader OAuth scopes.');
        if (tokens.expires_in) bundle.expiresAt = Date.now() + tokens.expires_in * 1000;
      }
      signal.throwIfAborted();
      const binary = !this.runtime.launch ? id === 'github' ? await installCatalogueGithub(this.home, signal)
        : google ? await installCatalogueGoogle(this.home, instance, signal) : undefined : undefined;
      const launch = await (this.runtime.launch?.(id, preset) ?? Promise.resolve(catalogueLaunch(id, binary?.path, preset)));
      if (google) {
        const cache = await withHomeLock(this.home, async () => googleCache(this.home, instance, true));
        bundle.googleCache = cache;
        launch.env = { ...launch.env, WORKSPACE_MCP_CREDENTIALS_DIR: cache };
      }
      signal.throwIfAborted();
      bundle.binaryDigest = binary ? verifiedBinaryDigest(binary, launch.command)
        : launch.transport === 'stdio' && launch.command ? binaryDigest(launch.command) : undefined;
      if (id === 'github' && !bundle.binaryDigest) throw new Error('A pinned local GitHub executable is required.');
      bundle.launchDigest = launchDigest(launch);
      const clientSecret = await store.put(app.clientSecret, `catalogue-${id}-app`); created.push(clientSecret);
      bundle.app = { ...app, clientSecret };
      if (bundle.access_token) { bundle.access_token = await store.put(bundle.access_token, `catalogue-${id}-token`); created.push(bundle.access_token); }
      const handle = await store.put(JSON.stringify(bundle), `catalogue-${id}`); created.push(handle);
      const envelope: CatalogueEnvelope = { id, instance, handle, preset, configuration: canonicalDefinitionDigest(launch), ...(bundle.binaryDigest ? { binaryDigest: bundle.binaryDigest } : {}) };
      await withHomeLock(this.home, async () => {
        signal.throwIfAborted();
        const config = this.config(), records = catalogueRecords(this.home);
        if (Object.hasOwn(config.mcpServers, `catalogue-${id}`) || records.installs[id]) throw new Error('A connector already uses this catalogue name.');
        records.installs[id] = envelope; saveCatalogueRecords(this.home, records);
        this.save(id, { ...launch, backboneCatalogue: envelope });
      });
      created.length = 0; return envelope;
    } catch (error) {
      if (!store) throw error;
      const revocation = issued ? await revokeCatalogueToken(id, app, issued, this.runtime.revocation) : 'not-needed';
      if (google) await withHomeLock(this.home, async () => { removeGoogleCache(this.home, instance); removeGoogleInstallation(this.home, instance); });
      await withHomeLock(this.home, async () => {
        const records = catalogueRecords(this.home);
        if (records.installs[id]?.instance === instance) delete records.installs[id];
        try { const entry = this.config().mcpServers[`catalogue-${id}`]; if (entry && catalogueEnvelope(entry.backboneCatalogue) && entry.backboneCatalogue.instance === instance) this.save(id, undefined); } catch { /* Preserve any person-owned malformed config. */ }
        records.receipts.push({ id, instance, at: new Date().toISOString(), revocation, reason: 'install-failed' }); saveCatalogueRecords(this.home, records);
      });
      throw error;
    } finally {
      for (const handle of created) store?.revoke(handle);
      if (this.pending.get(id) === controller) this.pending.delete(id);
    }
  }
  async resolve(launch: ServerLaunch): Promise<ServerLaunch> {
    const envelope = launch.catalogue;
    if (!envelope) return launch;
    if (!catalogueEnvelope(envelope)) throw new Error('The catalogue integrity metadata is invalid.');
    const store = await this.credentials();
    const value: unknown = JSON.parse(await store.resolve(envelope.handle));
    if (!object(value) || !object(value.app)) throw new Error('The catalogue credential is unavailable.');
    const bundle = value as unknown as Credentials;
    if (bundle.id !== envelope.id || bundle.instance !== envelope.instance) throw new Error('This credential belongs to another connection.');
    if (bundle.preset !== envelope.preset || bundle.scopes !== catalogueScopes(bundle.id, bundle.preset)) throw new Error('The installation scopes or preset changed.');
    if (bundle.launchDigest !== launchDigest(launch)) throw new Error('The installed catalogue launch changed. It was not started with these credentials.');
    const secret = await store.resolve(bundle.app.clientSecret);
    const token = bundle.access_token ? await store.resolve(bundle.access_token) : undefined;
    if (bundle.expiresAt && bundle.expiresAt <= Date.now()) throw new Error('This sign-in expired. Disconnect and connect again.');
    if (envelope.id === 'github' && !bundle.binaryDigest) throw new Error('The sealed GitHub executable pin is missing.');
    if (bundle.binaryDigest && (!launch.command || binaryDigest(launch.command) !== bundle.binaryDigest || envelope.binaryDigest !== bundle.binaryDigest)) throw new Error('The installed executable changed. Disconnect and install the pinned release again.');
    launch = { ...launch, executableDigest: bundle.binaryDigest };
    if (envelope.id === 'github') return { ...launch, env: { ...launch.env, GITHUB_PERSONAL_ACCESS_TOKEN: token! } };
    if (envelope.id === 'slack') return { ...launch, headers: { ...launch.headers, Authorization: `Bearer ${token}` } };
    if (!this.ownedGoogleCache(launch) || bundle.googleCache !== launch.env?.WORKSPACE_MCP_CREDENTIALS_DIR) throw new Error('The Google credential folder changed.');
    if (!bundle.googleCache || !existsSync(bundle.googleCache) || googleCache(this.home, envelope.instance) !== bundle.googleCache) throw new Error('The Google credential folder is unavailable.');
    assertGoogleScopes(this.home, envelope.instance, bundle.scopes);
    return { ...launch, env: { ...launch.env, GOOGLE_OAUTH_CLIENT_ID: bundle.app.clientId, GOOGLE_OAUTH_CLIENT_SECRET: secret, USER_GOOGLE_EMAIL: bundle.app.email! } };
  }
  async disconnect(id: CatalogueId): Promise<{ configurationKept?: true; revocation: CatalogueRevocation }> {
    this.cancel(id);
    // The private index still identifies our secrets when the public server entry is gone/broken.
    let entry: Record<string, unknown> | undefined;
    try { entry = this.config().mcpServers[`catalogue-${id}`]; } catch { /* Preserve malformed user config. */ }
    const envelope = catalogueRecords(this.home).installs[id] ?? (entry && catalogueEnvelope(entry.backboneCatalogue) && entry.backboneCatalogue.id === id ? entry.backboneCatalogue : undefined);
    if (!envelope) return { revocation: 'not-needed' };
    const store = await this.credentials();
    const value: unknown = await store.resolve(envelope.handle).then(value => JSON.parse(value)).catch(() => undefined);
    // An index/config handle alone never authorizes revocation or filesystem cleanup.
    if (!object(value) || value.id !== id || value.instance !== envelope.instance || !object(value.app)
      || typeof value.app.clientId !== 'string' || typeof value.app.clientSecret !== 'string' || !/^cred_[0-9a-f-]{36}$/.test(value.app.clientSecret)
      || !['reads', 'reads-and-effects'].includes(value.preset as string) || value.scopes !== catalogueScopes(id, value.preset as CataloguePreset)
      || (value.access_token !== undefined && (typeof value.access_token !== 'string' || !/^cred_[0-9a-f-]{36}$/.test(value.access_token)))) {
      throw new Error('This credential is not the matching catalogue installation.');
    }
    const bundle = value as unknown as Credentials;
    if ((id === 'calendar' || id === 'drive') && bundle.googleCache !== googleCachePath(this.home, envelope.instance)) throw new Error('The Google credential folder changed.');
    let revocation: CatalogueRevocation = 'unknown';
    try {
      if (id === 'calendar' || id === 'drive') {
        const tokens = googleTokens(this.home, envelope.instance);
        const results = await Promise.all(tokens.map(token => revokeCatalogueToken(id, bundle.app, token, this.runtime.revocation)));
        revocation = results.length ? results.every(result => result === 'revoked') ? 'revoked' : 'unknown' : 'not-needed';
      } else if (bundle.access_token) {
        const token = await store.resolve(bundle.access_token), secret = await store.resolve(bundle.app.clientSecret);
        revocation = await revokeCatalogueToken(id, { ...bundle.app, clientSecret: secret }, token, this.runtime.revocation);
      }
    } catch { revocation = 'unknown'; }
    // Local cleanup is unconditional even when the provider answer was lost. No automatic retry.
    return withHomeLock(this.home, async () => {
      let cacheFailed = false;
      try { if (id === 'calendar' || id === 'drive') { removeGoogleCache(this.home, envelope.instance); removeGoogleInstallation(this.home, envelope.instance); } } catch { cacheFailed = true; revocation = 'unknown'; }
      store.revoke(bundle.app.clientSecret); if (bundle.access_token) store.revoke(bundle.access_token);
      store.revoke(envelope.handle);
      let configurationKept: true | undefined;
      try {
        const current = this.config().mcpServers[`catalogue-${id}`];
        if (current) {
          const { backboneCatalogue: _metadata, ...launch } = current;
          if (catalogueEnvelope(current.backboneCatalogue) && current.backboneCatalogue.id === id && current.backboneCatalogue.handle === envelope.handle && current.backboneCatalogue.instance === envelope.instance && canonicalDefinitionDigest(launch) === envelope.configuration) this.save(id, undefined);
          else configurationKept = true;
        }
      } catch { configurationKept = true; }
      const records = catalogueRecords(this.home);
      if (records.installs[id]?.instance === envelope.instance && records.installs[id]?.handle === envelope.handle) delete records.installs[id];
      records.receipts.push({ id, instance: envelope.instance, revocation, reason: 'disconnect', at: new Date().toISOString() }); saveCatalogueRecords(this.home, records);
      if (cacheFailed) throw new Error('Local authority was removed but Google cache cleanup needs inspection.');
      return { ...(configurationKept ? { configurationKept } : {}), revocation };
    });
  }
}
