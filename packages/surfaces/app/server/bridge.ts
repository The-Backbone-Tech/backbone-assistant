// The browser transport for the same api port: POST /api carries one call, GET /api/events streams
// events. It serves the built renderer. Used for browser journeys; Electron uses IPC instead.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { METHODS, type Method } from '@backbone-next/platform';
import { createHost } from '@backbone-next/platform/composition';
import { keysFromEnvironment } from '@backbone-next/platform/keys';
import { exportDestinations, rendererExport } from '@backbone-next/platform/composition/backup';
import { callFromRenderer } from '../electron/renderer-api.ts';
import { answerRestore, createRestorer } from '../electron/restore.ts';

const home = process.env.BACKBONE_HOME;
if (!home) throw new Error('Set BACKBONE_HOME to a fresh data folder.');
const root = fileURLToPath(new URL('../dist/renderer/', import.meta.url));
// A test names a folder to stand in for the person's home, so memory imports and skills read nothing real.
const host = createHost({ home, ...(process.env.BACKBONE_USER_HOME ? { memory: { userHome: process.env.BACKBONE_USER_HOME } } : {}) });
// Opening never resumes; the app carries on what a kill interrupted.
void host.resumeInterrupted().catch(() => {});
const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff' };

const exportTickets = exportDestinations();
// A restore opens its new data folder the way this bridge opened the first one.
// A journey that needs restore to be unavailable (a company configuration) names the reason.
const restorer = createRestorer({ home, unavailable: () => process.env.BACKBONE_BRIDGE_RESTORE_UNAVAILABLE || undefined, openHost: (target) => createHost({ home: target, keys: keysFromEnvironment(), ...(process.env.BACKBONE_USER_HOME ? { memory: { userHome: process.env.BACKBONE_USER_HOME } } : {}) }) });
/** The bridge serves one page, a journey's: its tickets are bound to it as Electron binds them to a window. */
const BRIDGE_PAGE = 0;
const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/api' && req.method === 'POST') {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', async () => {
      try {
        const { method, args } = JSON.parse(body) as { method: Method; args: unknown };
        if (!METHODS.includes(method)) throw new Error(`Unknown api method ${method}`);
        // As in Electron's main: an export goes only to the picked folder's ticket, never a named path.
        const given = method === 'backup.export' ? rendererExport(exportTickets, args, BRIDGE_PAGE) : null;
        const result = given ? ('to' in given ? await host.call('backup.export', given) : given) : await callFromRenderer(host, method, args);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result ?? null));
      } catch (err) {
        const legacy=err instanceof Error&&err.name==='LegacyIdentityUnavailable';
        res.writeHead(legacy?503:400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: err instanceof Error ? err.message : String(err),...(legacy?{kind:'LegacyIdentityUnavailable'}:{}) }));
      }
    });
    return;
  }
  // The browser has no native picker. A journey names the folder that stands in for the person's pick
  // (BACKBONE_BRIDGE_PICK); with none, no folder is picked and nothing can be exported.
  if (url.pathname === '/api/choose-export-folder' && req.method === 'POST') {
    const picked = process.env.BACKBONE_BRIDGE_PICK;
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(picked ? exportTickets.issue(picked, BRIDGE_PAGE) : null));
    return;
  }
  // The same stand-ins for the restore pickers: the backup folder is BACKBONE_BRIDGE_RESTORE_FROM, and the
  // folder a new data folder is made inside is BACKBONE_BRIDGE_PICK, as for an export.
  if (url.pathname === '/api/choose-backup-folder' && req.method === 'POST') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(process.env.BACKBONE_BRIDGE_RESTORE_FROM ? restorer.source(process.env.BACKBONE_BRIDGE_RESTORE_FROM, BRIDGE_PAGE) : null));
    return;
  }
  if (url.pathname === '/api/choose-restore-place' && req.method === 'POST') {
    const picked = process.env.BACKBONE_BRIDGE_PICK;
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(picked ? restorer.target(picked, BRIDGE_PAGE) : null));
    return;
  }
  if (url.pathname === '/api/restore' && req.method === 'POST') {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', async () => {
      try { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(await answerRestore(restorer, JSON.parse(body), BRIDGE_PAGE))); }
      catch (err) { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) })); }
    });
    return;
  }
  if (url.pathname === '/api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(': open\n\n');
    const off = host.on((e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
    req.on('close', off);
    return;
  }
  const rel = normalize(url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
  const file = join(root, rel);
  if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
});

server.listen(Number(process.env.PORT ?? 0), '127.0.0.1', () => {
  const a = server.address();
  console.log(`backbone bridge on http://127.0.0.1:${typeof a === 'object' && a ? a.port : ''}`);
});
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => (host.close(), server.close(), process.exit(0)));
