// A shell exit confirms completion, not refusal. Scratch may change on any failed or unknown run.
export type WorkspaceRefusalCode = 'policy' | 'admission' | 'setup';
// Host and engines may load separate bundles. The marker preserves identity across those copies.
const beforeCommand = Symbol.for('@backbone-next/platform/workspace/refusal-before-command/v1');
/** Trusted checks certify the same rejection only after establishing that no command was dispatched. */
export class WorkspaceRefusal extends Error {
  static beforeCommand(error: WorkspaceRefusal): WorkspaceRefusal {
    Object.defineProperty(error, beforeCommand, { value: true });
    return error;
  }
}
const refusalLabels: Record<WorkspaceRefusalCode, string> = {
  policy: 'Host refused workspace execution before the command started.',
  admission: 'Workspace confinement could not be admitted; the command did not start.',
  setup: 'Workspace limits could not be set; the command did not start.',
};
export interface WorkspaceExecution {
  phase: 'done' | 'failed' | 'refused' | 'unknown';
  /** Fixed status evidence only: command output and arbitrary Host text stay out of work notes. */
  detail: string;
}

export function workspaceFailure(error?: unknown): WorkspaceExecution {
  try {
    if (error && typeof error === 'object' && Object.getOwnPropertyDescriptor(error, beforeCommand)?.value === true) {
      return { phase: 'refused', detail: refusalLabels.policy };
    }
  } catch { /* An opaque exception supplies no execution evidence. */ }
  return workspaceExecution();
}

export function workspaceExecution(text?: string): WorkspaceExecution {
  type Reply = { code?: unknown; stdout?: unknown; stderr?: unknown; reason?: unknown; refused?: unknown };
  let result: Reply | null = null;
  try { result = JSON.parse(text ?? '') as Reply | null; } catch { /* Preserve the original reply for the model. */ }
  if (result && typeof result === 'object' && result.code === null && typeof result.stdout === 'string' && typeof result.stderr === 'string' &&
      result.reason === undefined && (result.refused === 'policy' || result.refused === 'admission' || result.refused === 'setup')) {
    return { phase: 'refused', detail: refusalLabels[result.refused] };
  }
  if (!result || typeof result !== 'object' || result.refused !== undefined || !Number.isInteger(result.code) || (result.code as number) < 0 ||
      typeof result.stdout !== 'string' || typeof result.stderr !== 'string' || result.reason !== undefined) {
    return { phase: 'unknown', detail: 'Workspace execution, output or cleanup was not confirmed; scratch may have changed.' };
  }
  const code = result.code as number;
  return { phase: code === 0 ? 'done' : 'failed', detail: `Workspace command exited with status ${code}${code === 0 ? '.' : '; scratch may have changed.'}` };
}
