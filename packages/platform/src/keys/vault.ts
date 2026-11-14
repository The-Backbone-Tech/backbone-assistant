import { governedPolicy, keyDecision } from '../policy/index.ts';
// The data home's secrets at rest (README, "Secrets at rest"): the cluster's passwords and the master
// key that seals model credentials. One vault, keys/vault.json: each secret sealed with AES-256-GCM
// under one data key, and the data key wrapped by what the caller holds: the Keychain's key, through
// the desktop app (Electron safeStorage), or, for tests and headless trials only, nothing at all
// (plaintext), which the app refuses. A same-user process reading the home finds only ciphertext.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EXTERNAL_DATABASE_FILE, type ClusterPasswords, type PasswordKeeper } from '@backbone/core/db';
import { removeDurable, writeDurable } from '@backbone-next/kernel/files';
import { assertHomeWriteAdmission, withHomeLock } from '../composition/home-lock.ts';

/** Who holds the key that wraps the data key. A vault opens only with keys of its own holder. */
export type KeyHolder = 'keychain' | 'plaintext';

export interface HomeKeys {
  readonly holder: KeyHolder;
  /** How the data key is wrapped, recorded beside it (lab S22): `electron-safeStorage`, `none`, … */
  readonly wrap: string;
  wrapKey(key: Buffer): Promise<Buffer>;
  /** `rewrap` when the holder's own key rotated and the data key should be wrapped again. */
  unwrapKey(wrapped: Buffer, options?: {readOnly?: boolean}): Promise<{ key: Buffer; rewrap: boolean }>;
}

/** Why a vault did not open: its keys are elsewhere, it is a test home, or nobody chose keys. */
export class KeysRefused extends Error {
  readonly code: 'held-by-app' | 'plaintext-home' | 'test-database' | 'no-keys' | 'not-unwrapped' | 'no-keychain';
  constructor(code: KeysRefused['code'], message: string) {
    super(message);
    this.code = code;
  }
}

interface Entry {
  alg: 'A256GCM';
  iv: string;
  tag: string;
  data: string;
}
interface VaultFile {
  format: 1;
  holder: KeyHolder;
  wrap: string;
  /** The data key, wrapped as `wrap` says (base64). */
  key: string;
  entries: Record<string, Entry>;
}

const VAULT = ['keys', 'vault.json'];
/**
 * The vault's own lock (keys/.lock), apart from the data home's: a holder of the home's lock (a
 * tool being connected) may wait on a core link that is opening this vault, so sharing it would
 * deadlock them. Nothing under this lock takes another.
 */
const vaultLock = <T>(home: string, fn: () => Promise<T>) => withHomeLock(join(home, 'keys'), fn);
/** The master key's file before the vault: moved in once, then removed. */
const LEGACY_MASTER = ['keys', 'master.key'];
const MASTER = 'credentials.master';
const PASSWORDS = 'pg';
const vaultPath = (home: string) => join(home, ...VAULT);

/** No key at all: the data key is written as it is. For tests and headless trials; the app refuses such a home. */
export function plaintextKeys(): HomeKeys {
  return { holder: 'plaintext', wrap: 'none', wrapKey: async (key) => key, unwrapKey: async (wrapped) => ({ key: wrapped, rewrap: false }) };
}

/** What `keychainKeys` needs of Electron's safeStorage (its async calls; the sync ones go in Electron 46). */
export interface SafeStorage {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(plainText: string): Promise<Buffer>;
  decryptStringAsync(encrypted: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
  getSelectedStorageBackend?(): string;
}

/**
 * The Keychain's key, through Electron's safeStorage: one key per app in the login Keychain, which
 * another app cannot load without the person's override. Refused where safeStorage would fall back
 * to a key in plain text (Linux without a keyring).
 */
export function keychainKeys(store: SafeStorage): HomeKeys {
  const usable = async () => {
    if (!(await store.isAsyncEncryptionAvailable())) throw new KeysRefused('no-keychain', 'The system keychain is not available, so this data home\'s keys cannot be kept; the app does not keep them in plain text.');
    if (process.platform === 'linux' && store.getSelectedStorageBackend?.() === 'basic_text') {
      throw new KeysRefused('no-keychain', 'No keyring is running, so safeStorage would keep the key in plain text; start one (GNOME Keyring or KWallet) and open the app again.');
    }
  };
  return {
    holder: 'keychain',
    wrap: 'electron-safeStorage',
    async wrapKey(key) {
      await usable();
      return store.encryptStringAsync(key.toString('base64'));
    },
    async unwrapKey(wrapped) {
      await usable();
      const { result, shouldReEncrypt } = await store.decryptStringAsync(wrapped);
      return { key: Buffer.from(result, 'base64'), rewrap: shouldReEncrypt };
    },
  };
}

/** `BACKBONE_KEYS=plaintext` chooses plaintext keys for a command run by hand or a test; anything else chooses none. */
export function keysFromEnvironment(env: NodeJS.ProcessEnv = process.env): HomeKeys | undefined {
  const named = env.BACKBONE_KEYS;
  if (!named) return undefined;
  if (named !== 'plaintext') throw new Error('BACKBONE_KEYS takes only `plaintext` (a test home); the app keeps a real home\'s keys in the Keychain.');
  return plaintextKeys();
}

function seal(key: Buffer, name: string, value: Buffer): Entry {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(name));
  const data = Buffer.concat([cipher.update(value), cipher.final()]);
  return { alg: 'A256GCM', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

function unseal(key: Buffer, name: string, entry: Entry): Buffer {
  if (entry.alg !== 'A256GCM') throw new Error(`The vault's ${name} is sealed with ${entry.alg}, which this version cannot open.`);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(entry.iv, 'base64'));
  decipher.setAAD(Buffer.from(name));
  decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(entry.data, 'base64')), decipher.final()]);
}

const readVault = (home: string): VaultFile | null => {
  const policy = governedPolicy(home);
  const file = existsSync(vaultPath(home)) ? JSON.parse(readFileSync(vaultPath(home), 'utf8')) as VaultFile : null;
  if (file) keyDecision(policy, file.holder);
  return file;
};
/** Written as cluster.json is (`writeDurable`): owner-only from its first byte, on disk before it takes the name. */
function writeVault(home: string, file: VaultFile): void {
  keyDecision(governedPolicy(home), file.holder);
  assertHomeWriteAdmission(home, join(home, 'keys'));
  mkdirSync(join(home, 'keys'), { recursive: true, mode: 0o700 });
  chmodSync(join(home, 'keys'), 0o700);
  writeDurable(vaultPath(home), `${JSON.stringify(file, null, 2)}\n`);
}

/**
 * Data keys this process unwrapped, per keys and home, with the wrapped key they came from: the
 * Keychain is asked once per process, and other keys never reuse what these unwrapped.
 */
const unwrappedBy = new WeakMap<HomeKeys, Map<string, { wrapped: string; key: Buffer }>>();
const homes = new Set<Map<string, { wrapped: string; key: Buffer }>>();
const unwrapped = (keys: HomeKeys) => {
  let m = unwrappedBy.get(keys);
  if (!m) {
    m = new Map();
    unwrappedBy.set(keys, m);
    homes.add(m);
  }
  return m;
};

export class Vault {
  readonly home: string;
  readonly holder: KeyHolder;
  private readonly key: Buffer;
  private readonly readOnly: boolean;

  private constructor(home: string, holder: KeyHolder, key: Buffer, readOnly = false) {
    this.home = home;
    this.holder = holder;
    this.key = key;
    this.readOnly = readOnly;
  }

  /** Forget the data key this process holds for `home` (a removed home, or a test that rewrote its files). */
  static forget(home: string): void {
    for (const m of homes) m.delete(resolve(home));
  }

  /**
   * Open the home's vault with `keys`, or make it. A vault opens only with keys of its holder: a
   * Keychain-held one never without them, and Keychain keys never open a plaintext vault or a home
   * that borrows a test database. With no vault and no keys, nothing is made. A master key left in
   * the clear by an earlier version moves in once.
   */
  static async open(home: string, keys?: HomeKeys, options: {readOnly?: boolean} = {}): Promise<Vault> {
    const readOnly = !!options.readOnly;
    if (!readOnly) assertHomeWriteAdmission(home,join(home,'keys'));
    const at = resolve(home);
    let file = readVault(home);
    if (readOnly && (!file || existsSync(join(home, ...LEGACY_MASTER)))) {
      throw new KeysRefused('no-keys', 'This home needs a writable open to complete its vault or migrate legacy keys; nothing was changed.');
    }
    if (file?.holder ?? keys?.holder) keyDecision(governedPolicy(home), (file?.holder ?? keys!.holder));
    else governedPolicy(home);
    if (keys?.holder === 'keychain' && file?.holder !== 'plaintext' && existsSync(join(home, 'pg', EXTERNAL_DATABASE_FILE))) {
      throw new KeysRefused('test-database', 'This data home borrows a test database whose passwords are in plain text; the app opens only a home with a database of its own.');
    }
    if (!file) {
      if (!keys) {
        throw new KeysRefused('no-keys', 'This data home has no keys yet, and none were chosen: the app keeps them in the Keychain. For a test home whose keys are in plain text, set BACKBONE_KEYS=plaintext.');
      }
      file = await vaultLock(home, async () => {
        const now = readVault(home);
        if (now) { keyDecision(governedPolicy(home), now.holder); return now; }
        keyDecision(governedPolicy(home), keys.holder);
        const key = randomBytes(32);
        const made: VaultFile = { format: 1, holder: keys.holder, wrap: keys.wrap, key: (await keys.wrapKey(key)).toString('base64'), entries: {} };
        writeVault(home, made);
        unwrapped(keys).set(at, { wrapped: made.key, key });
        return made;
      });
    }
    const vault = new Vault(home, file.holder, await dataKey(home, file, keys, readOnly), readOnly);
    if (existsSync(join(home, ...LEGACY_MASTER))) await vault.moveLegacyMaster();
    return vault;
  }

  /** The secret kept under `name`, or null. */
  get(name: string): Buffer | null {
    keyDecision(governedPolicy(this.home), this.holder);
    const entry = readVault(this.home)?.entries[name];
    return entry ? unseal(this.key, name, entry) : null;
  }

  /** Keep `value` under `name`, holding the home's lock so two processes never drop each other's entries. */
  put(name: string, value: Buffer): Promise<void> {
    if (this.readOnly) throw new KeysRefused('no-keys', 'This vault was opened read-only; nothing was changed.');
    keyDecision(governedPolicy(this.home), this.holder);
    return vaultLock(this.home, async () => {
      const file = readVault(this.home);
      if (!file) throw new Error('The vault was removed while this data home was open.');
      file.entries[name] = seal(this.key, name, value);
      writeVault(this.home, file);
    });
  }

  /** The secret under `name`, made (32 random bytes by default) and kept the first time. */
  async ensure(name: string, make: () => Buffer = () => randomBytes(32)): Promise<Buffer> {
    assertHomeWriteAdmission(this.home, join(this.home, 'keys'));
    const kept = this.get(name);
    if (kept) return kept;
    if (this.readOnly) throw new KeysRefused('no-keys', 'This vault was opened read-only and the requested key is missing; use a writable open to prepare it.');
    return vaultLock(this.home, async () => {
      const now = this.get(name);
      if (now) return now;
      const value = make();
      await this.put(name, value);
      return value;
    });
  }

  /** The keeper the core's personal mode takes for its cluster's passwords. */
  passwords(): PasswordKeeper {
    return {
      read: async () => {
        const kept = this.get(PASSWORDS);
        return kept ? (JSON.parse(kept.toString('utf8')) as ClusterPasswords) : null;
      },
      write: (passwords) => this.put(PASSWORDS, Buffer.from(JSON.stringify(passwords))),
    };
  }

  /** The key that seals model credentials (credentials/store.ts). */
  masterKey(): Promise<Buffer> {
    return this.ensure(MASTER);
  }

  private moveLegacyMaster(): Promise<void> {
    const legacy = join(this.home, ...LEGACY_MASTER);
    return vaultLock(this.home, async () => {
      if (!existsSync(legacy)) return;
      // Kept in the vault first; the file goes only once the vault holds it.
      if (!this.get(MASTER)) await this.put(MASTER, readFileSync(legacy));
      assertHomeWriteAdmission(this.home, join(this.home, 'keys'));
      removeDurable(legacy);
    });
  }
}

async function dataKey(home: string, file: VaultFile, keys: HomeKeys | undefined, readOnly = false): Promise<Buffer> {
  keyDecision(governedPolicy(home), file.holder);
  if (file.holder === 'plaintext') {
    if (keys && keys.holder !== 'plaintext') {
      throw new KeysRefused('plaintext-home', 'This data home keeps its keys in plain text (a test home, or a headless trial); the app opens only a home whose keys the Keychain holds.');
    }
    return Buffer.from(file.key, 'base64');
  }
  if (!keys || keys.holder !== 'keychain') {
    throw new KeysRefused('held-by-app', 'This data home\'s keys are held in the Keychain by the app: open the app, which serves the doors and grants and revokes them.');
  }
  if (keys.wrap !== file.wrap) throw new KeysRefused('not-unwrapped', `This data home's key is wrapped by ${file.wrap}, not ${keys.wrap}.`);
  const at = resolve(home);
  const known = unwrapped(keys).get(at);
  if (known?.wrapped === file.key) return known.key;
  let opened: { key: Buffer; rewrap: boolean };
  try {
    opened = await keys.unwrapKey(Buffer.from(file.key, 'base64'), {readOnly});
  } catch (error) {
    if (error instanceof KeysRefused) throw error;
    throw new KeysRefused('not-unwrapped', 'The Keychain did not give this data home\'s key back, so nothing in it can be opened.');
  }
  if (opened.key.length !== 32) throw new KeysRefused('not-unwrapped', 'The Keychain gave back something that is not this data home\'s key.');
  let wrapped = file.key;
  if (opened.rewrap && !readOnly) {
    // The holder's own key rotated: the same data key is wrapped again, and nothing else changes.
    wrapped = await vaultLock(home, async () => {
      const now = readVault(home)!;
      now.key = (await keys.wrapKey(opened.key)).toString('base64');
      writeVault(home, now);
      return now.key;
    });
  }
  if (!readOnly || !opened.rewrap) unwrapped(keys).set(at, { wrapped, key: opened.key });
  return opened.key;
}

/**
 * Tests only: a plaintext vault for a fresh home, written at once (freshDataHome), so the home is a
 * test home before anything opens it. The app refuses it.
 */
export function writePlaintextVault(home: string): void {
  keyDecision(governedPolicy(home), 'plaintext');
  if (readVault(home)) return;
  writeVault(home, { format: 1, holder: 'plaintext', wrap: 'none', key: randomBytes(32).toString('base64'), entries: {} });
}
