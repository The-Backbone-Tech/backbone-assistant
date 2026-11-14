import type { HarnessEvent } from '@backbone-next/platform/ports';

export function channel() {
  const items: HarnessEvent[] = [];
  let wake: (() => void) | undefined, closed = false;
  return {
    push(item: HarnessEvent) { if (!closed) { items.push(item); wake?.(); } },
    close() { closed = true; wake?.(); },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (items.length) yield items.shift()!;
        else if (closed) return;
        else await new Promise<void>(resolve => { wake = resolve; });
      }
    },
  };
}
