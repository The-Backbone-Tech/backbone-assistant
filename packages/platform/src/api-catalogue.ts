/** Native catalogue requests carry app credentials only inside the trusted process. */
export type CatalogueId = 'calendar' | 'drive' | 'github' | 'slack';
export type CataloguePreset = 'reads' | 'reads-and-effects';
export interface CatalogueApp { clientId: string; clientSecret: string; email?: string; redirectPort?: number }
export interface CatalogueEntry {
  id: CatalogueId; name: string; server: string; version: string; licence: string;
  configuration: string;
}
export interface CatalogueConnection { id: CatalogueId; serverId: string; state: 'awaiting-google' | 'ready' }
export interface CatalogueDisconnect { disconnected: true; configurationKept?: true; revocation: 'revoked' | 'unknown' | 'not-needed' }
/** Requested provider scopes are shown before consent and retained in the sealed installation. */
export function catalogueScopes(id: CatalogueId, preset: CataloguePreset): string {
  const read = preset === 'reads';
  const googleIdentity = 'https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile openid ';
  if (id === 'calendar') return googleIdentity + (read ? 'https://www.googleapis.com/auth/calendar.readonly' : 'https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events');
  if (id === 'drive') return googleIdentity + (read ? 'https://www.googleapis.com/auth/drive.readonly' : 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file');
  // OAuth apps cannot express private-repository read without write. Reads use public repository
  // access and profile only; private read needs a separately configured fine-grained GitHub App.
  if (id === 'github') return read ? 'read:user' : 'repo read:user';
  return 'search:read.public search:read.private search:read.im search:read.mpim search:read.files search:read.users channels:history groups:history im:history mpim:history users:read' + (read ? '' : ' chat:write');
}
export const CONNECTOR_CATALOGUE: readonly CatalogueEntry[] = [
  { id: 'calendar', name: 'Google Calendar', server: 'workspace-mcp', version: '2.4.1', licence: 'MIT', configuration: 'needs a Google OAuth app' },
  { id: 'drive', name: 'Google Drive', server: 'workspace-mcp', version: '2.4.1', licence: 'MIT', configuration: 'needs a Google OAuth app' },
  { id: 'github', name: 'GitHub', server: 'github-mcp-server', version: '2.1.0', licence: 'MIT', configuration: 'needs a GitHub OAuth app' },
  { id: 'slack', name: 'Slack', server: 'Slack MCP', version: 'hosted', licence: 'Slack service terms', configuration: 'needs a Slack app' },
];
