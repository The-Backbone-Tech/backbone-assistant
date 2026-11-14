import { createHash } from 'node:crypto';
import type { RouteRecord } from '../api.ts';

/** Opaque endpoint/credential-handle identity. The model is bound separately, so native follow-ups can name one. */
export function routeFingerprint(route: RouteRecord & { credential?: string | null }): string {
  return createHash('sha256').update(JSON.stringify({ kind: route.kind, provider: route.provider, baseUrl: route.baseUrl, credential: route.credential ?? null })).digest('hex');
}

/** Known non-chat families cannot become chat routes just by appearing in a model list. */
export const chatModel = (model: string) => !/embed|rerank|whisper|(?:^|[/:_-])(?:tts|stable-diffusion|flux|dall-e)(?:$|[/:_-])/i.test(model);
