// Local model detection (scorecard row 10): what model servers run on this computer, read from each
// one's OpenAI-compatible /v1/models on its usual port. Only 127.0.0.1 is asked, a redirect is never
// followed, and each probe gives up quickly. Nothing is started, installed or downloaded: a person
// who wants a model pulls it in their runtime. What a server answers is data; names are cleaned and capped.
import { LOCAL_RUNTIMES, type LocalModels, type LocalProvider } from '../api.ts';

type Probed = Exclude<LocalProvider, 'other'>;
export const LOCAL_PORTS: Record<Probed, number> = { ollama: 11434, lmstudio: 1234, llamacpp: 8080, vllm: 8000 };
export const MAX_LOCAL_MODEL = 200;
const MAX_MODELS = 100;
const MAX_BODY = 256 * 1024;
/** Control and format characters, and Unicode's line separators, could show something other than the name. */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

export interface LocalProbe {
  /** The port to ask for each runtime; tests pass stand-ins. The host is always 127.0.0.1. */
  ports?: Partial<Record<Probed, number>>;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const modelName = (id: unknown): string | null => {
  if (typeof id !== 'string') return null;
  const name = id.replace(HIDDEN, '').trim().slice(0, MAX_LOCAL_MODEL);
  return name || null;
};

async function probe(port: number, timeoutMs: number, get: typeof fetch): Promise<string[] | null> {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  try {
    const res = await get(`http://127.0.0.1:${port}/v1/models`, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
    if (!res.ok || !res.body) return null;
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) { void reader.cancel(); return null; }
      chunks.push(value);
    }
    const data = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { data?: unknown }).data;
    if (!Array.isArray(data)) return null;
    const names = data.map((m) => modelName((m as { id?: unknown } | null)?.id)).filter((n): n is string => n !== null);
    return [...new Set(names)].slice(0, MAX_MODELS);
  } catch {
    return null;
  }
}

/** Each runtime that answers, in a fixed order, with the models it serves. */
export async function detectLocalModels(options: LocalProbe = {}): Promise<LocalModels> {
  const ports = { ...LOCAL_PORTS, ...options.ports };
  const timeoutMs = options.timeoutMs ?? 600;
  const get = options.fetch ?? fetch;
  const order = Object.keys(LOCAL_PORTS) as Probed[];
  const found = await Promise.all(order.map((provider) => probe(ports[provider], timeoutMs, get)));
  return {
    runtimes: order.flatMap((provider, i) => {
      const models = found[i];
      return models ? [{ provider, name: LOCAL_RUNTIMES[provider].name, baseUrl: `http://127.0.0.1:${ports[provider]}/v1`, models }] : [];
    }),
  };
}
