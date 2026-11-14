import { randomBytes, createHash } from 'node:crypto';
import { ROOT_CONTEXT, trace, SpanKind, SpanStatusCode, TraceFlags, type SpanContext } from '@opentelemetry/api';
import { TracerProvider, AlwaysOnSampler, type ReadableSpan, type SpanProcessor } from '@opentelemetry/sdk-trace';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { request as httpRequest, type ClientRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { JsonTraceSerializer } from '@opentelemetry/otlp-transformer';
import { A, ATTRIBUTES, EFFECT_PHASES, OPERATIONS, OUTCOMES, TOOLS, type SafeAttributes } from './conventions.ts';

export interface ExportOptions { endpoint: string; headers?: Record<string, string>; capacity?: number; timeoutMs?: number }
export interface ExportStats { dropped: number; exported: number; queued: number }
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const opaque = (value: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value) ? value : hash(value);
export function turnContext(thread: string, turn: string): SpanContext {
  const digest = hash(`turn:${thread}:${turn}`);
  return { traceId: digest.slice(0, 32), spanId: digest.slice(32, 48), traceFlags: TraceFlags.SAMPLED };
}

// Defence in depth: even a future caller cannot add an attribute or free-form outcome/tool string.
function attributes(input: SafeAttributes): SafeAttributes {
  const result: SafeAttributes = {};
  for (const key of ATTRIBUTES) {
    const value = input[key];
    if (value === undefined) continue;
    if (key.endsWith('.id')) { if (typeof value === 'string') result[key] = opaque(value); }
    else if (key === A.service) result[key] = 'backbone';
    else if (key === A.operation) { if (Object.values(OPERATIONS).includes(value as never)) result[key] = value; }
    else if (key === A.tool) { if (TOOLS.includes(value as never)) result[key] = value; }
    else if (key === A.outcome) { if (OUTCOMES.includes(value as never)) result[key] = value; }
    else if (key === A.phase) { if (EFFECT_PHASES.includes(value as never)) result[key] = value; }
    else if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) result[key] = value;
  }
  return result;
}

/** Private provider: no global instrumentation, resource detectors, environment headers or content hooks. */
export function createExporter(options: ExportOptions) {
  // Repeat configuration validation at this transport boundary without a runtime module/platform cycle.
  let endpoint: URL;
  try {
    endpoint = new URL(options.endpoint);
    const loopback = endpoint.hostname === 'localhost' || endpoint.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(endpoint.hostname);
    const secure = endpoint.protocol === 'https:' || (endpoint.protocol === 'http:' && loopback);
    if (options.endpoint.length > 2048 || !secure || !endpoint.hostname || endpoint.pathname === '/' || !endpoint.pathname || endpoint.username || endpoint.password || options.endpoint.includes('?') || options.endpoint.includes('#') || /[\s\x00-\x1f]/.test(options.endpoint)) throw new Error();
  } catch { throw new Error('Use an HTTPS collector traces URL, or HTTP on loopback only, with an explicit path and no credentials, query or fragment.'); }
  const capacity = Number.isSafeInteger(options.capacity) ? Math.max(1, Math.min(4096, options.capacity!)) : 256;
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) ? Math.max(10, Math.min(5000, options.timeoutMs!)) : 500;
  // Official serializer; explicit transport avoids the stock exporter's environment-header merge
  // and retry queue. Neither environment headers nor hidden retry buffers belong to this unit.
  let cancelRequest: (() => void) | undefined;
  const send = (batch: ReadableSpan[]): Promise<number> => new Promise(resolve => {
    let settled = false, req: ClientRequest | undefined, timer: NodeJS.Timeout | undefined;
    const finish = (dropped: number) => { if (!settled) { settled = true; clearTimeout(timer); cancelRequest = undefined; resolve(dropped); } };
    try {
      req = (endpoint.protocol === 'https:' ? httpsRequest : httpRequest)(endpoint, {
        method: 'POST', agent: false, headers: { ...options.headers, 'content-type': 'application/json' },
      }, res => {
        let body = '';
        res.on('data', chunk => { body += String(chunk); if (body.length > 8192) { req?.destroy(); finish(batch.length); } });
        res.on('error', () => finish(batch.length));
        res.on('end', () => {
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) return finish(batch.length);
          try {
            const response = body ? JSON.parse(body) : {};
            const rejected = Number(response.partialSuccess?.rejectedSpans ?? 0);
            finish(Number.isSafeInteger(rejected) && rejected >= 0 ? Math.min(batch.length, rejected) : batch.length);
          } catch { finish(batch.length); }
        });
      });
      req.on('error', () => finish(batch.length));
      cancelRequest = () => { req?.destroy(); finish(batch.length); };
      timer = setTimeout(cancelRequest, timeoutMs);
      req.end(JsonTraceSerializer.serializeRequest(batch));
    } catch { req?.destroy(); finish(batch.length); }

  });
  const stats: ExportStats = { dropped: 0, exported: 0, queued: 0 };
  const queue: ReadableSpan[] = [];
  let closed = false, active: Promise<void> | undefined, scheduled = false;
  const pump = (): Promise<void> => {
    if (active) return active;
    if (!queue.length) return Promise.resolve();
    const batch = queue.splice(0, 32); stats.queued = queue.length;
    active = send(batch).then(dropped => { stats.dropped += dropped; stats.exported += batch.length - dropped; }, () => { stats.dropped += batch.length; })
      .finally(() => { active = undefined; if (queue.length) schedule(); });
    return active;
  };
  const schedule = () => {
    if (scheduled || active) return;
    scheduled = true;
    setImmediate(() => { scheduled = false; void pump(); }).unref();
  };
  const flush = async () => { while (active || queue.length) await (active ?? pump()); };
  const processor: SpanProcessor = {
    onStart() {},
    onEnd(span) {
      if (closed || queue.length >= capacity) { stats.dropped++; return; }
      queue.push(span); stats.queued = queue.length; schedule();
    },
    forceFlush: flush,
    async shutdown() { closed = true; stats.dropped += queue.length; queue.length = 0; stats.queued = 0; cancelRequest?.(); await active; },
  };
  let forced: SpanContext | undefined;
  const provider = new TracerProvider({
    resource: resourceFromAttributes({ [A.service]: 'backbone' }),
    sampler: new AlwaysOnSampler(), spanProcessors: [processor],
    idGenerator: { generateTraceId: () => forced?.traceId ?? randomBytes(16).toString('hex'), generateSpanId: () => forced?.spanId ?? randomBytes(8).toString('hex') },
    spanLimits: { attributeCountLimit: ATTRIBUTES.length, eventCountLimit: 0, linkCountLimit: 0, attributeValueLengthLimit: 128 },
  });
  const tracer = provider.getTracer('backbone.telemetry', '0.0.0');
  return {
    stats,
    timeoutMs,
    emit(operation: keyof typeof OPERATIONS, start: number, end: number, values: SafeAttributes, parent?: SpanContext, identity?: SpanContext) {
      if (closed) { stats.dropped++; return; }
      if (!Number.isFinite(start) || !Number.isFinite(end)) { stats.dropped++; return; }
      forced = identity;
      try {
        const safe = attributes({ ...values, [A.operation]: OPERATIONS[operation], [A.dropped]: stats.dropped });
        const span = tracer.startSpan(OPERATIONS[operation], { startTime: start, kind: SpanKind.INTERNAL, attributes: safe }, parent ? trace.setSpanContext(ROOT_CONTEXT, parent) : ROOT_CONTEXT);
        if (safe[A.outcome] === 'failed') span.setStatus({ code: SpanStatusCode.ERROR });
        span.end(Math.max(start, end));
      } catch { stats.dropped++; }
      finally { forced = undefined; }
    },
    flush,
    async close() { try { await provider.shutdown(); } catch { stats.dropped++; } },
  };
}
