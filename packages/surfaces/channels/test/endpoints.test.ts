import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeProvider } from './fake-providers.ts';
for (const provider of ['slack','telegram'] as const) test(`${provider} fake records, fails once and can stay silent`, async () => {
  const fake = await fakeProvider(provider);
  const path = provider === 'slack' ? '/api/chat.postMessage' : '/botfake/sendMessage';
  try {
    fake.script('fail');
    assert.equal((await (await fetch(fake.url+path,{method:'POST',body:'first'})).json()).ok, false);
    assert.equal((await (await fetch(fake.url+path,{method:'POST',body:'second'})).json()).ok, true);
    fake.script('silent');
    // The silent endpoint never answers. Abort only once it has recorded the request, so a loaded machine cannot abort first.
    const abort = new AbortController();
    const third = assert.rejects(fetch(fake.url+path,{method:'POST',body:'third',signal:abort.signal}));
    for (let waited = 0; fake.requests.length < 3 && waited < 5_000; waited += 10) await new Promise((r) => setTimeout(r, 10));
    abort.abort();
    await third;
    assert.deepEqual(fake.requests.map(r=>r.body), ['first','second','third']);
    fake.events(async r => new Response(await r.text()));
    assert.deepEqual(await (await fake.emit({event:'hello'})).json(),{event:'hello'});
  } finally { await fake.close(); }
});
