// Administrative inspection is read-only and cannot select a runtime policy path.
import { policyFor, policyDescription, verifyPolicyFile, settingLabel } from '@backbone-next/platform/policy';
import { EXIT, type Parsed, type Io } from './commands.ts';
export function policyCommand(parsed: Parsed, io: Pick<Io, 'out' | 'err'>): number {
  const result = parsed.name === 'policy verify' ? verifyPolicyFile(parsed.target!) : policyFor(parsed.home);
  const description = policyDescription(result);
  if (parsed.json) io.out(JSON.stringify(result, null, 2));
  else {
    io.out(description.detail);
    if (result.status === 'verified') {
      for (const [key, value] of Object.entries(result.policy.requirements)) io.out(`${settingLabel(key)} = ${JSON.stringify(value)} (fixed by policy; cannot be changed here)`);
      for (const [key, value] of Object.entries(result.policy.defaults)) io.out(`${settingLabel(key)} = ${JSON.stringify(value)} (default; personal choice takes precedence)`);
      for (const warning of result.policy.warnings) io.out(`Warning: ${warning}`);
    }
  }
  return result.status === 'refused' ? EXIT.REFUSED : EXIT.OK;
}
