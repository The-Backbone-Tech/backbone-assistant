import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserPolicyDecision } from '../electron/browser-policy.ts';

test('personal browsing refuses an active or unreadable managed policy and preserves its reason', () => {
  assert.equal(browserPolicyDecision({status:'none'}), undefined);
  assert.match(browserPolicyDecision({status:'verified',policy:{id:'company',version:1,requirements:{modelRoutes:['endpoint']},defaults:{},warnings:[]}})!, /Managed policy is active/);
  assert.equal(browserPolicyDecision({status:'refused',code:'expired',detail:'Policy expired.'}), 'Policy expired.');
});
