// Native decisions answered after close must not inspect arguments, ownership, services or Core.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Host } from '../src/composition/host.ts';
import type { ConnectorService } from '../src/connectors/service.ts';
import { connectorPerson } from '../src/composition/connector-person.ts';
import { CoreLink } from '../src/composition/core.ts';
import { hostClosed } from '../src/composition/host.ts';
import { open } from './helpers.ts';
import {hangDetector} from '../../../scripts/lib/test-hang.ts';

const CLOSING = 'This app is closing; nothing was read, changed, signed or sent.';
const effect = '10000000-0000-4000-8000-000000000001', hash = 'a'.repeat(64);

const decisions = (host: Pick<Host, 'releaseConnectorCall' | 'signConnectorTool' | 'openConnectorDoor' | 'markConnectorToolRead' | 'connectorEffectDecisions' | 'endConnectorSignature'>) => [
  ['release one call', () => host.releaseConnectorCall(effect, hash)],
  ['release invalid call', () => host.releaseConnectorCall('effect', 'hash')],
  ['sign tool', () => host.signConnectorTool('server', 'tool', 'seal', 'stamp', false)],
  ['invalid signing request', () => host.signConnectorTool('', '', '', '', false)],
  ['open door', () => host.openConnectorDoor('server', 'seal')],
  ['invalid door request', () => host.openConnectorDoor('', '')],
  ['mark read', () => host.markConnectorToolRead('server', 'tool')],
  ['invalid read request', () => host.markConnectorToolRead('', '')],
  ['restore server read classification', () => host.markConnectorToolRead('server', 'tool', true)],
  ['unknown question', () => host.connectorEffectDecisions.question(effect, hash)],
  ['invalid unknown question', () => host.connectorEffectDecisions.question('effect', 'hash')],
  ...(['happened', 'did_not_happen', 'keep_closed'] as const).map(answer => [
    `resolve ${answer}`, () => host.connectorEffectDecisions.resolve({ effect, argsHash: hash, answer }),
  ] as const),
  ['invalid unknown answer', () => host.connectorEffectDecisions.resolve(new Proxy({} as never, { get() { throw Error('arguments inspected after close'); } }))],
  ['end signature', () => host.endConnectorSignature('server', 'tool')],
  ['invalid signature', () => host.endConnectorSignature('', '')],
] as const;

async function closing(name: string, call: () => unknown) {
  try {
    const receipt = await hangDetector(Promise.resolve().then(call), `closed connector entry: ${name}`);
    assert.deepEqual(receipt, { ok: false, reason: 'NOT_AVAILABLE', outcome: 'REFUSED', detail: CLOSING }, name);
  } catch (error) {
    // Host.call and native view builders throw; native decisions return receipts.
    assert.equal((error as Error).message, CLOSING, name);
  }
}

test('every connector person entry refuses closing first, without argument inspection, ownership or Core', async t => {
  // The extracted boundary must not even enter admission or read an ownership/Core thenable.
  let touched = 0;
  const untouched = () => { touched++; throw Error('closed entry touched a dependency'); };
  const blocked = { get then() { return untouched(); } } as unknown as Promise<unknown>;
  const person = connectorPerson({ connectors: new Proxy({} as ConnectorService, { get: untouched }),
    owner: blocked, core: blocked, unavailable: () => CLOSING, enter: untouched });
  for (const [name, call] of decisions(person)) await closing(name, call);
  assert.equal(touched, 0);
  // The inaccessible thenables and dependency counter prove no wait, independent of scheduling.

  let opens = 0, release!: () => void, opened!: () => void;
  const opening = new Promise<void>(resolve => { opened = resolve; });
  const pending = new Promise<CoreLink>((_resolve, reject) => { release = () => reject(Error('test Core opening cancelled')); });
  t.mock.method(CoreLink, 'open', () => { opens++; opened(); return pending; });
  // Immediate close proves no Core open at all. Closing after open starts proves no Core wait.
  for (const waitForOpen of [false, true]) {
    const { home, host } = open();
    try {
      if (waitForOpen) await opening;
      host.close();
      const before = opens;
      const entries = [
        ...decisions(host),
        ['enable tool', () => host.enableConnector('server', 'tool', 'stamp')],
        ['enable server', () => host.enableConnector('server', undefined, 'stamp')],
        ['enable server tools', () => host.enableConnectorTools('server', ['tool'], 'stamp')],
        ['discard call', () => host.call('connectors.decide', { effect, argsHash: hash, verdict: 'discard' })],
        ['discard malformed call', () => host.call('connectors.decide', new Proxy({} as never, { get() { throw Error('discard arguments inspected after close'); } }))],
        ['resolve retained read', () => host.call('connectors.resolveRead', { id: 'read', verdict: 'reconcile' })],
        ['discard retained read', () => host.call('connectors.resolveRead', { id: 'read', verdict: 'discard' })],
        ['end signature over API', () => host.call('connectors.set', { serverId: 'server', tool: { name: 'tool', standing: false } })],
        ['enable view', () => host.connectorEnableView('server', 'tool')],
        ['batch enable view', () => host.connectorToolsEnableView('server')],
        ['door seal', () => host.connectorDoorSeal('server')],
        ['door view', () => host.connectorDoorView('server')],
        ['signing view', () => host.connectorToolView('server', 'tool')],
        ['connect AI tool', () => host.connectTool({} as never)],
        ['sign capability', () => host.signCapability({} as never)],
      ] as const;
      for (const [name, call] of entries) await closing(name, call);
      assert.equal(opens, before, 'late entries never open Core');
      if (!waitForOpen) assert.equal(opens, 0, 'immediate close never opens Core');
    } finally {
      host.close();
      if (waitForOpen) release();
      await hostClosed(home);
    }
  }
});
