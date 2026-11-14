// Trusted composition settings and sealed collector headers. Nothing here reaches a model or API line.
import { governedPolicy, telemetryDecision, PolicyRefused } from '../policy/index.ts';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { removeDurable, writeDurable } from '@backbone-next/kernel/files';
import { withHomeLock } from '../composition/home-lock.ts';
import { assertHomeWriteAdmission } from '../composition/home-lock.ts';
import { Vault, type HomeKeys } from '../keys/vault.ts';
import { CredentialStore } from './store.ts';

export interface TelemetrySettings { endpoint: string }

function objectFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* Refuse without exposing a malformed record, which may hold secrets. */ }
  throw new Error('Telemetry settings need inspection.');
}

/** The exporter repeats this policy at its transport boundary to avoid a runtime dependency cycle. */
export function collectorEndpoint(value: string): string {
  try {
    const url = new URL(value);
    const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
    const secure = url.protocol === 'https:' || (url.protocol === 'http:' && loopback);
    if (value.length <= 2048 && secure && url.hostname && url.pathname !== '/' && url.pathname !== '' && !url.username && !url.password && !value.includes('?') && !value.includes('#') && !/[\s\x00-\x1f]/.test(value)) return url.href;
  } catch { /* The same fixed diagnostic covers malformed or unsafe input without echoing it. */ }
  throw new Error('Use an HTTPS collector traces URL, or HTTP on localhost, 127.0.0.0/8 or ::1, with an explicit path and no credentials, query or fragment. Store authentication with telemetry header.');
}

export function readTelemetrySettings(home: string): TelemetrySettings | undefined {
  const policy = governedPolicy(home);
  const value = objectFile(join(home, 'settings.json')).telemetry;
  let personal: string | false | undefined;
  if (value === false) personal = false;
  else if (value !== undefined) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'endpoint') || typeof (value as TelemetrySettings).endpoint !== 'string') throw new Error('Telemetry settings need inspection.');
    personal = collectorEndpoint((value as TelemetrySettings).endpoint);
  }
  const endpoint = telemetryDecision(policy, personal);
  return endpoint ? { endpoint: collectorEndpoint(endpoint) } : undefined;
}

export async function putTelemetryEndpoint(home: string, endpoint: string | undefined): Promise<void> {
  const checked = endpoint === undefined ? undefined : collectorEndpoint(endpoint);
  await withHomeLock(join(home, 'credentials', 'telemetry-settings'), async () => {
    const path = join(home, 'settings.json'), settings = objectFile(path);
    const policy = governedPolicy(home);
    const effective = telemetryDecision(policy, checked ?? false);
    if (effective !== checked) throw new PolicyRefused('requirement', 'The telemetry setting is fixed by policy and cannot be changed here.');
    const retired = checked === undefined ? headerHandles(home) : {};
    if (checked === undefined) {
      if (policy?.defaults.telemetryEndpoint) settings.telemetry = false;
      else delete settings.telemetry;
    }
    else settings.telemetry = { endpoint: checked };
    assertHomeWriteAdmission(home, home, join(home, 'credentials'));
    writeDurable(path, JSON.stringify(settings));
    if (checked === undefined) {
      // Revocation deletes sealed records by handle and needs no key or vault access.
      const store = new CredentialStore(home, async () => { throw new Error('Credential revocation does not open the vault.'); });
      for (const handle of Object.values(retired)) store.revoke(handle);
      assertHomeWriteAdmission(home, join(home, 'credentials'));
      removeDurable(join(home, 'credentials', 'telemetry.json'));
    }
  });
}

/** Bound and validate before sealing or passing values to the HTTP exporter. */
export function collectorHeaders(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Pipe a JSON object of collector header names and string values on standard input.');
  const entries = Object.entries(value);
  if (entries.length > 32) throw new Error('Too many collector headers.');
  const headers: Record<string, string> = Object.create(null);
  for (const [name, content] of entries) {
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]{1,128}$/i.test(name) || ['host', 'content-length', 'connection', 'transfer-encoding', 'content-type'].includes(name.toLowerCase()) || typeof content !== 'string' || content.length > 8192 || /[^\t\x20-\x7e\x80-\xff]/.test(content)) throw new Error('Collector headers contain an invalid name or value.');
    if (Object.hasOwn(headers, name.toLowerCase())) throw new Error('Collector header names must be unique.');
    headers[name.toLowerCase()] = content;
  }
  return headers;
}

function headerHandles(home: string): Record<string, string> {
  const index = objectFile(join(home, 'credentials', 'telemetry.json'));
  try {
    collectorHeaders(index);
    if (Object.values(index).some(handle => typeof handle !== 'string' || !/^cred_[0-9a-f-]{36}$/.test(handle))) throw new Error();
    return index as Record<string, string>;
  } catch { throw new Error('Collector credential handles need inspection.'); }
}

/** Configuration inspection only: validate the index without opening the vault or resolving handles. */
export function storedTelemetryHeaderCount(home: string): number {
  return Object.keys(headerHandles(home)).length;
}

export async function putTelemetryHeaders(home: string, value: unknown, keys?: HomeKeys): Promise<void> {
  governedPolicy(home);
  const checked = collectorHeaders(value);
  const vault = await Vault.open(home, keys), store = new CredentialStore(home, () => vault.masterKey());
  await withHomeLock(join(home, 'credentials', 'telemetry-settings'), async () => {
    const prior = headerHandles(home), next: Record<string, string> = Object.create(null);
    try {
      for (const [name, content] of Object.entries(checked)) next[name] = await store.put(content, 'telemetry collector header');
      assertHomeWriteAdmission(home, join(home, 'credentials'));
      writeDurable(join(home, 'credentials', 'telemetry.json'), JSON.stringify(next));
    } catch (error) { for (const handle of Object.values(next)) store.revoke(handle); throw error; }
    for (const handle of Object.values(prior)) store.revoke(handle);
  });
}

export async function resolveTelemetryHeaders(home: string, keys?: HomeKeys): Promise<Record<string, string>> {
  const handles = headerHandles(home);
  if (!Object.keys(handles).length) return {};
  const vault = await Vault.open(home, keys), store = new CredentialStore(home, () => vault.masterKey());
  try {
    const headers: Record<string, string> = Object.create(null);
    for (const [name, handle] of Object.entries(handles)) headers[name] = await store.resolve(handle);
    return collectorHeaders(headers);
  }
  catch { throw new Error('Collector credentials could not be opened. Store them again with telemetry header.'); }
}
