import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import type { Socket } from 'node:net';

export async function fakeProvider(provider: 'slack' | 'telegram') {
  const requests: { path: string; body: string }[] = [];
  const sockets = new Set<Socket>();
  let next: 'ok' | 'fail' | 'silent' = 'ok';
  let events: ((request: Request) => Promise<Response>) | undefined;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const path = req.url ?? '/';
    requests.push({ path, body });
    if (path === '/events' && events) {
      const reply = await events(new Request('http://localhost/events', { method: 'POST', body, headers: req.headers as Record<string,string> }));
      res.writeHead(reply.status, Object.fromEntries(reply.headers)); res.end(await reply.text()); return;
    }
    const method = path.split('/').at(-1)!;
    const posting = method === 'chat.postMessage' || method === 'sendMessage';
    const action = posting ? next : 'ok';
    if (posting && next === 'fail') next = 'ok';
    if (action === 'silent') return;
    res.setHeader('content-type', 'application/json');
    if (action === 'fail') { res.end(JSON.stringify({ ok: false, error: 'internal_error', error_code: 500, description: 'temporary refusal' })); return; }
    if (provider === 'slack') res.end(JSON.stringify(method === 'auth.test' ? { ok: true, user_id: 'BOT', bot_id: 'BOT', team_id: 'T1' } : method === 'users.info' ? { ok: true, user: { id: 'U1', name: 'person', is_bot: false } } : method === 'conversations.info' ? { ok: true, channel: { id: 'D1', is_im: true } } : { ok: true, ts: String(requests.length), channel: 'D1', message: { text: 'reply' } }));
    else res.end(JSON.stringify({ ok: true, result: method === 'getMe' ? { id: 42, is_bot: true, first_name: 'Bot', username: 'testbot' } : { message_id: requests.length, date: Math.floor(Date.now()/1000), chat: { id: 1, type: 'private' }, text: 'reply' } }));
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}`;
  return { url, requests, posts() {
      return requests.filter(r=>r.path.endsWith('/chat.postMessage')||r.path.endsWith('/sendMessage')).map(r=>provider==='slack'?Object.fromEntries(new URLSearchParams(r.body)):JSON.parse(r.body) as Record<string,unknown>);
    }, script(action: typeof next) { next = action; }, events(fn: NonNullable<typeof events>) { events = fn; },
    async emit(payload: unknown, secret = 'test-signing', extraHeaders: Record<string,string> = {}) {
      const body = JSON.stringify(payload), timestamp = String(Math.floor(Date.now()/1000));
      return fetch(`${url}/events`, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': timestamp, 'x-slack-signature': `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`, 'x-telegram-bot-api-secret-token': secret, ...extraHeaders } });
    },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise<void>(r => server.close(() => r())); }
  };
}
