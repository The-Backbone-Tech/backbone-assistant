// Fixed diagnostics: no database words, endpoint, credential or verifier reason enters this detail.
import type {StandingSignatureStatus} from '@backbone-next/platform';
import type {Api} from './commands.ts';
const STEP: StandingSignatureStatus['step'] = 'connector-signature-ledger-v1';
export async function standingSignaturesCheck(api: Pick<Api,'call'> | null, external: boolean) {
  let verified = false, inspected = false;
  try {
    const status = await api?.call('core.signatureStatus', {});
    inspected = status?.step === STEP && (status.state === 'verified' || status.state === 'paused');
    verified = inspected && status?.state === 'verified';
  } catch { /* Unavailable inspection is a warning, never database text or a doctor failure. */ }
  return {
    name: 'standing signatures', status: verified ? 'ok' as const : 'warn' as const,
    detail: verified ? `${STEP} verified.` : `${STEP} ${inspected ? 'is missing or not verified' : 'could not be inspected'}: tools cannot be permitted to act without asking and individual calls still wait for your permission, which works; ${external
      ? 'the database operator installs the step through the administrative installer route in the permission ledger contract'
      : 'a later version installs it at this data folder\'s next open'}.`,
  };
}
