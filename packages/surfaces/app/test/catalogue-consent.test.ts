import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONNECTOR_CATALOGUE } from '@backbone-next/platform';
import { catalogueConsent, catalogueDisconnected } from '../src/lib/catalogue-consent.ts';

test('Google sign-in states the plaintext cache location, client-secret copy, permissions and removal', () => {
  const entry = CONNECTOR_CATALOGUE.find(entry => entry.id === 'drive')!;
  const text = catalogueConsent(entry, 'reads');
  for (const fact of ['plain JSON', 'client secret', 'connectors/google', '0700', '0600', 'drive.readonly', '--read-only', 'deletes this folder']) assert.ok(text.includes(fact), fact);
});
test('consent and disconnect messages distinguish private GitHub limits and uncertain provider revocation', () => {
  assert.match(catalogueConsent(CONNECTOR_CATALOGUE.find(entry => entry.id === 'github')!, 'reads'), /cannot .*private-repository read without write/);
  // Human consent uses the glossary; UNKNOWN remains the receipt's machine-readable enum.
  assert.match(catalogueDisconnected({ disconnected: true, revocation: 'unknown' }), /unknown outcome/i);
  assert.ok(!catalogueDisconnected({ disconnected: true, revocation: 'unknown' }).includes('Provider token revoked'));
  assert.ok(catalogueDisconnected({ disconnected: true, revocation: 'revoked' }).includes('Provider token revoked'));
});
