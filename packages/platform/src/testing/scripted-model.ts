// A scripted model for tests and journeys: an OpenAI-compatible chat-completions server on the
// loopback that decides each step from the request alone, so a real harness can be driven with no
// network and no key. It asks for an editable brief by reading the attached files and writing
// brief.md; it answers a question by listing the files and reading the drafted ones. It keeps every
// request it was sent, headers included, so a test can scan what reached the model.
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { isJudgeRequest, judgeStep } from './memory-model.ts';
import { TRIAGE_REQUEST, triageStep } from './triage-model.ts';

export interface ScriptedModel {
  /** The OpenAI-compatible base URL, ending in /v1. */
  url: string;
  model: string;
  requests: { headers: IncomingHttpHeaders; body: string }[];
  close(): Promise<void>;
}

export interface Message {
  role: string;
  content?: string | { type: string; text?: string }[] | null;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export type Step = { text: string; /** null simulates a stream cut off without a finish reason. */ finish?: string | null } | { calls: { name: string; args: Record<string, unknown> }[]; finish?: string | null };
/**
 * What the server says it serves at GET /models, and which of those it refuses when asked to run them.
 * `before` sees each chat request first: it may wait, and may answer with an HTTP error instead of a step.
 */
export interface ServedModels {
  served?: string[];
  refuses?: string[];
  before?(messages: Message[]): void | { status: number; message: string } | Promise<void | { status: number; message: string }>;
}

const WRITE_INTENT = /\b(write|draft|create|make|produce|prepare)\b[^.?!]*\b(brief|document|summary)\b/i;
const text = (m: Message) => (typeof m.content === 'string' ? m.content : (m.content ?? []).map((c) => c.text ?? '').join(''));
const compact = (s: string, n = 160) => s.replace(/\s+/g, ' ').trim().slice(0, n);

/** The next step of the turn whose last person message ends `messages`. */
export function scriptedStep(messages: Message[]): Step {
  const start = messages.findLastIndex((m) => m.role === 'user');
  const asked = text(messages[start]);
  const triage = TRIAGE_REQUEST.exec(asked);
  if (triage) return triageStep(messages, triage[1]);
  if (isJudgeRequest(messages)) return judgeStep(messages);
  const request = asked.split('\n\nAttached: ')[0];
  const attached = /\n\nAttached: (.+)$/m.exec(asked)?.[1].split(', ') ?? [];
  const results = new Map<string, { name: string; args: Record<string, string>; result: string }>();
  for (const m of messages.slice(start + 1)) {
    for (const c of m.tool_calls ?? []) results.set(c.id, { name: c.function.name, args: JSON.parse(c.function.arguments || '{}'), result: '' });
    if (m.role === 'tool' && m.tool_call_id && results.has(m.tool_call_id)) results.get(m.tool_call_id)!.result = text(m);
  }
  const done = [...results.values()];
  const reads = done.filter((d) => d.name === 'read_file');

  if (WRITE_INTENT.test(request)) {
    const wrote = done.find((d) => d.name === 'write_file');
    if (wrote) {
      const v = /^Wrote (\S+) v(\d+)/.exec(wrote.result);
      return { text: v ? `I drafted ${v[1]} v${v[2]} from ${reads.length} source(s). It is ready to edit.` : wrote.result };
    }
    if (attached.length && !reads.length) return { calls: attached.map((name) => ({ name: 'read_file', args: { name } })) };
    // The real ToolHost requires a replacement to be based on a version actually read.
    // Discover the target even when the message has no attachments; listing alone is not a read.
    const listed = done.find((d) => d.name === 'list_files');
    if (!listed) return { calls: [{ name: 'list_files', args: {} }] };
    if (/^- brief\.md v\d+\b/m.test(listed.result) && !reads.some((read) => read.args.name === 'brief.md')) {
      return { calls: [{ name: 'read_file', args: { name: 'brief.md' } }] };
    }
    const sources = reads.map((r) => `- ${r.args.name}: ${compact(r.result.split('\n\n').slice(1).join(' '))}`);
    const content = ['# Brief', '', `Request: ${request}`, '', '## Sources', ...(sources.length ? sources : ['- (no attachments)']), '', '## Draft', '', 'Edit this document, then Save to make it yours.', ''].join('\n');
    return { calls: [{ name: 'write_file', args: { name: 'brief.md', content } }] };
  }

  const listed = done.find((d) => d.name === 'list_files');
  if (!listed) return { calls: [{ name: 'list_files', args: {} }] };
  const drafted = listed.result.split('\n').filter((l) => /^- .+ v\d+ .*\b(working|accepted)\b/.test(l)).map((l) => l.slice(2).split(' v')[0]);
  if (!drafted.length) return { text: 'Nothing has been drafted in this project yet.' };
  if (!reads.length) return { calls: drafted.map((name) => ({ name: 'read_file', args: { name } })) };
  const lines = reads.map((r) => {
    const [head, ...body] = r.result.split('\n\n');
    return `- ${head}. It says: ${compact(body.join(' '))}`;
  });
  return { text: `I read the current versions:\n${lines.join('\n')}` };
}

const chunk = (model: string, delta: Record<string, unknown>, finish: string | null) =>
  `data: ${JSON.stringify({ id: 'scripted', object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

export function startScriptedModel(model = 'scripted-model', script: (messages: Message[]) => Step = scriptedStep, models: ServedModels = {}): Promise<ScriptedModel> {
  const requests: ScriptedModel['requests'] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', async () => {
      requests.push({ headers: req.headers, body });
      if (req.method === 'GET' && req.url?.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify({ object: 'list', data: (models.served ?? [model]).map((id) => ({ id, object: 'model' })) }));
      }
      if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) return void res.writeHead(404).end();
      const asked = JSON.parse(body) as { messages: Message[]; model?: string };
      if (asked.model && models.refuses?.includes(asked.model)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify({ error: { message: `The model ${asked.model} is not available.`, type: 'invalid_request_error' } }));
      }
      const failed = await models.before?.(asked.messages);
      if (failed) {
        res.writeHead(failed.status, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify({ error: { message: failed.message, type: 'scripted_error' } }));
      }
      const step = script(asked.messages);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      res.write(chunk(model, { role: 'assistant', content: '' }, null));
      if ('text' in step) {
        for (const piece of step.text.match(/[\s\S]{1,40}/g) ?? ['']) res.write(chunk(model, { content: piece }, null));
        if (step.finish !== null) res.write(chunk(model, {}, step.finish ?? 'stop'));
      } else {
        step.calls.forEach((c, index) =>
          res.write(chunk(model, { tool_calls: [{ index, id: `call_${requests.length}_${index}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }] }, null)),
        );
        if (step.finish !== null) res.write(chunk(model, {}, step.finish ?? 'tool_calls'));
      }
      res.write(`data: ${JSON.stringify({ id: 'scripted', object: 'chat.completion.chunk', created: 0, model, choices: [], usage: { prompt_tokens: body.length >> 2, completion_tokens: 8, total_tokens: (body.length >> 2) + 8 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const a = server.address();
      const port = typeof a === 'object' && a ? a.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        model,
        requests,
        close: () => new Promise((r) => (server.closeAllConnections(), server.close(() => r()))),
      });
    });
  });
}
