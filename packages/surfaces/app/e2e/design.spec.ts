// The rebuilt screens, driven as a person would, in Light and Dark at 1440 and 375 px: the sidebar
// and Needs you, Settings by section, the Files tree with folders and its keyboard, the filter and
// a file's menu, the viewer reading a markdown table and editing in CodeMirror, and the thread's
// calm work block. Screenshots go to the ignored evidence/design-pass/ folder.
// Cites R-UX-SIDEBAR-01, R-UX-THREAD-01, R-UX-PANES-01, R-FILES-OS-01, R-MODEL-02.
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { removeDataHome } from '@backbone-next/platform/composition';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { startBridge, stopBridge } from './bridge';
import { api, closePaneOnNarrow, closeSidebar, expectDocumentInfo, narrow, openSidebar, repoRoot } from './journey';

const TABLE = '# Q4 numbers\n\n| Region | Revenue | Change |\n| --- | ---: | ---: |\n| North | 120 | +4% |\n| South | 95 | −2% |\n\nThe **South** dip is seasonal.\n';

test('the rebuilt screens', async ({ page }, info) => {
  const home = freshDataHome('design');
  const dir = join(repoRoot, 'evidence', 'design-pass', info.project.name.replace(/^design-/, ''), new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(dir, { recursive: true });
  const shot = (name: string) => page.screenshot({ path: join(dir, `${name}.png`) });
  const bridge = await startBridge(home);
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  try {
    await page.goto(bridge.url);
    await expect(page.locator('[data-ready=true]')).toBeVisible();
    await shot('01-home');

    // The bell keeps occasional decisions within reach without taking a navigation row.
    await openSidebar(page);
    const sidebar = page.getByRole('navigation', { name: 'Projects and threads' });
    await expect(sidebar.getByRole('button', { name: /^(Now|Scheduled|Memory)$/ })).toHaveCount(0);
    const bell = page.getByRole('button', { name: 'Needs you', exact: true });
    await expect(bell).toHaveText('');
    await bell.click();
    await expect(page.getByTestId('needs-you')).toContainText('Nothing needs you');
    await shot('02-sidebar-needs-you');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: /^Your account/ })).toHaveCount(0);
    await sidebar.getByRole('button', { name: 'More', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: 'Now', exact: true })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Scheduled', exact: true })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Memory', exact: true })).toBeVisible();
    await shot('02-sidebar-more');
    await page.keyboard.press('Escape');

    // A folder project with nested files, made in the Terminal, and two attached files.
    await page.getByRole('button', { name: 'New project' }).click();
    await page.getByRole('textbox', { name: 'Name' }).fill('Harbor');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('navigation').getByRole('button', { name: 'Harbor' })).toBeVisible();
    await closeSidebar(page);
    await page.keyboard.press('Control+Backquote');
    await page.getByRole('textbox', { name: 'Terminal command' }).fill("mkdir -p notes/q4 && printf '# Plan\\n' > notes/q4/plan.md && printf 'todo\\n' > notes/todo.txt");
    await page.getByRole('textbox', { name: 'Terminal command' }).press('Enter');
    await expect(page.getByTestId('terminal-tab').locator('pre')).toHaveCount(1);
    await closePaneOnNarrow(page);
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Add files…' }).click();
    await (await chooser).setFiles([{ name: 'numbers.md', mimeType: 'text/markdown', buffer: Buffer.from(TABLE) }]);
    await expect(page.getByTestId('attachment-chip')).toHaveCount(1);
    await page.getByRole('textbox', { name: 'Message' }).fill('Write an editable brief from these');
    await page.getByRole('textbox', { name: 'Message' }).press('Enter');

    // The thread: one shared bar, on-demand details and a collapsed work block.
    const work = page.getByTestId('work-block').first();
    await expect(work).toHaveText(/Worked for \d+s · \d+ steps?/);
    await expect(work).toHaveAttribute('aria-expanded', 'false');
    await work.click();
    await page.getByRole('button', { name: 'Chat details', exact: true }).click();
    await expect(page.getByTestId('summary-card')).toContainText('Harbor');
    await page.keyboard.press('Escape');
    await closePaneOnNarrow(page);
    await shot('03-thread');

    // Files: a real tree, folders first, with the ARIA tree keyboard.
    if (narrow(page)) await page.getByRole('button', { name: 'Show side pane' }).click();
    await page.keyboard.press('ControlOrMeta+p');
    const tree = page.getByRole('tree', { name: 'Project files' });
    await expect(tree.getByRole('treeitem').first()).toHaveAccessibleName('notes');
    const notes = tree.getByRole('treeitem', { name: 'notes', exact: true });
    await notes.focus();
    await page.keyboard.press('ArrowRight');
    await expect(notes).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('ArrowDown');
    const q4 = tree.getByRole('treeitem', { name: 'q4', exact: true });
    await expect(q4).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(tree.getByRole('treeitem', { name: 'plan.md' })).toBeVisible();
    await page.keyboard.press('ArrowLeft');
    await expect(q4).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('ArrowLeft');
    await expect(notes).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowRight');
    await expect(q4).toHaveAttribute('aria-expanded', 'true');
    await shot('04-files-tree');

    await page.getByRole('searchbox', { name: 'Filter files' }).fill('PLAN');
    await expect(tree.getByRole('treeitem')).toHaveCount(1);
    await expect(tree.getByRole('treeitem')).toContainText('in notes/q4');
    await expect(tree.getByRole('treeitem')).toContainText('Unregistered');
    await expect(page.getByTestId('unregistered-files-help')).toHaveText('Unregistered: not given to the engine; attach to use it');
    await shot('05-files-filter');
    await page.getByRole('searchbox', { name: 'Filter files' }).fill('');

    const row = page.getByTestId('file-row').filter({ hasText: 'numbers.md' });
    await row.focus();
    await page.keyboard.press('Shift+F10');
    await expect(page.getByRole('menuitem', { name: 'Download' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: /Rename/ })).toHaveCount(0);
    await shot('06-file-menu');
    await page.keyboard.press('Escape');

    await page.getByRole('tab', { name: /Review/ }).click();
    await expect(page.getByRole('tabpanel', { name: /Review/ })).toContainText('brief.md');
    await expect(page.getByRole('tabpanel', { name: /Review/ })).not.toContainText('plan.md');
    await expect(page.getByRole('tabpanel', { name: /Review/ })).not.toContainText('todo.txt');
    await shot('07-files-review');
    await page.getByRole('tab', { name: 'Files', exact: true }).last().click();

    // The viewer: an original markdown table read through Streamdown.
    await row.click();
    await expect(page.getByTestId('reader').filter({ visible: true }).locator('table')).toBeVisible();
    await expect(page.getByTestId('reader').filter({ visible: true }).locator('th')).toHaveText(['Region', 'Revenue', 'Change']);
    await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeDisabled();
    await shot('08-viewer-read-table');

    // A working copy opens rendered; Edit opens CodeMirror; Full screen covers the window.
    await page.getByRole('tab', { name: /Files/ }).first().click();
    await page.getByTestId('file-row').filter({ hasText: 'brief.md' }).click();
    await expect(page.getByTestId('reader').filter({ visible: true }), 'a document opens rendered').toBeVisible();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const editor = page.getByRole('textbox', { name: 'Edit brief.md' });
    await expect(editor).toBeVisible();
    await editor.press('ControlOrMeta+End');
    await editor.pressSequentially('\nA line typed in CodeMirror.');
    await expect(page.getByTestId('edit-state').filter({ visible: true })).toHaveText('Unsaved edit');
    await shot('09-viewer-edit');
    await page.getByRole('button', { name: 'Read', exact: true }).click();
    await expect(page.getByTestId('reader').filter({ visible: true })).toContainText('A line typed in CodeMirror.');
    await page.getByRole('button', { name: 'Full screen', exact: true }).click();
    await shot('10-viewer-full-screen');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Full screen', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    // Discard drops the unsaved edit; typing again and ⌘S saves a new version.
    await page.getByRole('button', { name: 'Document options', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Discard unsaved edit', exact: true }).click();
    await expectDocumentInfo(page);
    await expect(editor).not.toContainText('A line typed in CodeMirror.');
    await editor.press('ControlOrMeta+End');
    await editor.pressSequentially('\nA line typed in CodeMirror.');
    await editor.press('ControlOrMeta+s');
    await expectDocumentInfo(page, 'v2 · saved by you');
    await closePaneOnNarrow(page);

    // Settings: only sections that work, search, the model route in its own section.
    await openSidebar(page);
    await page.getByRole('button', { name: 'Settings' }).click();
    const settings = page.getByRole('dialog', { name: 'Settings' });
    const sections = settings.getByRole('navigation', { name: 'Settings sections' });
    // Grouped by the decision (You, AI, Apps and tools, Team, This computer); keep the full navigation contract.
    await expect(sections.getByRole('button')).toHaveText(['General', 'AI and models', 'Helper roles', 'Connected tools', 'Tool permissions', 'Plugins', 'Assistants using this app', 'People and roles', 'Sharing', 'Heartbeat and brief', 'Backup', 'Telemetry', 'Licences and notices']);
    if (narrow(page)) await sections.getByRole('button', { name: 'General' }).click();
    await expect(settings.getByRole('radiogroup', { name: 'Appearance' })).toBeVisible();
    await shot('11-settings-general');
    if (narrow(page)) await settings.getByRole('button', { name: 'All settings' }).click();
    await page.route('**/api', async (route) => {
      const { method } = route.request().postDataJSON();
      if (method === 'connectors.list') await route.fulfill({ json: { egress: 'per-server', held: [{ effect: 'unknown-call', serverId: 'home:notes', serverName: 'Notes', tool: 'send_note', args: { body: 'Inspect this exact message.' }, argsHash: 'a'.repeat(64), statement: 'Call send_note with exactly this message.', at: '2026-11-10T10:00:00Z', state: 'unknown', detail: 'Its outcome is unknown. It is never sent again.', standing: true, standingSignatureId: '10000000-0000-4000-8000-000000000001', dispatchedAt: '2026-11-10T10:00:01Z', dispatchReceipt: { seq: '31', hash: 'b'.repeat(64) } }, { effect: 'waiting-call', serverId: 'home:notes', serverName: 'Notes', tool: 'send_note', args: { body: 'New words.' }, argsHash: 'c'.repeat(64), statement: 'Call send_note with the new words.', at: '2026-11-10T10:01:00Z', state: 'waiting', detail: 'An earlier call to this tool is still dispatching. This call waits for you.' }], servers: [{
        id: 'home:notes', name: 'Notes', source: 'Own config', transport: 'stdio', shown: 'notes-mcp', envNames: [],
        enabled: true, egress: false, listedAt: '2026-11-10T00:00:00Z', tools: [
          { name: 'search', description: 'Search the notes.', annotated: 'read', kind: 'read', enabled: false },
          { name: 'draft', description: 'Draft an unshared note.', annotated: 'effect', kind: 'effect', enabled: false },
        ],
      }] } });
      else await route.continue();
    });
    await sections.getByRole('button', { name: 'Connected tools', exact: true }).click();
    await expect(settings).toContainText('Turning on a server or tool is confirmed in the desktop app.');
    await expect(settings.getByRole('button', { name: 'Turn on its tools', exact: true })).toBeVisible();
    await expect(settings.getByTestId('connector-call-unknown-call')).toContainText('Permission: 10000000-0000-4000-8000-000000000001');
    await expect(settings.getByTestId('connector-call-waiting-call').getByText('Waiting', { exact: true })).toBeVisible();
    await expect(settings.getByRole('button', { name: 'Resolve outcome' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    await shot('11-settings-connected-tools');
    await page.unroute('**/api');
    if (narrow(page)) await settings.getByRole('button', { name: 'All settings' }).click();
    await sections.getByRole('button', { name: 'Tool permissions', exact: true }).click();
    await expect(settings.getByText('No active permissions.', { exact: true })).toBeVisible();
    const signedView = settings.getByRole('combobox', { name: 'How much runs without asking' });
    await expect(signedView).toHaveValue('full');
    await expect(signedView.locator('option[value=balanced]')).toBeDisabled();
    await expect(signedView.locator('option[value=strict]')).toBeDisabled();
    await expect(settings).toContainText('Full and Custom apply the same rules today. Custom only shows the per-tool choices.');
    await shot('11-settings-signed-tools');
    if (narrow(page)) await settings.getByRole('button', { name: 'All settings' }).click();
    const priorConnection = await api(page, 'settings.model.get', {});
    let failSettingsRead = true;
    let settingsWriteStarted = false;
    let releaseSettingsWrite = () => {};
    const heldSettingsWrite = new Promise<void>((resolve) => { releaseSettingsWrite = resolve; });
    await page.route('**/api', async (route) => {
      const request = route.request().postDataJSON();
      if (request.method === 'settings.model.get' && failSettingsRead) {
        await route.fulfill({ status: 503, json: { error: 'Controlled settings-read failure' } });
      } else if (request.method === 'settings.model.put') {
        settingsWriteStarted = true;
        await heldSettingsWrite;
        await route.fulfill({ json: { ok: false, reason: 'NOT_AVAILABLE', detail: 'This controlled test refuses the connection.', outcome: 'REFUSED' } });
      } else await route.continue();
    });
    try {
      await sections.getByRole('button', { name: 'AI and models' }).click();
      await expect(settings.getByRole('alert')).toHaveText('Couldn’t load the model settings.');
      failSettingsRead = false;
      await settings.getByRole('button', { name: 'Try again', exact: true }).click();
      await expect(settings.getByTestId('model-active')).toContainText('Model');
      await expect(settings.getByRole('form', { name: 'Or a gateway' })).toBeHidden();
      await settings.getByText('Change your model', { exact: true }).click();
      await expect(settings.getByRole('form', { name: 'Or a gateway' })).toBeVisible();
      const own = settings.getByRole('form', { name: 'Your own key', exact: true });
      const key = own.getByLabel('Your own key: key', { exact: true });
      await key.fill('synthetic-ui-test-key');
      await own.getByRole('button', { name: 'Save', exact: true }).click();
      await expect.poll(() => settingsWriteStarted).toBe(true);
      await expect(own).toHaveAttribute('aria-busy', 'true');
      await expect(key).toBeDisabled();
      await expect(key).toHaveValue('');
      await expect(own.getByRole('button', { name: 'Saving…', exact: true })).toBeDisabled();
      releaseSettingsWrite();
      await expect(own.getByRole('alert')).toHaveText('This controlled test refuses the connection.');
      await expect(own).toHaveAttribute('aria-busy', 'false');
      await expect(key).toBeEnabled();
      await expect(key).toHaveValue('');
      expect(await api(page, 'settings.model.get', {})).toEqual(priorConnection);
    } finally {
      releaseSettingsWrite();
      await page.unrouteAll({ behavior: 'wait' });
    }
    await shot('12-settings-model-route');
    if (narrow(page)) await settings.getByRole('button', { name: 'All settings' }).click();
    await settings.getByRole('searchbox', { name: 'Search settings' }).fill('openrouter');
    await expect(sections.getByRole('button')).toHaveText(['AI and models']);
    await sections.getByRole('button', { name: 'AI and models' }).click();
    await shot('13-settings-search');
    await settings.getByRole('button', { name: 'Done' }).click();
  } finally {
    await stopBridge(bridge.proc);
    await removeDataHome(home);
  }
});

test('Settings explains each fixed policy setting even when the model read fails', async ({ page }) => {
  const home = freshDataHome('managed-policy-design');
  const bridge = await startBridge(home);
  try {
    await page.route('**/api', async route => {
      const request = route.request().postDataJSON() as { method?: string };
      if (request.method === 'settings.policy.get') return route.fulfill({ json: { state: 'verified', id: 'design-policy', version: 3, fixed: ['harnesses', 'auditContent'], descriptions: { harnesses: 'the engines a person may choose', auditContent: 'whether audit exports may include content' }, warnings: [] } });
      if (request.method === 'settings.model.get') return route.fulfill({ status: 503, json: { error: 'Controlled model read refusal' } });
      return route.fallback();
    });
    await page.goto(bridge.url);
    await expect(page.locator('[data-ready=true]')).toBeVisible();
    await openSidebar(page);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await settings.getByRole('button', { name: 'AI and models', exact: true }).click();
    await expect(settings.getByTestId('managed-policy')).toContainText('Managed policy design-policy, version 3');
    await expect(settings.getByTestId('managed-policy')).toContainText('harnesses: the engines a person may choose; fixed by policy; cannot be changed here.');
    await expect(settings.getByTestId('managed-policy')).toContainText('auditContent: whether audit exports may include content; fixed by policy; cannot be changed here.');
    await expect(settings.getByRole('alert')).toContainText('Couldn’t load the model settings.');
  } finally { await stopBridge(bridge.proc); await removeDataHome(home); }
});
