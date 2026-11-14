// Shared with native engines: one maintained base profile and one excluded scratch parent.
export { BASE_POLICY, NETWORK_POLICY } from './seatbelt-policy.ts';
export const workspaceScratchParent = () => `/tmp/backbone-workspaces-${process.getuid?.() ?? 'user'}`;
