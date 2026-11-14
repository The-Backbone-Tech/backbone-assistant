import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { McpSession } from '../src/connectors/client.ts';
import { join } from 'node:path';
import { test } from 'node:test';
import { ConnectorService, type ConnectorCore } from '../src/connectors/service.ts';
import { CoreLink } from '../src/composition/core.ts';
import { CatalogueStore } from '../src/connectors/catalogue-store.ts';
import { createHost, hostClosed } from '../src/composition/host.ts';
import { connectorPerson } from '../src/composition/connector-person.ts';
import { CredentialStore } from '../src/credentials/store.ts';
import { Vault } from '../src/keys/vault.ts';
import { catalogueRecords } from '../src/connectors/catalogue-records.ts';
import { googleTokens, googleCache, removeGoogleCache } from '../src/connectors/catalogue-revocation.ts';
import { plaintextKeys } from '../src/keys/vault.ts';
import { defaultToolEnv } from '../src/tools/places.ts';
import { freshDir, freshHome, value } from './helpers.ts';
import type { CatalogueId } from '../src/api-catalogue.ts';
import { catalogueServerId } from '../src/connectors/catalogue.ts';
import { discover, ownServers } from '../src/connectors/discover.ts';

const APP_SECRET = 'fixture-app-secret-only', TOKEN = 'fixture-access-token-only';
async function world(keys = true, unknownRevocation = false) {
  const home = freshHome(), person = freshDir('catalogue-person-'), state = join(person, 'authorized'), log = join(person, 'calls.jsonl');
  let exchanges = 0, requestedScopes = ''; const revoked: { path: string; body: string }[] = [];
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/token') { exchanges++; for await (const _chunk of req) { /* consume the owned request */ }
      res.end(JSON.stringify({ access_token: TOKEN, token_type: 'bearer', expires_in: 3600, scope: requestedScopes })); return; }
    if (req.url === '/google-authorize') { writeFileSync(state, 'authorized'); res.end('{}'); return; }
    if (req.url?.startsWith('/revoke/')) {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      revoked.push({ path: req.url, body: Buffer.concat(chunks).toString() });
      if (req.url === '/revoke/github') {
        assert.equal(req.method, 'DELETE'); assert.equal(req.headers.authorization, `Basic ${Buffer.from(`fixture-app:${APP_SECRET}`).toString('base64')}`);
        assert.equal(JSON.parse(revoked.at(-1)!.body).access_token, TOKEN);
      } else {
        assert.equal(req.method, 'POST');
        if (req.url === '/revoke/slack') assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
      }
      if (unknownRevocation) { req.socket.destroy(); return; }
      if (req.url === '/revoke/github') res.writeHead(204).end(); else res.end(JSON.stringify({ ok: true, revoked: true }));
      return;
    }
    if (req.url !== '/mcp') { res.writeHead(404).end('{}'); return; }
    assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
    if (req.method !== 'POST') { res.writeHead(req.method === 'DELETE' ? 204 : 405).end(); return; }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const rpc = JSON.parse(Buffer.concat(chunks).toString());
    if (rpc.id === undefined) { res.writeHead(202).end(); return; }
    const result = rpc.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fake-slack', version: '1' } }
      : rpc.method === 'tools/list' ? { tools: [{ name: 'slack_search_messages', description: 'Fixture search', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }, { name: 'slack_send_message', description: 'Fixture send', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } }] }
      : { content: [{ type: 'text', text: 'fixture response' }] };
    res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  let link: CoreLink | undefined;
  const service = new ConnectorService({ home, env: () => defaultToolEnv({ HOME: person, PATH: process.env.PATH }), sources: ['home'], keys: keys ? plaintextKeys() : undefined,
    link: async () => link ??= await CoreLink.open({ home }), callTimeoutMs: 3000,
    catalogueRuntime: { googleAuthorizationOrigin: origin, revocation: { google: `${origin}/revoke/google`, github: `${origin}/revoke/github`, slack: `${origin}/revoke/slack` }, oauth: Object.fromEntries(['github', 'slack'].map(id => [id, { issuer: origin, authorization: `${origin}/authorize`, token: `${origin}/token`, scope: 'fixture.read fixture.write' }])),
      launch: async (id, preset) => id === 'slack' ? { transport: 'http', url: `${origin}/mcp` } : { transport: 'stdio', command: process.execPath, args: [join(import.meta.dirname, 'fake-catalogue-server.ts')], env: { CATALOGUE_FAKE_ID: id, CATALOGUE_FAKE_PRESET: preset, CATALOGUE_FAKE_AUTH_STATE: state, CATALOGUE_FAKE_LOG: log, CATALOGUE_FAKE_AUTH_URL: `${origin}/google-authorize` } },
    },
  });
  const native = connectorPerson({ connectors: service, owner: Promise.resolve(), core: Promise.resolve(), unavailable: () => undefined, enter: () => () => {} }).connectorCatalogue;
  const open = async (url: string) => {
    const auth = new URL(url);
    if (auth.pathname === '/google-authorize') { await fetch(url); return; }
    requestedScopes = auth.searchParams.get('scope')!;
    const callback = new URL(auth.searchParams.get('redirect_uri')!);
    callback.searchParams.set('state', auth.searchParams.get('state')!); callback.searchParams.set('code', 'fixture-code');
    assert.equal((await fetch(callback)).status, 200);
  };
  return { home, service, native, log, person, open, revoked, exchanges: () => exchanges,
    app: { clientId: 'fixture-app', clientSecret: APP_SECRET, email: 'fixture@example.test' },
    close: async () => { await service.close(); await link?.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

test('a person connects all four catalogue entries with fake OAuth, chooses tools and disconnects without losing other config', async () => {
  const w = await world();
  try {
    mkdirSync(join(w.home, 'connectors'), { recursive: true });
    writeFileSync(ownServers(w.home), JSON.stringify({ userSetting: 'preserve', mcpServers: { personal: { command: 'personal-server' } } }));
    for (const id of ['calendar', 'drive', 'github', 'slack'] as CatalogueId[]) {
      const connected = value(await w.native.connect(id, w.app, w.open, 'reads-and-effects'));
      assert.equal(connected.state, id === 'calendar' || id === 'drive' ? 'awaiting-google' : 'ready');
      assert.ok(!w.service.list().servers.find(s => s.id === connected.serverId)!.enabled);
      value(await w.native.finish(id));
      const question = value(await w.native.question(id));
      const active = value(await w.native.activate(id, 'reads-and-effects', question.stamp));
      assert.equal(active.enabled, true); assert.equal(active.egress, false);
      assert.ok(active.tools.filter(t => t.kind === 'effect').every(t => !t.standing));
      assert.ok(w.service.offered().some(t => t.serverId === active.id && t.kind === 'read'));
      if (id === 'drive') assert.equal(active.tools.find(t => t.name === 'create_drive_file')!.kind, 'effect');
      const shown = JSON.stringify(w.service.list());
      assert.ok(!shown.includes(TOKEN) && !shown.includes(APP_SECRET));
      const disconnected = value(await w.native.disconnect(id));
      if (id === 'github' || id === 'slack') assert.equal(disconnected.revocation, 'revoked');
      assert.ok(!w.service.offered().some(t => t.serverId === active.id));
      assert.ok(!w.service.list().servers.some(t => t.id === active.id));
    }
    const config = JSON.parse(readFileSync(ownServers(w.home), 'utf8'));
    assert.equal(config.userSetting, 'preserve'); assert.deepEqual(config.mcpServers, { personal: { command: 'personal-server' } });
    assert.equal(w.exchanges(), 2);
    assert.equal(readdirSync(join(w.home, 'credentials')).filter(name => name.startsWith('cred_')).length, 0);
  } finally { await w.close(); }
});

test('reads preset keeps effects off and a changed live definition invalidates a pending native choice', async () => {
  const w = await world();
  try {
    value(await w.native.connect('drive', w.app, w.open)); value(await w.native.finish('drive'));
    const old = value(await w.native.question('drive'));
    await w.service.refresh(catalogueServerId('drive'));
    // Refresh alone preserves the definitions; an explicit choice revision must invalidate the stamp.
    await w.service.set(catalogueServerId('drive'), { tool: { name: 'search_drive_files', override: 'effect' } });
    assert.equal((await w.native.activate('drive', 'reads', old.stamp)).ok, false);
    const question = value(await w.native.question('drive'));
    const active = value(await w.native.activate('drive', 'reads', question.stamp));
    assert.ok(active.tools.filter(t => t.kind === 'effect').every(t => !t.enabled));
    assert.equal(active.tools.find(t => t.name === 'search_drive_files')!.kind, 'effect', 'a preset preserves a person narrowing');
    assert.equal(active.tools.find(t => t.name === 'new_unreviewed_tool')!.enabled, false);
    const raw = readFileSync(ownServers(w.home), 'utf8');
    assert.ok(!raw.includes(APP_SECRET) && !raw.includes(TOKEN));
    const launch = discover(w.home, defaultToolEnv({ HOME: w.person }), ['home'])[0].launch;
    value(await w.native.disconnect('drive'));
    await assert.rejects(w.service.catalogue.store.resolve(launch));
  } finally { await w.close(); }
});

test('missing Host keys fail closed before OAuth, config writes or launching a server', async () => {
  const w = await world(false);
  try {
    let opened = 0;
    assert.equal((await w.native.connect('github', w.app, async () => { opened++; })).ok, false);
    assert.equal(opened, 0); assert.equal(w.exchanges(), 0); assert.equal(existsSync(ownServers(w.home)), false);
  } finally { await w.close(); }
});

test('disconnect preserves comments and a person-edited launch while revoking its credentials', async () => {
  const w = await world();
  try {
    mkdirSync(join(w.home, 'connectors'), { recursive: true });
    writeFileSync(ownServers(w.home), '{\n  // A person keeps this comment.\n  "mcpServers": {}\n}\n');
    value(await w.native.connect('drive', w.app, w.open));
    const original = readFileSync(ownServers(w.home), 'utf8');
    assert.ok(original.includes('// A person keeps this comment.'));
    const changed = original.replace('"transport": "stdio"', '"personNote": "keep my edit", "transport": "stdio"');
    writeFileSync(ownServers(w.home), changed);
    const result = value(await w.native.disconnect('drive'));
    assert.equal(result.configurationKept, true);
    assert.equal(readFileSync(ownServers(w.home), 'utf8'), changed);
    assert.ok(w.service.list().servers.every(server => !server.enabled));
    assert.equal(readdirSync(join(w.home, 'credentials')).filter(name => name.startsWith('cred_')).length, 0);
  } finally { await w.close(); }
});

test('every catalogue native entry refuses closing before inspecting arguments or services', async () => {
  let touched = 0;
  const fail = () => { touched++; throw new Error('A closed native entry touched a dependency.'); };
  const blocked = { get then() { return fail(); } } as unknown as Promise<unknown>;
  const person = connectorPerson({ connectors: new Proxy({} as ConnectorService, { get: fail }), owner: blocked, core: blocked, unavailable: () => 'Closed', enter: fail }).connectorCatalogue;
  for (const run of [() => person.connect('github', new Proxy({} as never, { get: fail }), fail), () => person.finish('github'), () => person.question('github'), () => person.activate('github', 'reads', 'stamp'), () => person.disconnect('github')]) {
    assert.deepEqual(await run(), { ok: false, reason: 'NOT_AVAILABLE', outcome: 'REFUSED', detail: 'Closed' });
  }
  assert.equal(touched, 0);
});

test('catalogue effects keep exact release receipts and an unknown signed effect is never resent', async () => {
  const w = await world();
  try {
    value(await w.native.connect('drive', w.app, w.open, 'reads-and-effects')); value(await w.native.finish('drive'));
    const question = value(await w.native.question('drive'));
    const active = value(await w.native.activate('drive', 'reads-and-effects', question.stamp));
    const offered = (tool: string) => w.service.offered().find(t => t.serverId === active.id && t.tool === tool)!;
    const signal = new AbortController().signal;
    const core = new Proxy({} as ConnectorCore, { get() { throw new Error('An effect entered the read port.'); } });
    const first = await w.service.call(offered('create_drive_file'), { name: 'fixture-file' }, core, { threadId: 'catalogue-thread', turnId: 'catalogue-turn', seq: 1 }, signal);
    assert.equal(first.outcome, 'HELD');
    assert.ok(!readFileSync(w.log, 'utf8').includes('create_drive_file'));
    value(await w.service.set(active.id, { egress: true, seal: w.service.doorSeal(active.id)! }));
    const held = w.service.list().held.find(call => call.tool === 'create_drive_file')!;
    assert.equal(value(await w.service.decide(held.effect, held.argsHash, 'release')).state, 'sent');
    const view = w.service.toolView(active.id, 'update_drive_file')!;
    value(await w.service.set(active.id, { seal: view.seal, tool: { name: 'update_drive_file', standing: { stamp: view.stamp } } }));
    const origin = { threadId: 'catalogue-thread', turnId: 'unknown-catalogue-turn', seq: 2 };
    const unknown = await w.service.call(offered('update_drive_file'), { id: 'fixture-file' }, core, origin, signal);
    assert.equal(unknown.outcome, 'SENT'); if (unknown.outcome === 'SENT') assert.equal(unknown.state, 'unknown');
    await w.service.call(offered('update_drive_file'), { id: 'fixture-file' }, core, origin, signal);
    const calls = readFileSync(w.log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { name: string });
    assert.equal(calls.filter(call => call.name === 'create_drive_file').length, 1);
    assert.equal(calls.filter(call => call.name === 'update_drive_file').length, 1);
    const receipt = w.service.list().held.find(call => call.tool === 'update_drive_file')!;
    assert.equal(receipt.state, 'unknown'); assert.ok(receipt.standingSignatureId); assert.ok(receipt.dispatchedAt); assert.ok(receipt.dispatchReceipt?.hash);
  } finally { await w.close(); }
});

test('Google installations have owner-only separate caches, revoke refresh tokens and remove only their own cache', async () => {
  const w = await world();
  try {
    for (const id of ['calendar', 'drive'] as const) value(await w.native.connect(id, w.app, w.open));
    const launches = discover(w.home, defaultToolEnv({ HOME: w.person }), ['home']);
    const calendar = launches.find(d => d.launch.catalogue?.id === 'calendar')!.launch.env!.WORKSPACE_MCP_CREDENTIALS_DIR;
    const drive = launches.find(d => d.launch.catalogue?.id === 'drive')!.launch.env!.WORKSPACE_MCP_CREDENTIALS_DIR;
    assert.notEqual(calendar, drive); assert.equal(statSync(calendar).mode & 0o777, 0o700); assert.equal(statSync(drive).mode & 0o777, 0o700);
    assert.equal(statSync(join(drive, 'fixture.json')).mode & 0o777, 0o600);
    assert.ok(readFileSync(join(drive, 'fixture.json'), 'utf8').includes('fixture-google-refresh'));
    assert.equal(value(await w.native.disconnect('drive')).revocation, 'revoked');
    assert.equal(existsSync(drive), false); assert.equal(existsSync(calendar), true);
    assert.deepEqual(w.revoked.map(request => [request.path, new URLSearchParams(request.body).get('token')]), [['/revoke/google', 'fixture-google-refresh']]);
    value(await w.native.disconnect('calendar'));
  } finally { await w.close(); }
});

test('lost provider revocation stays UNKNOWN while Google secrets and local authority are removed', async () => {
  const w = await world(true, true);
  try {
    value(await w.native.connect('drive', w.app, w.open));
    const launch = discover(w.home, defaultToolEnv({ HOME: w.person }), ['home'])[0].launch;
    const result = value(await w.native.disconnect('drive'));
    assert.equal(result.revocation, 'unknown'); assert.equal(w.revoked.length, 1);
    assert.equal(existsSync(launch.env!.WORKSPACE_MCP_CREDENTIALS_DIR), false);
    await assert.rejects(w.service.catalogue.store.resolve(launch));
    const record = JSON.parse(readFileSync(join(w.home, 'connectors', 'catalogue-installs.json'), 'utf8'));
    assert.equal(record.receipts.at(-1).revocation, 'unknown'); assert.deepEqual(record.installs, {});
    assert.ok(!JSON.stringify(record).includes('fixture-google-refresh'));
  } finally { await w.close(); }
});

test('disconnect stops a cached server and revokes its credentials after its config entry is deleted', async () => {
  const w = await world();
  try {
    value(await w.native.connect('drive', w.app, w.open));
    const before = readFileSync(w.log, 'utf8').split('fixture-closed').length;
    writeFileSync(ownServers(w.home), '{"mcpServers":{}}');
    assert.equal(value(await w.native.disconnect('drive')).revocation, 'revoked');
    assert.ok(readFileSync(w.log, 'utf8').split('fixture-closed').length > before);
    assert.equal(readdirSync(join(w.home, 'credentials')).filter(name => name.startsWith('cred_')).length, 0);
  } finally { await w.close(); }
});

test('the sealed executable pin cannot be removed from config and changed binaries receive no credentials', async () => {
  const w = await world();
  const executable = join(w.person, 'fixture-executable'); writeFileSync(executable, 'fixture executable', { mode: 0o700 });
  w.service.catalogue.store.runtime.launch = async () => ({ transport: 'stdio', command: executable, args: [] });
  try {
    await w.service.catalogue.store.install('github', w.app, w.open);
    const launch = discover(w.home, defaultToolEnv({ HOME: w.person }), ['home'])[0].launch;
    const unpinned = { ...launch, catalogue: { ...launch.catalogue!, binaryDigest: undefined } };
    await assert.rejects(w.service.catalogue.store.resolve(unpinned), /integrity/);
    writeFileSync(executable, 'replaced executable');
    await assert.rejects(w.service.catalogue.store.resolve(launch), /executable changed/);
    await assert.rejects(McpSession.open({ ...launch, executableDigest: launch.catalogue!.binaryDigest }), /executable changed before start/);
  } finally { await w.close(); }
});

test('an OAuth token is revoked if a later install step fails', async () => {
  const w = await world();
  w.service.catalogue.store.runtime.launch = async () => { throw new Error('Fixture installation failure'); };
  try {
    assert.equal((await w.native.connect('github', w.app, w.open)).ok, false);
    assert.equal(w.exchanges(), 1); assert.equal(w.revoked.length, 1); assert.equal(w.revoked[0].path, '/revoke/github');
    assert.ok(!existsSync(ownServers(w.home)));
    const records = JSON.parse(readFileSync(join(w.home, 'connectors', 'catalogue-installs.json'), 'utf8'));
    assert.equal(records.receipts.at(-1).revocation, 'revoked'); assert.equal(records.receipts.at(-1).reason, 'install-failed');
  } finally { await w.close(); }
});

test('a provider token broader than the requested read scopes is refused and revoked', async () => {
  const w = await world();
  try {
    const result = await w.native.connect('github', w.app, async url => {
      const altered = new URL(url); altered.searchParams.set('scope', 'repo read:user');
      await w.open(altered.toString());
    }, 'reads');
    assert.equal(result.ok, false); assert.equal(w.exchanges(), 1); assert.equal(w.revoked.length, 1);
    assert.equal(existsSync(ownServers(w.home)), false);
  } finally { await w.close(); }
});

test('disconnect cleans its private installation even when public connector JSON is malformed', async () => {
  const w = await world();
  try {
    value(await w.native.connect('drive', w.app, w.open));
    const before = readFileSync(w.log, 'utf8').split('fixture-closed').length;
    writeFileSync(ownServers(w.home), '{ person unfinished edit');
    const result = value(await w.native.disconnect('drive'));
    assert.equal(result.revocation, 'revoked'); assert.equal(result.configurationKept, true);
    assert.equal(readFileSync(ownServers(w.home), 'utf8'), '{ person unfinished edit');
    assert.ok(readFileSync(w.log, 'utf8').split('fixture-closed').length > before);
    assert.equal(readdirSync(join(w.home, 'credentials')).filter(name => name.startsWith('cred_')).length, 0);
  } finally { await w.close(); }
});


test('disconnect rejects traversal and mismatched provider entries in the private index', async () => {
  const w = await world();
  try {
    value(await w.native.connect('drive', w.app, w.open));
    const file = join(w.home, 'connectors', 'catalogue-installs.json');
    const records = JSON.parse(readFileSync(file, 'utf8'));
    const original = records.installs.drive;
    // Existing, owned directories outside the installation must never become token sources.
    const foreign = join(w.home, 'shared-credentials'); mkdirSync(foreign);
    writeFileSync(join(foreign, 'token.json'), JSON.stringify({ refresh_token: 'fixture-unrelated-refresh' }));
    for (const operation of [googleTokens, googleCache, removeGoogleCache]) assert.throws(() => operation(w.home, '../../shared-credentials'), /installation/);
    writeFileSync(ownServers(w.home), '{"mcpServers":{}}');
    for (const bad of [{ ...original, instance: '../../shared-credentials' }, { ...original, id: 'calendar' }]) {
      records.installs.drive = bad; writeFileSync(file, JSON.stringify(records));
      assert.equal(catalogueRecords(w.home).installs.drive, undefined);
      assert.equal(value(await w.native.disconnect('drive')).revocation, 'not-needed');
      assert.equal(w.revoked.length, 0); assert.ok(existsSync(join(foreign, 'token.json')));
    }
  } finally { await w.close(); }
});

test('disconnect never deletes a foreign vault handle from either the index or public config', async () => {
  const w = await world();
  try {
    value(await w.native.connect('drive', w.app, w.open));
    const file = join(w.home, 'connectors', 'catalogue-installs.json');
    const records = JSON.parse(readFileSync(file, 'utf8'));
    const config = JSON.parse(readFileSync(ownServers(w.home), 'utf8'));
    const vault = await Vault.open(w.home, plaintextKeys());
    const credentials = new CredentialStore(w.home, () => vault.masterKey());
    for (const foreignValue of ['fixture-unrelated-model-key', JSON.stringify({ id: 'calendar', instance: records.installs.drive.instance, app: {} })]) {
      const handle = await credentials.put(foreignValue, 'unrelated-credential');
      for (const source of ['index', 'config']) {
        const envelope = { ...records.installs.drive, handle };
        writeFileSync(file, JSON.stringify({ installs: source === 'index' ? { drive: envelope } : {}, receipts: [] }));
        config.mcpServers['catalogue-drive'].backboneCatalogue = envelope;
        writeFileSync(ownServers(w.home), JSON.stringify(config));
        assert.equal((await w.native.disconnect('drive')).ok, false);
        assert.equal(await credentials.resolve(handle), foreignValue);
        assert.equal(w.revoked.length, 0);
        assert.ok(existsSync(config.mcpServers['catalogue-drive'].env.WORKSPACE_MCP_CREDENTIALS_DIR));
      }
    }
  } finally { await w.close(); }
});

test('Google finish refuses and revokes broader or unconfirmed cached token scopes', async () => {
  for (const scopes of [['https://www.googleapis.com/auth/drive'], undefined]) {
    const w = await world();
    try {
      value(await w.native.connect('drive', w.app, w.open));
      const launch = discover(w.home, defaultToolEnv({ HOME: w.person }), ['home'])[0].launch;
      const cache = launch.env!.WORKSPACE_MCP_CREDENTIALS_DIR;
      const file = join(cache, 'fixture.json'), data = JSON.parse(readFileSync(file, 'utf8'));
      writeFileSync(file, JSON.stringify({ ...data, scopes }));
      assert.equal((await w.native.finish('drive')).ok, false);
      assert.equal(w.revoked.length, 1); assert.equal(w.revoked[0].path, '/revoke/google');
      assert.equal(existsSync(cache), false);
      assert.equal(w.service.offered().length, 0);
    } finally { await w.close(); }
  }
});

test('disconnect removes only the Google installation venv after stopping its server', async () => {
  const w = await world();
  try {
    for (const id of ['calendar', 'drive'] as const) value(await w.native.connect(id, w.app, w.open));
    const records = catalogueRecords(w.home);
    const drive = join(w.home, 'connectors', 'bin', `google-${records.installs.drive!.instance}`);
    const calendar = join(w.home, 'connectors', 'bin', `google-${records.installs.calendar!.instance}`);
    for (const root of [drive, calendar]) { mkdirSync(join(root, 'venv'), { recursive: true }); writeFileSync(join(root, 'requirements.txt'), 'fixture'); }
    value(await w.native.disconnect('drive'));
    assert.equal(existsSync(drive), false); assert.equal(existsSync(calendar), true);
    value(await w.native.disconnect('calendar')); assert.equal(existsSync(calendar), false);
  } finally { await w.close(); }
});


test('disconnect cannot borrow a genuine sealed bundle from another provider or installation', async () => {
  const w = await world();
  try {
    for (const id of ['calendar', 'drive'] as const) value(await w.native.connect(id, w.app, w.open));
    const file = join(w.home, 'connectors', 'catalogue-installs.json');
    const records = JSON.parse(readFileSync(file, 'utf8'));
    const original = records.installs.drive;
    writeFileSync(ownServers(w.home), '{"mcpServers":{}}');
    for (const envelope of [{ ...original, handle: records.installs.calendar.handle }, { ...original, instance: records.installs.calendar.instance }]) {
      records.installs.drive = envelope; writeFileSync(file, JSON.stringify(records));
      assert.equal((await w.native.disconnect('drive')).ok, false);
      assert.equal(w.revoked.length, 0);
      for (const instance of [original.instance, records.installs.calendar.instance]) assert.ok(existsSync(join(w.home, 'connectors', 'google', instance)));
      for (const handle of [original.handle, records.installs.calendar.handle]) assert.ok(existsSync(join(w.home, 'credentials', `${handle}.json`)));
    }
  } finally { await w.close(); }
});


test('the real Host passes its key provider so native catalogue disconnect can unseal its installation', async () => {
  const home = freshHome(), person = freshDir('catalogue-host-person-'), keys = plaintextKeys();
  // Stage an empty Google setup cache: disconnect needs the Host keys but no provider request.
  const store = new CatalogueStore(home, keys, { launch: async () => ({ transport: 'stdio', command: process.execPath, args: ['-e', 'process.exit(0)'] }) });
  const envelope = await store.install('drive', { clientId: 'fixture-host-app', clientSecret: APP_SECRET, email: 'fixture@example.test' }, async () => { throw new Error('No OAuth is needed to stage this cache.'); });
  const host = createHost({ home, keys, harness: 'harness-stub', connectors: { sources: ['home'], env: defaultToolEnv({ HOME: person, PATH: process.env.PATH }) } });
  try {
    const disconnected = value(await host.connectorCatalogue.disconnect('drive'));
    assert.equal(disconnected.revocation, 'not-needed');
    assert.equal(existsSync(join(home, 'credentials', `${envelope.handle}.json`)), false);
    assert.deepEqual(catalogueRecords(home).installs, {});
    assert.equal(existsSync(join(home, 'connectors', 'google', envelope.instance)), false);
  } finally { host.close(); await hostClosed(home); store.close(); }
});
