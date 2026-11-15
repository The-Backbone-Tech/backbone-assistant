import assert from 'node:assert/strict';
import { test } from 'node:test';
import { onComposerFocusRequest, requestComposerFocus, takeComposerFocusRequest } from '../src/lib/composer-focus.ts';

test('a request for the message box is taken once, tells a mounted box at once and does not outlive its moment', () => {
  assert.equal(takeComposerFocusRequest(1_000), false, 'nothing was asked');
  let told = 0;
  const off = onComposerFocusRequest(() => { told++; });
  requestComposerFocus(1_000);
  assert.equal(told, 1, 'a mounted box hears the request');
  assert.equal(takeComposerFocusRequest(1_500), true);
  assert.equal(takeComposerFocusRequest(1_600), false, 'taken once');
  off();
  requestComposerFocus(2_000);
  assert.equal(told, 1, 'an unmounted box is not told');
  assert.equal(takeComposerFocusRequest(8_000), false, 'a request nobody took in time is dropped');
  requestComposerFocus(9_000);
  assert.equal(takeComposerFocusRequest(8_000 + 1_000 + 6_000), false);
});
