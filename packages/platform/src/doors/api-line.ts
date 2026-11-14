// The api line: a named part of the `api`, from the process that holds a data home's keys (the app) to
// another process of the person's user (the command line). Newline-delimited JSON over a Unix socket
// beside the door's, in the same folder only that user may enter: `{ api: 1 }` is answered with
// `{ ready, send, serverPid }`, then `{ id, method, args }` with `{ id, result }`, or `{ id, failed: true }` when
// the host threw, which says nothing about whether the call took effect. docs/adr/0002-api-line.md
// says who may use it. This file opens no database, so a client imports nothing that could.
import { createConnection, type Socket } from 'node:net';
import { basename, dirname, join } from 'node:path';
import type { Args, Method, Receipt, Result, ConnectorEffectAnswer, ConnectorEffectResolution } from '../api.ts';
import { doorSocket, MAX_LINE, ownFolder, unsupported } from './protocol.ts';

export const API_LINE_PROTOCOL = 1;
/** The longest answer a client takes: a thread's whole text can be far longer than a request. */
export const MAX_ANSWER = 64 << 20;
const HELLO_WAIT_MS = 10_000;
/** The longest words a person is asked about: all of them must fit in the question, so nothing is clipped. */
export const MAX_ASKED = 1_000;

/**
 * Reads that start no work. Most answer from plain files or projections of them. audit.export
 * additionally reads the database ledger: a same-user process learns ids, times, operation classes
 * and outcomes across the whole home. It receives no content or unkeyed argument/proposal/intent
 * digests. core.signatureStatus returns only its fixed step name and verified/paused state
 * through the existing Core connection. Content opt-in is refused here; an asked, person-confirmed app call is not built yet.
 */
export const API_LINE_READS = ['solutions.options', 'solutions.verify', 'audit.export', 'core.signatureStatus', 'projects.list', 'threads.list', 'threads.get', 'threads.search', 'goals.runs', 'schedules.get', 'memory.search', 'work.now', 'files.list', 'material.read', 'changes.get', 'models.list', 'settings.model.get', 'settings.policy.get'] as const satisfies readonly Method[];
/**
 * Writes that run only once the person allows each one in the app's own question: each can spend their
 * model route, now (a send, a queued message, a goal run) or later (a schedule), or changes what a goal
 * run is judged against (goals.set). docs/adr/0002-api-line.md gives each its reason.
 */
export const API_LINE_ASKED = ['solutions.run', 'turns.send', 'queue.add', 'goals.set', 'goals.run', 'schedules.create'] as const satisfies readonly Method[];
export const API_LINE_PERSON_ASKED = ['connectors.resolveEffect', 'threads.checked'] as const;
/** Explicitly enabled only by the shared daemon, on its same-user local socket. */
export const API_LINE_TEAM = ['identity.get','identity.invite','identity.share','identity.remove'] as const satisfies readonly Method[];
/** Local project creation, explicitly enabled by the device owner's app or daemon. Never a network capability. */
export const API_LINE_PROJECTS = ['projects.create'] as const satisfies readonly Method[];
/** General API methods on the line. The separate person-only asked list above adds no Host.call method. */
export const API_LINE_METHODS = [...API_LINE_READS, ...API_LINE_ASKED, 'turns.stop'] as const satisfies readonly Method[];

/** What an asked write meets: the person will be asked, or writes are closed here. The name is the first one's. */
export type SendState = 'ask' | 'closed';
export type HelloAnswer = { ready: true; send: SendState; serverPid?: number };

/** Where a home's api line is served: beside its door socket, in that same user-only folder. */
export function apiSocket(home: string): string {
  const door = doorSocket(home);
  const name = basename(door);
  return join(dirname(door), name === 'door.sock' ? 'api.sock' : name.replace(/\.sock$/, '.api.sock'));
}

export const refusal = <T>(reason: 'INVALID' | 'NOT_AVAILABLE', detail: string): Receipt<T> => ({ ok: false, reason, detail, outcome: 'REFUSED' });

/** The app is there and said nothing: nothing was asked of it. */
export class LineSilent extends Error {}

export interface ConnectorEffectInput { effect: string; argsHash: string; answer: ConnectorEffectAnswer }

export interface ApiLine {
  /** What a send will need, as it stood when this line opened. */
  readonly send: SendState;
  /** The serving process, read through the private socket rather than trusted from a pid file. */
  readonly serverPid?: number;
  call<M extends Method>(method: M, args: Args<M>): Promise<Result<M>>;
  /** This separate asked write is never an API read or a ToolHost method. */
  resolveConnectorEffect(args: ConnectorEffectInput): Promise<Receipt<ConnectorEffectResolution>>;
  checkedTurn(args: import('../api.ts').UnknownCheckInput): Promise<Receipt<import('../api.ts').UnknownCheck>>;
  close(): void;
}

/** The host went away or threw with a call in flight: what became of it is not known, and it is not sent again. */
const LOST = 'The line to the app ended with this call in flight, so whether it happened is not known.';

/**
 * Open the home's api line, or null when nothing serves it here: no socket, a dead one, or a folder
 * that is not this user's alone, which could be another user's stand-in for the app. Nothing retries:
 * a call that fails is never sent twice.
 */
export function attachApi(home: string): Promise<ApiLine | null> {
  if (unsupported()) return Promise.resolve(null);
  const path = apiSocket(home);
  if (!ownFolder(path)) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const socket: Socket = createConnection(path);
    const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
    let buffered = '';
    let next = 1;
    let line: ApiLine | undefined;
    let ended = false;
    const silent = setTimeout(() => {
      socket.destroy();
      reject(new LineSilent('The app is running and did not answer, and nothing was done.'));
    }, HELLO_WAIT_MS);
    const end = () => {
      ended = true;
      clearTimeout(silent);
      if (!line) resolve(null);
      for (const p of pending.values()) p.reject(new Error(LOST));
      pending.clear();
    };
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify({ api: API_LINE_PROTOCOL })}\n`));
    socket.on('error', () => socket.destroy());
    socket.on('close', end);
    socket.on('data', (chunk: string) => {
      buffered += chunk;
      if (buffered.length > MAX_ANSWER) return socket.destroy();
      let at: number;
      while ((at = buffered.indexOf('\n')) >= 0) {
        const text = buffered.slice(0, at);
        buffered = buffered.slice(at + 1);
        let message: { ready?: boolean; send?: SendState; serverPid?: number; id?: number; result?: unknown; failed?: boolean } | null;
        try {
          message = JSON.parse(text);
        } catch {
          return socket.destroy();
        }
        if (!message || typeof message !== 'object') return socket.destroy();
        if (!line) {
          if (message.ready !== true || !message.send) return socket.destroy();
          clearTimeout(silent);
          line = opened(message.send, Number.isSafeInteger(message.serverPid) && message.serverPid! > 0 ? message.serverPid : undefined);
          resolve(line);
          continue;
        }
        const waiting = pending.get(message.id as number);
        pending.delete(message.id as number);
        if (message.failed) waiting?.reject(new Error(LOST));
        else waiting?.resolve(message.result);
      }
    });
    function request<T>(method: string, args: object): Promise<T> {
      const id = next++;
      const text = JSON.stringify({ id, method, args });
      // Refused here, where it is known that nothing left: an ended line reads as unknown.
      if (text.length >= MAX_LINE) return Promise.resolve(refusal('INVALID', 'That is too long for the line to the app, and nothing was sent.') as T);
      if (ended) return Promise.reject(new Error(LOST));
      return new Promise<T>((done, fail) => {
        pending.set(id, { resolve: (v) => done(v as T), reject: fail });
        socket.write(`${text}\n`);
      });
    }
    const opened = (send: SendState, serverPid?: number): ApiLine => ({
      send, serverPid,
      call<M extends Method>(method: M, args: Args<M>) { return request<Result<M>>(method, args as object); },
      resolveConnectorEffect(args) { return request('connectors.resolveEffect', args); },
      checkedTurn: args => request('threads.checked', args),
      close: () => void socket.destroy(),
    });
  });
}
