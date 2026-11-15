import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lastActive } from '../src/lib/when.ts';

test('a conversation says when it was last active, briefly', () => {
  const now = Date.parse('2026-11-15T12:00:00Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();
  assert.equal(lastActive(ago(20_000), now), 'just now');
  assert.equal(lastActive(ago(5 * 60_000), now), '5 minutes ago');
  assert.equal(lastActive(ago(3 * 3_600_000), now), '3 hours ago');
  assert.equal(lastActive(ago(26 * 3_600_000), now), 'yesterday');
  assert.equal(lastActive(ago(4 * 86_400_000), now), '4 days ago');
  assert.equal(lastActive('2026-10-02T09:00:00Z', now), 'Oct 2');
  assert.equal(lastActive('2025-10-02T09:00:00Z', now), 'Oct 2, 2025');
  assert.equal(lastActive('not a date', now), '');
});
