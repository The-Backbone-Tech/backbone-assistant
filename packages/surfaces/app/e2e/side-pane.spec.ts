// A turn's document and its version diff open in a resizable side pane beside the conversation,
// and an answer's link to a workspace document opens it there. Real bridge, platform and controlled
// harness; the answers' links are added to the threads.get response, since the controlled harness
// writes none. Local paths outside the workspace stay text.
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { removeDataHome } from '@backbone-next/platform/composition';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { startScriptedModel } from '@backbone-next/platform/testing';
import { startBridge, stopBridge } from './bridge';
import { api, phase1Home, phase2ProjectAndAttach, phase3Brief, repoRoot } from './journey';

const LINKS = '\n\nOpen [the brief](brief.md), or compare [the passwords](/etc/passwd), [the hosts](file:///etc/hosts), [a neighbour](../outside.md), [another project](/srv/projects/other-project/brief.md) and [the site](https://example.com/brief).';
// As a real engine writes them: the project's own folder, absolute and as a file: address.
const ABSOLUTE = (folder: string) => `\n\nWritten to [the written brief](<${folder}/brief.md>) and [the brief file](${pathToFileURL(`${folder}/brief.md`).href}).`;

async function box(page: Page, testId: string) {
  const b = await page.getByTestId(testId).boundingBox();
  if (!b) throw new Error(`${testId} is not on screen`);
  return b;
}

test('a turn\'s version diff and an answer\'s workspace link open beside the conversation', async ({ page }, info) => {
  page.setDefaultTimeout(15_000);
  const home = freshDataHome('side-pane');
  const bridge = await startBridge(home);
  const evidence = join(repoRoot, 'evidence', 'app-side-pane-20261104', info.project.name);
  mkdirSync(evidence, { recursive: true });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let folder = '';
  try {
    await page.route('**/api', async (route) => {
      if (route.request().postDataJSON().method !== 'threads.get') return route.continue();
      const response = await route.fetch();
      const body = await response.json();
      for (const turn of body?.value?.turns ?? []) if (turn.answer) turn.answer.text += LINKS + (folder ? ABSOLUTE(folder) : '');
      await route.fulfill({ response, json: body });
    });
    await page.goto(bridge.url);
    await phase1Home(page);
    const projectId = await phase2ProjectAndAttach(page);
    // The test knows the folder from the data home; the app is never told it.
    const stored = JSON.parse(readFileSync(join(home, 'projects.json'), 'utf8')) as { id: string; dir: string }[];
    folder = join(home, 'projects', stored.find((p) => p.id === projectId)!.dir);
    await phase3Brief(page);
    const message = page.getByRole('textbox', { name: 'Message', exact: true });
    await message.fill('Write the brief again, without the attachments');
    await message.press('Enter');
    await expect(page.getByTestId('work-block')).toHaveCount(2);
    await expect(page.getByTestId('work-block').nth(1)).toHaveText(/Worked for \d+/);
    if (await page.getByTestId('pane').isVisible()) await page.getByRole('button', { name: 'Close pane' }).click();
    await expect(page.getByTestId('pane')).toBeHidden();

    // The diff of what the turn wrote opens beside the conversation, which stays in place.
    const transcript = page.getByRole('list', { name: 'Transcript' });
    const answer = page.getByTestId('answer').last();
    await answer.getByRole('button', { name: 'Changes in brief.md v2' }).click();
    const pane = page.getByTestId('pane');
    await expect(pane).toBeVisible();
    await expect(pane.getByRole('tab', { name: 'brief.md · v2 changes' })).toHaveAttribute('aria-selected', 'true');
    const diff = pane.getByTestId('version-changes');
    await expect(diff).toContainText('brief.md v2');
    await expect(diff).toContainText('against v1');
    await expect(diff).toContainText('(no attachments)');
    await expect(diff.getByRole('button', { name: 'Open v2' })).toBeVisible();
    await expect(transcript).toBeVisible();
    await expect(answer).toBeInViewport();
    const conversation = await transcript.boundingBox();
    const beside = await box(page, 'pane');
    expect(beside.x, 'the pane sits to the right of the conversation').toBeGreaterThanOrEqual(conversation!.x + conversation!.width);
    expect(beside.width).toBeGreaterThanOrEqual(360);
    await page.screenshot({ path: join(evidence, 'side-pane-diff.png') });

    // The pane is resizable, and the conversation keeps its room.
    const handle = page.getByRole('separator', { name: 'Resize conversation and workspace' });
    const h = (await handle.boundingBox())!;
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
    await page.mouse.down();
    await page.mouse.move(h.x - 180, h.y + h.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => (await box(page, 'pane')).width).toBeGreaterThan(beside.width + 120);
    await expect(transcript).toBeVisible();
    await page.screenshot({ path: join(evidence, 'side-pane-resized.png') });

    // An answer's link to a workspace document opens it in the pane, at the version the turn wrote.
    await expect(answer).not.toContainText('[blocked]');
    const brief = answer.getByRole('button', { name: 'the brief', exact: true });
    await expect(brief).toHaveAttribute('data-workspace-link', 'brief.md');
    await brief.click();
    await expect(pane.getByRole('tab', { name: 'brief.md · v2', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(pane.getByRole('tabpanel').filter({ visible: true })).toContainText('(no attachments)');
    await expect(transcript).toBeVisible();
    await page.screenshot({ path: join(evidence, 'side-pane-link.png') });

    // An absolute or file: link into this project's folder opens too: the platform resolved it.
    for (const name of ['the written brief', 'the brief file']) {
      await pane.getByRole('tab', { name: 'brief.md · v2 changes', exact: true }).click();
      const opener = answer.getByRole('button', { name, exact: true });
      await expect(opener).toHaveAttribute('data-workspace-link', 'brief.md');
      await opener.click();
      await expect(pane.getByRole('tab', { name: 'brief.md · v2', exact: true })).toHaveAttribute('aria-selected', 'true');
    }

    // Paths outside the workspace are text: nothing to click, nothing opens.
    const tabs = await pane.getByRole('tab').count();
    for (const name of ['the passwords', 'the hosts', 'a neighbour', 'another project']) {
      const text = answer.locator('[data-blocked-link]', { hasText: name });
      await expect(text).toHaveCount(1);
      await expect(answer.getByRole('button', { name, exact: true })).toHaveCount(0);
      await expect(answer.getByRole('link', { name, exact: true })).toHaveCount(0);
      await expect(text.locator('[href]')).toHaveCount(0);
      await text.click();
    }
    await expect(pane.getByRole('tab')).toHaveCount(tabs);
    // A web link keeps Streamdown's safe handling: it asks before anything leaves the app.
    const site = answer.locator('[data-streamdown=link]', { hasText: 'the site' });
    await expect(site).toHaveCount(1);
    await site.click();
    await expect(page.getByText('https://example.com/brief')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByText('https://example.com/brief')).toBeHidden();
    expect(errors).toEqual([]);
  } finally {
    await stopBridge(bridge.proc);
    await removeDataHome(home);
  }
});

test('a side chat answer opens only its own project\'s document, once that project\'s files arrive', async ({ page }, info) => {
  page.setDefaultTimeout(15_000);
  const home = freshDataHome('side-pane-projects');
  const model = await startScriptedModel();
  const bridge = await startBridge(home, { BACKBONE_HARNESS: 'harness-pi', BACKBONE_MODEL_ENDPOINT: model.url, BACKBONE_MODEL_ID: model.model });
  const evidence = join(repoRoot, 'evidence', 'app-side-pane-20261104', info.project.name);
  mkdirSync(evidence, { recursive: true });
  let held = '';
  let release = () => {};
  const filesArrive = new Promise<void>((resolve) => { release = resolve; });
  try {
    await page.route('**/api', async (route) => {
      const { method, args } = route.request().postDataJSON();
      if (method === 'files.list' && held && args.projectId === held) await filesArrive;
      if (method !== 'threads.get') return route.continue();
      const response = await route.fetch();
      const body = await response.json();
      for (const turn of body?.value?.sideTurns ?? []) if (turn.answer) turn.answer.text += '\n\nSee [the brief](brief.md).';
      await route.fulfill({ response, json: body });
    });
    await page.goto(bridge.url);
    await phase1Home(page);
    await phase2ProjectAndAttach(page);
    await phase3Brief(page);
    const sideChat = page.getByTestId('side-chat-tab');
    const openSideChat = () => page.keyboard.press(process.platform === 'darwin' ? 'Alt+Meta+S' : 'Control+Alt+S');
    const ask = async () => {
      await page.getByRole('textbox', { name: 'Ask the side chat' }).fill('Which files are here?');
      await page.getByRole('textbox', { name: 'Ask the side chat' }).press('Enter');
    };
    await openSideChat();
    await ask();
    await expect(sideChat.getByRole('button', { name: 'the brief', exact: true })).toHaveCount(1);

    // Project B also has a brief.md. Its files are held back while the pane stays mounted.
    const second = await phase2ProjectAndAttach(page, 'Second review');
    held = second;
    const message = page.getByRole('textbox', { name: 'Message', exact: true });
    await message.fill('Draft the second brief from these');
    await message.press('Enter');
    await expect(page.getByTestId('work-block').first()).toHaveText(/Worked for \d+/);
    await openSideChat();
    await expect(sideChat).toBeVisible();
    await ask();
    const link = sideChat.locator(':scope > ol > li').last();
    await expect(link.locator('[data-blocked-link]', { hasText: 'the brief' })).toHaveCount(1);
    await expect(link.getByRole('button', { name: 'the brief', exact: true })).toHaveCount(0);
    await page.screenshot({ path: join(evidence, 'side-chat-before-files.png') });

    // Once B's files arrive, the same link opens B's brief, never A's.
    release();
    const open = link.getByRole('button', { name: 'the brief', exact: true });
    await expect(open).toHaveCount(1);
    await open.click();
    const briefB = (await api<{ id: string; name: string }[]>(page, 'material.list', { projectId: second })).find((m) => m.name === 'brief.md')!;
    const pane = page.getByTestId('pane');
    await expect(pane.getByRole('tab', { selected: true })).toHaveText(/brief\.md/);
    await expect(pane.getByRole('tabpanel').filter({ visible: true })).toContainText('Request: Draft the second brief from these');
    await expect.poll(async () => (await api<{ pane: { active?: string } }>(page, 'viewer.get', {})).pane.active).toMatch(new RegExp(`^file:${briefB.id}(:v\\d+)?$`));
    await page.screenshot({ path: join(evidence, 'side-chat-second-project.png') });
  } finally {
    release();
    await stopBridge(bridge.proc);
    await removeDataHome(home);
    await model.close();
  }
});
