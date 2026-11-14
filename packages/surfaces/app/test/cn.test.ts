import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cn } from '../src/lib/utils.ts';

test('the type tokens are sizes: they replace sizes and keep colours', () => {
  assert.equal(cn('text-xs text-muted', 'text-ui'), 'text-muted text-ui');
  assert.equal(cn('text-caption font-medium', 'text-draft'), 'text-caption font-medium text-draft');
});
