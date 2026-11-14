import { TEST_HANG_MS } from '../../../../scripts/lib/test-hang.ts';
// Assertion deadlines detect hangs; Playwright retains the pending locator/property and last value.
// The mail triage journey on the built Electron app, through what a person sees and does: connect
// the sample mailbox (reads only), sign the capability in main's own window with Touch ID, watch the
// job run on Pi and the scripted model, read the brief, open a draft in the viewer, and discard a
// proposal. The renderer cannot sign: signing is not a method of the transport it reaches. Native
// dialogs and Touch ID are answered from the test, in main. No network and no key.
import { removeDataHome } from '@backbone-next/platform/composition';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { startScriptedModel, type ScriptedModel } from '@backbone-next/platform/testing';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appDir, repoRoot } from './journey';
import { waitForSampleInbox } from './triage-progress';

const installed = process.env.BACKBONE_APP_EXECUTABLE;
const evidence = join(repoRoot, 'evidence', installed ? 'triage-installed' : 'triage');
let app: ElectronApplication | undefined;
let model: ScriptedModel | undefined;
let home = '';

test.afterAll(async () => {
  // A person's quit, not a window close: on macOS closing the window keeps the app and its work running.
  await app?.evaluate(({ app: electronApp }) => { electronApp.quit(); }).catch(() => undefined);
  if (home) await expect.poll(() => execSync(`ps -eo command | grep -F "${home}" | grep -v grep || true`).toString(), { timeout: TEST_HANG_MS }).toBe('');
  await model?.close();
  if (home) await removeDataHome(home);
});

interface Asked {
  message: string;
  detail?: string;
  buttons: string[];
}

/** Answer main's native dialogs and Touch ID from the test, recording what main showed. */
async function answer(electronApp: ElectronApplication, dialogs: number[], touchId: boolean) {
  await electronApp.evaluate(({ dialog, systemPreferences }, [queue, ok]) => {
    const g = globalThis as unknown as { asked: Asked[]; answers: number[]; touched: number };
    g.asked = [];
    g.answers = queue as number[];
    g.touched = 0;
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const o = (args.length > 1 ? args[1] : args[0]) as Asked;
      g.asked.push({ message: o.message, detail: o.detail, buttons: o.buttons });
      return { response: g.answers.shift() ?? o.buttons.length - 1, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
    systemPreferences.canPromptTouchID = () => true;
    systemPreferences.promptTouchID = async () => {
      g.touched++;
      if (!ok) throw new Error('Touch ID was cancelled');
    };
  }, [dialogs, touchId] as const);
}
const shown = (electronApp: ElectronApplication) => electronApp.evaluate(() => globalThis as unknown as { asked: Asked[]; touched: number });

test('connect the sample mailbox, sign the capability in main with Touch ID, read the brief, open a draft, discard a proposal', async ({}, testInfo) => {
  // Forty-seven serial model/receipt workflows have no throughput promise on a shared machine.
  test.setTimeout(TEST_HANG_MS * 4);
  if (process.platform !== 'darwin') {
    const reason = 'macOS-only presence signing: Touch ID / Authorization Services; no Linux presence backend exists (electron/sign-capability.ts).';
    console.log(`Skipped: ${reason}`);
    testInfo.skip(true, reason);
  }
  home = installed ? mkdtempSync(join(tmpdir(), 'backbone-triage-installed-')) : freshDataHome('triage-electron');
  mkdirSync(evidence, { recursive: true });
  model = await startScriptedModel();
  const runtime = { env: { ...process.env, BACKBONE_HOME: home, BACKBONE_MODEL_ENDPOINT: model.url, BACKBONE_MODEL_ID: model.model } as Record<string, string> };
  app = await electron.launch(installed ? { ...runtime, executablePath: installed, args: [] } : { ...runtime, args: [appDir] });
  expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(!!installed);
  const compiled = await app.evaluate(({ app }) => {
    const fs = process.getBuiltinModule('node:fs');
    const path = process.getBuiltinModule('node:path');
    return JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'dist', 'build.json'), 'utf8'));
  });
  // Bind the test's expectation to the executable actually launched, including an old-DMG retry.
  expect(compiled).toEqual(JSON.parse(readFileSync(join(appDir, 'dist', 'build.json'), 'utf8')));
  writeFileSync(join(evidence, 'build-identity.json'), JSON.stringify(compiled, null, 2) + '\n');
  const page = await app.firstWindow();
  await expect(page.locator('[data-ready=true]')).toBeVisible({ timeout: TEST_HANG_MS });

  // The renderer cannot sign: it is not a method of the transport it reaches.
  const direct = await page.evaluate(() =>
    (window as unknown as { backbone: { call(m: string, a: unknown): Promise<unknown> } }).backbone.call('triage.sign', { hash: 'x', presence: 'touch-id' }).then(
      () => 'signed',
      (e: Error) => e.message,
    ),
  );
  expect(direct).toMatch(/Unknown api method/);

  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Mail triage' }).click();
  const brief = page.getByTestId('brief');
  await brief.getByRole('button', { name: 'Connect the sample mailbox' }).click();
  await expect(brief.getByTestId('triage-status')).toContainText('reads only, until you give permission');
  await page.screenshot({ path: join(evidence, '01-connected.png') });

  // Touch ID refused: nothing is signed.
  await answer(app, [0], false);
  await brief.getByRole('button', { name: 'Give permission…' }).click();
  await expect(brief.getByRole('alert')).toContainText('your presence was not confirmed');
  await expect(brief.getByTestId('capability')).toHaveCount(0);

  // One screen in main: the payload's summary and its hash; one Touch ID; signed.
  await answer(app, [0], true);
  await brief.getByRole('button', { name: 'Give permission…' }).click();
  await expect(brief.getByTestId('capability')).toContainText('Capability v1 · active');
  const { asked, touched } = await shown(app);
  expect(touched).toBe(1);
  expect(asked[0].message).toBe(`Let ${compiled.configuration.brand.name} triage your mail?`);
  expect(asked[0].buttons).toEqual(['Permit…', 'Cancel']);
  expect(asked[0].detail).toMatch(/^Purpose: Read mail, draft replies; later label and move\n/);
  expect(asked[0].detail).toMatch(/\nNever: send, forward or delete mail/);
  expect(asked[0].detail).toMatch(/\nPayload hash: sha256:[0-9a-f]{64}\n/);
  const hash = /Payload hash: sha256:([0-9a-f]{64})/.exec(asked[0].detail ?? '')![1];
  await expect(brief.getByTestId('capability')).toContainText(`sha256:${hash.slice(0, 16)}`);

  // Signing starts the job; it handles the whole inbox and asks nothing.
  await waitForSampleInbox(() => brief.getByTestId('brief-counts').innerText(), () => `model requests: ${model?.requests.length}`);
  await expect(brief.getByTestId('brief-counts')).toContainText('47 requests');
  await expect(brief.getByTestId('triage-running')).toHaveCount(0, { timeout: TEST_HANG_MS });
  await expect(brief.getByTestId('needs-m08')).toContainText('Marked suspicious');
  await expect(brief.getByTestId('draft-m01')).toContainText('Recovery: exact undo');
  await expect(brief.getByTestId('proposal-m05')).toContainText('Move to Archive, labelled Newsletters');
  await page.screenshot({ path: join(evidence, '02-brief.png'), fullPage: true });

  // A draft opens in the viewer, addressed to the requester.
  await brief.getByTestId('draft-m01').getByRole('button', { name: /Open the draft/ }).click();
  await expect(page.getByText('To: Dana Whitfield <dana.whitfield@harborlight.example>')).toBeVisible();
  await page.screenshot({ path: join(evidence, '03-draft.png') });

  // One click discards a proposal; it is never proposed again.
  const proposal = brief.getByTestId('proposal-m05');
  await proposal.getByRole('button', { name: 'Discard' }).click();
  await expect(proposal).toContainText('Discarded');
  await expect(proposal.getByRole('button', { name: 'Discard' })).toHaveCount(0);
  await page.screenshot({ path: join(evidence, '04-discarded.png') });
});
