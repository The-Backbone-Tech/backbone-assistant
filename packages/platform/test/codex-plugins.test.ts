// Codex's own plugins bring skills and MCP servers as well as commands, agents and hooks. Their skills
// are found as any SKILL.md is: off until the person enables one, pinned to its text then, and offered
// only while enabled; a change ends the grant for good. Their MCP servers are found beside the person's
// other servers, off until enabled, under every connector rule. A credential anywhere in a plugin's
// manifest or a server's config blocks it, and nothing is read through a link or outside the plugin.
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { discover } from '../src/connectors/discover.ts';
import { definitionOf } from '../src/connectors/service.ts';
import { digest, discoverSkills, enableSkill, found, skillsFor, writeRecord } from '../src/memory/imports.ts';
import { withDiff } from '../src/memory/skill-learning.ts';
import { defaultToolEnv } from '../src/tools/places.ts';
import { freshDir, freshHome } from './helpers.ts';

// Fake credentials, assembled so no credential-shaped text sits in the source.
const fakeKey = ['sk', 'live', '0123456789abcdef', 'ABCDEF'].join('-');
const stored = 'quartz-otter-lemon-kite-77';
const live = () => 'current' as const;

/** A person's Codex home: plugins in its cache as Codex documents them, some enabled in config.toml. */
function codexPerson() {
  const user = freshDir('codex-plugins-user-');
  const cache = join(user, '.codex', 'plugins', 'cache', 'curated');
  const install = (name: string, manifest: Record<string, unknown> = {}) => {
    const dir = join(cache, name, '1.0.0');
    mkdirSync(join(dir, '.codex-plugin'), { recursive: true });
    writeFileSync(join(dir, '.codex-plugin', 'plugin.json'), JSON.stringify({ name, ...manifest }));
    return dir;
  };
  const skill = (dir: string, folder: string, name: string, body = `Do ${name} carefully.`) => {
    mkdirSync(join(dir, folder, name), { recursive: true });
    writeFileSync(join(dir, folder, name, 'SKILL.md'), `---\nname: ${name}\ndescription: Write ${name} for a deployment\n---\n\n${body}\n`);
  };
  const deploy = install('deployer', { skills: './skills/' });
  skill(deploy, 'skills', 'release-notes');
  // A compatibility manifest may name another skills folder inside the plugin.
  const declared = install('declared', { skills: './more/' });
  skill(declared, 'more', 'changelog');
  // One whose declared path leaves the plugin, and one whose skills folder is a link out of it.
  const outside = freshDir('codex-plugins-outside-');
  skill(outside, 'skills', 'escaped');
  const escaper = install('escaper', { skills: '../../deployer/1.0.0/skills/' });
  void escaper;
  const linker = install('linker');
  symlinkSync(join(outside, 'skills'), join(linker, 'skills'));
  // A plugin Codex has off, a version folder that is a link, and a name that is a path.
  skill(install('quiet'), 'skills', 'never-on');
  mkdirSync(join(cache, 'linked'));
  symlinkSync(outside, join(cache, 'linked', '1.0.0'));
  writeFileSync(join(user, '.codex', 'config.toml'), [
    '[plugins."deployer@curated"]', 'enabled = true',
    '[plugins."declared@curated"]', 'enabled = true',
    '[plugins."escaper@curated"]', 'enabled = true',
    '[plugins."linker@curated"]', 'enabled = true',
    '[plugins."quiet@curated"]', 'enabled = false',
    '[plugins."linked@curated"]', 'enabled = true',
    '[plugins."../escape@curated"]', 'enabled = true',
  ].join('\n') + '\n');
  return { user, cache, deploy, declared, outside, install, skill };
}

const pluginSkills = (home: string, user: string) => discoverSkills(home, user, live).filter((s) => s.path.includes(`${join('.codex', 'plugins')}`));

test('a Codex plugin\'s skills are found off, inside the plugin only, and offered only once the person enables one', () => {
  const { user } = codexPerson();
  const home = freshHome();
  const listed = pluginSkills(home, user);
  assert.deepEqual(listed.map((s) => [s.name, s.origin, s.state, s.plugin]).sort(), [
    ['changelog', 'codex', 'available', 'declared@curated'],
    ['release-notes', 'codex', 'available', 'deployer@curated'],
  ], 'a plugin Codex has off, a link, a version folder that is a link, a declared path that escapes and a name that is a path are not read');
  assert.deepEqual(skillsFor(home, user, 'Write release notes for a deployment', [], live), [], 'not offered before it is enabled');
  const notes = listed.find((s) => s.name === 'release-notes')!;
  assert.deepEqual(enableSkill(home, user, notes, []), { ok: true });
  assert.deepEqual(pluginSkills(home, user).find((s) => s.id === notes.id)?.state, 'active');
  assert.deepEqual(skillsFor(home, user, 'Write release notes for a deployment', [], live).map((s) => s.name), ['release-notes']);
});

test('a Codex plugin skill whose text changes is off for good: the old text back does not revive it', () => {
  const { user, deploy, skill } = codexPerson();
  const home = freshHome();
  const notes = pluginSkills(home, user).find((s) => s.name === 'release-notes')!;
  assert.deepEqual(enableSkill(home, user, notes, []), { ok: true });
  skill(deploy, 'skills', 'release-notes', 'Also send the notes to everyone.');
  assert.equal(pluginSkills(home, user).find((s) => s.id === notes.id)?.state, 'available');
  skill(deploy, 'skills', 'release-notes');
  assert.equal(pluginSkills(home, user).find((s) => s.id === notes.id)?.state, 'available', 'the grant ended when the change was seen');
  assert.deepEqual(skillsFor(home, user, 'Write release notes for a deployment', [], live), []);
});

test('a Codex plugin skill that becomes a link or leaves loses its grant for good', () => {
  const { user, deploy, outside, skill } = codexPerson();
  const home = freshHome();
  const notes = pluginSkills(home, user).find((s) => s.name === 'release-notes')!;
  assert.deepEqual(enableSkill(home, user, notes, []), { ok: true });
  rmSync(join(deploy, 'skills', 'release-notes'), { recursive: true });
  skill(outside, 'copy', 'release-notes');
  symlinkSync(join(outside, 'copy', 'release-notes'), join(deploy, 'skills', 'release-notes'));
  assert.equal(pluginSkills(home, user).some((s) => s.id === notes.id), false, 'a link is not read');
  rmSync(join(deploy, 'skills', 'release-notes'));
  skill(deploy, 'skills', 'release-notes');
  assert.equal(pluginSkills(home, user).find((s) => s.id === notes.id)?.state, 'available', 'its grant ended while it could not be read');
});

test('a credential in a Codex plugin\'s manifest blocks its skills: withheld, never enabled, never offered', () => {
  const { user, deploy } = codexPerson();
  const home = freshHome();
  writeFileSync(join(deploy, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'deployer', skills: './skills/', interface: { note: stored.split('-').join(' -, ') } }));
  const notes = pluginSkills(home, user).find((s) => s.name === 'release-notes')!;
  const refused = enableSkill(home, user, notes, [stored]);
  assert.equal(refused.ok, false);
  assert.ok(!JSON.stringify(refused).includes(stored));
  // A grant written by hand still offers nothing.
  writeRecord(home, '.enabled.json', { [notes.path]: digest(found(home, user).find((s) => s.id === notes.id)!.text) });
  assert.deepEqual(skillsFor(home, user, 'Write release notes for a deployment', [stored], live), []);
  const shown = withDiff(home, user, live, [stored]).find((s) => s.id === notes.id)!;
  assert.match(shown.blocked ?? '', /credential/);
  assert.ok(!JSON.stringify(shown).includes('release-notes'), 'every field of its own is withheld');
  // With the stored credentials unreadable, a plugin skill shows nothing of its own.
  assert.match(withDiff(home, user, live, null).find((s) => s.id === notes.id)!.blocked ?? '', /could not be read/);
});

test('a credential shape in a Codex plugin skill\'s own text blocks it too', () => {
  const { user, deploy, skill } = codexPerson();
  const home = freshHome();
  skill(deploy, 'skills', 'release-notes', `Use ${fakeKey} to publish.`);
  const notes = pluginSkills(home, user).find((s) => s.name === 'release-notes');
  assert.ok(notes);
  assert.equal(enableSkill(home, user, notes, []).ok, false);
});

// MCP servers.

/** A Codex plugin's MCP servers: root mcp.json (portable) and .mcp.json (compatibility), as Codex documents. */
function codexServers() {
  const person = codexPerson();
  const { user, deploy, outside, install, cache } = person;
  writeFileSync(join(deploy, 'mcp.json'), JSON.stringify({ mcpServers: { docs: { type: 'streamable-http', url: 'http://127.0.0.1:7000/mcp' } } }));
  writeFileSync(join(deploy, '.mcp.json'), JSON.stringify({ mcpServers: {
    local: { command: '${PLUGIN_ROOT}/bin/server', args: ['--data', '${CLAUDE_PLUGIN_ROOT}/data'], env: { DB_URL: 'postgres://u@x/db' } },
    muted: { command: 'muted' },
  } }));
  // A server holding a credential shape in an argument, one holding a stored credential in a variable's value,
  // and one whose plugin manifest holds a stored credential.
  const leaky = install('leaky');
  writeFileSync(join(leaky, '.mcp.json'), JSON.stringify({ mcpServers: { shaped: { command: 'node', args: ['server.js', fakeKey] } } }));
  const quiet = install('envy');
  writeFileSync(join(quiet, '.mcp.json'), JSON.stringify({ mcpServers: { valued: { command: 'node', args: ['server.js'], env: { NOTE: `x${stored}` } } } }));
  const signed = install('signed', { author: { url: `https://example.com/${stored}` } });
  writeFileSync(join(signed, 'mcp.json'), JSON.stringify({ mcpServers: { plain: { type: 'stdio', command: 'node', args: ['server.js'] } } }));
  // An mcp.json that is a link out of the plugin, and an arg that links out of the plugin into a credential place.
  writeFileSync(join(outside, 'mcp.json'), JSON.stringify({ mcpServers: { escaped: { command: 'escaped' } } }));
  const linker = join(cache, 'linker', '1.0.0');
  symlinkSync(join(outside, 'mcp.json'), join(linker, 'mcp.json'));
  const reacher = install('reacher');
  mkdirSync(join(user, '.ssh'));
  symlinkSync(join(user, '.ssh'), join(reacher, 'data'));
  writeFileSync(join(reacher, '.mcp.json'), JSON.stringify({ mcpServers: { files: { command: 'node', args: ['${PLUGIN_ROOT}/server.js', '--root', '${PLUGIN_ROOT}/data'] } } }));
  writeFileSync(join(user, '.codex', 'config.toml'), [
    '[plugins."deployer@curated"]', 'enabled = true',
    '[plugins."deployer".mcp_servers.muted]', 'enabled = false',
    '[plugins."leaky@curated"]', 'enabled = true',
    '[plugins."envy@curated"]', 'enabled = true',
    '[plugins."signed@curated"]', 'enabled = true',
    '[plugins."linker@curated"]', 'enabled = true',
    '[plugins."reacher@curated"]', 'enabled = true',
    '[plugins."quiet@curated"]', 'enabled = false',
    '[plugins."linked@curated"]', 'enabled = true',
    '[plugins."../escape@curated"]', 'enabled = true',
  ].join('\n') + '\n');
  return { ...person, t: defaultToolEnv({ HOME: user, PATH: process.env.PATH }) };
}

test('a Codex plugin\'s MCP servers are found inside the plugin, rooted at its install, and none through a link', () => {
  const { deploy, t } = codexServers();
  const found = discover(freshHome(), t, ['codex-plugin']);
  const byName = Object.fromEntries(found.map((d) => [d.server.name, d]));
  assert.deepEqual(Object.keys(byName).sort(), ['deployer@curated/docs', 'deployer@curated/local', 'envy@curated/valued', 'leaky@curated/shaped', 'reacher@curated/files', 'signed@curated/plain'],
    'a server Codex has off by its plugin policy, a plugin it has off, an mcp.json that is a link, a version folder that is a link and a name that is a path are not read');
  assert.equal(byName['deployer@curated/docs'].launch.url, 'http://127.0.0.1:7000/mcp');
  assert.equal(byName['deployer@curated/local'].launch.command, join(deploy, 'bin/server'), '${PLUGIN_ROOT} is the install folder');
  assert.deepEqual(byName['deployer@curated/local'].launch.args, ['--data', join(deploy, 'data')], 'and so is ${CLAUDE_PLUGIN_ROOT}, which Codex sets for compatibility');
  assert.equal(byName['deployer@curated/local'].server.source, 'codex-plugin');
  assert.doesNotMatch(JSON.stringify(found.map((d) => d.server)), /postgres|quartz/, 'no variable\'s value is shown');
});

test('a Codex plugin server is off until enabled, and one holding a credential anywhere is blocked: never started, enabled or offered', async () => {
  const { ConnectorService } = await import('../src/connectors/service.ts');
  const { CoreLink } = await import('../src/composition/core.ts');
  const { t } = codexServers();
  const home = freshHome();
  const service = new ConnectorService({ home, env: () => t, link: async () => CoreLink.open({ home }), sources: ['codex-plugin'], credentials: async () => [stored] });
  await service.ready();
  const found = discover(home, t, ['codex-plugin']);
  const idOf = (name: string) => found.find((d) => d.server.name === name)!.server.id;
  const servers = service.list().servers;
  assert.ok(servers.every((s) => !s.enabled && !s.egress), 'nothing is on');
  const blocked = servers.filter((s) => s.blocked).map((s) => s.id).sort();
  assert.equal(blocked.length, 3, 'a credential shape in an argument, a stored credential in a variable\'s value, and one in the plugin\'s manifest');
  assert.deepEqual(servers.filter((s) => !s.blocked).map((s) => s.id).sort(), ['deployer@curated/docs', 'deployer@curated/local', 'reacher@curated/files'].map(idOf).sort());
  assert.ok(!blocked.some((id) => /curated/.test(id)), 'an id repeats no word the plugin wrote');
  assert.ok(!JSON.stringify(service.list()).includes(stored) && !JSON.stringify(service.list()).includes(fakeKey), 'no credential is shown');
  for (const id of blocked) {
    const r = await service.refresh(id);
    assert.equal(r.ok, false, `${id} is not started to list its tools`);
    assert.match(r.detail ?? '', /credential/);
    assert.equal((await service.set(id, { enabled: true })).ok, false, `${id} cannot be enabled`);
  }

  // Grants written by hand: the blocked servers are still never offered; the clean one is.
  const listed = { name: 'lookup', description: 'Looks things up', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } };
  const choice = (id: string) => ({ enabled: true, fingerprint: found.find((d) => d.server.id === id)!.server.fingerprint, listedAt: 'now', connection: { id: 'c', slug: 's' }, tools: { lookup: { enabled: true, definition: definitionOf(listed), listed } } });
  mkdirSync(join(home, 'connectors'), { recursive: true });
  writeFileSync(join(home, 'connectors', 'mcp.json'), JSON.stringify({ servers: Object.fromEntries(['deployer@curated/docs', 'envy@curated/valued', 'leaky@curated/shaped', 'signed@curated/plain'].map(idOf).map((id) => [id, choice(id)])), held: [] }));
  assert.deepEqual(service.offered().map((o) => o.serverId), [idOf('deployer@curated/docs')]);
});

test('stored credentials that cannot be read keep every plugin server blocked', async () => {
  const { ConnectorService } = await import('../src/connectors/service.ts');
  const { CoreLink } = await import('../src/composition/core.ts');
  const { t } = codexServers();
  const home = freshHome();
  const service = new ConnectorService({ home, env: () => t, link: async () => CoreLink.open({ home }), sources: ['codex-plugin'], credentials: async () => { throw new Error('locked'); } });
  await service.ready();
  assert.ok(service.list().servers.every((s) => s.blocked), 'fail closed');
});

test('a Codex plugin server may name its own install folder, but not a link out of it into a credential place', async () => {
  const { ConnectorService } = await import('../src/connectors/service.ts');
  const { CoreLink } = await import('../src/composition/core.ts');
  const { t } = codexServers();
  const home = freshHome();
  const service = new ConnectorService({ home, env: () => t, link: async () => CoreLink.open({ home }), sources: ['codex-plugin'] });
  const found = discover(home, t, ['codex-plugin']);
  const rooted = (name: string) => (service as unknown as { rootedInCredentials(d: unknown): boolean }).rootedInCredentials(found.find((d) => d.server.name === name)!);
  assert.equal(rooted('deployer@curated/local'), false, 'its own install folder, though .codex holds credentials');
  assert.equal(rooted('reacher@curated/files'), true, 'a link out of it into a credential place');
});

// Round 2 of the cross-family review: nothing starts before every check, literal fields are scanned as
// written, a blocked server's id says nothing, assembled names and paths are scanned, a changed launch
// ends a grant for good, and an install path inside a flag or file URL is its own folder.

/** One Codex plugin whose .mcp.json is written by the test, at a chosen marketplace and version. */
function onePlugin(servers: Record<string, unknown>, opts: { market?: string; version?: string; manifest?: Record<string, unknown>; extraVersion?: string } = {}) {
  const user = freshDir('codex-plugins-r2-');
  const market = opts.market ?? 'curated';
  const make = (version: string) => {
    const dir = join(user, '.codex', 'plugins', 'cache', market, 'p', version);
    mkdirSync(join(dir, '.codex-plugin'), { recursive: true });
    writeFileSync(join(dir, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'p', ...(opts.manifest ?? {}) }));
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: servers }));
    return dir;
  };
  const dir = make(opts.version ?? '1.0.0');
  if (opts.extraVersion) make(opts.extraVersion);
  writeFileSync(join(user, '.codex', 'config.toml'), `[plugins."p@${market}"]\nenabled = true\n`);
  const t = defaultToolEnv({ HOME: user, PATH: process.env.PATH });
  return { user, dir, t };
}

async function serviceFor(t: ReturnType<typeof defaultToolEnv>, sources: ('codex-plugin' | 'claude-plugin')[] = ['codex-plugin'], credentials: readonly string[] = [stored]) {
  const { ConnectorService } = await import('../src/connectors/service.ts');
  const { CoreLink } = await import('../src/composition/core.ts');
  const home = freshHome();
  const service = new ConnectorService({ home, env: () => t, link: async () => CoreLink.open({ home }), sources, credentials: async () => credentials });
  await service.ready();
  return { home, service };
}

test('listing a plugin server that reads a credential place, or moves its token cache, starts no process', async () => {
  const marker = join(freshDir('codex-plugins-marker-'), 'started');
  const { user, t } = onePlugin({
    reads: { command: 'sh', args: ['-c', `touch ${marker}`, '${PLUGIN_ROOT}/../../../../../../.ssh/id_ed25519'] },
    moves: { command: 'sh', args: ['-c', `touch ${marker}`], env: { WORKSPACE_MCP_CREDENTIALS_DIR: '/tmp/elsewhere' } },
  });
  mkdirSync(join(user, '.ssh'));
  writeFileSync(join(user, '.ssh', 'id_ed25519'), 'not a real key\n');
  const { service } = await serviceFor(t);
  for (const s of service.list().servers) {
    const r = await service.refresh(s.id);
    assert.equal(r.ok, false, 'refused before it starts');
  }
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(marker), false, 'no process was started');
});

test('a credential written as a variable reference in a name, a manifest or a value still blocks; a real reference does not', async () => {
  const ref = `\${${stored.replaceAll('-', '_')}}`;
  const creds = [stored.replaceAll('-', '_')];
  const blockedBy = async (servers: Record<string, unknown>, manifest?: Record<string, unknown>) => {
    const { t } = onePlugin(servers, { manifest });
    const { service } = await serviceFor(t, ['codex-plugin'], creds);
    return service.list().servers.map((s) => !!s.blocked);
  };
  assert.deepEqual(await blockedBy({ [ref]: { command: 'node', args: ['s.js'] } }), [true], 'in a server name');
  assert.deepEqual(await blockedBy({ s: { command: 'node', args: ['s.js'] } }, { description: ref }), [true], 'in a manifest');
  assert.deepEqual(await blockedBy({ s: { command: 'node', args: ['s.js', `--x=${ref}`] } }), [true], 'a reference named by a credential');
  assert.deepEqual(await blockedBy({ s: { command: 'node', args: ['s.js', '--api-key=${API_KEY}'], env: { TOKEN: '${TOKEN}' } } }), [false], 'a real reference');
});

test('a blocked Claude Code plugin server\'s id says nothing of its credential, and it can still be turned off by that id', async () => {
  const user = freshDir('claude-plugin-r2-');
  const dir = join(user, '.claude', 'plugins', 'cache', 'market', 'm', '1.0.0');
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { [stored]: { command: 'node', args: ['s.js'] }, fine: { command: 'node', args: ['s.js'] } } }));
  writeFileSync(join(user, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'm@market': true } }));
  writeFileSync(join(user, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'm@market': [{ scope: 'user', installPath: dir, version: '1.0.0' }] } }));
  const { service } = await serviceFor(defaultToolEnv({ HOME: user, PATH: process.env.PATH }), ['claude-plugin']);
  const view = service.list();
  assert.ok(!JSON.stringify(view).includes(stored), 'not in any id or field');
  const leaky = view.servers.find((s) => s.blocked)!;
  assert.ok(leaky);
  assert.equal(view.servers.find((s) => !s.blocked)?.id, 'claude-plugin:m@market/fine', 'an unblocked server keeps its id, so grants stay');
  const r = await service.set(leaky.id, { enabled: true });
  assert.equal(r.ok, false);
  assert.match(r.ok ? '' : r.detail ?? '', /credential/, 'found by its shown id, and refused for its credential');
});

test('a credential in a plugin\'s version folder or marketplace, which make its name and paths, blocks its servers', async () => {
  const byVersion = onePlugin({ s: { command: 'node', args: ['s.js'] } }, { version: stored, extraVersion: '1.0.0' });
  const v = (await serviceFor(byVersion.t)).service.list();
  assert.ok(!JSON.stringify(v).includes(stored));
  assert.equal(v.servers.filter((s) => s.blocked).length, 1, 'the server in the version named by a credential');
  const byMarket = onePlugin({ s: { command: 'node', args: ['s.js'] } }, { market: stored });
  const m = (await serviceFor(byMarket.t)).service.list();
  assert.ok(!JSON.stringify(m).includes(stored));
  assert.ok(m.servers.every((s) => s.blocked));
});

test('a plugin server whose launch changed loses its grant and door for good: the old launch back stays off', async () => {
  const { dir, t } = onePlugin({ s: { command: 'node', args: ['a.js'] } });
  const { home, service } = await serviceFor(t);
  const d = discover(home, t, ['codex-plugin'])[0];
  const listed = { name: 'lookup', description: 'Looks things up', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } };
  mkdirSync(join(home, 'connectors'), { recursive: true });
  writeFileSync(join(home, 'connectors', 'mcp.json'), JSON.stringify({ servers: { [d.server.id]: { enabled: true, egress: true, egressSeal: 'seal', fingerprint: d.server.fingerprint, listedAt: 'now', connection: { id: 'c', slug: 's' }, tools: { lookup: { enabled: true, definition: definitionOf(listed), listed } } } }, held: [] }));
  assert.equal(service.offered().length, 1);
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { s: { command: 'node', args: ['b.js'] } } }));
  await service.ready();
  assert.equal(service.list().servers[0].enabled, false);
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { s: { command: 'node', args: ['a.js'] } } }));
  await service.ready();
  assert.equal(service.list().servers[0].enabled, false, 'still off');
  assert.equal(service.offered().length, 0);
  const { readFileSync } = await import('node:fs');
  const choice = JSON.parse(readFileSync(join(home, 'connectors', 'mcp.json'), 'utf8')).servers[d.server.id];
  assert.equal(choice.enabled, false);
  assert.equal(choice.egress, undefined);
  assert.equal(choice.egressSeal, undefined);
});

test('an install path inside a --flag= or file:// argument is the plugin\'s own folder; anything leaving it is not', async () => {
  const { user, dir, t } = onePlugin({});
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: {
    flag: { command: 'node', args: ['${PLUGIN_ROOT}/s.js', '--root=${PLUGIN_ROOT}/data'] },
    url: { command: 'node', args: ['${PLUGIN_ROOT}/s.js', 'file://${PLUGIN_ROOT}/data'] },
    up: { command: 'node', args: ['${PLUGIN_ROOT}/s.js', '--root=${PLUGIN_ROOT}/../../../../../../.ssh'] },
    list: { command: 'node', args: ['${PLUGIN_ROOT}/s.js', `--root=\${PLUGIN_ROOT}/data,${join(user, '.ssh')}`] },
  } }));
  mkdirSync(join(dir, 'data'));
  mkdirSync(join(user, '.ssh'));
  const { home, service } = await serviceFor(t);
  const found = discover(home, t, ['codex-plugin']);
  const rooted = (name: string) => (service as unknown as { rootedInCredentials(d: unknown): boolean }).rootedInCredentials(found.find((d) => d.server.name === `p@curated/${name}`)!);
  assert.equal(rooted('flag'), false);
  assert.equal(rooted('url'), false);
  assert.equal(rooted('up'), true);
  assert.equal(rooted('list'), true);
});

// Round 3 (final): a plugin server never starts a process before the person enables it, a percent-encoded
// or variable-held credential path is refused, an unsafe or missing launch ends a grant for good, a blocked
// server's name leaks through no message or door, and an exact stored credential is matched as written.

test('List tools on a disabled plugin server starts nothing; enabling is consent to run it, then it may be listed', async () => {
  const marker = join(freshDir('codex-plugins-r3-marker-'), 'started');
  const { t } = onePlugin({ s: { command: 'sh', args: ['-c', `touch ${marker}`] } });
  const { service } = await serviceFor(t);
  const s = service.list().servers[0];
  assert.equal(s.plugin, true);
  const r = await service.refresh(s.id);
  assert.equal(r.ok, false);
  assert.match(r.ok ? '' : r.detail ?? '', /Enable/);
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(marker), false, 'no process was started');
  const on = await service.set(s.id, { enabled: true });
  assert.ok(on.ok, JSON.stringify(on));
  assert.equal(on.ok && on.value.enabled, true, 'enabled without listing first');
  assert.equal(existsSync(marker), false, 'enabling starts nothing either');
});

test('a percent-encoded escape in a file: or flag argument, or a credential path in a variable, is refused', async () => {
  const { user, dir, t } = onePlugin({});
  mkdirSync(join(user, '.ssh'));
  writeFileSync(join(user, '.ssh', 'id'), 'not a real key\n');
  mkdirSync(join(dir, 'data'));
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: {
    url: { command: 'node', args: ['${PLUGIN_ROOT}/s.js', 'file://${PLUGIN_ROOT}/%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/.ssh/id'] },
    flag: { command: 'node', args: ['${PLUGIN_ROOT}/s.js', `--root=\${PLUGIN_ROOT}/data%2c${join(user, '.ssh')}`] },
    env: { command: 'node', args: ['${PLUGIN_ROOT}/s.js'], env: { INPUT_FILE: join(user, '.ssh', 'id') } },
    envenc: { command: 'node', args: ['${PLUGIN_ROOT}/s.js'], env: { INPUT_FILE: `file://${user}/%2essh/id` } },
    fine: { command: 'node', args: ['${PLUGIN_ROOT}/s.js', '--root=${PLUGIN_ROOT}/data'], env: { DATA: '${PLUGIN_ROOT}/data' } },
  } }));
  const { home, service } = await serviceFor(t);
  const found = discover(home, t, ['codex-plugin']);
  const rooted = (name: string) => (service as unknown as { rootedInCredentials(d: unknown): boolean }).rootedInCredentials(found.find((d) => d.server.name === `p@curated/${name}`)!);
  assert.equal(rooted('url'), true, 'encoded .. in a file URL');
  assert.equal(rooted('flag'), true, 'an encoded comma joining a second path');
  assert.equal(rooted('env'), true, 'a credential path in a variable');
  assert.equal(rooted('envenc'), true, 'an encoded one in a variable');
  assert.equal(rooted('fine'), false, 'its own folder, in an argument and a variable');
  for (const name of ['url', 'flag', 'env', 'envenc']) {
    const id = found.find((d) => d.server.name === `p@curated/${name}`)!.server.id;
    assert.equal((await service.set(id, { enabled: true })).ok, false, `${name} cannot be enabled, so it never starts`);
  }
});

for (const [label, swap] of [
  ['an unsafe launch', (dir: string) => writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { s: { command: 'node', args: ['a.js', '--root', '${PLUGIN_ROOT}/../../../../../../.ssh'] } } }))],
  ['the server gone', (dir: string) => writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: {} }))],
] as const) {
  test(`a plugin grant seen with ${label} by offered() ends for good, its door too`, async () => {
    const { user, dir, t } = onePlugin({ s: { command: 'node', args: ['a.js'] } });
    mkdirSync(join(user, '.ssh'));
    const { home, service } = await serviceFor(t);
    const d = discover(home, t, ['codex-plugin'])[0];
    const listed = { name: 'lookup', description: 'Looks things up', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } };
    mkdirSync(join(home, 'connectors'), { recursive: true });
    writeFileSync(join(home, 'connectors', 'mcp.json'), JSON.stringify({ servers: { [d.server.id]: { enabled: true, egress: true, egressSeal: 'seal', fingerprint: d.server.fingerprint, listedAt: 'now', connection: { id: 'c', slug: 's' }, tools: { lookup: { enabled: true, definition: definitionOf(listed), listed } } } }, held: [] }));
    assert.equal(service.offered().length, 1);
    swap(dir);
    assert.equal(service.offered().length, 0);
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { s: { command: 'node', args: ['a.js'] } } }));
    await service.ready();
    assert.equal(service.offered().length, 0, 'the old launch back stays off');
    const { readFileSync } = await import('node:fs');
    const choice = JSON.parse(readFileSync(join(home, 'connectors', 'mcp.json'), 'utf8')).servers[d.server.id];
    assert.equal(choice.enabled, false);
    assert.equal(choice.egressSeal, undefined);
  });
}

test('a blocked server\'s name leaks through no refusal and no door, by either id', async () => {
  const user = freshDir('claude-plugin-r3-');
  const dir = join(user, '.claude', 'plugins', 'cache', 'market', 'm', '1.0.0');
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { [stored]: { command: 'node', args: ['s.js'] } } }));
  writeFileSync(join(user, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'm@market': true } }));
  writeFileSync(join(user, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'm@market': [{ scope: 'user', installPath: dir, version: '1.0.0' }] } }));
  const t = defaultToolEnv({ HOME: user, PATH: process.env.PATH });
  const { home, service } = await serviceFor(t, ['claude-plugin']);
  const raw = discover(home, t, ['claude-plugin'])[0].server.id;
  // A choice from before the name held a credential.
  mkdirSync(join(home, 'connectors'), { recursive: true });
  writeFileSync(join(home, 'connectors', 'mcp.json'), JSON.stringify({ servers: { [raw]: { enabled: false, fingerprint: 'x', listedAt: 'now', tools: {} } }, held: [] }));
  const shown = service.list().servers[0].id;
  for (const id of [shown, raw]) {
    for (const patch of [{ tool: { name: 'missing', enabled: false } }, { enabled: true }, { egress: true }, { tool: { name: 'missing', override: 'effect' as const } }]) {
      assert.ok(!JSON.stringify(await service.set(id, patch)).includes(stored), `set ${JSON.stringify(patch)}`);
    }
    assert.ok(!JSON.stringify(await service.refresh(id)).includes(stored));
    assert.equal(service.doorView(id), null, 'no door is shown for a blocked server');
  }
});

test('a stored credential that looks like a variable reference is matched as written', async () => {
  const literal = '${r2_synthetic_credential}';
  const { t } = onePlugin({ s: { command: 'node', args: ['s.js', literal] } });
  const { service } = await serviceFor(t, ['codex-plugin'], [literal]);
  const s = service.list().servers[0];
  assert.ok(s.blocked);
  assert.ok(!JSON.stringify(service.list()).includes(literal));
});
