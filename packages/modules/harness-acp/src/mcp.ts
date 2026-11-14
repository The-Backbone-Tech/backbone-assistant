// Per-session MCP endpoint; every call is bound to the current turn's ToolHost.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { open, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { assertDirectory, assertOpenedFile, type DirectoryIdentity } from './directories.ts';
import { MCP_STDIO } from './mcp-stdio.ts';
import type { McpServer } from '@agentclientprotocol/sdk';
import { HOST_TOOLS, workspaceExecution, workspaceFailure, type HarnessEvent } from '@backbone-next/platform/ports';
import type { TurnContext, TurnRequest, ToolFile } from '@backbone-next/platform/ports';

export interface ToolTurn { request: TurnRequest; context: TurnContext; signal: AbortSignal; stopped: boolean; writeClosed: boolean; writeTail?: Promise<void>; stop?(): void; push?(event: HarnessEvent): void; unknown?: string; inFlight?: Set<Promise<void>> }
/** Track only Host calls whose missing receipt must remain UNKNOWN when a turn ends. */
function pendingCall(turn: ToolTurn): () => void {
  let resolve!: () => void;
  const pending = new Promise<void>(done => { resolve = done; });
  (turn.inFlight ??= new Set()).add(pending);
  return () => { turn.inFlight!.delete(pending); resolve(); };
}
export async function settleToolCalls(turn: ToolTurn, waitMs: number): Promise<void> {
  if (!turn.inFlight?.size) return;
  let timer: NodeJS.Timeout | undefined;
  try { await Promise.race([Promise.allSettled([...turn.inFlight]), new Promise<void>(resolve => { timer = setTimeout(resolve, waitMs); })]); }
  finally { clearTimeout(timer); }
  if (turn.inFlight.size) {
    turn.writeClosed = true;
    turn.unknown ??= 'A host connector or write call is still in flight. Its outcome is UNKNOWN; inspect the host receipt and never resend it blindly.';
  }
}
const object = (v: unknown): Record<string, unknown> => { if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Expected an argument object.'); return v as Record<string, unknown>; };
const string = (v: unknown) => { if (typeof v !== 'string') throw new Error('Expected text.'); return v; };
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const text = { type: 'string' };
export async function toolBridge(current: () => ToolTurn | undefined, recordRead: (file: (ToolFile & { text: string }) | null) => void, unattested: () => void, state: DirectoryIdentity, validate: () => void) {
  validate(); assertDirectory(state);
  const token = randomBytes(32).toString('hex');
  const catalog = () => {
    const turn = current(); if (!turn || turn.stopped) return [];
    const tools = turn.context.tools;
    return [
      { name: 'list_files', description: 'List current canonical project documents through the host.', inputSchema: schema({}) },
      { name: 'read_file', description: 'Read a current canonical document through the host.', inputSchema: schema({ name: text }, ['name']) },
      ...(!turn.request.readOnly ? [{ name: 'write_file', description: 'Propose a canonical write through the host. Never retry UNKNOWN or REFUSED.', inputSchema: schema({ name: text, body: text }, ['name', 'body']) }] : []),
      ...(!turn.request.readOnly && !turn.request.bare && tools.runWorkspace ? [{ name: 'workspace_run', description: HOST_TOOLS.workspace_run.description, inputSchema: HOST_TOOLS.workspace_run.inputSchema }] : []),
      ...(tools.searchMemory ? [{ name: 'search_memory', description: HOST_TOOLS.memory_search.description, inputSchema: schema({ query: text }, ['query']) }] : []),
      ...(!turn.request.readOnly && tools.proposeMemory ? [{ name: 'propose_memory', description: HOST_TOOLS.propose_memory.description, inputSchema: schema({ text, topic: text }, ['text']) }] : []),
      ...(!turn.request.readOnly && tools.proposeGoal ? [{ name: 'propose_goal', description: HOST_TOOLS.propose_goal.description, inputSchema: schema({ text }, ['text']) }] : []),
      ...(!turn.request.readOnly && tools.addCard ? [{ name: 'add_card', description: 'Add a delegated board card.', inputSchema: schema({ title: text, brief: text, dependsOn: { type: 'array', items: text } }, ['brief']) }] : []),
      ...(!turn.request.readOnly && tools.messageCard ? [{ name: 'message_card', description: HOST_TOOLS.message_card.description, inputSchema: schema({ card: text, text }, ['card', 'text']) }] : []),
      ...(!turn.request.readOnly && tools.startChild ? [{ name: 'start_child', description: 'Propose depth-one delegated work.', inputSchema: schema({ brief: text, role: { enum: ['worker', 'reviewer'] }, title: text }, ['brief', 'role']) }] : []),
      ...(!turn.request.readOnly && tools.awaitChild ? [{ name: 'await_child', description: 'Await delegated work.', inputSchema: schema({ threadId: text }, ['threadId']) }] : []),
      ...(tools.connectors?.() ?? []).filter(t => !turn.request.readOnly || t.kind === 'read').map(t => ({ name: `connector_${t.name}`, description: t.description, inputSchema: t.inputSchema })),
    ];
  };
  const call = async (name: string, args: Record<string, unknown>) => {
    const turn = current();
    if (!turn || turn.stopped || turn.signal.aborted || (turn.request.stillAllowed?.() ?? true) !== true || !catalog().some(t => t.name === name)) throw new Error('This turn does not grant that tool.');
    const tools = turn.context.tools;
    if (['list_files', 'search_memory', 'await_child'].includes(name) || name.startsWith('connector_')) unattested();
    switch (name) {
      case 'list_files': return tools.list();
      case 'read_file': { const file = await tools.read(string(args.name)); recordRead(file); return file; }
      case 'write_file': {
        const name = string(args.name), body = string(args.body);
        const prior = turn.writeTail ?? Promise.resolve(); let release!: () => void;
        turn.writeTail = new Promise<void>(resolve => { release = resolve; });
        await prior;
        try {
          if (current() !== turn || turn.stopped || turn.signal.aborted || turn.writeClosed || (turn.request.stillAllowed?.() ?? true) !== true) throw new Error('This write is no longer granted.');
          const finish = pendingCall(turn);
          try {
            let result;
            try { result = await tools.write(name, body, turn.signal); }
            catch { result = { outcome: 'UNKNOWN' as const, detail: 'The host write did not return a definitive receipt. It must not be retried.' }; }
            if (result.outcome !== 'DONE') turn.writeClosed = true;
            if (result.outcome === 'UNKNOWN') turn.unknown = result.detail;
            return result;
          } finally { finish(); }
        } finally { release(); }
      }
      case 'workspace_run': {
        const request = { command: string(args.command), ...(args.attachment === undefined ? {} : { attachment: string(args.attachment) }) };
        const event = { type: 'tool' as const, tool: 'workspace_run', label: HOST_TOOLS.workspace_run.label };
        turn.push?.({ ...event, phase: 'proposed' });
        let execution = workspaceExecution();
        try {
          const text = await tools.runWorkspace!(request, turn.signal);
          execution = workspaceExecution(turn.signal.aborted ? undefined : text);
          return text;
        } catch (error) {
          execution = workspaceFailure(turn.signal.aborted ? undefined : error);
          throw error;
        } finally { turn.push?.({ ...event, ...execution }); }
      }
      case 'search_memory': return tools.searchMemory!(string(args.query));
      case 'propose_memory': return tools.proposeMemory!({ text: string(args.text), ...(args.topic === undefined ? {} : { topic: string(args.topic) }) });
      case 'propose_goal': await tools.proposeGoal!(string(args.text)); return 'Proposal held for the person.';
      case 'add_card': return tools.addCard!({ brief: string(args.brief), ...(args.title === undefined ? {} : { title: string(args.title) }), ...(args.dependsOn === undefined ? {} : { dependsOn: (args.dependsOn as unknown[]).map(string) }) });
      case 'message_card': return tools.messageCard!({ card: string(args.card), text: string(args.text) });
      case 'start_child': if (args.role !== 'worker' && args.role !== 'reviewer') throw new Error('Unknown child role.'); return tools.startChild!({ brief: string(args.brief), role: args.role, ...(args.title === undefined ? {} : { title: string(args.title) }) });
      case 'await_child': return tools.awaitChild!(string(args.threadId), turn.signal);
      default: {
        const connector = tools.connectors?.().find(t => `connector_${t.name}` === name);
        if (!connector || !tools.callConnector) throw new Error('Connector is unavailable.');
        const finish = pendingCall(turn);
        try {
          let result;
          try { result = await tools.callConnector(connector.name, args, turn.signal); }
          catch { result = { outcome: 'UNKNOWN' as const, detail: 'The connector call returned no definitive result; its outcome is UNKNOWN and it must not be retried.' }; }
          // A call that went out on the person's signature and got no answer is unknown too: the identical call is never
          // sent again by the Host, and this turn must not go on to ask for a similar one.
          if (result.outcome === 'UNKNOWN' || (result.outcome === 'SENT' && result.state === 'unknown')) {
            turn.unknown = result.detail; turn.writeClosed = true;
            turn.stop?.(); turn.stopped = true;
          }
          return result;
        } finally { finish(); }
      }
    }
  };
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/' || req.headers.authorization !== `Bearer ${token}`) { res.writeHead(403).end(); return; }
    const admitted = current();
    if (!admitted || admitted.stopped || admitted.signal.aborted) { res.writeHead(403).end(); return; }
    let bytes = 0; const chunks: Buffer[] = [];
    try {
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 1_000_000) throw new Error('Request too large.'); chunks.push(chunk); }
      if (current() !== admitted || admitted.stopped || admitted.signal.aborted) { res.writeHead(403).end(); return; }
      const message = object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (message.id === undefined) { res.writeHead(202).end(); return; }
      let result: unknown;
      switch (message.method) {
        case 'initialize': result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'backbone-turn', version: '0.0.0' } }; break;
        case 'ping': result = {}; break;
        case 'tools/list': result = { tools: catalog() }; break;
        case 'tools/call': {
          const params = object(message.params);
          try {
            const turn = current(), value = await call(string(params.name), object(params.arguments ?? {}));
            if (!turn || current() !== turn || turn.stopped || turn.signal.aborted || (turn.request.stillAllowed?.() ?? true) !== true) throw new Error('Turn closed before returning tool data.');
            const failed = params.name === 'workspace_run' && typeof value === 'string' ? workspaceExecution(value).phase !== 'done'
              : value && typeof value === 'object' && 'outcome' in value && value.outcome === 'SENT' && 'state' in value && value.state === 'failed';
            result = { ...(failed ? { isError: true } : {}), content: [{ type: 'text', text: JSON.stringify(value) }] };
          }
          catch { result = { isError: true, content: [{ type: 'text', text: 'Tool result unavailable or request refused. Consult the host receipts; never retry an uncertain write.' }] }; }
          break;
        }
        default: throw new Error('Method unavailable.');
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    } catch { res.writeHead(400).end(); }
  });
  server.requestTimeout = 30_000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('MCP endpoint unavailable.');
  // Only the path crosses argv. Peer process inspection cannot recover this capability.
  const capability = join(state.path, `bridge-${randomBytes(16).toString('hex')}.json`);
  let file;
  try {
    validate(); assertDirectory(state);
    file = await open(capability, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    const info = await file.stat();
    validate(); assertOpenedFile(state, capability, info);
    await file.writeFile(JSON.stringify({ url: `http://127.0.0.1:${address.port}/`, token }));
    validate(); assertOpenedFile(state, capability, await file.stat());
  }
  catch (error) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); throw error; }
  finally { await file?.close(); }
  const spec: McpServer = { name: 'backbone', command: process.execPath, args: ['--input-type=module', '-e', MCP_STDIO, capability], env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }] };
  return { spec, async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await unlink(capability).catch(() => {}); } };
}
