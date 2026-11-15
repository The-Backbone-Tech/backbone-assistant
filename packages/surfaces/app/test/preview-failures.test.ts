import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rememberedFailure, rememberFailure, forgetFailure, PREVIEW_LIMITS_VERSION } from '../src/components/files/preview-failures.ts';
import { PDF_CANVAS_LIMIT, READ_FAILURE } from '../src/components/files/preview-boundary.ts';

test('failure records are bounded, versioned, forgettable and never keep a zoom refusal', () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); }, key: (i: number) => [...values.keys()][i] ?? null, get length() { return values.size; }, clear() { values.clear(); } };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
  try {
    storage.setItem('document-preview-failure:legacy:1', READ_FAILURE);
    for (let i = 0; i < 40; i++) rememberFailure(`material:${i}`, READ_FAILURE);
    const record = JSON.parse(storage.getItem('document-preview-failures')!);
    assert.equal(record.limits, PREVIEW_LIMITS_VERSION);
    assert.equal(record.failures.length, 32);
    assert.equal(storage.getItem('document-preview-failure:legacy:1'), null);
    assert.equal(rememberedFailure('material:0'), undefined);
    assert.equal(rememberedFailure('material:39'), READ_FAILURE);
    rememberFailure('zoom:1', PDF_CANVAS_LIMIT);
    assert.equal(rememberedFailure('zoom:1'), undefined);
    forgetFailure('material:39');
    assert.equal(rememberedFailure('material:39'), undefined);
    storage.setItem('document-preview-failures', JSON.stringify({ ...record, limits: 'old-limits' }));
    assert.equal(rememberedFailure('material:38'), undefined);
    assert.equal(storage.getItem('document-preview-failures'), null);
    storage.setItem('document-preview-failures', '{invalid');
    assert.equal(rememberedFailure('material:38'), undefined);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
