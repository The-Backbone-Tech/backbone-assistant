import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AcpSteering } from '../src/steering.ts';

const supported = { _meta: { steering: { supported: true } } };
test('ACP injects through its advertised extension and forbids detached idle fallback', async () => {
  const sent: unknown[] = [];
  const steering = new AcpSteering();
  steering.open(supported, async (method, params) => { sent.push({ method, params }); return { outcome: 'injected' }; });
  assert.deepEqual(await steering.deliver('Change course'), { outcome: 'DELIVERED' });
  assert.deepEqual(sent, [{ method: '_session/steering', params: { prompt: [{ type: 'text', text: 'Change course' }], _meta: { steering: { idleBehavior: 'promptRequired' } } } }]);
});
test('ACP without steering or with an idle turn confirms non-delivery for the existing Host queue', async () => {
  const unavailable = new AcpSteering();
  unavailable.open({}, async () => { throw new Error('must not dispatch'); });
  assert.equal((await unavailable.deliver('later')).outcome, 'NOT_DELIVERED');
  const idle = new AcpSteering();
  idle.open(supported, async () => ({ outcome: 'promptRequired', reason: 'noRunningTurn' }));
  assert.equal((await idle.deliver('later')).outcome, 'NOT_DELIVERED');
});
test('ACP response loss, detached turns and malformed acknowledgements remain unknown and stop the owning turn', async () => {
  for (const answer of [undefined, { outcome: 'startedNewTurn' }, { outcome: 'promptRequired' }, { outcome: 'other' }]) {
    let stopped = 0;
    const steering = new AcpSteering(() => stopped++);
    steering.open(supported, async () => answer);
    assert.equal((await steering.deliver('uncertain')).outcome, 'UNKNOWN');
    assert.equal(stopped, 1);
  }
  const lost = new AcpSteering();
  lost.open(supported, async () => { throw new Error('private diagnostic'); });
  const result = await lost.deliver('uncertain');
  assert.equal(result.outcome, 'UNKNOWN');
  if (result.outcome === 'UNKNOWN') assert.doesNotMatch(result.detail, /private diagnostic/);
});
test('early steering is not buffered twice and ending a pending delivery settles it as unknown', async () => {
  const steering = new AcpSteering();
  assert.equal((await steering.deliver('early')).outcome, 'NOT_DELIVERED');
  let reply!: (value: unknown) => void;
  steering.open(supported, () => new Promise(resolve => { reply = resolve; }));
  const delivery = steering.deliver('pending');
  steering.close();
  assert.equal((await delivery).outcome, 'UNKNOWN');
  reply({ outcome: 'injected' });
  assert.equal((await steering.deliver('late')).outcome, 'NOT_DELIVERED');
});
