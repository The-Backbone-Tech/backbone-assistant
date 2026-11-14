import { resolve } from 'node:path';
// The live Host checks policy before startup, each call, recovery and inference dispatch.
import { governedPolicy, engineDecision, keyDecision, PolicyRefused } from '../policy/index.ts';
import { readTelemetrySettings } from '../credentials/telemetry.ts';
import { homeKeyProvider } from '../system-keys/selection.ts';
import type { HomeKeys } from '../keys/vault.ts';
import type { Host } from './host-types.ts';
import { startConfiguredTelemetry } from './telemetry.ts';

// Host construction is synchronous: capture its check when its triage service is constructed.
// Retaining that reference prevents another Host for the same home from replacing its checks.
const hostAdmissions = new Map<string, (dispatch?: boolean) => ReturnType<typeof governedPolicy>>();
export function capturePolicyAdmission(home: string) {
  const admit = hostAdmissions.get(resolve(home));
  if (admit) hostAdmissions.delete(resolve(home));
  return () => {
    if (admit) return admit(true);
    const policy = governedPolicy(home);
    if (policy?.requirements.telemetryRequired) throw new PolicyRefused('requirement', 'Required telemetry needs an owning managed Host before triage can run.');
    return policy;
  };
}

export function createPolicyAdmission(home: string, engine: string, config: () => object | undefined, keys: HomeKeys | undefined, host: () => Host, readOnly: boolean) {
  let telemetry: Awaited<ReturnType<typeof startConfiguredTelemetry>> | undefined;
  let endpoint: string | undefined;
  let closed = false;
  function check(dispatch = false) {
    if (dispatch && closed) throw new PolicyRefused('requirement', 'The managed Host is closed; nothing was sent.');
    const policy = governedPolicy(home);
    engineDecision(policy, engine, config());
    if (policy?.requirements.keyHolders) keyDecision(policy, homeKeyProvider(home)?.holder ?? keys?.holder ?? 'plaintext');
    if (dispatch && !readOnly && policy?.requirements.telemetryRequired === true && (!telemetry || telemetry.status !== 'on' || endpoint !== readTelemetrySettings(home)?.endpoint)) throw new PolicyRefused('requirement', 'Required telemetry is not running at the current policy destination; restart this Host.');
    return policy;
  }
  hostAdmissions.set(resolve(home), check);
  return {
    check,
    async ready() {
      if (closed) return;
      if (!readOnly && check()?.requirements.telemetryRequired === true) {
        telemetry = await startConfiguredTelemetry(host(), home, keys);
        endpoint = 'endpoint' in telemetry && typeof telemetry.endpoint === 'string' ? telemetry.endpoint : undefined;
        check(true);
      }
      if (closed) await telemetry?.close();
    },
    async close() { closed = true; if (hostAdmissions.get(resolve(home)) === check) hostAdmissions.delete(resolve(home)); await telemetry?.close(); },
  };
}
