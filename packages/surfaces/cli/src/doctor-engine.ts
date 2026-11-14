// Probe only the selected engine. A disposable stub home never asks installed clients about accounts.
import { claudeCheck, codexCheck, type MachineCheck } from '@backbone-next/platform/composition';

export function engineClientChecks(engine?: string): MachineCheck[] {
  const skipped = (name: string): MachineCheck => ({ name, status: 'ok', detail: 'not checked: this engine is not selected' });
  return [
    /^(?:harness-)?codex(?:$|[\s·])/i.test(engine ?? '') ? codexCheck() : skipped('codex'),
    /^(?:harness-)?claude(?:$|[\s·])/i.test(engine ?? '') ? claudeCheck() : skipped('claude'),
  ];
}
