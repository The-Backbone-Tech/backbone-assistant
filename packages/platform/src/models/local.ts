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
/** The same loopback rule the route applies: http on 127.0.0.1, localhost or [::1], with a port. */
const LOCAL_ADDRESS = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+(\/|$)/;
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

/** The model ids a server lists at `url`, or null when it does not answer with a list. Redirects are never followed. */
async function readModelList(url: string, timeoutMs: number, get: typeof fetch): Promise<string[] | null> {
  try {
    const res = await get(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
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

async function probe(port: number, timeoutMs: number, get: typeof fetch): Promise<string[] | null> {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return readModelList(`http://127.0.0.1:${port}/v1/models`, timeoutMs, get);
}

/**
 * The address to save for a local runtime. Ollama, LM Studio, llama.cpp and vLLM serve their OpenAI-compatible
 * interface under /v1, so a bare address (no path) gets /v1; any path the person gave is kept, and `other` is saved as given.
 * Only the shape is read here: whether the address is on this computer is the caller's rule.
 */
export function normaliseLocalEndpoint(provider: LocalProvider, address: string): { baseUrl: string; addedPath: boolean } {
  const baseUrl = String(address ?? '').trim().replace(/\/+$/, '');
  if (provider === 'other' || !/^http:\/\/[^/?#\s]+$/.test(baseUrl)) return { baseUrl, addedPath: false };
  return { baseUrl: `${baseUrl}/v1`, addedPath: true };
}

/** What a saved local address and model look like from the server: its listed models, a model it lacks, or no usable answer. */
export type LocalCheck = { state: 'listed' } | { state: 'missing'; served: string[] } | { state: 'unchecked' };

/** Asks only the loopback address the person gave for its model list (a read; no model runs). */
export async function checkLocalModel(baseUrl: string, model: string, options: Pick<LocalProbe, 'timeoutMs' | 'fetch'> = {}): Promise<LocalCheck> {
  if (!LOCAL_ADDRESS.test(baseUrl)) return { state: 'unchecked' };
  const served = await readModelList(`${baseUrl.replace(/\/+$/, '')}/models`, options.timeoutMs ?? 1500, options.fetch ?? fetch);
  if (!served) return { state: 'unchecked' };
  return served.includes(model) ? { state: 'listed' } : { state: 'missing', served };
}

/** The line a person reads after saving a local choice, from the address change and the check. */
export function describeLocalSave(baseUrl: string, model: string, addedPath: boolean, check: LocalCheck): string {
  const using = addedPath ? `Using ${baseUrl} (the /v1 path was added). ` : '';
  if (check.state === 'listed') return `${using}The server answered and ${model} is listed.`;
  if (check.state === 'missing') return `${using}The server answered but does not list ${model}. It lists: ${check.served.slice(0, 10).join(', ') || 'no models'}. Saved anyway; check the model name or load the model.`;
  return `${using}The model could not be checked: nothing usable answered at ${baseUrl}/models. Saved anyway; start the server, load ${model} and check the address before the first turn.`;
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
