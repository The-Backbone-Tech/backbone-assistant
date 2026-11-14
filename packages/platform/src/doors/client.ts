// The door's side of its line to the process that holds the data home's keys (protocol.ts). The door
// holds no secret and opens no database: every call goes over the socket, and with nothing serving
// the home it is refused as not running, sending nothing. It connects on the first call and again
// after the app restarts, so a tool's door outlives the app's restarts.
import { createConnection, type Socket } from 'node:net';
import type { Gateway, GatewayArgs, GatewayMethod, GatewayRefusal, GatewayValue } from '../gateway.ts';
import { DOOR_PROTOCOL, doorSocket, type HelloReply, LOST_MID_CALL, MAX_LINE, NOT_RUNNING, ownFolder, type ResultLine, unsupported } from './protocol.ts';

export { doorSocket, LOST_MID_CALL, NOT_RUNNING };

export interface DoorConnection extends Gateway {
  /** Connect now, if not yet: 'ready', 'not-running', or the host's refusal of this grant. */
  ready(): Promise<'ready' | 'not-running' | GatewayRefusal>;
}

export function connectDoor(options: { home: string; grant: string }): DoorConnection {
  // Where no door runs yet (Windows), every call says so; nothing is ever connected.
  const refused = unsupported();
  const path = refused ? '' : doorSocket(options.home);
  let line: Promise<{ socket: Socket; pending: Map<number, { resolve(v: unknown): void; reject(e: Error): void }> } | GatewayRefusal> | undefined;
  let next = 1;
  let closed = false;

  function open(): Promise<{ socket: Socket; pending: Map<number, { resolve(v: unknown): void; reject(e: Error): void }> } | GatewayRefusal> {
    return new Promise((resolve) => {
      if (refused) return resolve(refused);
      // A socket in a folder that is not this user's alone could be another user's stand-in for the app.
      if (!ownFolder(path)) return resolve(NOT_RUNNING);
      const socket = createConnection(path);
      const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
      let buffered = '';
      let greeted = false;
      const drop = () => {
        line = undefined;
        for (const p of pending.values()) p.reject(new Error(LOST_MID_CALL));
        pending.clear();
      };
      socket.setEncoding('utf8');
      socket.on('connect', () => socket.write(`${JSON.stringify({ door: DOOR_PROTOCOL, grant: options.grant })}\n`));
      socket.on('error', () => {
        if (!greeted) resolve(NOT_RUNNING);
        socket.destroy();
      });
      socket.on('close', () => {
        if (!greeted) resolve(NOT_RUNNING);
        drop();
      });
      socket.on('data', (chunk: string) => {
        buffered += chunk;
        if (buffered.length > MAX_LINE * 2) return socket.destroy();
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
          if (!greeted) {
            greeted = true;
            const reply = message as HelloReply;
            if ('ready' in reply && reply.ready === true) resolve({ socket, pending });
            else {
              resolve('refused' in reply ? reply.refused : NOT_RUNNING);
              socket.destroy();
            }
            continue;
          }
          const { id, result } = message as ResultLine;
          pending.get(id)?.resolve(result);
          pending.delete(id);
        }
      });
    });
  }

  const connected = () => (line ??= open().then((l) => ('socket' in l ? l : ((line = undefined), l))));

  return {
    async ready() {
      const l = await connected();
      return 'socket' in l ? 'ready' : l === NOT_RUNNING ? 'not-running' : l;
    },
    async call<M extends GatewayMethod>(method: M, args: GatewayArgs<M>): Promise<GatewayValue<M>> {
      if (closed) return NOT_RUNNING as GatewayValue<M>;
      let l = await connected();
      // A line the host closed after it was opened: open it again once, before anything is sent.
      if ('socket' in l && !l.socket.writable) {
        line = undefined;
        l = await connected();
      }
      if (!('socket' in l)) return l as GatewayValue<M>;
      const id = next++;
      return new Promise<GatewayValue<M>>((resolve, reject) => {
        l.pending.set(id, { resolve: (v) => resolve(v as GatewayValue<M>), reject });
        l.socket.write(`${JSON.stringify({ id, method, args })}\n`);
      });
    },
    async close() {
      closed = true;
      const l = await line?.catch(() => undefined);
      if (l && 'socket' in l) l.socket.end();
    },
  };
}
