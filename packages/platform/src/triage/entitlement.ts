import type { MailConnector } from '../ports/mail.ts';

/** Proposals need reads; dispatch requires complete current write entitlement for this account. */
export async function writeEntitled(connector: MailConnector): Promise<boolean> {
  try {
    const answer = await connector.entitlement();
    return answer.ok === true && answer.provider === connector.provider && answer.account === connector.account && Array.isArray(answer.missing) && answer.missing.length === 0;
  } catch { return false; }
}
