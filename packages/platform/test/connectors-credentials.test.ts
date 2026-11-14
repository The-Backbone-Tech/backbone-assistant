// A connector call never reaches a place that holds credentials: an MCP server runs with the
// person's rights, outside the engine's sandbox. Synthetic folders only; nothing real is read.
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { movesCredentialCache, reachesCredentials } from '../src/connectors/credential-args.ts';
import { inCredentialPlace } from '../src/memory/safe-read.ts';
import { freshDir } from './helpers.ts';

/** The home as a person writes it in a path. */
const TILDE = '~';

test('an argument naming a credential place is caught however it is written', () => {
  const home = freshDir('cred-args-home-');
  mkdirSync(join(home, '.google_workspace_mcp', 'credentials'), { recursive: true });
  const elsewhere = freshDir('cred-args-link-');
  symlinkSync(join(home, '.google_workspace_mcp'), join(elsewhere, 'innocent'));
  const moved = freshDir('cred-args-moved-');
  const env = { HOME: home, MCP_REMOTE_CONFIG_DIR: moved };
  const caught = [
    { path: join(home, '.google_workspace_mcp', 'credentials', 'me.json') },
    { path: `${TILDE}/.ssh/id_ed25519` },
    { uri: `file://${home}/.mcp-auth/tokens.json` },
    { path: `${home}/%2Egoogle_workspace_mcp/x` },
    { path: join(home, '.GOOGLE_WORKSPACE_MCP', 'x') },
    { path: '../../.aws/credentials' },
    { command: `cat ${home}/.netrc` },
    { path: join(elsewhere, 'innocent', 'credentials', 'me.json') },
    { path: join(moved, 'tokens.json') },
    { nested: [{ deeper: { path: `${TILDE}/.codex/auth.json` } }] },
  ];
  for (const args of caught) assert.equal(reachesCredentials(args, home, env), true, JSON.stringify(args));
  let deep: Record<string, unknown> = { path: 'notes.md' };
  for (let i = 0; i < 40; i++) deep = { deep };
  assert.equal(reachesCredentials(deep, home, env), true, 'nested past what a call needs fails closed');
  const serverFolder = freshDir('cred-args-cwd-');
  symlinkSync(join(home, '.google_workspace_mcp'), join(serverFolder, 'plain'));
  assert.equal(reachesCredentials({ path: 'plain/credentials/me.json' }, home, env, serverFolder), true, 'a relative alias in the server\'s folder');
  assert.equal(reachesCredentials({ path: 'notes/today.md' }, home, env, serverFolder), false);
  assert.equal(reachesCredentials({ path: 'notes/today.md' }, home, env), true, 'no known folder: a relative path fails closed');
  assert.equal(reachesCredentials({ query: 'invoices' }, home, env), false);
  for (const args of [{ path: join(home, 'Documents', 'notes.md') }, { query: 'invoices from March' }, { to: 'a@example.com', body: 'Hello' }, {}]) {
    assert.equal(reachesCredentials(args, home, env), false, JSON.stringify(args));
  }
});

test('a cache moved by its variable is a credential place to the safe reader, and its server is not used', () => {
  const home = freshDir('cred-moved-home-');
  const moved = freshDir('cred-moved-');
  assert.equal(inCredentialPlace(join(moved, 'notes.md'), home, undefined, { WORKSPACE_MCP_CREDENTIALS_DIR: moved }), true);
  assert.equal(inCredentialPlace(join(moved, 'notes.md'), home, undefined, {}), false);
  assert.equal(movesCredentialCache({ transport: 'stdio', command: 'uvx', env: { GOOGLE_MCP_CREDENTIALS_DIR: moved } }), true);
  assert.equal(movesCredentialCache({ transport: 'stdio', command: 'uvx', env: { GOOGLE_CLIENT_SECRET_PATH: '/x' } }), false);
  assert.equal(movesCredentialCache({ transport: 'stdio', command: 'uvx', env: { HOME: moved } }), true, 'its own home moves its default cache');
  assert.equal(movesCredentialCache({ transport: 'stdio', command: 'uvx', env: { XDG_CONFIG_HOME: moved } }), true);
});
