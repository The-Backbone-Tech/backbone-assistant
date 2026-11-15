import { PDF_CANVAS_LIMIT } from './preview-boundary.ts';

// Change this whenever preview ceilings or conversion rules change. Keep only the
// latest 32 failures so files no longer visited cannot grow storage indefinitely.
export const PREVIEW_LIMITS_VERSION = '5';
const KEY = 'document-preview-failures';
interface Failure { key: string; message: string }
function read(): Failure[] {
  try {
    const legacy = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).filter(k => k?.startsWith('document-preview-failure:'));
    for (const key of legacy) localStorage.removeItem(key!);
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const value = raw.length <= 100000 ? JSON.parse(raw) : undefined;
    if (value?.limits !== PREVIEW_LIMITS_VERSION || !Array.isArray(value.failures)) { localStorage.removeItem(KEY); return []; }
    return value.failures.filter((f: Failure) => typeof f?.key === 'string' && typeof f.message === 'string' && f.message.length <= 500 && f.message !== PDF_CANVAS_LIMIT).slice(-32);
  } catch { return []; }
}
export function rememberedFailure(key?: string): string | undefined { return read().find(f => f.key === key)?.message; }
export function rememberFailure(key: string | undefined, message: string): void {
  if (!key || message === PDF_CANVAS_LIMIT) return;
  const failures = [...read().filter(f => f.key !== key), { key, message }].slice(-32);
  try { localStorage.setItem(KEY, JSON.stringify({ limits: PREVIEW_LIMITS_VERSION, failures })); } catch { /* Limits hold without storage. */ }
}
export function forgetFailure(key?: string): void {
  const failures = read().filter(f => f.key !== key);
  try { localStorage.setItem(KEY, JSON.stringify({ limits: PREVIEW_LIMITS_VERSION, failures })); } catch { /* Explicit attempts work without storage. */ }
}
