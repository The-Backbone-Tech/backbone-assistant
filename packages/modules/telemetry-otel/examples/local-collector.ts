// Standalone OTLP/HTTP example. Only a loopback fake collector is used.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createExporter } from '../src/index.ts';

let received = 0;
const collector = createServer((req, res) => {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    const request = JSON.parse(body);
    const spans = request.resourceSpans.flatMap((resource: any) => resource.scopeSpans.flatMap((scope: any) => scope.spans));
    assert.equal(spans[0].name, 'invoke_agent');
    received += spans.length;
    res.end('{}');
  });
});
collector.listen(0, '127.0.0.1');
await once(collector, 'listening');
const exporter = createExporter({ endpoint: `http://127.0.0.1:${(collector.address() as { port: number }).port}/v1/traces` });
try {
  const at = Date.now();
  exporter.emit('turn', at, at + 1, { 'backbone.thread.id': randomUUID(), 'backbone.turn.id': randomUUID(), 'backbone.outcome': 'done', 'backbone.step.count': 0 });
  await exporter.flush();
  assert.equal(received, 1);
  assert.equal(exporter.stats.dropped, 0);
  console.log('received invoke_agent; dropped 0');
} finally {
  await exporter.close();
  collector.closeAllConnections();
  await new Promise<void>(resolve => collector.close(() => resolve()));
}
