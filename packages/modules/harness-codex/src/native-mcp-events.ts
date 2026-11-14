// Native account activity is observation, not a Backbone effect receipt or permission grant.
import { createHash } from 'node:crypto';
import type { HarnessEvent } from '@backbone-next/platform/ports';
import type { ObjectValue } from './native.ts';

const safeName = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_.:/-]{1,200}$/.test(value) ? value : 'native tool';
interface Call { identity: string; label: string; status: string; readOnly: boolean; fingerprint?: string }

/** Bounded, content-free work steps for the pinned protocol's mcpToolCall items. */
export class NativeMcpEvents {
  private calls = new Map<string, Call>();
  private readonly prefix: string;
  private readonly labelPrefix: string;
  constructor(prefix = '', labelPrefix = '') { this.prefix = prefix; this.labelPrefix = labelPrefix; }
  receive(item: ObjectValue, complete: boolean): HarnessEvent[] {
    if (item.type !== 'mcpToolCall') return [];
    if (typeof item.id !== 'string' || !item.id || item.id.length > 256 || /[\x00-\x1f\x7f]/.test(item.id)) throw new Error('Native connector identity is invalid.');
    const identity = JSON.stringify([item.server, item.tool]);
    if (typeof item.server !== 'string' || typeof item.tool !== 'string' || identity.length > 1000) throw new Error('Native connector name is invalid.');
    const prior = this.calls.get(item.id);
    if (!prior && this.calls.size >= 1000) throw new Error('Native connector count exceeded its limit.');
    if (prior && prior.identity !== identity) throw new Error('Native connector identity changed.');
    const label = `${this.labelPrefix}Codex connector ${safeName(item.server)} / ${safeName(item.tool)}`;
    const status = complete ? item.status : 'inProgress';
    if (!['inProgress', 'completed', 'failed'].includes(String(status))) throw new Error('Native connector status is invalid.');
    let fingerprint: string | undefined;
    if (complete) {
      // Keep only a bounded digest for duplicate validation, never account arguments/results in steps.
      const bytes = JSON.stringify([item.arguments, item.result, item.error, item.readOnlyHint, status]);
      if (Buffer.byteLength(bytes) > 2_000_000) throw new Error('Native connector report exceeded its limit.');
      fingerprint = createHash('sha256').update(bytes).digest('hex');
    }
    if (prior?.fingerprint) {
      if (complete && prior.status === status && prior.fingerprint === fingerprint) return [];
      throw new Error('Native completed connector report changed.');
    }
    const readOnly = item.readOnlyHint === true || prior?.readOnly === true;
    this.calls.set(item.id, { identity, label, status: String(status), readOnly, fingerprint });
    if (prior && !complete) return [];
    const succeeded = status === 'completed' && item.error == null;
    return [{ type: 'tool', tool: 'native_connector', id: `${this.prefix}${item.id}`, readOnly,
      phase: !complete ? 'proposed' : succeeded ? 'done' : 'failed', label,
      detail: !complete ? 'Running in Codex under its native account permissions.'
        : succeeded ? 'Codex says this finished. No receipt for it is held here.'
          : readOnly ? 'Codex reported a tool error or declined call; this step failed.'
            : 'Codex reported a tool error or declined call. An error does not prove the account was left unchanged; check it there if it matters.' }];
  }
  /** Stop/failure/completion without an answer cannot establish that an outside action did not happen. */
  cutOff(): HarnessEvent[] {
    const events: HarnessEvent[] = [];
    for (const [id, call] of this.calls) if (call.status === 'inProgress') {
      call.status = 'unknown';
      events.push({ type: 'tool', tool: 'native_connector', id: `${this.prefix}${id}`, phase: call.readOnly ? 'failed' : 'unknown', readOnly: call.readOnly, label: call.label,
        detail: call.readOnly ? 'Read-only native call ended without completion; no account write is implied.' : 'Native connector outcome is UNKNOWN. Reconcile in the source system before another attempt.' });
    }
    return events;
  }
}
