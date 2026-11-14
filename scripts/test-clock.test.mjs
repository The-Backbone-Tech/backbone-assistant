import assert from 'node:assert/strict';
import { test } from 'node:test';
import { productClock } from './lib/test-clock.ts';
import { hangDetector } from './lib/test-hang.ts';

test('a product clock leaves native I/O timers live and fires only its selected deadline', async t => {
  const nativeSet = globalThis.setTimeout, nativeClear = globalThis.clearTimeout;
  const clock = productClock(t.mock, [300]);
  try {
    let expired = false, native = false;
    setTimeout(() => { expired = true; }, 300);
    await hangDetector(new Promise(resolve => setTimeout(() => { native = true; resolve(); }, 0)), 'native I/O timer with product clock held');
    assert.equal(native, true); assert.equal(expired, false);
    clock.tick(299); assert.equal(expired, false);
    clock.tick(1); assert.equal(expired, true);
  } finally { clock.reset(); }
  assert.equal(globalThis.setTimeout, nativeSet); assert.equal(globalThis.clearTimeout, nativeClear);
});

test('selected and native timeout handles are cancelled by their own clock', t => {
  const nativeClear = globalThis.clearTimeout;
  const cancelled = [];
  t.mock.method(globalThis, 'clearTimeout', handle => { cancelled.push(handle); nativeClear(handle); });
  const clock = productClock(t.mock, [300]);
  try {
    let fired = false;
    const native = setTimeout(() => { fired = true; }, 1000);
    const selected = setTimeout(() => { fired = true; }, 300);
    clearTimeout(native); clearTimeout(selected);
    assert.deepEqual(cancelled, [native]);
    clock.tick(300); assert.equal(fired, false);
  } finally { clock.reset(); }
});
