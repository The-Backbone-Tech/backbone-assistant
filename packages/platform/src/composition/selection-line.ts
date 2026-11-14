// The selection calls a same-user surface may carry. Unknown fields grant nothing.
import type { TaskNeeds } from '../api.ts';

export function selectionTask(input: unknown): TaskNeeds | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const a = input as Record<string, unknown>;
  if (!Array.isArray(a.needs) || !a.needs.length || a.needs.length > 4 || !a.needs.every((n) => ['model', 'code', 'files', 'mail'].includes(n)) || typeof a.network !== 'boolean' || !['none', 'plan', 'metered'].includes(a.spend as string) || (a.structured !== undefined && typeof a.structured !== 'boolean')) return null;
  if (a.evidenceQuery !== undefined && (typeof a.evidenceQuery !== 'string' || !a.evidenceQuery.trim() || a.evidenceQuery.length > 200 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(a.evidenceQuery) || a.evidenceQuery.startsWith('-'))) return null;
  return { needs: a.needs as TaskNeeds['needs'], network: a.network, spend: a.spend as TaskNeeds['spend'], ...(a.structured === undefined ? {} : { structured: a.structured as boolean }), ...(a.evidenceQuery === undefined ? {} : { evidenceQuery: a.evidenceQuery as string }) };
}
