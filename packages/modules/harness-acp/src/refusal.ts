/** Safe adapter-generated reasons only; never raw process/provider diagnostics. */
export class AcpRefusal extends Error {}
/** Raw credentials cannot be represented by this route's surrogate-only piece grant. */
export function checkEnvironment(env: Record<string, string> = {}) {
  if (Object.keys(env).some(name => /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i.test(name))) throw new AcpRefusal('ACP accepts non-secret environment configuration only; configure agent-owned authentication separately.');
}

export { ACP_PROCESS_VISIBILITY_WARNING as PROCESS_VISIBILITY_WARNING } from '@backbone-next/platform';
import { ACP_PROCESS_VISIBILITY_WARNING as PROCESS_VISIBILITY_WARNING } from '@backbone-next/platform';
export const PROCESS_VISIBILITY_REFUSAL = 'ACP is disabled. Set harnesses.harness-acp.acceptsProcessVisibility: true only if you accept this risk. ' + PROCESS_VISIBILITY_WARNING;
