// A route's error reaches the person in plain words: its status and the provider's message, never a raw JSON body.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { plainError } from '../src/composition/harness-turn.ts';

test('a provider error body becomes its status and message', () => {
  assert.equal(plainError('429: {"message":"Rate limit reached for requests","type":"rate_limit"}'), '429: Rate limit reached for requests');
  assert.equal(plainError('500: {"error":{"message":"overloaded","code":529}}'), '500: overloaded');
  assert.equal(plainError('401: {"error":"invalid key"}'), '401: invalid key');
});

test('anything else is kept, on one line and at most 200 characters', () => {
  assert.equal(plainError('The model request failed.'), 'The model request failed.');
  assert.equal(plainError('503: {not json'), '503: {not json');
  assert.equal(plainError('x\n  y'), 'x y');
  assert.equal(plainError('e'.repeat(500))!.length, 200);
  assert.equal(plainError(undefined), undefined);
});
