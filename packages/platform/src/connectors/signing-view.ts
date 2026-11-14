// A bounded description of schema capabilities for the native signing question, never authority.
import { SENDING_ARG } from './signature-coverage.ts';
export function argumentView(schema: Record<string, unknown>, hide: (text: string) => string) {
  const names = new Set<string>();
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    const s = node as Record<string, unknown>;
    for (const key of ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']) {
      const children = s[key];
      if (children && typeof children === 'object' && !Array.isArray(children)) for (const [name, child] of Object.entries(children)) {
        if (key === 'properties') names.add(name);
        visit(child);
      }
    }
    for (const key of ['items', 'additionalProperties', 'contains', 'not', 'if', 'then', 'else', 'propertyNames', 'unevaluatedProperties']) visit(s[key]);
    for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) if (Array.isArray(s[key])) for (const child of s[key]) visit(child);
  };
  visit(schema);
  const sendingArguments = [...names].some(name => SENDING_ARG.test(name));
  const clean = (name: string) => hide(name).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  return { argumentNames: [...names].slice(0, 20).map(clean), additionalArgumentNames: Math.max(0, names.size - 20), sendingArguments,
    ...(sendingArguments ? { argumentWarning: 'This tool can also send, publish, post, share, deliver, notify or broadcast, depending on its arguments.' } : {}) };
}
