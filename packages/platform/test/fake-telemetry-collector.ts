// Local collector only: preserves request bytes so tests inspect the complete egress boundary.
import { createServer, type IncomingHttpHeaders } from 'node:http';

export interface CollectedRequest { method: string | undefined; url: string | undefined; headers: IncomingHttpHeaders; body: string }
export interface CollectedSpan {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: { key: string; value: { stringValue?: string; intValue?: string | number } }[];
}
export async function fakeCollector(mode: 'ok' | 'hang' | '500' = 'ok') {
  const requests: CollectedRequest[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += String(chunk); });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (mode === 'hang') return;
      res.writeHead(mode === '500' ? 500 : 200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/traces`;
  let closed = false;
  return {
    endpoint,
    requests,
    spans(): CollectedSpan[] {
      return requests.flatMap(request => {
        const body = JSON.parse(request.body) as { resourceSpans?: { scopeSpans?: { spans?: CollectedSpan[] }[] }[] };
        return body.resourceSpans?.flatMap(resource => resource.scopeSpans?.flatMap(scope => scope.spans ?? []) ?? []) ?? [];
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
export const attribute = (span: CollectedSpan, key: string) => {
  const value = span.attributes.find(entry => entry.key === key)?.value;
  return value?.stringValue ?? value?.intValue;
};
