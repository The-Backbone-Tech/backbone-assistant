import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TurnRequest } from '@backbone-next/platform/ports';
import { memoryReferenceText } from '@backbone-next/platform';
import { prompt } from '../src/index.ts';

test('native history renders an older assistant memory quote visibly without mutating it', () => {
  const text = 'Friday ' + String.fromCodePoint(0xe0049, 0xe0067) + '\u202ehistory\u202c';
  const request: TurnRequest = { threadId: 't', turnId: 'r', text: 'Continue.', history: [{ role: 'assistant', text }], effort: 3, attachments: [], resumed: false };
  const built = prompt(request, []);
  assert.ok(built.includes(memoryReferenceText(text)));
  assert.doesNotMatch(built, /\p{Cf}/u);
  assert.equal(request.history[0].text, text);
});
