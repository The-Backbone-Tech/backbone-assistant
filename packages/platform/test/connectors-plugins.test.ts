// The MCP servers of the Claude Code plugins the person enabled are found beside their own configs:
// .mcp.json in either documented shape and plugin.json's mcpServers, with ${CLAUDE_PLUGIN_ROOT} the
// install folder, read only inside the plugin cache, and no variable's value shown.
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { discover } from '../src/connectors/discover.ts';
import { defaultToolEnv } from '../src/tools/places.ts';
import { freshDir } from './helpers.ts';

test('servers of enabled Claude Code plugins are found, rooted at their install, and nothing else of theirs is read', () => {
  const user = freshDir('plugin-servers-');
  const cache = join(user, '.claude', 'plugins', 'cache', 'market');
  const install = (name: string) => { const dir = join(cache, name, '1.0.0'); mkdirSync(join(dir, '.claude-plugin'), { recursive: true }); return dir; };
  const wrapped = install('wrapped');
  writeFileSync(join(wrapped, '.mcp.json'), JSON.stringify({ mcpServers: { db: { command: '${CLAUDE_PLUGIN_ROOT}/servers/db', args: ['--config', '${CLAUDE_PLUGIN_ROOT}/config.json'], env: { DB_URL: 'postgres://secret@x/db' } } } }));
  const bare = install('bare');
  writeFileSync(join(bare, '.mcp.json'), JSON.stringify({ notes: { url: 'http://127.0.0.1:7000/mcp' } }));
  const inline = install('inline');
  writeFileSync(join(inline, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'inline', version: '1.0.0', mcpServers: { search: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/search.js'] } } }));
  const manifestOnly = install('manifest-only');
  writeFileSync(join(manifestOnly, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'manifest-only', description: 'no servers' }));
  const off = install('off');
  writeFileSync(join(off, '.mcp.json'), JSON.stringify({ mcpServers: { never: { command: 'never' } } }));
  const outside = freshDir('plugin-outside-');
  writeFileSync(join(outside, '.mcp.json'), JSON.stringify({ mcpServers: { escaped: { command: 'escaped' } } }));
  symlinkSync(outside, join(cache, 'linked'));
  const at = (name: string, dir: string) => ({ [`${name}@market`]: [{ scope: 'user', installPath: dir, version: '1.0.0' }] });
  writeFileSync(join(user, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'wrapped@market': true, 'bare@market': true, 'inline@market': true, 'manifest-only@market': true, 'off@market': false, 'escape@market': true, 'linked@market': true } }));
  writeFileSync(join(user, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { ...at('wrapped', wrapped), ...at('bare', bare), ...at('inline', inline), ...at('manifest-only', manifestOnly), ...at('off', off), ...at('escape', outside), ...at('linked', join(cache, 'linked')) } }));

  const found = discover(freshDir('plugin-home-'), defaultToolEnv({ HOME: user, PATH: process.env.PATH }), ['claude-plugin']);
  const byName = Object.fromEntries(found.map((d) => [d.server.name, d]));
  assert.deepEqual(Object.keys(byName).sort(), ['bare@market/notes', 'inline@market/search', 'wrapped@market/db']);
  assert.equal(byName['wrapped@market/db'].launch.command, join(wrapped, 'servers/db'), '${CLAUDE_PLUGIN_ROOT} is the install folder');
  assert.deepEqual(byName['wrapped@market/db'].launch.args, ['--config', join(wrapped, 'config.json')]);
  assert.equal(byName['wrapped@market/db'].server.source, 'claude-plugin');
  assert.deepEqual(byName['wrapped@market/db'].server.envNames, ['DB_URL']);
  assert.doesNotMatch(JSON.stringify(found.map((d) => d.server)), /secret/, 'no variable\'s value is shown');
  assert.equal(byName['bare@market/notes'].launch.url, 'http://127.0.0.1:7000/mcp');
  assert.deepEqual(byName['inline@market/search'].launch.args, [join(inline, 'search.js')]);
});

test('a server started from an app with a short PATH still finds uvx, npx or node where tools are installed', async () => {
  const { withToolFolders } = await import('../src/connectors/client.ts');
  const path = withToolFolders('/usr/bin:/bin').split(':');
  assert.deepEqual(path.slice(0, 2), ['/usr/bin', '/bin'], 'the PATH it has comes first');
  assert.ok(path.includes('/opt/homebrew/bin'));
  assert.equal(new Set(path).size, path.length, 'no folder twice');
});

test('a plugin server is offered from its own install, but not with an argument that links out of it into a credential place', async () => {
  const { ConnectorService } = await import('../src/connectors/service.ts');
  const { CoreLink } = await import('../src/composition/core.ts');
  const { freshHome } = await import('./helpers.ts');
  const user = freshDir('plugin-cred-');
  const cache = join(user, '.claude', 'plugins', 'cache', 'market');
  const make = (name: string) => { const dir = join(cache, name, '1.0.0'); mkdirSync(join(dir, '.claude-plugin'), { recursive: true }); return dir; };
  const fine = make('fine');
  const linked = make('linked');
  mkdirSync(join(user, '.google_workspace_mcp'));
  symlinkSync(join(user, '.google_workspace_mcp'), join(linked, 'data'));
  const bare = make('bare');
  symlinkSync(join(user, '.google_workspace_mcp'), join(bare, 'data'));
  for (const [dir, extra] of [[fine, []], [linked, ['--root', '${CLAUDE_PLUGIN_ROOT}/data']]] as const) {
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { files: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/server.js', ...extra] } } }));
  }
  writeFileSync(join(bare, '.mcp.json'), JSON.stringify({ mcpServers: { files: { command: 'node', args: ['server.js', '--root', 'data'], cwd: '${CLAUDE_PLUGIN_ROOT}' } } }));
  writeFileSync(join(fine, '.mcp.json'), JSON.stringify({ mcpServers: { files: { command: 'node', args: ['server.js', '--root', '.'], cwd: '${CLAUDE_PLUGIN_ROOT}' } } }));
  writeFileSync(join(user, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'fine@market': true, 'linked@market': true, 'bare@market': true } }));
  writeFileSync(join(user, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: {
    'fine@market': [{ scope: 'user', installPath: fine, version: '1.0.0' }], 'linked@market': [{ scope: 'user', installPath: linked, version: '1.0.0' }], 'bare@market': [{ scope: 'user', installPath: bare, version: '1.0.0' }] } }));
  const home = freshHome();
  const t = defaultToolEnv({ HOME: user, PATH: process.env.PATH });
  const service = new ConnectorService({ home, env: () => t, link: async () => CoreLink.open({ home }) });
  const found = discover(home, t, ['claude-plugin']);
  const rooted = (name: string) => (service as unknown as { rootedInCredentials(d: unknown): boolean }).rootedInCredentials(found.find((d) => d.server.name === name)!);
  assert.equal(rooted('fine@market/files'), false, 'its own install folder');
  assert.equal(rooted('linked@market/files'), true, 'a link out of it into a credential place');
  assert.equal(rooted('bare@market/files'), true, 'a bare relative argument linking out, from the plugin folder as its cwd');
});
