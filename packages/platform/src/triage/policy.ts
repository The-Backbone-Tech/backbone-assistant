// Triage bypasses the ordinary turn runner, so it captures the constructing Host's admission.
import type { HarnessV1, ModelRoute } from '../ports/harness.ts';
import { engineDecision, routeDecision, PolicyRefused } from '../policy/index.ts';
import { capturePolicyAdmission } from '../composition/policy-admission.ts';

export function triagePolicyFor(home: string) {
  const admit = capturePolicyAdmission(home);
  function check(engine?: HarnessV1, route?: ModelRoute): void {
    const policy = admit();
    if (engine) engineDecision(policy, engine.id);
    if (route) routeDecision(policy, route);
  }
  return { check, allowed(engine: HarnessV1, route: ModelRoute): true | string {
    try { check(engine, route); return true; }
    catch (error) { return error instanceof PolicyRefused ? error.message : 'Managed policy admission could not be checked. Nothing was sent.'; }
  } };
}
