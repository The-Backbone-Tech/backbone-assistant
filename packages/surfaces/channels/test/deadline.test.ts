import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SlackAdapter } from '@chat-adapter/slack';
import { channelAdapters, PRODUCTION_DELIVERY_TIMEOUT_MS } from '../src/adapters.ts';
test('production adapters and daemon share a twenty-second deadline; tests can explicitly shorten it',()=>{
 assert.equal(PRODUCTION_DELIVERY_TIMEOUT_MS,20_000);
 for(const override of [undefined,50]){
  const adapters=channelAdapters({deliveryTimeoutMs:override,slack:{token:'fake',signingSecret:'fake-secret'},telegram:{token:'fake',secret:'fake-secret'}});
  const axios=Reflect.get((adapters.slack as SlackAdapter).webClient,'axios') as {defaults:{timeout:number}};
  assert.equal(axios.defaults.timeout,override??20_000);
  assert.equal(Reflect.get(adapters.telegram,'deadline'),override??20_000);
 }
});
