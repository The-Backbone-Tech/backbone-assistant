// Projection of the pinned app-server item protocol, not a tool-enforcement boundary.
// Origin: openai/codex 360319d8, protocol/v2/item.rs and MessagePhase (Apache-2.0).
import type { HarnessEvent, HarnessMessage } from '@backbone-next/platform/ports';
import { createHash } from 'node:crypto';
import { object, type ObjectValue } from './native.ts';
import { NativeMcpEvents } from './native-mcp-events.ts';

const MAX_ITEMS = 1_000;
const MAX_TEXT_BYTES = 1_000_000;
const MAX_TOOL_BYTES = 2_000_000;
function id(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Native event identity is invalid.');
  return value;
}
function phase(value: unknown): HarnessMessage['phase'] {
  if (value == null) return null;
  if (value === 'commentary' || value === 'partial_answer' || value === 'final_answer') return value;
  throw new Error('Native message phase is invalid.');
}

/** Compare execution and outcome, not JSON key order, duration or derived parser hints. */
function toolFingerprint(item: ObjectValue, status: string): string {
  const string = (value: unknown): string | null => {
    if (value == null) return null;
    if (typeof value !== 'string') throw new Error('Native tool text is invalid.');
    return value;
  };
  let semantic: unknown;
  if (item.type === 'commandExecution') {
    if (item.exitCode != null && !Number.isSafeInteger(item.exitCode)) throw new Error('Native tool exit code is invalid.');
    semantic = { type: item.type, status, command: string(item.command), cwd: string(item.cwd),
      processId: string(item.processId), source: string(item.source), pluginId: string(item.pluginId), scriptPath: string(item.scriptPath),
      output: string(item.aggregatedOutput), exitCode: item.exitCode ?? null };
  } else {
    if (item.changes != null && (!Array.isArray(item.changes) || item.changes.length > MAX_ITEMS)) throw new Error('Native file changes are invalid.');
    const changes = item.changes == null ? null : (item.changes as unknown[]).map((value) => {
      const change = object(value), kind = object(change.kind);
      if (typeof change.path !== 'string' || typeof change.diff !== 'string' || !['add', 'delete', 'update'].includes(String(kind.type))) throw new Error('Native file change is invalid.');
      return { path: change.path, diff: change.diff, kind: kind.type,
        move: kind.type === 'update' ? string(kind.move_path) : null };
    });
    semantic = { type: item.type, status, changes };
  }
  const bytes = JSON.stringify(semantic);
  if (Buffer.byteLength(bytes, 'utf8') > MAX_TOOL_BYTES) throw new Error('Native terminal tool data exceeded its limit.');
  // Bounded digests retain duplicate identity without retaining command outputs in memory.
  return createHash('sha256').update(bytes).digest('hex');
}

function protectedFolderDenied(command: unknown, output: unknown): 'Desktop' | 'Documents' | 'Downloads' | undefined {
  if (typeof command !== 'string' || typeof output !== 'string' || !/operation not permitted/i.test(output)) return undefined;
  const match = command.match(/(?:~|\/Users\/[^/\s]+)\/(Desktop|Documents|Downloads)(?:\/|\b)/);
  return match?.[1] as 'Desktop' | 'Documents' | 'Downloads' | undefined;
}

/** Execution evidence belongs beside the staged label, distinct from a canonical import receipt. */
function toolDetail(item: ObjectValue, complete: boolean): { detail?: string } {
  const command = item.type === 'commandExecution' && typeof item.command === 'string' ? item.command : undefined;
  const paths = item.type === 'fileChange' && Array.isArray(item.changes) ? item.changes.map(c => String(object(c).path ?? '')).filter(Boolean).join(', ') : undefined;
  const action = command ?? paths;
  const status = complete ? String(item.status) : 'running';
  if (!action && (!complete || status === 'completed')) return {};
  return { detail: `${action ?? 'Action (command not reported)'}${protectedFolderDenied(command, item.aggregatedOutput) ? ' · macOS denied access to a protected folder' : ''} · ${status}${Number.isSafeInteger(item.exitCode) ? ` · exit ${item.exitCode}` : ''}${status === 'declined' ? ' · the native client declined this action; no further reason was reported' : status === 'failed' && item.exitCode == null ? ' · the native client reported failure without an exit code' : ''}` };
}

export class NativeTurnEvents {
  readonly connectors = new NativeMcpEvents();
  private turn?: string;
  private kinds = new Map<string, string>();
  private messages = new Map<string, HarnessMessage>();
  private tools = new Map<string, { status: string; fingerprint?: string }>();
  private compactions = new Map<string, boolean>();
  private commandWatch = new Map<string, { command: string; tail: string; reported: boolean }>();
  private bytes = 0;
  private ended = false;
  private readonly thread: string;
  get completed() { return this.ended; }
  readonly usage = { input: 0, output: 0 };
  constructor(thread: string) { this.thread = id(thread); }

  /** Notifications may arrive before the turn/start reply. The reply must bind the same id. */
  bindTurn(value: unknown) {
    const next = id(value);
    if (this.turn && this.turn !== next) throw new Error('Native event targeted another turn.');
    this.turn = next;
  }
  private frame(params: ObjectValue, turn: unknown = params.turnId) {
    if (params.threadId !== this.thread) throw new Error('Native event targeted another thread.');
    this.bindTurn(turn);
  }
  private item(value: unknown, kind: string) {
    const key = id(value), prior = this.kinds.get(key);
    if (prior && prior !== kind) throw new Error('Native item changed its type.');
    if (!prior && this.kinds.size >= MAX_ITEMS) throw new Error('Native item count exceeded its limit.');
    this.kinds.set(key, kind);
    return key;
  }
  private text(key: string, text: string, nextPhase: HarnessMessage['phase'], complete: boolean, delta: string): HarnessEvent[] {
    const prior = this.messages.get(key);
    if (prior?.phase && nextPhase && prior.phase !== nextPhase) throw new Error('Native message changed its phase.');
    const actualPhase = nextPhase ?? prior?.phase ?? null;
    if (prior?.complete) {
      if (complete && prior.text === text && prior.phase === actualPhase) return [];
      throw new Error('Native completed message changed.');
    }
    const size = Buffer.byteLength(text, 'utf8');
    const bytes = this.bytes - Buffer.byteLength(prior?.text ?? '', 'utf8') + size;
    if (bytes > MAX_TEXT_BYTES) throw new Error('Native answer exceeded its limit.');
    this.bytes = bytes;
    const message = { id: key, phase: actualPhase, text, complete };
    this.messages.set(key, message);
    return [{ type: 'text', delta, message: { ...message } }];
  }
  /** A known final wins over commentary/partials. Legacy unphased messages use the last item. */
  answer(): string {
    const all = [...this.messages.values()];
    return all.findLast((m) => m.phase === 'final_answer')?.text ?? all.findLast((m) => m.phase === null)?.text ?? '';
  }
  receive(method: string, params: ObjectValue): HarnessEvent[] {
    const relevant = ['turn/started', 'turn/completed', 'item/started', 'item/completed', 'item/agentMessage/delta', 'item/commandExecution/outputDelta', 'thread/tokenUsage/updated'].includes(method);
    if (!relevant) return [];
    if (this.ended && method === 'item/commandExecution/outputDelta') return [];
    if (this.ended) throw new Error('Native event arrived after completion.');
    if (method === 'turn/started' || method === 'turn/completed') {
      const turn = object(params.turn); this.frame(params, turn.id);
      if (method === 'turn/completed') {
        if (turn.status !== 'completed') throw new Error(turn.status === 'interrupted' ? 'Native turn was interrupted.' : 'Native turn failed.');
        // Complete snapshots are authoritative, including a final message with no streamed deltas.
        const events: HarnessEvent[] = [];
        if (turn.items !== undefined && !Array.isArray(turn.items)) throw new Error('Native turn items are invalid.');
        if (turn.itemsView !== undefined && !['full', 'summary', 'notLoaded'].includes(String(turn.itemsView))) throw new Error('Native turn items view is invalid.');
        const full = turn.itemsView === 'full';
        if (full && !Array.isArray(turn.items)) throw new Error('Native full turn items are missing.');
        const items = (turn.items ?? []) as unknown[];
        if (items.length > MAX_ITEMS) throw new Error('Native item count exceeded its limit.');
        const ordered = new Map<string, HarnessMessage>(), seen = new Set<string>();
        for (const value of items) {
          const item = object(value), key = id(item.id);
          if (seen.has(key)) throw new Error('Native terminal snapshot repeats an item identity.');
          seen.add(key);
          const next = this.receive('item/completed', { ...params, turnId: turn.id, item: value });
          // Full snapshots replace message order atomically, even for already-seen duplicates.
          events.push(...(full ? next.filter((event) => event.type !== 'text') : next));
          if (full && item.type === 'agentMessage') ordered.set(key, this.messages.get(key)!);
        }
        if (full) {
          this.messages = ordered;
          events.push({ type: 'messages', messages: [...ordered.values()].map((message) => ({ ...message })) });
        }
        events.push(...this.connectors.cutOff());
        this.ended = true;
        return events;
      }
      return [];
    }
    this.frame(params);
    if (method === 'thread/tokenUsage/updated') {
      const total = object(object(params.tokenUsage).total);
      const input = total.inputTokens, output = total.outputTokens;
      if (!Number.isSafeInteger(input) || !Number.isSafeInteger(output) || Number(input) < this.usage.input || Number(output) < this.usage.output) throw new Error('Native usage is invalid or moved backwards.');
      const event: HarnessEvent = { type: 'usage', input: Number(input) - this.usage.input, output: Number(output) - this.usage.output };
      this.usage.input = Number(input); this.usage.output = Number(output);
      return [event];
    }
    if (method === 'item/commandExecution/outputDelta') {
      // Output is watched only to offer a hint. Nothing here registers an item or fails the turn.
      const key = typeof params.itemId === 'string' ? params.itemId : '';
      const watch = this.commandWatch.get(key);
      if (!watch || watch.reported || typeof params.delta !== 'string') return [];
      const text = watch.tail + params.delta.slice(-4096);
      watch.tail = text.slice(-256);
      const folder = protectedFolderDenied(watch.command, text);
      if (!folder) return [];
      watch.reported = true;
      return [{ type: 'tool', id: key, tool: 'native_staged', phase: 'proposed', label: 'Work in temporary drafts', detail: 'macOS denied access to a protected folder', denied: { kind: 'macos-protected-folder', folder } }];
    }
    if (method === 'item/agentMessage/delta') {
      const key = this.item(params.itemId, 'agentMessage');
      if (typeof params.delta !== 'string') throw new Error('Native text delta is invalid.');
      const prior = this.messages.get(key);
      return this.text(key, (prior?.text ?? '') + params.delta, prior?.phase ?? null, false, params.delta);
    }
    const item = object(params.item);
    if (typeof item.type !== 'string' || !item.type) throw new Error('Native item type is invalid.');
    const key = this.item(item.id, item.type), complete = method === 'item/completed';
    if (item.type === 'mcpToolCall') return this.connectors.receive(item, complete);
    if (item.type === 'contextCompaction') {
      const prior = this.compactions.get(key);
      if (prior === true || prior === complete) return [];
      this.compactions.set(key, complete);
      return [{ type: 'compaction', compaction: { id: key, engine: 'codex', sessionId: this.thread, status: complete ? 'completed' : 'in_progress' } }];
    }
    if (item.type === 'webSearch') {
      if (typeof item.query !== 'string' || item.query.length > 20_000) throw new Error('Native web query is invalid.');
      const prior = this.tools.get(key);
      if (prior?.fingerprint !== undefined && prior.fingerprint !== item.query) throw new Error('Native web query changed after completion.');
      if (prior?.status === 'completed' || prior?.status === 'inProgress' && !complete) return [];
      this.tools.set(key, { status: complete ? 'completed' : 'inProgress', ...(complete ? { fingerprint: item.query } : {}) });
      return [{ type: 'tool', tool: 'native_web', id: key, phase: complete ? 'done' : 'proposed', label: 'Web lookup', detail: item.query }];
    }
    if (item.type === 'agentMessage') {
      if (typeof item.text !== 'string') throw new Error('Native message text is invalid.');
      const prior = this.messages.get(key), nextPhase = phase(item.phase);
      // A repeated start is harmless only if it does not rewind text already streamed.
      if (!complete && prior) {
        if (prior.complete || prior.text !== item.text || (prior.phase && nextPhase && prior.phase !== nextPhase)) throw new Error('Native message start was repeated after progress.');
        return this.text(key, prior.text, nextPhase, false, '');
      }
      const delta = item.text.startsWith(prior?.text ?? '') ? item.text.slice(prior?.text.length ?? 0) : '';
      return this.text(key, item.text, nextPhase, complete, delta);
    }
    if (item.type !== 'commandExecution' && item.type !== 'fileChange') return [];
    if (item.type === 'commandExecution' && !complete && typeof item.command === 'string') this.commandWatch.set(key, { command: item.command, tail: '', reported: false });
    const deniedDuringRun = complete && this.commandWatch.get(key)?.reported;
    if (complete) this.commandWatch.delete(key);
    const status = complete ? item.status : 'inProgress';
    if (complete && !['completed', 'failed', 'declined'].includes(String(status))) throw new Error('Native tool completion status is invalid.');
    const fingerprint = complete ? toolFingerprint(item, String(status)) : undefined;
    const prior = this.tools.get(key);
    if (prior && prior.status !== 'inProgress') {
      if (complete && prior.status === status && prior.fingerprint === fingerprint) return [];
      throw new Error('Native completed tool changed.');
    }
    this.tools.set(key, { status: String(status), fingerprint });
    const detail = toolDetail(item, complete);
    if (deniedDuringRun && !detail.detail?.includes('macOS denied access to a protected folder')) detail.detail = `${detail.detail ?? ''} · macOS denied access to a protected folder`;
    const folder = protectedFolderDenied(item.command, item.aggregatedOutput);
    return [{ type: 'tool', id: key, tool: 'native_staged', phase: !complete ? 'proposed' : status === 'completed' ? 'done' : 'refused', label: 'Work in temporary drafts', ...detail, ...(folder ? { denied: { kind: 'macos-protected-folder' as const, folder } } : {}) }];
  }
}

const MAX_AGENTS = 32;
const MAX_HELD = 256;
const MAX_HELD_BYTES = 8_000_000;
/** A model-chosen agent path, shown to people: plain path characters only, bounded. */
function agentName(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z0-9_./-]{1,80}$/.test(value) ? value : 'sub-agent';
}
interface SubAgent { thread: string; name: string; awaitingTurn: boolean; turns: Map<string, 'running' | 'ended'>; endedAs: Map<string, unknown>; usage: { input: number; output: number }; tools: Map<string, { status: string; fingerprint?: string }>; connectors: NativeMcpEvents }
export interface RunningSubAgent { thread: string; name: string; turn?: string }

/**
 * The sub-agents a native turn spawns (Codex collaboration tools). Strict rules:
 * - A thread is the turn's only once a spawn item names it, in the parent's validated turn or in a validated
 *   turn of an accepted sub-agent, whether reported as an item or only in a terminal snapshot.
 * - Every sub-agent turn notification names this turn as its root, checked at receipt and again on replay.
 *   A sub-agent item counts only inside one of its validated turns.
 * - Notifications for a thread not yet named are held, bounded in count and bytes, because Codex may report a
 *   child's first status before the spawn item. The harness refuses the turn if any are left unclaimed.
 * - A sub-agent turn that ends other than completed, or a conflicting sub-agent tool report, makes the whole
 *   turn UNKNOWN (`unknown`): the harness then imports nothing.
 * Its command and file items become the turn's tool events, labelled as that sub-agent; its messages are not
 * the turn's answer. Its files are in the same staged workspace, so they reach the project only through the
 * same import.
 */
export class NativeSubAgents {
  private agents = new Map<string, SubAgent>();
  private held: { method: string; params: ObjectValue }[] = [];
  private heldBytes = 0;
  private rootTurn?: string;
  private readonly root: string;
  /** Why a sub-agent's work is UNKNOWN, if it is: the first such reason. */
  unknown?: string;
  readonly usage = { input: 0, output: 0 };
  constructor(root: string) { this.root = id(root); }
  bindRootTurn(turn: string) {
    const next = id(turn);
    if (this.rootTurn && this.rootTurn !== next) throw new Error('Native event targeted another turn.');
    this.rootTurn = next;
  }
  knows(thread: unknown) { return typeof thread === 'string' && this.agents.has(thread); }
  get unclaimed() { return this.held.length; }
  /** Sub-agents whose work is not over: spawned and not yet started, or with a turn still running. */
  running(): RunningSubAgent[] {
    return [...this.agents.values()].filter((a) => a.awaitingTurn || [...a.turns.values()].includes('running'))
      .map((a) => ({ thread: a.thread, name: a.name, turn: [...a.turns].find(([, state]) => state === 'running')?.[0] }));
  }
  /** Marks the running sub-agents as cut off, for the person: their work was not taken. */
  cutOff(why: string): HarnessEvent[] {
    return [...this.cutOffConnectors(), ...this.running().map((a): HarnessEvent => ({ type: 'tool', id: `subagent:${a.thread}`, tool: 'native_subagent', phase: 'unknown', label: `Sub-agent ${a.name} ${why}` }))];
  }
  cutOffConnectors(): HarnessEvent[] { return [...this.agents.values()].flatMap(agent => agent.connectors.cutOff()); }
  private markUnknown(reason: string) { this.unknown ??= reason; }
  /** Every sub-agent turn names this turn as its root; nothing is patched up later. */
  private rootOf(turn: ObjectValue) {
    if (!this.rootTurn || turn.rootTurnId !== this.rootTurn) throw new Error('Native sub-agent event targeted another turn.');
  }
  /** Items already validated as the parent turn's or a validated sub-agent turn's: registers the threads they spawn. */
  private spawned(items: unknown[]): HarnessEvent[] {
    const named: [unknown, unknown][] = [];
    for (const value of items) {
      const item = object(value);
      if (item.type === 'subAgentActivity' && item.kind === 'started') named.push([item.agentThreadId, item.agentPath]);
      // multi_agent v1 shape: the spawn call lists the threads it created.
      if (item.type === 'collabAgentToolCall' && item.tool === 'spawnAgent' && Array.isArray(item.receiverThreadIds)) for (const thread of item.receiverThreadIds) named.push([thread, null]);
    }
    const events: HarnessEvent[] = [];
    for (const [value, path] of named) {
      const thread = id(value);
      if (thread === this.root || this.agents.has(thread)) continue;
      if (this.agents.size >= MAX_AGENTS) throw new Error('Native sub-agent count exceeded its limit.');
      const agent: SubAgent = { thread, name: agentName(path), awaitingTurn: true, turns: new Map(), endedAs: new Map(), usage: { input: 0, output: 0 }, tools: new Map(), connectors: new NativeMcpEvents(`subagent:${thread}/`, `Sub-agent ${agentName(path)}: `) };
      this.agents.set(thread, agent);
      events.push({ type: 'tool', id: `subagent:${thread}`, tool: 'native_subagent', phase: 'proposed', label: `Sub-agent ${agent.name} started` });
    }
    if (events.length && this.held.length) {
      // Replayed through the same checks as at receipt.
      const held = this.held; this.held = []; this.heldBytes = 0;
      for (const notification of held) events.push(...this.receive(notification.method, notification.params));
    }
    return events;
  }
  private terminalItems(turn: ObjectValue): unknown[] {
    if (turn.items === undefined) return [];
    if (!Array.isArray(turn.items) || turn.items.length > MAX_ITEMS) throw new Error('Native turn items are invalid.');
    return turn.items;
  }
  /** A notification in the parent thread, after the parent projection accepted it. */
  fromRoot(method: string, params: ObjectValue): HarnessEvent[] {
    if (method === 'turn/completed') { const turn = object(params.turn); this.bindRootTurn(String(turn.id)); return this.spawned(this.terminalItems(turn)); }
    if (method !== 'item/started' && method !== 'item/completed') return [];
    this.bindRootTurn(String(params.turnId));
    return this.spawned([params.item]);
  }
  /** A notification for another thread: the turn's sub-agent's, or held until a spawn names it. */
  receive(method: string, params: ObjectValue): HarnessEvent[] {
    const thread = id(params.threadId), agent = this.agents.get(thread);
    if (!agent) {
      // A turn notification already naming another root is refused at once; it can never become this turn's.
      if ((method === 'turn/started' || method === 'turn/completed') && this.rootTurn) this.rootOf(object(params.turn));
      const bytes = Buffer.byteLength(JSON.stringify(params), 'utf8');
      if (this.held.length >= MAX_HELD || this.heldBytes + bytes > MAX_HELD_BYTES) throw new Error('Native notification targeted another thread.');
      this.held.push({ method, params }); this.heldBytes += bytes; return [];
    }
    if (method === 'turn/started' || method === 'turn/completed') {
      const turn = object(params.turn), key = id(turn.id);
      this.rootOf(turn);
      const prior = agent.turns.get(key), status = turn.status, completed = status === 'completed';
      if (prior === 'ended') {
        if (method === 'turn/started') throw new Error('Native sub-agent turn restarted after completion.');
        // A repeated completion is validated, never dismissed unread: only an identical repeat changes nothing.
        if (agent.endedAs.get(key) !== status) this.markUnknown(`the sub-agent ${agent.name} reported its ended turn again as ${completed ? 'completed' : status === 'interrupted' ? 'interrupted' : 'failed'}`);
        return this.snapshot(agent, turn);
      }
      if (!prior && agent.turns.size >= MAX_ITEMS) throw new Error('Native item count exceeded its limit.');
      agent.awaitingTurn = false;
      if (method === 'turn/started') { agent.turns.set(key, 'running'); return []; }
      agent.turns.set(key, 'ended'); agent.endedAs.set(key, status);
      if (!completed) this.markUnknown(`the sub-agent ${agent.name} ended ${status === 'interrupted' ? 'interrupted' : 'failed'}`);
      const events: HarnessEvent[] = [{ type: 'tool', id: `subagent:${thread}`, tool: 'native_subagent', phase: completed ? 'done' : 'unknown',
        label: `Sub-agent ${agent.name} ${completed ? 'finished' : status === 'interrupted' ? 'was interrupted' : 'failed'}` }];
      return [...events, ...this.snapshot(agent, turn)];
    }
    if (method === 'thread/tokenUsage/updated') {
      const total = object(object(params.tokenUsage).total);
      const input = total.inputTokens, output = total.outputTokens;
      if (!Number.isSafeInteger(input) || !Number.isSafeInteger(output) || Number(input) < agent.usage.input || Number(output) < agent.usage.output) throw new Error('Native usage is invalid or moved backwards.');
      const event: HarnessEvent = { type: 'usage', input: Number(input) - agent.usage.input, output: Number(output) - agent.usage.output };
      this.usage.input += event.input; this.usage.output += event.output;
      agent.usage = { input: Number(input), output: Number(output) };
      return [event];
    }
    if (method !== 'item/started' && method !== 'item/completed') return [];
    // Only inside a validated turn of this sub-agent; an item never opens a turn.
    const state = agent.turns.get(id(params.turnId));
    if (!state) throw new Error('Native sub-agent event targeted another turn.');
    const item = object(params.item);
    if (state === 'ended') {
      // As for the parent: Codex reports a descendant's later lifecycle on the turn that spawned it, even once
      // that turn has ended. Only those are accepted; a new spawn or any other item after completion is refused.
      if (item.type === 'subAgentActivity' && item.kind !== 'started') return [];
      throw new Error('Native event arrived after completion.');
    }
    return [...this.spawned([item]), ...this.tool(agent, item, method === 'item/completed')];
  }
  /** A terminal snapshot's items: its spawns are registered and its tools checked like streamed reports. */
  private snapshot(agent: SubAgent, turn: ObjectValue): HarnessEvent[] {
    const items = this.terminalItems(turn), events = this.spawned(items);
    for (const value of items) events.push(...this.tool(agent, object(value), true));
    const unfinished = agent.connectors.cutOff();
    if (unfinished.length) this.markUnknown('a native connector did not report completion');
    events.push(...unfinished);
    return events;
  }
  /** A sub-agent's command or file item, with the parent's semantic identity: a changed report of a finished tool is UNKNOWN. */
  private tool(agent: SubAgent, item: ObjectValue, complete: boolean): HarnessEvent[] {
    if (item.type === 'mcpToolCall') {
      const events = agent.connectors.receive(item, complete);
      if (events.some(event => event.type === 'tool' && event.phase === 'unknown')) this.markUnknown('a native connector outcome is unknown');
      return events;
    }
    if (item.type !== 'commandExecution' && item.type !== 'fileChange') return [];
    const key = id(item.id);
    const status = complete ? String(item.status) : 'inProgress';
    if (complete && !['completed', 'failed', 'declined'].includes(status)) throw new Error('Native tool completion status is invalid.');
    const fingerprint = complete ? toolFingerprint(item, status) : undefined;
    const prior = agent.tools.get(key), label = `Sub-agent ${agent.name}: Work in temporary drafts`, toolId = `subagent:${agent.thread}/${key}`;
    if (prior && prior.status !== 'inProgress') {
      if (complete && prior.status === status && prior.fingerprint === fingerprint) return [];
      this.markUnknown(`the sub-agent ${agent.name} reported a finished tool differently`);
      return [{ type: 'tool', id: toolId, tool: 'native_subagent', phase: 'unknown', label, ...toolDetail(item, complete) }];
    }
    if (!prior && agent.tools.size >= MAX_ITEMS) throw new Error('Native item count exceeded its limit.');
    agent.tools.set(key, { status, fingerprint });
    return [{ type: 'tool', id: toolId, tool: 'native_subagent', phase: !complete ? 'proposed' : status === 'completed' ? 'done' : 'refused', label, ...toolDetail(item, complete) }];
  }
}
