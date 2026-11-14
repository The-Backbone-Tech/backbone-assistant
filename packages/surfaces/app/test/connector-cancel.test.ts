import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONNECTOR_CANCEL, connectorRefusal } from '../src/lib/connector-cancel.ts';

test('only the exact fixed cancel receipt for the action is hidden', () => {
  for (const action of Object.keys(CONNECTOR_CANCEL) as (keyof typeof CONNECTOR_CANCEL)[]) {
    const cancel = { ok: false, reason: 'NOT_AVAILABLE', outcome: 'REFUSED', detail: CONNECTOR_CANCEL[action] };
    assert.equal(connectorRefusal(cancel, action), undefined);
    assert.equal(connectorRefusal({ ...cancel, detail: `Server cancelled: ${cancel.detail}` }, action), `Server cancelled: ${cancel.detail}`);
    assert.equal(connectorRefusal({ ...cancel, reason: 'INVALID' }, action), cancel.detail);
    assert.equal(connectorRefusal({ ...cancel, outcome: 'UNKNOWN' }, action), cancel.detail);
    assert.equal(connectorRefusal(cancel), cancel.detail, 'a disabling or refresh action has no native cancellation');
  }
  assert.equal(connectorRefusal({ ok: false, detail: 'The server cancelled its handshake.' }, 'enable'), 'The server cancelled its handshake.');
});
