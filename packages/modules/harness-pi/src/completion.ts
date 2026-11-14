// pi-ai defaults an unterminated OpenAI stream to "stop". Observe the provider's actual terminal
// reason while forwarding the original bytes, so an EOF or [DONE] alone cannot establish success.
const REASONS = new Set(['stop', 'length', 'tool_calls', 'function_call', 'end_turn', 'tool_use', 'max_tokens', 'stop_sequence', 'pause_turn', 'refusal', 'content_filter']);
export const normalFinish = (reason: string) => ['stop', 'end_turn', 'stop_sequence'].includes(reason);
export function unfinishedMessage(reason: string): string {
  return reason === 'length' || reason === 'max_tokens'
    ? 'The answer was cut off by the model limit. The context window or output token limit is likely too small; increase it or reduce the input, then ask again.'
    : 'The answer was cut off without a normal stop. The connection may have ended or the provider stopped early; check the model server and its context/output limits, then ask again.';
}
export function observeCompletion(response: Response, finish: (reason: string) => void): Response {
  if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream')) return response;
  const decoder = new TextDecoder(); let pending = '';
  const line = (s: string) => {
    if (!s.startsWith('data:')) return;
    try {
      const data = JSON.parse(s.slice(5).trim());
      const raw = data.choices?.[0]?.finish_reason ?? data.delta?.stop_reason;
      if (typeof raw === 'string') finish(REASONS.has(raw) ? raw : 'unknown');
    } catch { /* [DONE] is transport framing, never a finish reason. */ }
  };
  const drain = () => { let i; while ((i = pending.indexOf('\n')) >= 0) { line(pending.slice(0, i).trimEnd()); pending = pending.slice(i + 1); } };
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(bytes, controller) { pending += decoder.decode(bytes, { stream: true }); drain(); controller.enqueue(bytes); },
    flush() { pending += decoder.decode(); drain(); if (pending) line(pending); },
  }));
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
