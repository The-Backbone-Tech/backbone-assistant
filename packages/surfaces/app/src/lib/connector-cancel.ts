// A server refusal that happens to contain “cancelled” is still a refusal to show.
export const CONNECTOR_CANCEL = {
  resolve: 'Not resolved: you cancelled.',
  enable: 'Not turned on: you cancelled.',
  read: 'Not changed: you cancelled.',
  open: 'Sending not allowed: you cancelled.',
  release: 'Not released: you cancelled.',
  sign: 'Not signed: you cancelled.',
} as const;
export function connectorRefusal(result: { ok: boolean; detail?: string; reason?: string; outcome?: string }, action?: keyof typeof CONNECTOR_CANCEL): string | undefined {
  if (result.ok) return undefined;
  return action && result.reason === 'NOT_AVAILABLE' && result.outcome === 'REFUSED' && result.detail === CONNECTOR_CANCEL[action] ? undefined : result.detail;
}
