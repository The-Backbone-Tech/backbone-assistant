import assert from 'node:assert/strict';
import { test } from 'node:test';
import { freshHome, open, value } from './helpers.ts';
import {observeNativeHomeLocks} from './native-lock-observation.ts';

test('draft revisions refuse stale and late writes across a tombstone and reopen', async () => {
  const home = freshHome(); const first = open(home).host;
  const put = (baseRevision: number, text: string, clientKey: string) => first.call('drafts.put', {key: 'composer:cas', text, clientKey, baseRevision});
  assert.equal(value(await put(0, 'new', 'one')).revision, 1);
  assert.equal(value(await put(1, '', 'clear')).revision, 2);
  const stale = await put(0, 'late', 'late'); assert.ok(!stale.ok); assert.equal(stale.reason, 'STALE_BASE');
  first.close(); const { CoreLink } = await import('../src/composition/core.ts'); await CoreLink.whenClosed(home);
  const second = open(home).host; const draft = await second.call('drafts.get', {key:'composer:cas'});
  assert.equal(draft?.text, ''); assert.equal(draft?.revision, 2);
  const withoutBase = await second.call('drafts.put', {key:'composer:cas', text:'legacy late', clientKey:'legacy'}); assert.ok(!withoutBase.ok);
});

test('same-base writes choose one winner and leave independent keys usable', async () => {
  const host = open().host;
  const [a,b] = await Promise.all(['a','b'].map(clientKey => host.call('drafts.put', {key:'same', text:clientKey, clientKey, baseRevision:0})));
  assert.equal([a,b].filter(r => r.ok).length, 1);
  const rejected = [a,b].find(r => !r.ok)!; assert.ok(!rejected.ok); assert.equal(rejected.reason,'STALE_BASE');
  assert.equal(value(await host.call('drafts.put', {key:'other', text:'independent', clientKey:'c', baseRevision:0})).revision, 1);
  const current = await host.call('drafts.get',{key:'same'}); assert.ok(current && ['a','b'].includes(current.text));
});

test('the real Host takes the home lock for a draft mutation', async t => {
  const {host,home} = open();
  // Finish startup before observing the lock; the assertion concerns this public handler.
  await host.call('host.status', {});
  let entries = 0;
  observeNativeHomeLocks(t,home,()=>{entries++;});
  const result = await host.call('drafts.put', {key:'lock-check', text:'saved', clientKey:'lock-check', baseRevision:0});
  assert.ok(result.ok); assert.ok(entries > 0, 'drafts.put must use the process-shared home lock');
});
