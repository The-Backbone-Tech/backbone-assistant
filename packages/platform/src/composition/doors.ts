import { governedPolicy, PolicyRefused } from '../policy/index.ts';
// The doors of a data home, served by the one process that holds its keys (the app's host, or
// `backbone-mcp host`): each door process connects over the home's socket (doors/protocol.ts), names
// its grant, and its four gateway calls run here, on this process's link to the core, so the door
// itself holds no secret (lab S18: enforcers do not share the agent's failure domain). The socket
// admits only the person's user (a folder only it may enter) and carries no control call: a grant
// or a revoke is never made through it.
import { chmodSync, existsSync, mkdirSync, rmdirSync, rmSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';
import type { Executor, Gateway, GatewayRefusal } from '../gateway.ts';
import { BAD_GRANT, BAD_METHOD, type CallLine, DOOR_METHODS, DOOR_PROTOCOL, doorSocket, GRANT_NAME, type Hello, MAX_LINE, ownFolder, unsupported } from '../doors/protocol.ts';
import { CoreLink, type CoreOptions } from './core.ts';
import { gatewayOn, sweepInterruptedDispatches } from './gateway.ts';
import { ownHome } from './home-owner.ts';
import {assertHomeWriteAdmission} from './home-lock.ts';
import { outboxExecutor } from './outbox.ts';
import { PieceRefused } from './pieces.ts';

export interface DoorServer {
  /** Where the doors connect; null when another process already serves this home's doors. */
  readonly socket: string | null;
  close(): Promise<void>;
}

export interface DoorServerOptions {
  home: string;
  /** Managed Host startup and live admission, including required telemetry. */
  admit?(): Promise<void>;
  /** This process's link to the core; every door's calls run on it. */
  link: () => Promise<CoreLink>;
  /** The door's own folder, whose files its grants are bound to; the MCP door's by default. */
  piece?: string;
  executors?: Record<string, Executor>;
}

/** Whether something answers on the socket now. */
function answers(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createConnection(path);
    probe.once('connect', () => (probe.destroy(), resolve(true)));
    probe.once('error', () => resolve(false));
  });
}

const refused = (refusal: GatewayRefusal) => `${JSON.stringify({ refused: refusal })}\n`;

/**
 * Serve the home's doors on its socket. A live server already there (another host of the same home)
 * keeps serving them and this one serves none; a stale socket a killed process left is replaced.
 */
export async function serveDoors(options: DoorServerOptions): Promise<DoorServer> {
  if (governedPolicy(options.home)?.requirements.telemetryRequired && !options.admit) throw new PolicyRefused('requirement', 'Required telemetry needs the managed Host before its doors can serve governed work.');
  // Where no door runs yet (Windows), none is served: doorSocket refuses with the reason.
  const path = doorSocket(options.home);
  assertHomeWriteAdmission(options.home,dirname(path));
  const executors = options.executors ?? { 'outbox.write': outboxExecutor(options.home) };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    chmodSync(dirname(path), 0o700);
  } catch {
    // Not ours to change: refused just below.
  }
  if (!ownFolder(path)) throw new Error(`${dirname(path)} is not this user's alone, so the doors are not served there.`);
  if (existsSync(path)) {
    if (await answers(path)) return { socket: null, close: async () => {} };
    rmSync(path, { force: true });
  }
  const open = new Set<{ socket: Socket; gateway?: Promise<Gateway | null> }>();
  const server: Server = createServer((socket) => {
    const conn: { socket: Socket; gateway?: Promise<Gateway | null> } = { socket };
    open.add(conn);
    let buffered = '';
    socket.setEncoding('utf8');
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      open.delete(conn);
      void conn.gateway?.then((g) => g?.close()).catch(() => {});
    });
    const hello = async (h: Partial<Hello>) => {
      if (h.door !== DOOR_PROTOCOL || typeof h.grant !== 'string' || !GRANT_NAME.test(h.grant)) {
        socket.end(refused(BAD_GRANT));
        return null;
      }
      try {
        const gateway = await gatewayOn(await options.link(), { home: options.home, grant: h.grant, executors, piece: options.piece }, { own: false });
        if (socket.destroyed) {
          await gateway.close();
          return null;
        }
        socket.write(`${JSON.stringify({ ready: true })}\n`);
        return gateway;
      } catch (error) {
        // The core's or the piece check's own words; never the caller's.
        const detail = error instanceof PieceRefused ? error.message : 'The app could not open this door.';
        socket.end(refused({ ok: false, outcome: 'REFUSED', reason: 'REFUSED', detail }));
        return null;
      }
    };
    const call = async (gateway: Gateway, c: Partial<CallLine>) => {
      if (typeof c.id !== 'number') return socket.destroy();
      let policyFailure: GatewayRefusal | undefined;
      try { governedPolicy(options.home); await options.admit?.(); }
      catch (error) { if (error instanceof PolicyRefused) policyFailure = { ok: false, outcome: 'REFUSED', reason: 'REFUSED', detail: error.message }; else throw error; }
      const result = policyFailure ?? (DOOR_METHODS.includes(c.method as never) ? await gateway.call(c.method as CallLine['method'], (c.args ?? {}) as never) : BAD_METHOD);
      if (!socket.destroyed) socket.write(`${JSON.stringify({ id: c.id, result })}\n`);
    };
    socket.on('data', (chunk: string) => {
      buffered += chunk;
      if (buffered.length > MAX_LINE) return socket.destroy();
      let at: number;
      while ((at = buffered.indexOf('\n')) >= 0) {
        const text = buffered.slice(0, at);
        buffered = buffered.slice(at + 1);
        let message: unknown;
        try {
          message = JSON.parse(text);
        } catch {
          return socket.destroy();
        }
        if (!message || typeof message !== 'object' || Array.isArray(message)) return socket.destroy();
        if (!conn.gateway) conn.gateway = hello(message as Partial<Hello>);
        else void conn.gateway.then((g) => (g ? call(g, message as Partial<CallLine>) : undefined)).catch(() => socket.destroy());
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => resolve());
  });
  chmodSync(path, 0o600);
  server.unref();
  return {
    socket: path,
    async close() {
      // The server stops listening at once, and closes once its connections are gone: end them now.
      const stopped = new Promise((r) => server.close(r));
      const conns = [...open];
      for (const c of conns) c.socket.destroy();
      await stopped;
      await Promise.all(conns.map((c) => c.gateway?.then((g) => g?.close()).catch(() => {})));
      rmSync(path, { force: true });
      // The folder goes too once no other home's socket is in it (the shared one for long home paths).
      try {
        rmdirSync(dirname(path));
      } catch {
        // Another home's socket is still there, or the folder is already gone.
      }
    },
  };
}

/**
 * The headless host of a data home's doors (`backbone-mcp host`): this process opens the core with
 * the home's keys, settles dispatches a dead door left, and serves the doors until it is closed.
 * For a home whose keys the Keychain holds, that process is the app.
 */
export async function hostDoors(options: { home: string; piece?: string } & Pick<CoreOptions, 'baselineSql' | 'postgresNative' | 'keys'>): Promise<DoorServer> {
  const refused = unsupported();
  if (refused) throw new Error(refused.detail);
  const link = await CoreLink.open(options);
  // The sweep below is a host's recovery, so this process holds the home first, as `createHost` does.
  let release: () => Promise<void>;
  try { release = await ownHome(options.home); }
  catch (error) { await link.release(); throw error; }
  const executors = { 'outbox.write': outboxExecutor(options.home) };
  const sweep = () => sweepInterruptedDispatches(link, executors).catch(() => 0);
  await sweep();
  const sweeper = setInterval(sweep, 2_000);
  let served: DoorServer;
  try {
    served = await serveDoors({ home: options.home, link: async () => link, piece: options.piece, executors });
  } catch (error) {
    clearInterval(sweeper);
    await link.release();
    await release();
    throw error;
  }
  if (!served.socket) {
    clearInterval(sweeper);
    await link.release();
    await release();
    throw new Error('Another process already serves this data home\'s doors.');
  }
  return {
    socket: served.socket,
    async close() {
      clearInterval(sweeper);
      await served.close();
      await link.release();
      await release();
    },
  };
}
