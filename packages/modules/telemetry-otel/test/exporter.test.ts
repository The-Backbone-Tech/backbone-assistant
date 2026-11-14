import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createExporter } from '../src/exporter.ts';

test('official OTLP JSON exporter uses only explicit resources and headers and counts overflow', async () => {
  const bodies: string[] = [];
  const server = createServer((req,res) => { let body=''; req.on('data', chunk => body += chunk); req.on('end', () => { bodies.push(body); res.end('{}'); }); });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const exporter = createExporter({ endpoint: `http://127.0.0.1:${(server.address() as {port:number}).port}/v1/traces`, capacity: 1 });
  try {
    for (let i=0;i<3;i++) exporter.emit('turn', Date.now(), Date.now(), { 'backbone.outcome': 'done' });
    await exporter.flush();
    assert.equal(exporter.stats.dropped,2); assert.equal(exporter.stats.exported,1);
    const request=JSON.parse(bodies.join('')); assert.equal(request.resourceSpans[0].resource.attributes.length,1);
    assert.equal(request.resourceSpans[0].scopeSpans[0].spans[0].name,'invoke_agent');
  } finally { await exporter.close(); server.closeAllConnections(); await new Promise<void>(r=>server.close(()=>r())); }
});

test('transport requires HTTPS outside loopback and an explicit traces path without echoing secrets', async () => {
  for (const endpoint of ['https://collector.example/custom/traces', 'http://127.42.99.5/v1/traces', 'http://localhost:4318/v1/traces', 'http://[::1]/v1/traces']) {
    await createExporter({ endpoint }).close(); // Construct/close only; no request is made.
  }
  const marker = 'endpoint-secret-marker';
  for (const endpoint of [`http://${marker}.example/v1/traces`, 'http://10.0.0.1/v1/traces', 'http://192.168.0.1/v1/traces', 'http://localhost.example/v1/traces', 'http://localhost./v1/traces', 'http://[::ffff:127.0.0.1]/v1/traces', 'http://[::]/v1/traces', 'https://collector.example', 'https://collector.example/', 'http://127.0.0.1:4318', 'https://collector.example/traces/..', `https://${marker}@collector.example/v1/traces`, `https://collector.example/v1/traces?key=${marker}`, marker]) {
    assert.throws(() => createExporter({ endpoint }), error => error instanceof Error && !error.message.includes(marker));
  }
});
