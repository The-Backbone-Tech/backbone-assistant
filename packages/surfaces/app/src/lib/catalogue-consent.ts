import { catalogueScopes, type CatalogueEntry, type CataloguePreset, type CatalogueDisconnect } from '@backbone-next/platform';
export function catalogueConsent(entry: CatalogueEntry, preset: CataloguePreset): string {
  const storage = entry.id === 'calendar' || entry.id === 'drive'
    ? 'Google: workspace-mcp stores access tokens, refresh tokens and a copy of the client secret as plain JSON in a separate folder for this installation under the app data folder (connectors/google). The folder is owner-only (0700); credential files are 0600. Disconnect stops the server, attempts Google token revocation and deletes this folder. Google may also revoke other tokens issued to this account by the same OAuth app.'
    : 'GitHub and Slack client secrets and tokens stay sealed in the app vault. Disconnect stops local access and attempts provider token revocation; its receipt distinguishes confirmed revocation from an unknown outcome.';
  const privateGithub = entry.id === 'github' && preset === 'reads' ? ' Read access here covers public repositories and your profile. GitHub OAuth apps cannot request private-repository read without write; that needs a fine-grained GitHub App.' : '';
  return `${entry.server} ${entry.version} (${entry.licence}). ${entry.configuration}. Your browser handles consent. Requested scopes: ${catalogueScopes(entry.id, preset)}. ${preset === 'reads' && entry.id !== 'slack' ? 'The local server runs with --read-only. ' : ''}${storage}${privateGithub} You review its tools after sign-in.`;
}
export function catalogueDisconnected(value: CatalogueDisconnect): string {
  const local = value.configurationKept ? 'Disconnected locally. Your edited connector configuration was kept; remove or rename its entry before reconnecting.' : 'Disconnected locally. Earlier sources remain until you withdraw them.';
  return `${local} ${value.revocation === 'revoked' ? 'Provider token revoked.' : value.revocation === 'unknown' ? 'Provider revocation has an unknown outcome. Check the provider account; no automatic retry was made.' : 'No issued provider token was found to revoke.'}`;
}
