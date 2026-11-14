/**
 * What an authority covers along one axis (projects, connections, tools, operations): either an
 * explicit list of identifiers, or `'*'`, which means "whatever the grantor itself covers" and never
 * more. A root mandate's `'*'` is bounded by the workspace, which the database enforces.
 */
export type SetSpec = '*' | readonly string[];

export const ALL: SetSpec = '*';

/** The same set, sorted and without repeats, so that equal sets compare equal. */
export function normalize(spec: SetSpec): SetSpec {
  return spec === '*' ? '*' : [...new Set(spec)].sort();
}

export function covers(spec: SetSpec, id: string): boolean {
  return spec === '*' || spec.includes(id);
}

/** What both sets cover. */
export function intersect(a: SetSpec, b: SetSpec): SetSpec {
  if (a === '*') return normalize(b);
  if (b === '*') return normalize(a);
  return normalize(a.filter((id) => b.includes(id)));
}

/** True when `child` covers nothing that `parent` does not. */
export function isSubset(child: SetSpec, parent: SetSpec): boolean {
  if (parent === '*') return true;
  return child !== '*' && child.every((id) => parent.includes(id));
}
