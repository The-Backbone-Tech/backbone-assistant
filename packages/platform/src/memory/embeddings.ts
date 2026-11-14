// Recall by meaning (scorecard row 6): when the person names an embeddings model on this computer,
// remembered lines and a turn's words are turned into vectors there, and memory/rank.ts merges their
// similarity with the words. Only a loopback address is accepted, a redirect is never followed, and
// nothing is started or downloaded: the person runs the model in their own runtime (Ollama, LM
// Studio, llama.cpp, vLLM). A line holding a credential is never sent. Vectors are kept in
// memory/.vectors.json by the hash of the text, for that route only, and pruned to the lines memory
// still holds, so a forgotten or withdrawn line's vector goes with it. Any failure is lexical recall.
import { governedPolicy, routeDecision, PolicyRefused } from '../policy/index.ts';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readJson, writeJson } from '../stub/fsx.ts';
import { holdsCredential } from './learn.ts';
import { cosine } from './rank.ts';
import { memoryReferenceText } from './visible.ts';
import type { Similarity } from './store.ts';

import type { MemoryRoute as MeaningRoute } from '../api.ts';
export type { MeaningRoute };

// An address, never a name: `localhost` is whatever the resolver says, which may be elsewhere.
const LOOPBACK = /^http:\/\/(127\.0\.0\.1|\[::1\]):\d{1,5}(\/[\w./-]*)?$/;
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const MAX_MODEL = 200;
/** Lines sent in one request, lines embedded per turn at most, and the largest answer read. */
const BATCH = 64;
const MAX_LINES = 512;
const MAX_BODY = 8 * 1024 * 1024;
const MAX_DIMS = 4_096;
const TIMEOUT_MS = 4_000;
const MAX_WAITING = 2;

interface Cache { route: string; vectors: Record<string, number[]> }
/** What may be sent now: memory's lines as they stand, and the credentials known now; null when they cannot be read. */
export type Current = () => Promise<{ lines: readonly string[]; exact: readonly string[] } | null>;

const hash = (text: string) => createHash('sha256').update(memoryReferenceText(text)).digest('hex');
const routeKey = (r: MeaningRoute) => `${r.baseUrl}\n${r.model}`;

/** The route as the person gave it, checked; throws a plain sentence when it is not on this computer. */
export function checkedRoute(route: { baseUrl: string; model: string }): MeaningRoute {
  const baseUrl = route.baseUrl.trim().replace(/\/+$/, '');
  if (!LOOPBACK.test(baseUrl)) throw new Error('An embeddings model must be on this computer: an http:// address on 127.0.0.1 or [::1], with its port.');
  const model = route.model.replace(HIDDEN, '').trim().slice(0, MAX_MODEL);
  if (!model) throw new Error('Name the embeddings model, as its runtime lists it.');
  return { baseUrl, model };
}

export class Meaning {
  private readonly home: string;
  private readonly routePath: string;
  private readonly cachePath: string;
  private readonly get: typeof fetch;
  /** One similarity at a time: a slow or hostile server cannot hold many answers in memory at once. */
  private queue: Promise<unknown> = Promise.resolve();
  /** Runs going or waiting; past `MAX_WAITING` a recall is by words alone rather than wait. */
  private pending = 0;
  /** Counts each change of route: a run that sees it move sends and keeps nothing more. */
  private epoch = 0;

  constructor(home: string, get: typeof fetch = fetch) {
    this.home = home;
    this.get = get;
    this.routePath = join(home, 'memory', '.meaning.json');
    this.cachePath = join(home, 'memory', '.vectors.json');
  }

  route(): MeaningRoute | null {
    const stored = readJson<MeaningRoute | null>(this.routePath, null);
    const policy = governedPolicy(this.home);
    try { if (stored) routeDecision(policy, { kind: 'endpoint', provider: 'openai-compatible' }); }
    catch (error) {
      // A forbidden saved route disables meaning recall; an invalid policy still refuses the read.
      if (error instanceof PolicyRefused && error.code === 'requirement') return null;
      throw error;
    }
    try { return stored ? checkedRoute(stored) : null; } catch { return null; }
  }

  /** Name the route, or clear it (null): then recall is by words alone and the kept vectors go. */
  set(route: { baseUrl: string; model: string } | null): MeaningRoute | null {
    if (route) routeDecision(governedPolicy(this.home), { kind: 'endpoint', provider: 'openai-compatible' });
    const checked = route ? checkedRoute(route) : null;
    this.epoch++;
    writeJson(this.routePath, checked);
    if (!checked) writeJson(this.cachePath, { route: '', vectors: {} } satisfies Cache);
    return checked;
  }

  /**
   * How near each of memory's lines is to `words`, from the person's route; undefined with no route,
   * or when it does not answer as asked. What may be sent is asked again (`current`) before each
   * request and before the cache is written, so a line forgotten, withdrawn or found to hold a
   * credential meanwhile is not sent, kept or scored. Lines holding a credential have no similarity.
   */
  similarity(words: string, current: Current): Promise<Similarity | undefined> {
    if (this.pending >= MAX_WAITING) return Promise.resolve(undefined);
    this.pending++;
    const run = this.queue.then(() => this.measure(words, current)).finally(() => this.pending--);
    this.queue = run.catch(() => {});
    return run;
  }

  /**
   * Keep only vectors for `lines` (what memory holds now) that hold no credential (`exact`): called
   * when a line is forgotten, changed or withdrawn. With no credentials to check against (null), none is kept.
   */
  prune(lines: readonly string[], exact: readonly string[] | null): void {
    const stored = readJson<Cache>(this.cachePath, { route: '', vectors: {} });
    const keep = new Set(exact ? lines.filter((l) => !holdsCredential(l, exact)).map(hash) : []);
    const vectors = Object.fromEntries(Object.entries(stored.vectors).filter(([k]) => keep.has(k)));
    if (Object.keys(vectors).length !== Object.keys(stored.vectors).length) writeJson(this.cachePath, { route: stored.route, vectors } satisfies Cache);
  }

  private async measure(words: string, current: Current): Promise<Similarity | undefined> {
    const route = this.route();
    const epoch = this.epoch;
    if (!route || !words.trim()) return undefined;
    // The route the person named when this run began, still: else nothing more is sent or kept.
    const same = () => this.epoch === epoch;
    const sendable = async () => {
      const now = await current();
      return now ? new Set([...new Set(now.lines)].filter((l) => !holdsCredential(l, now.exact)).slice(0, MAX_LINES)) : null;
    };
    const first = await current();
    if (!first || holdsCredential(words, first.exact)) return undefined;
    const stored = readJson<Cache>(this.cachePath, { route: '', vectors: {} });
    const vectors = stored.route === routeKey(route) ? stored.vectors : {};
    try {
      const [asked] = await this.embed(route, [words]);
      let allowed = await sendable();
      if (!allowed) return undefined;
      const missing = [...allowed].filter((l) => !vectors[hash(l)]);
      for (let i = 0; i < missing.length; i += BATCH) {
        if (!same()) return undefined;
        if (i) allowed = await sendable();
        const batch = missing.slice(i, i + BATCH).filter((l) => allowed?.has(l));
        if (batch.length) (await this.embed(route, batch)).forEach((v, j) => (vectors[hash(batch[j])] = v));
      }
      // Asked once more before anything is kept: the route still named, and only lines memory still holds.
      allowed = await sendable();
      if (!allowed || !same()) return undefined;
      const keep = new Set([...allowed].map(hash));
      writeJson(this.cachePath, { route: routeKey(route), vectors: Object.fromEntries(Object.entries(vectors).filter(([k]) => keep.has(k))) } satisfies Cache);
      return (text) => { const v = keep.has(hash(text)) ? vectors[hash(text)] : undefined; return v ? cosine(asked, v) : undefined; };
    } catch (error) {
      if (error instanceof PolicyRefused) throw error;
      return undefined;
    }
  }

  private async embed(route: MeaningRoute, input: string[]): Promise<number[][]> {
    routeDecision(governedPolicy(this.home), { kind: 'endpoint', provider: 'openai-compatible' });
    const res = await this.get(`${route.baseUrl}/embeddings`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ model: route.model, input: input.map(memoryReferenceText) }),
    });
    if (!res.ok || !res.body) throw new Error(`embeddings answered ${res.status}`);
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) { void reader.cancel(); throw new Error('embeddings answer too large'); }
      chunks.push(value);
    }
    const data = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { data?: unknown }).data;
    if (!Array.isArray(data) || data.length !== input.length) throw new Error('embeddings answer does not match the request');
    const out: number[][] = new Array(input.length);
    for (const [n, item] of data.entries()) {
      const { embedding, index } = (item ?? {}) as { embedding?: unknown; index?: unknown };
      const at = typeof index === 'number' ? index : n;
      if (!Number.isInteger(at) || at < 0 || at >= input.length || out[at]) throw new Error('embeddings answer is out of order');
      if (!Array.isArray(embedding) || !embedding.length || embedding.length > MAX_DIMS || !embedding.every((x) => typeof x === 'number' && Number.isFinite(x))) throw new Error('embeddings answer is not a vector');
      out[at] = embedding as number[];
    }
    const dims = out[0].length;
    if (out.some((v) => v.length !== dims)) throw new Error('embeddings differ in length');
    return out;
  }
}
