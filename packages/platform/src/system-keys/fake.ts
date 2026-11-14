// Explicitly injected in tests; production selection never constructs this store.
import type { SystemKeyStore } from './store.ts';

export class MemoryKeyStore implements SystemKeyStore {
  readonly items = new Map<string, Buffer>();
  usable = true;
  failAfterWrite = false;
  reads = 0;
  writes = 0;
  async available(): Promise<boolean> { return this.usable; }
  async get(account: string): Promise<Buffer | null> {
    this.reads++;
    if (!this.usable) throw new Error('Unavailable fake store');
    const key = this.items.get(account);
    return key ? Buffer.from(key) : null;
  }
  async create(account: string, key: Buffer): Promise<void> {
    if (!this.usable || this.items.has(account)) throw new Error('Fake store refused creation');
    this.items.set(account, Buffer.from(key)); this.writes++;
    if (this.failAfterWrite) throw new Error('Interrupted fake write');
  }
}
