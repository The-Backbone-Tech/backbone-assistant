import { type ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// The sizes in styles.css: without this, text-ui reads as a colour and removes the real one.
const twMerge = extendTailwindMerge({ extend: { theme: { text: ['ui', 'caption'] } } });

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function duration(from: string, to?: string): string {
  const ms = Math.max(0, (to ? Date.parse(to) : Date.now()) - Date.parse(from));
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined;
  const run = (...a: A) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
  /** Drops a pending call, so a stale write cannot land after a newer one. */
  run.cancel = () => clearTimeout(t);
  return run;
}

/**
 * Focuses an element on the next task, not during the keystroke that opened it, so a shortcut's own
 * key never lands in the new field.
 */
export function focusSoon(el: () => HTMLElement | null | undefined) {
  const before = document.activeElement;
  const t = setTimeout(() => {
    // Opening may finish after the person already moved into the view. Respect that focus.
    if (document.activeElement === before || document.activeElement === document.body) el()?.focus();
  }, 0);
  return () => clearTimeout(t);
}
