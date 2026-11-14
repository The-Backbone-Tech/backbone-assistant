// The client for Hermes's supported host interface: the API server's runs API, read from v0.22.5
// (website/docs/user-guide/features/api-server.md). A bearer key, JSON and one SSE stream per run.

export interface RunStatus {
  status: string;
  output?: string;
  error?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export interface RunFrame {
  seq?: number;
  event?: string;
  [field: string]: unknown;
}

/** The request never left: Stop came first. Nothing was submitted, and nothing will be. */
export class NotSent extends Error {}

export class HermesClient {
  private baseUrl: string;
  private key: () => Promise<string>;
  private timeoutMs: number;

  constructor(baseUrl: string, key: () => Promise<string>, timeoutMs: number) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.key = key;
    this.timeoutMs = timeoutMs;
  }

  private async headers(_path: string, extra: Record<string, string> = {}) {
    return { authorization: `Bearer ${await this.key()}`, 'content-type': 'application/json', ...extra };
  }

  /** `unless`: a request that must not leave once Stop has come, checked after the last await before it is sent. */
  private async json(path: string, init: RequestInit = {}, unless?: AbortSignal): Promise<{ status: number; body: any }> {
    const headers = await this.headers(path, init.headers as Record<string, string>);
    if (unless?.aborted) throw new NotSent('Stopped before the request was sent.');
    const res = await fetch(`${this.baseUrl}${path}`, { signal: AbortSignal.timeout(this.timeoutMs), redirect: 'error', ...init, headers });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      // A body that is not JSON carries no fact this client uses; the status code still does.
    }
    return { status: res.status, body };
  }

  async health() {
    const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(this.timeoutMs), redirect: 'error' });
    return (await res.json()) as { version?: string };
  }

  async capabilities() {
    return (await this.json('/v1/capabilities')).body?.features as Record<string, any> | undefined;
  }

  async toolsets() {
    return (await this.json('/v1/toolsets')).body?.data as { name?: string; enabled?: boolean; tools?: string[] }[] | undefined;
  }

  /** One request, once. A lost response leaves the run's creation unknown; the caller never resends. */
  async createRun(key: string, body: Record<string, unknown>, unless?: AbortSignal) {
    const { status, body: reply } = await this.json('/v1/runs', { method: 'POST', headers: { 'idempotency-key': key }, body: JSON.stringify(body) }, unless);
    if (status !== 202 || typeof reply?.run_id !== 'string') throw new Error(`Hermes did not accept the run (HTTP ${status}).`);
    return reply.run_id as string;
  }

  async status(runId: string) {
    return (await this.json(`/v1/runs/${encodeURIComponent(runId)}`)).body as RunStatus | null;
  }

  async stop(runId: string) {
    return (await this.json(`/v1/runs/${encodeURIComponent(runId)}/stop`, { method: 'POST', body: '{}' })).status;
  }

  async steer(runId: string, input: string, unless?: AbortSignal) {
    return (await this.json(`/v1/runs/${encodeURIComponent(runId)}/steer`, { method: 'POST', body: JSON.stringify({ input }) }, unless)).status;
  }

  /** Frames from just after `lastSeq` until the stream ends; a throw is a broken connection. */
  async *events(runId: string, lastSeq: number, signal: AbortSignal): AsyncGenerator<RunFrame> {
    const res = await fetch(`${this.baseUrl}/v1/runs/${encodeURIComponent(runId)}/events?last_seq=${lastSeq}`, { signal, redirect: 'error', headers: await this.headers(`/v1/runs/${encodeURIComponent(runId)}/events`) });
    if (!res.ok || !res.body) throw new Error(`Hermes's event stream answered HTTP ${res.status}.`);
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const fields = frame.split('\n').filter((l) => l !== '' && !l.startsWith(':'));
        // Only comments: no record. Any field makes one, an empty or a bare `data` too.
        if (!fields.length) continue;
        const lines = fields.filter((l) => l === 'data' || l.startsWith('data:'));
        if (!lines.length) {
          yield { fieldsOnly: true };
          continue;
        }
        const data = lines.map((l) => l.slice(5).trimStart()).join('\n');
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          parsed = null;
        }
        // A frame that is not an object is still a frame: the caller must see that it could not read it.
        yield parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as RunFrame) : { malformed: true };
      }
    }
    // Anything left at the close is a record cut off: the caller must not take the end as clean.
    if ((buffer + decoder.decode()).trim()) yield { malformed: true };
  }
}
