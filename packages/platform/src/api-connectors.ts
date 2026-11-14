// Connector projections of the api port, moved unchanged from api.ts.
import type { Id } from './api.ts';

/** A tool of one of the person's MCP servers, as the person chose it. `kind` decides the crossing: a read flows, an effect is held. */
export interface ConnectorTool {
  name: string;
  title?: string;
  description: string;
  /** What decides the crossing: the person's override, else the server's annotations; a tool with none is an effect. */
  kind: 'read' | 'effect';
  /** What the server's annotations say, before any override. */
  annotated: 'read' | 'effect' | 'unannotated';
  override?: 'read' | 'effect';
  enabled: boolean;
  /** Its name, description, schema or annotations changed since the person enabled it, so it is off until enabled again. */
  changed?: boolean;
  /**
   * The person's standing signature for this tool, shown only while it applies: its calls go out with
   * no question per call, each with its receipt. It applies while the tool is defined and the server
   * starts exactly as signed, and not otherwise; put back exactly, it applies again. Turning the tool
   * or server off, closing the door, a changed definition found by a listing, or the person ending it
   * ends it for good. `blockedToo` preserves legacy argument coverage; new grants have one meaning.
   */
  standing?: { id?: string; at: string; blockedToo?: true };
  /** Its name is on the effect-classification list. This warns the person and grants or refuses nothing. */
  blocklisted?: true;
  /** The server itself reports a destructive effect; descriptive, never a permission. */
  destructive?: true;
}

/** One MCP server of the person's, from one of their configs. Variable values are never shown or kept. */
export interface ConnectorServer {
  /** Catalogue identity only; credential handles remain inside trusted composition. */
  catalogue?: import('./api-catalogue.ts').CatalogueId;
  id: Id;
  name: string;
  /** Which config it came from: Backbone's own, Claude Code, Claude Desktop, Codex or Cursor. */
  source: string;
  config: string;
  transport: 'stdio' | 'http';
  /** The command and arguments, or the address. */
  shown: string;
  /** The names of the variables its config sets; their values stay in that config. */
  envNames: string[];
  enabled: boolean;
  /** The person opened the egress door for it: a call they release, or a call to a tool they signed (ConnectorTool.standing), is sent. The name list does not restrict release or signing. */
  egress: boolean;
  /** How it starts changed since the person enabled it, so it is off until enabled again. */
  changed?: boolean;
  /** Its tools as last listed; empty until it is listed. */
  tools: ConnectorTool[];
  listedAt?: string;
  /** Why it could not be listed, in plain words. */
  problem?: string;
  /** Why it is never started, enabled or offered: its plugin's config or manifest holds a credential, or could not be checked. */
  blocked?: string;  /** A plugin's server: it starts no process, not even to list its tools, until the person enables it. */
  plugin?: true;
}

/** An effect a connector tool was asked for: held for the person unless they signed its tool beforehand, and never sent while the egress door is closed. */
export interface HeldCall {
  effect: Id;
  serverId: Id;
  serverName: string;
  tool: string;
  /** The arguments exactly as the engine gave them. */
  args: Record<string, unknown>;
  /** What the person answers on: the args hash the core holds. */
  argsHash: string;
  /** The exact statement shown to the person. */
  statement: string;
  threadId?: Id;
  turnId?: Id;
  at: string;
  /** released: conclusively not sent (the door was closed or what it was approved on had changed; the core then holds it cancelled or, when it was stopped at the last check before going out, failed); sent, failed or unknown: it went out through the egress door. */
  state: 'waiting' | 'released' | 'discarded' | 'sent' | 'failed' | 'unknown';
  detail: string;
  /** It was released on the person's standing signature for its tool, given beforehand: nobody was asked about this one call. */
  standing?: true;
  /** Exact immutable approval identity, never inferred from the current signature or time. */
  standingSignatureId?: string;
  /** A fresh person release, never a reusable file-based permission. */
  personReleasedAt?: string;
  /** Time Core admitted dispatch, not proof of provider delivery. Absent when not retained. */
  dispatchedAt?: string;
  dispatchReceipt?: { seq: string; hash: string };
  resolution?: ConnectorEffectResolution;
}
/** A person's inspection of an unknown connector effect. keep_closed preserves uncertainty. */
export type ConnectorEffectAnswer = 'happened' | 'did_not_happen' | 'keep_closed';
export interface ConnectorEffectResolution {
  id: Id; effect: Id; answer: ConnectorEffectAnswer; at: string;
  state: 'pending' | 'recorded';
  /** Present only when Core confirms the existing effect.reconciled ledger entry. */
  ledger?: { seq: string; hash: string };
}
export interface ConnectorEffectQuestion { effect: Id; argsHash: string; statement: string }
export interface ConnectorsView {
  servers: ConnectorServer[];
  held: HeldCall[];
  /** Local pending/conflict queues, not a Core end receipt. */
  signatureEndings?: { pending: string[]; conflicts: string[] };
  /** The egress door is opened per server by the person (ConnectorServer.egress); closed by default. */
  egress: 'per-server';
}
