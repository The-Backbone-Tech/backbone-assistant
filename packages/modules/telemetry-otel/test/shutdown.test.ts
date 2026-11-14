import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { TracerProvider } from '@opentelemetry/sdk-trace';
import { startTelemetry, type TelemetryHost } from '../src/subscriber.ts';
import { createExporter } from '../src/exporter.ts';

test('close never rejects when either unsubscribe or the SDK shutdown throws', async () => {
  let events = 0, observations = 0, shutdowns = 0;
  const failure = mock.method(TracerProvider.prototype, 'shutdown', async () => { shutdowns++; throw new Error('PRIVATE_SHUTDOWN_DETAIL'); });
  try {
    const host = { on() { return () => { events++; throw new Error('PRIVATE_EVENT_DETAIL'); }; } } as unknown as TelemetryHost;
    const service = startTelemetry(host, { endpoint: 'http://127.0.0.1:4318/v1/traces', observe: () => () => { observations++; throw new Error('PRIVATE_OBSERVER_DETAIL'); } })!;
    await assert.doesNotReject(service.close());
    await assert.doesNotReject(service.close());
    assert.equal(events, 1); assert.equal(observations, 1); assert.equal(shutdowns, 1);
    assert.equal(service.stats.dropped, 3);
    await assert.doesNotReject(createExporter({ endpoint: 'http://127.0.0.1:4318/v1/traces' }).close());
    assert.equal(shutdowns, 2);
  } finally { failure.mock.restore(); }
});
