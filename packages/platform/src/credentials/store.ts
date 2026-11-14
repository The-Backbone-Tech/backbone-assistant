// Sealed credentials, held by handle (docs/contracts/secrets.md). A value is sealed with AES-256-GCM
// under a master key kept apart from the sealed records and from the core's database: in the data
// home's vault (keys/vault.ts), whose own key the Keychain holds. Modules and models only ever see a
// handle; resolving one is for the composition, at request time.
// The successor core has no sealed-secrets store yet; this one sits behind the same handle API, so
// the core's (or a broker's) can replace it and must pass the same canary tests.
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeDurable } from '@backbone-next/kernel/files';
import { assertHomeWriteAdmission } from '../composition/home-lock.ts';
import { isKeychainHandle, KEYCHAIN_SERVICES, type KeychainReader } from './keychain.ts';

interface Sealed {
  label: string;
  iv: string;
  tag: string;
  data: string;
  at: string;
}

const HANDLE = /^cred_[0-9a-f-]{36}$/;

export class CredentialStore {
  private readonly dir: string;
  private readonly home: string;
  private readonly master: () => Promise<Buffer>;
  private readonly keychain?: KeychainReader;

  /**
   * `master` gives the master key (the vault's `masterKey`), made on first use. `keychain`, given only
   * by the desktop app, also lets the handles in KEYCHAIN_SERVICES name keys the person stored there.
   */
  constructor(home: string, master: () => Promise<Buffer>, keychain?: KeychainReader) {
    this.home = home;
    this.dir = join(home, 'credentials');
    this.master = master;
    this.keychain = keychain;
  }

  private path(handle: string): string {
    if (!HANDLE.test(handle)) throw new Error('Not a credential handle.');
    return join(this.dir, `${handle}.json`);
  }

  /** Seal a value; returns its handle. The value is never written in the clear. */
  async put(value: string, label: string): Promise<string> {
    const handle = `cred_${randomUUID()}`;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', await this.master(), iv);
    cipher.setAAD(Buffer.from(handle));
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const sealed: Sealed = { label, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64'), at: new Date().toISOString() };
    assertHomeWriteAdmission(this.home, this.dir);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeDurable(this.path(handle), JSON.stringify(sealed));
    return handle;
  }

  has(handle: string | null | undefined): boolean {
    if (isKeychainHandle(handle)) return !!this.keychain?.has(KEYCHAIN_SERVICES[handle]);
    return !!handle && HANDLE.test(handle) && existsSync(this.path(handle));
  }

  /** The value, for the composition at request time only. */
  async resolve(handle: string): Promise<string> {
    if (isKeychainHandle(handle)) {
      if (!this.keychain) throw new Error('This host does not read the Keychain.');
      return this.keychain.read(KEYCHAIN_SERVICES[handle]);
    }
    if (!this.has(handle)) throw new Error('That credential was removed; set it again in Settings.');
    const sealed = JSON.parse(readFileSync(this.path(handle), 'utf8')) as Sealed;
    const decipher = createDecipheriv('aes-256-gcm', await this.master(), Buffer.from(sealed.iv, 'base64'));
    decipher.setAAD(Buffer.from(handle));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]).toString('utf8');
  }

  /**
   * Every value this store holds, sealed here or named in the Keychain, so a reader can keep each one
   * out of anything it stores or hands on. A value that cannot be opened makes this fail: a caller
   * that cannot check refuses, rather than storing unchecked.
   */
  async values(): Promise<string[]> {
    const handles = existsSync(this.dir) ? readdirSync(this.dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).filter((h) => HANDLE.test(h)) : [];
    const keychain = (Object.keys(KEYCHAIN_SERVICES) as (keyof typeof KEYCHAIN_SERVICES)[]).filter((h) => this.has(h));
    return Promise.all([...handles, ...keychain].map((h) => this.resolve(h)));
  }

  /** Replace the value behind a new handle and revoke the old one. */
  async rotate(handle: string, value: string): Promise<string> {
    const label = this.has(handle) ? (JSON.parse(readFileSync(this.path(handle), 'utf8')) as Sealed).label : 'credential';
    const next = await this.put(value, label);
    this.revoke(handle);
    return next;
  }

  revoke(handle: string): void {
    if (HANDLE.test(handle)) {
      assertHomeWriteAdmission(this.home, this.dir);
      rmSync(this.path(handle), { force: true });
    }
  }
}
