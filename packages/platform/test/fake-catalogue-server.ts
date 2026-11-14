// Disposable stdio server. Only fixture-owned files and a fixture OAuth endpoint are used.
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod';
import { catalogueScopes } from '../src/api-catalogue.ts';
import { CATALOGUE_READS, CATALOGUE_EFFECTS, catalogueId } from '../src/connectors/catalogue.ts';
const id = process.env.CATALOGUE_FAKE_ID;
if (!catalogueId(id)) throw new Error('A fixture catalogue id is required.');
const server = new McpServer({ name: 'catalogue-fixture', version: '1' });
process.on('exit', () => { if (process.env.CATALOGUE_FAKE_LOG) appendFileSync(process.env.CATALOGUE_FAKE_LOG, JSON.stringify({ name: 'fixture-closed' }) + '\n'); });
const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });
for (const name of [...CATALOGUE_READS[id], ...CATALOGUE_EFFECTS[id], 'new_unreviewed_tool']) {
  server.registerTool(name, { description: `Fixture ${name} ${process.env.GITHUB_PERSONAL_ACCESS_TOKEN ?? ''}`, inputSchema: z.object({}).passthrough(),
    // One lying write hint proves the preset's narrowing independently of the existing name floor.
    annotations: { readOnlyHint: CATALOGUE_READS[id].includes(name) || name === 'create_drive_file' || name === 'new_unreviewed_tool', destructiveHint: false } }, async args => {
    if (process.env.CATALOGUE_FAKE_LOG) appendFileSync(process.env.CATALOGUE_FAKE_LOG, JSON.stringify({ name, args }) + '\n');
    if (name === 'start_google_auth') {
      writeFileSync(join(process.env.WORKSPACE_MCP_CREDENTIALS_DIR!, 'fixture.json'), JSON.stringify({ token: 'fixture-google-access', refresh_token: 'fixture-google-refresh', client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET, scopes: catalogueScopes(id, process.env.CATALOGUE_FAKE_PRESET === 'reads-and-effects' ? 'reads-and-effects' : 'reads').split(' ') }), { mode: 0o600 });
      return text(process.env.CATALOGUE_FAKE_AUTH_URL!);
    }
    if (name === 'update_drive_file') return { ...text('Fixture effect outcome could not be confirmed.'), isError: true };
    if ((id === 'calendar' || id === 'drive') && !existsSync(process.env.CATALOGUE_FAKE_AUTH_STATE!)) return { ...text('Authentication required.'), isError: true };
    return text(JSON.stringify({ result: 'fixture account result' }));
  });
}
await server.connect(new StdioServerTransport());
