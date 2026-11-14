import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONNECTOR_CATALOGUE, catalogueLaunch, catalogueClass } from '../src/connectors/catalogue.ts';
import { catalogueScopes } from '../src/api-catalogue.ts';
import { GOOGLE_REQUIREMENTS } from '../src/connectors/catalogue-google-lock.ts';

test('the catalogue pins local Google and GitHub servers and names Slack app configuration', () => {
  assert.deepEqual(CONNECTOR_CATALOGUE.map(entry => entry.id), ['calendar', 'drive', 'github', 'slack']);
  for (const id of ['calendar', 'drive'] as const) {
    // Replaces the version-only uvx mechanism under security review M3: the executable now
    // comes from an absolute venv installed from a complete, hash-checked wheel set.
    const launch = catalogueLaunch(id, '/owned/venv/bin/workspace-mcp');
    assert.equal(launch.command, '/owned/venv/bin/workspace-mcp');
    assert.ok(launch.args?.includes('--read-only'));
    assert.equal(CONNECTOR_CATALOGUE.find(entry => entry.id === id)?.licence, 'MIT');
  }
  assert.deepEqual(catalogueLaunch('github', '/owned/github-mcp-server').args, ['stdio', '--read-only']);
  for (const line of GOOGLE_REQUIREMENTS.trim().split('\n')) { assert.ok(line.includes('==')); assert.ok(line.includes('--hash=sha256:')); }
  assert.ok(GOOGLE_REQUIREMENTS.includes('workspace-mcp==2.4.1'));
  assert.ok(GOOGLE_REQUIREMENTS.includes('9bc1c0292e23c3be711f7136de4f695809642f940ed4ffa07a6191eecf0e0d8a'));
  assert.equal(CONNECTOR_CATALOGUE.find(entry => entry.id === 'github')?.version, '2.1.0');
  assert.equal(CONNECTOR_CATALOGUE.find(entry => entry.id === 'slack')?.configuration, 'needs a Slack app');
});

test('read scopes and local server modes cannot acquire effect scopes through the read preset', () => {
  assert.equal(catalogueScopes('github', 'reads'), 'read:user');
  assert.ok(!catalogueScopes('slack', 'reads').includes('chat:write'));
  assert.ok(catalogueScopes('slack', 'reads-and-effects').includes('chat:write'));
  for (const id of ['calendar', 'drive', 'github'] as const) {
    assert.ok(catalogueLaunch(id, '/owned/executable', 'reads').args!.includes('--read-only'));
    assert.ok(!catalogueLaunch(id, '/owned/executable', 'reads-and-effects').args!.includes('--read-only'));
  }
  assert.ok(catalogueScopes('drive', 'reads').includes('drive.readonly'));
  assert.ok(catalogueScopes('calendar', 'reads').includes('calendar.readonly'));
});

test('presets never lower effect hints, missing annotations, unknown tools or the name floor', () => {
  const read = { readOnlyHint: true, destructiveHint: false };
  assert.equal(catalogueClass('calendar', 'list_calendars', read), 'read');
  assert.equal(catalogueClass('drive', 'search_drive_files', read), 'read');
  assert.equal(catalogueClass('drive', 'get_drive_shareable_link', read), 'effect');
  assert.equal(catalogueClass('calendar', 'manage_event', read), 'effect');
  assert.equal(catalogueClass('drive', 'create_drive_file', read), 'effect');
  assert.equal(catalogueClass('calendar', 'list_calendars', {}), 'effect');
  assert.equal(catalogueClass('calendar', 'list_calendars', { ...read, destructiveHint: true }), 'effect');
  assert.equal(catalogueClass('calendar', 'new_unreviewed_tool', read), 'effect');
});
