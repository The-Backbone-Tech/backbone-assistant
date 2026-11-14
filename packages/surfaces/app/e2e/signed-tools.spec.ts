// 10 November 2026: show real Core signature identities and label drained local end queues truthfully; stored desktop ending no longer requires discovery.
// Actual renderer, bridge and Host; the previously signed fixture uses no real account or provider.
import { expect, test } from '@playwright/test';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { removeDataHome } from '@backbone-next/platform/composition';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { seedSignedHome } from '../test/fixtures/signed-home';
import { startBridge, stopBridge } from './bridge';
import { openSidebar } from './journey';

test('Signed tools lists a Host signature and ends it with one click', async ({ page }) => {
  const home = freshDataHome('signed-tools');
  const person = mkdtempSync(join(tmpdir(), 'signed-tools-person-'));
  const seeded = await seedSignedHome(home);
  const bridge = await startBridge(home, { BACKBONE_USER_HOME: person, HOME: person });
  try {
    await page.goto(bridge.url);
    await expect(page.locator('[data-ready=true]')).toBeVisible();
    await openSidebar(page);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await settings.getByRole('button', { name: 'Tool permissions', exact: true }).click();
    const viewChoice = settings.getByRole('combobox', { name: 'How much runs without asking' });
    await expect(viewChoice).toHaveValue('full');
    await expect(viewChoice.locator('option[value=balanced]')).toBeDisabled();
    await expect(viewChoice.locator('option[value=strict]')).toBeDisabled();
    await viewChoice.selectOption('custom');
    await expect(settings.getByRole('combobox', { name: 'Permission for draft_note on notes' })).toHaveValue('acts');
    await expect(settings).toContainText('Full and Custom apply the same rules today. Custom only shows the per-tool choices.');
    const removed = await page.request.put(`${bridge.url}/api/signature-posture`, { data: { posture: 'full' } });
    expect(removed.status()).toBe(404);
    const signature = settings.getByRole('article', { name: 'draft_note on notes' });
    await expect(signature).toContainText('Acts without asking');
    await expect(signature).toContainText('Draft a note, not yet shared.');
    const at = seeded.servers[0].tools.find(t => t.name === 'draft_note')!.standing!.at;
    await expect(signature.locator('time')).toHaveAttribute('datetime', at);
    await expect(signature.locator('time')).toHaveText(await page.evaluate(at => new Date(at).toLocaleString(), at));
    let releases = 0;
    page.on('request', (request) => { if (request.url().endsWith('/api') && /connectors.decide/.test(request.postData() ?? '')) releases++; });
    const end = signature.getByRole('button', { name: 'End permission' });
    let mode: 'refused' | 'lost' | 'send' = 'refused';
    let endRequests = 0;
    await page.route('**/api', async (route) => {
      const request = route.request().postDataJSON();
      if (request.method !== 'connectors.set' || request.args.tool?.standing !== false) return route.continue();
      endRequests++;
      // Ask the REAL Host for a prohibited door-open with this end. It refuses before
      // changing anything. Only the request is fault-injected; no receipt is fabricated.
      if (mode === 'refused') return route.continue({ postData: JSON.stringify({ ...request, args: { ...request.args, egress: true } }) });
      if (mode === 'lost') return route.abort();
      return route.continue();
    });
    await end.click();
    await expect(settings.getByRole('alert')).toContainText('Only the person allows sending');
    await expect(signature).toContainText('Acts without asking');
    await expect(signature).not.toContainText('Ended locally.');
    mode = 'lost';
    await end.click();
    await expect(settings.getByRole('alert')).toContainText('The end request could not be confirmed.');
    await expect(signature).not.toContainText('Ended locally.');
    await settings.getByRole('button', { name: 'Reload tool permissions' }).click();
    await expect(signature).toContainText('Acts without asking');
    mode = 'send';
    await end.click();
    await expect(signature).toContainText('Ended locally. No pending Core end remains in the local record.');
    await expect(settings).toContainText('No active permissions.');
    await expect(signature.getByRole('button', { name: 'End permission' })).toHaveCount(0);
    const result = await page.request.post(`${bridge.url}/api`, { data: { method: 'connectors.list', args: {} } });
    expect((await result.json()).servers.find((s: any) => s.id === 'home:notes').tools.find((t: any) => t.name === 'draft_note').standing).toBeUndefined();
    expect(releases).toBe(0);
    expect(endRequests).toBe(3);
    await page.reload();
    await expect(page.locator('[data-ready=true]')).toBeVisible();
    await openSidebar(page);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await settings.getByRole('button', { name: 'Tool permissions', exact: true }).click();
    await expect(viewChoice).toHaveValue('custom');
    await expect(settings).toContainText('No active permissions.');
    await expect(settings.getByRole('combobox', { name: 'Permission for draft_note on notes' })).toHaveValue('asks');
  } finally { await stopBridge(bridge.proc); await removeDataHome(home); rmSync(person, { recursive: true, force: true }); }
});


test('a desktop-shaped transport needs no settings handlers for the renderer view choice', async ({ page }) => {
  const home = freshDataHome('signed-tools-desktop-boundary');
  const person = mkdtempSync(join(tmpdir(), 'signed-tools-person-'));
  await seedSignedHome(home);
  const bridge = await startBridge(home, { BACKBONE_USER_HOME: person, HOME: person });
  try {
    // Controlled desktop-shaped transport over the real Host; this does not claim native IPC coverage.
    await page.addInitScript(() => {
      Object.assign(window, { backbone: { platform: 'linux', setTheme() {},
        async endConnectorSignature(serverId: string, tool: string): Promise<unknown> { return this.call('connectors.set', { serverId, tool: { name: tool, standing: false } }); },
        async call(method: string, args: unknown) {
          const response = await fetch('/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, args }) });
          const value = await response.json();
          if (!response.ok) throw new Error(value.error);
          return value;
        },
        onEvent(listener: (event: unknown) => void) {
          const source = new EventSource('/api/events');
          source.onmessage = (event) => listener(JSON.parse(event.data));
          return () => source.close();
        },
      } });
    });
    await page.goto(bridge.url);
    await expect(page.locator('[data-ready=true]')).toBeVisible();
    await openSidebar(page);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await settings.getByRole('button', { name: 'Tool permissions', exact: true }).click();
    const choice = settings.getByRole('combobox', { name: 'How much runs without asking' });
    await expect(choice).toBeEnabled();
    await choice.selectOption('custom');
    await expect(settings.getByRole('combobox', { name: 'Permission for draft_note on notes' })).toHaveValue('acts');
    await expect(settings.getByRole('article', { name: 'draft_note on notes' })).toContainText('Acts without asking');
  } finally { await stopBridge(bridge.proc); await removeDataHome(home); rmSync(person, { recursive: true, force: true }); }
});

// Contract coverage for the reserved listing hunk. These response additions do not
// claim to implement the ledger owner's pending/conflict fields in connectors.list.
test('Core pause and the three ending states are distinct; missing fields remain unavailable', async ({ page }) => {
  const home = freshDataHome('signed-tools-listing-contract');
  const person = mkdtempSync(join(tmpdir(), 'signed-tools-person-'));
  const seeded = await seedSignedHome(home);
  const bridge = await startBridge(home, { BACKBONE_USER_HOME: person, HOME: person });
  let state: 'pending' | 'conflict' | 'ended' | 'unavailable' = 'pending';
  let paused = true;
  let resigned = false;
  let withheld = false;
  let listingFailure = false;
  try {
    await page.addInitScript(() => {
      const listeners = new Set<(event: { topic: string }) => void>();
      Object.assign(window, { notifyConnectors: () => listeners.forEach(f => f({ topic: 'connectors' })),
        backbone: { platform: 'linux', setTheme() {},
          async endConnectorSignature(serverId: string, tool: string): Promise<unknown> { return this.call('connectors.set', { serverId, tool: { name: tool, standing: false } }); },
        async call(method: string, args: unknown) {
            const response = await fetch('/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, args }) });
            const value = await response.json();
            if (!response.ok) throw new Error(value.error);
            return value;
          },
          onEvent(listener: (event: { topic: string }) => void) { listeners.add(listener); return () => listeners.delete(listener); },
        },
      });
    });
    await page.route('**/api', async route => {
      const request = route.request().postDataJSON();
      if (request.method === 'core.signatureStatus') return route.fulfill({ json: { step: 'connector-signature-ledger-v1', state: paused ? 'paused' : 'verified' } });
      if (request.method !== 'connectors.list') return route.continue();
      if (listingFailure) return route.fulfill({ status: 503, json: { error: 'Listing unavailable' } });
      const response = await route.fetch();
      const listing = resigned ? structuredClone(seeded) : await response.json();
      for (const server of listing.servers) for (const tool of server.tools) {
        if (tool.standing) tool.standing.id = resigned ? 'later-signature' : seeded.signatureId;
      }
      if (state === 'unavailable') delete listing.signatureEndings;
      if (state !== 'unavailable') listing.signatureEndings = {
        pending: state === 'pending' ? [seeded.signatureId] : [],
        conflicts: state === 'conflict' ? [seeded.signatureId] : [],
      };
      if (withheld) listing.servers = listing.servers.map((server: { id: string }) => ({ ...server,
        id: 'claude-plugin:withheld-current', name: 'Withheld', shown: 'Withheld', blocked: 'Plugin contains a credential.', tools: [] }));
      return route.fulfill({ response, json: listing });
    });
    await page.goto(bridge.url);
    await expect(page.locator('[data-ready=true]')).toBeVisible();
    await openSidebar(page);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await settings.getByRole('button', { name: 'Tool permissions', exact: true }).click();
    const row = settings.getByRole('article', { name: 'draft_note on notes' });
    await expect(row).toContainText('Paused');
    await expect(row).not.toContainText('Acts without asking');
    paused = false;
    await page.evaluate(() => (window as unknown as { notifyConnectors(): void }).notifyConnectors());
    await expect(row).toContainText('Acts without asking');
    await row.getByRole('button', { name: 'End permission' }).click();
    await expect(row).toContainText('Ending pending in Core');
    state = 'conflict';
    await page.evaluate(() => (window as unknown as { notifyConnectors(): void }).notifyConnectors());
    await expect(row).toContainText('Conflict');
    await expect(row).toContainText('no Core end is claimed');
    state = 'ended';
    await page.evaluate(() => (window as unknown as { notifyConnectors(): void }).notifyConnectors());
    await expect(row).toContainText('No pending Core end remains in the local record.');
    state = 'unavailable';
    await page.evaluate(() => (window as unknown as { notifyConnectors(): void }).notifyConnectors());
    await expect(row).toContainText('Core confirmation: Not available yet.');
    await expect(row).toContainText('checked again just before sending');
    // A later listing is authoritative even if signing times happen to coincide.
    resigned = true;
    await page.evaluate(() => (window as unknown as { notifyConnectors(): void }).notifyConnectors());
    const rows = settings.getByRole('article', { name: 'draft_note on notes' });
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ has: page.getByRole('button', { name: 'End permission' }) })).toContainText('Acts without asking');
    await expect(rows.filter({ hasText: 'Core confirmation: Not available yet.' })).toHaveCount(1);
    listingFailure = true;
    await page.evaluate(() => (window as unknown as { notifyConnectors(): void }).notifyConnectors());
    await expect(settings.getByRole('alert')).toContainText('Tool permissions could not be loaded');
    await expect(settings.getByRole('article')).toHaveCount(0);
    listingFailure = false;
    await page.evaluate(() => (window as unknown as { notifyConnectors(): void }).notifyConnectors());
    await expect(rows).toHaveCount(2);
    withheld = true;
    await page.evaluate(() => (window as unknown as { notifyConnectors(): void }).notifyConnectors());
    await expect(settings.getByRole('article')).toHaveCount(0);
    listingFailure = true;
    await page.evaluate(() => (window as unknown as { notifyConnectors(): void }).notifyConnectors());
    await expect(settings.getByRole('alert')).toContainText('Tool permissions could not be loaded');
    await expect(settings.getByRole('article')).toHaveCount(0);
  } finally { await stopBridge(bridge.proc); await removeDataHome(home); rmSync(person, { recursive: true, force: true }); }
});

test('a real Host Core-end failure keeps the row and its exact fixed diagnostic', async ({ page }) => {
  const home = freshDataHome('signed-tools-core-end-failure');
  const person = mkdtempSync(join(tmpdir(), 'signed-tools-person-'));
  await seedSignedHome(home);
  const injection = pathToFileURL(join(import.meta.dirname, '../test/fixtures/fail-signature-end.ts')).href;
  const bridge = await startBridge(home, { BACKBONE_USER_HOME: person, HOME: person,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${injection}` });
  const diagnostic = 'The signature end could not be confirmed. Local authority stays closed and its receipt will be retried. Run backbone doctor.';
  try {
    await page.goto(bridge.url);
    await expect(page.locator('[data-ready=true]')).toBeVisible();
    await openSidebar(page);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await settings.getByRole('button', { name: 'Tool permissions', exact: true }).click();
    const row = settings.getByRole('article', { name: 'draft_note on notes' });
    await row.getByRole('button', { name: 'End permission' }).click();
    await expect(settings.getByRole('alert')).toHaveText(`${diagnostic} Reload tool permissions`);
    await expect(settings).not.toContainText('PRIVATE_TEST_BACKEND_CONTEXT');
    await expect(row).toContainText('End not confirmed');
    await expect(row).not.toContainText('Ended locally.');
    await expect(row.getByRole('button', { name: 'End again' })).toBeEnabled();
    // The real service has removed authority despite its failed Core acknowledgement.
    const response = await page.request.post(`${bridge.url}/api`, { data: { method: 'connectors.list', args: {} } });
    const listing = await response.json();
    expect(listing.servers[0].tools.find((t: { name: string }) => t.name === 'draft_note').standing).toBeUndefined();
    await settings.getByRole('button', { name: 'Reload tool permissions' }).click();
    await expect(row).toContainText('End not confirmed');
    await expect(row).not.toContainText('Acts without asking');
    await row.getByRole('button', { name: 'Check permission status' }).click();
    await expect(row).toContainText('End not confirmed');
    await row.getByRole('button', { name: 'End again' }).click();
    await expect(row).toContainText('Ended locally. No pending Core end remains in the local record.');
    await expect(row).not.toContainText('End not confirmed');
    const record = JSON.parse(readFileSync(join(home, 'connectors', 'mcp.json'), 'utf8'));
    expect(record.pendingEnds).toBeUndefined();
    expect(record.servers['home:notes'].tools.draft_note.standing).toBeUndefined();
  } finally { await stopBridge(bridge.proc); await removeDataHome(home); rmSync(person, { recursive: true, force: true }); }
});

test('a blocked plugin lists no tools in Signed tools, Custom or Connected tools', async ({ page }) => {
  const home = freshDataHome('signed-tools-blocked');
  const person = mkdtempSync(join(tmpdir(), 'signed-tools-person-'));
  await seedSignedHome(home);
  const dir = join(person, '.claude', 'plugins', 'cache', 'market', 'blocked', '1.0.0');
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  const fakeToken = `sk-proj-${'synthetic'.repeat(10)}`;
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { hidden_tool_server: { command: 'node', args: ['must-not-run', fakeToken] } } }));
  writeFileSync(join(person, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'blocked@market': true } }));
  writeFileSync(join(person, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2,
    plugins: { 'blocked@market': [{ scope: 'user', installPath: dir, version: '1.0.0' }] } }));
  const bridge = await startBridge(home, { BACKBONE_USER_HOME: person, HOME: person });
  try {
    await page.goto(bridge.url);
    await expect(page.locator('[data-ready=true]')).toBeVisible();
    const response = await page.request.post(`${bridge.url}/api`, { data: { method: 'connectors.list', args: {} } });
    const listing = await response.json();
    const blocked = listing.servers.find((s: { blocked?: string }) => s.blocked);
    expect(blocked).toBeDefined();
    expect(blocked.tools).toEqual([]);
    expect(blocked.problem).toBeUndefined();
    expect(JSON.stringify(listing)).not.toContain(fakeToken);
    await openSidebar(page);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await settings.getByRole('button', { name: 'Tool permissions', exact: true }).click();
    await expect(settings.getByRole('article')).toHaveCount(1);
    await settings.getByRole('combobox', { name: 'How much runs without asking' }).selectOption('custom');
    await expect(settings.getByRole('combobox', { name: /^Permission for / })).toHaveCount(1);
    await expect(settings).not.toContainText('hidden_tool_server');
    if (await settings.getByRole('button', { name: 'All settings' }).isVisible()) await settings.getByRole('button', { name: 'All settings' }).click();
    await settings.getByRole('button', { name: 'Connected tools', exact: true }).click();
    const server = settings.getByTestId(`connector-${blocked.id}`);
    await expect(server).toContainText('Blocked');
    await expect(server.getByRole('button', { name: /List tools|Enable to list/ })).toBeDisabled();
    await expect(server.getByRole('combobox')).toHaveCount(0);
    await expect(settings).not.toContainText(fakeToken);
  } finally { await stopBridge(bridge.proc); await removeDataHome(home); rmSync(person, { recursive: true, force: true }); }
});

// A real Host refusal supplies the diagnostic; only the later blocked listing is
// substituted to exercise the renderer's response to a changed disclosure boundary.
test('a newly blocked listing clears both end and Custom diagnostics', async ({ page }) => {
  const home = freshDataHome('signed-tools-blocked-diagnostics');
  const person = mkdtempSync(join(tmpdir(), 'signed-tools-person-'));
  await seedSignedHome(home);
  const bridge = await startBridge(home, { BACKBONE_USER_HOME: person, HOME: person });
  let blocked = false;
  try {
    await page.route('**/api', async route => {
      const request = route.request().postDataJSON();
      if (request.method === 'connectors.set' && request.args.tool?.standing === false)
        return route.continue({ postData: JSON.stringify({ ...request,
          args: { ...request.args, tool: { ...request.args.tool, name: 'old-hidden-tool-name' } } }) });
      if (request.method !== 'connectors.list' || !blocked) return route.continue();
      const response = await route.fetch();
      const listing = await response.json();
      listing.servers = listing.servers.map((server: { id: string }) => ({ ...server,
        id: 'claude-plugin:withheld-current', name: 'Withheld', shown: 'Withheld',
        blocked: 'Plugin contains a credential.', tools: [], problem: undefined }));
      return route.fulfill({ response, json: listing });
    });
    await page.goto(bridge.url);
    await expect(page.locator('[data-ready=true]')).toBeVisible();
    await openSidebar(page);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await settings.getByRole('button', { name: 'Tool permissions', exact: true }).click();
    await settings.getByRole('combobox', { name: 'How much runs without asking' }).selectOption('custom');
    await settings.getByRole('article').getByRole('button', { name: 'End permission' }).click();
    await expect(settings.getByRole('alert')).toContainText('old-hidden-tool-name');
    await settings.getByRole('combobox', { name: 'Permission for draft_note on notes' }).selectOption('asks');
    await expect(settings.getByRole('status').filter({ hasText: 'old-hidden-tool-name' })).toBeVisible();
    blocked = true;
    // A normal connector event reload, rather than the explicit error-clearing button.
    await page.request.post(`${bridge.url}/api`, { data: { method: 'connectors.set',
      args: { serverId: 'home:notes', tool: { name: 'plain', enabled: false } } } });
    await expect(settings.getByRole('article')).toHaveCount(0);
    await expect(settings.getByRole('alert')).toHaveCount(0);
    await expect(settings).not.toContainText('old-hidden-tool-name');
    await expect(settings.getByRole('combobox', { name: /^Permission for / })).toHaveCount(0);
  } finally { await stopBridge(bridge.proc); await removeDataHome(home); rmSync(person, { recursive: true, force: true }); }
});
