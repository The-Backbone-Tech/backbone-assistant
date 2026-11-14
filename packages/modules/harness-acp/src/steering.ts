import type { SteerOutcome } from '@backbone-next/platform/ports';

// Adopt the agent's extension. A promptRequired response returns to the Host's existing
// queue; never send a second session/prompt or accept an unowned detached turn here.
type Send = (method: '_session/steering', params: { prompt: { type: 'text'; text: string }[]; _meta: { steering: { idleBehavior: 'promptRequired' } } }) => Promise<unknown>;
const unknown: SteerOutcome = { outcome: 'UNKNOWN', detail: 'ACP did not confirm steering delivery. These words will not be resent.' };
export class AcpSteering {
  private send?: Send;
  private pending = new Set<(value: SteerOutcome) => void>();
  private uncertain: () => void;
  constructor(uncertain: () => void = () => {}) { this.uncertain = uncertain; }
  open(initialized: { _meta?: Record<string, unknown> | null }, send: Send) {
    const capability = initialized._meta?.steering;
    if (capability && typeof capability === 'object' && 'supported' in capability && capability.supported === true) this.send = send;
  }
  deliver(text: string): Promise<SteerOutcome> {
    if (!this.send) return Promise.resolve({ outcome: 'NOT_DELIVERED', detail: 'This ACP agent is not taking steering. The message can wait for the next turn.' });
    return new Promise(resolve => {
      const settle = (value: SteerOutcome) => { if (!this.pending.delete(settle)) return; if (value.outcome === 'UNKNOWN') this.uncertain(); resolve(value); };
      this.pending.add(settle);
      let response: Promise<unknown>;
      try { response = this.send!('_session/steering', { prompt: [{ type: 'text', text }], _meta: { steering: { idleBehavior: 'promptRequired' } } }); }
      catch { settle(unknown); return; }
      void response.then(value => {
        const result = value as { outcome?: unknown; reason?: unknown } | undefined;
        settle(result?.outcome === 'injected' ? { outcome: 'DELIVERED' }
          : result?.outcome === 'promptRequired' && result.reason === 'noRunningTurn' ? { outcome: 'NOT_DELIVERED', detail: 'The ACP turn ended before it took these words.' } : unknown);
      }, () => settle(unknown));
    });
  }
  close() { this.send = undefined; for (const settle of [...this.pending]) settle(unknown); }
}
