// Adapted from OpenCode's MIT-licensed desktop storage/write-behind.ts, commit 7b1e54a7.
// Copyright (c) 2025 opencode. Full notice: ../../third_party/opencode-LICENSE.
// Keep latest-per-key coalescing, retry retention and explicit flush. Our API is asynchronous:
// one drain owns dispatch, including writes arriving while a previous request is in flight.
type Waiting = { resolve(): void; reject(error: unknown): void };
type Pending<T> = { value: T; waiting: Waiting[] };

export function createWriteBehind<T>(input: { delay: number; write(batch: Map<string, T>): Promise<void> }) {
  const pending = new Map<string, Pending<T>>();
  let current = new Map<string, Pending<T>>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void> | undefined;

  async function drain() {
    while (pending.size) {
      current = new Map(pending);
      pending.clear();
      try {
        await input.write(new Map([...current].map(([key, entry]) => [key, entry.value])));
        for (const entry of current.values()) for (const waiting of entry.waiting) waiting.resolve();
      } catch (error) {
        // A newer edit wins over a failed older write. Keep the latest payload for an explicit
        // retry, and reject its waiters too: nobody should call that newer edit saved yet.
        for (const [key, entry] of current) {
          if (!pending.has(key)) pending.set(key, { value: entry.value, waiting: [] });
          for (const waiting of entry.waiting) waiting.reject(error);
        }
        for (const entry of pending.values()) {
          for (const waiting of entry.waiting) waiting.reject(error);
          entry.waiting = [];
        }
        throw error;
      } finally {
        current.clear();
      }
    }
  }

  function flush(): Promise<void> {
    clearTimeout(timer);
    timer = undefined;
    if (active) return active;
    if (!pending.size) return Promise.resolve();
    // Publish the promise before calling the async driver, including synchronous re-entry.
    active = Promise.resolve().then(drain).finally(() => {
      active = undefined;
      // An error handler may already have queued a new edit. Retained failures have no waiters
      // and do not spin; a new request must not remain stranded behind the failed drain.
      if ([...pending.values()].some((entry) => entry.waiting.length)) schedule();
    });
    return active;
  }

  function schedule() {
    if (!active) timer ??= setTimeout(() => { void flush().catch(() => {}); }, input.delay);
  }

  return {
    get: (key: string) => (pending.get(key) ?? current.get(key))?.value,
    discard(key: string): void {
      if (current.has(key)) throw new Error('A draft write is still in flight.');
      const entry = pending.get(key); pending.delete(key);
      if (entry) for (const waiting of entry.waiting) waiting.reject(new Error('The local draft was replaced by the saved draft.'));
    },
    set(key: string, value: T): Promise<void> {
      const entry: Pending<T> = { value, waiting: pending.get(key)?.waiting ?? [] };
      pending.set(key, entry);
      const saved = new Promise<void>((resolve, reject) => entry.waiting.push({ resolve, reject }));
      schedule();
      return saved;
    },
    flush,
  };
}
