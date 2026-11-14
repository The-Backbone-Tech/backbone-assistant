// Real app navigation, synthetic transport: drafts and receipts belong to their original side chat.
import { expect } from '@playwright/test';
import { releaseFixture, select, side, test, waitForFixture } from './sidechat-custody-fixture';

test('a stuck side draft read can be retried without a late response replacing newer edits', async ({ page }) => {
  await page.evaluate(() => sessionStorage.setItem('sidechat-fixture', JSON.stringify({ holdDraft: true, drafts: {
    'side-chat:a': { key: 'side-chat:a', text: 'Saved question', updatedAt: new Date().toISOString() },
    'side-chat-request:a': { key: 'side-chat-request:a', text: 'Earlier question', meta: { clientKey: 'original-key' }, updatedAt: new Date().toISOString() },
  } })));
  await page.clock.install();
  await page.reload();
  await expect(side(page)).toBeDisabled();
  await waitForFixture(page, 'drafts.get', { key: 'side-chat:a' }, 'held');
  // Exercise the real load-failure timer without waiting ten wall-clock seconds under load.
  await page.clock.fastForward(10_000);
  await page.evaluate(() => { (window as any).fixture.holdDraft = false; });
  await page.getByRole('button', { name: 'Try loading again' }).click();
  await waitForFixture(page, 'drafts.get', { key: 'side-chat:a' });
  await expect(side(page)).toHaveValue('Saved question');
  await expect(page.getByRole('button', { name: 'Retry original question' })).toBeVisible();
  await side(page).fill('Newer question');
  await releaseFixture(page, 'drafts.get');
  await expect(side(page)).toHaveValue('Newer question');
  expect(await page.evaluate(() => (window as any).fixture.calls)).toEqual([]);
});

test('lost response survives reload and retry uses the original identity and words', async ({ page }) => {
  await page.evaluate(() => { (window as any).fixture.mode = 'lost'; });
  await side(page).fill('Original question'); await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.getByText(/could not be confirmed/)).toBeVisible();
  const original = await page.evaluate(() => (window as any).fixture.calls[0]);
  await side(page).fill('Newer question'); await page.reload();
  await expect(side(page)).toHaveValue('Newer question');
  await page.getByRole('button', { name: 'Retry original question' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).fixture.calls.length)).toBe(1);
  const retry = await page.evaluate(() => (window as any).fixture.calls[0]);
  expect(retry).toEqual(original);
  await expect(side(page)).toHaveValue('Newer question');
});

test('stop targets the visible side turn, not the main turn', async ({ page }) => {
  await page.evaluate(() => sessionStorage.setItem('sidechat-fixture', JSON.stringify({ drafts: {}, sideTurns: [{ id: 'side-1', status: 'running', user: { text: 'Side question' } }] })));
  await page.reload();
  await page.getByRole('button', { name: 'Stop side question' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).fixture.calls)).toEqual([{ method: 'sidechat.stop', threadId: 'a', turnId: 'side-1' }]);
});

test('a pending Stop on another view does not disable Stop after returning', async ({ page }) => {
  await page.evaluate(() => sessionStorage.setItem('sidechat-fixture', JSON.stringify({ drafts: {}, sideTurns: [{ id: 'side-1', status: 'running', user: { text: 'Side question' } }] })));
  await page.reload();
  await page.evaluate(() => { (window as any).fixture.holdStop = true; });
  await page.getByRole('button', { name: 'Stop side question' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).fixture.calls.length)).toBe(1);
  await waitForFixture(page, 'sidechat.stop', { threadId: 'a', turnId: 'side-1' }, 'held');
  await expect(page.getByRole('button', { name: 'Stop side question' })).toBeDisabled();
  await select(page, 'B');
  await select(page, 'A');
  await expect(page.getByRole('button', { name: 'Stop side question' })).toBeDisabled();
  expect(await page.evaluate(() => (window as any).fixture.calls.length)).toBe(1);
  await releaseFixture(page, 'sidechat.stop');
  await expect(page.getByRole('button', { name: 'Stop side question' })).toBeEnabled();
});

test('a late Stop refusal identifies its original side chat without changing the current draft', async ({ page }) => {
  await page.evaluate(() => sessionStorage.setItem('sidechat-fixture', JSON.stringify({ drafts: {}, sideTurns: [{ id: 'side-1', status: 'running', user: { text: 'Side question' } }] })));
  await page.reload();
  await page.evaluate(() => { const f = (window as any).fixture; f.holdStop = true; f.stopRefused = true; });
  await page.getByRole('button', { name: 'Stop side question' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).fixture.calls.length)).toBe(1);
  await waitForFixture(page, 'sidechat.stop', { threadId: 'a', turnId: 'side-1' }, 'held');
  await expect(page.getByRole('button', { name: 'Stop side question' })).toBeDisabled();
  await select(page, 'B');
  await side(page).fill('Keep B draft');
  await releaseFixture(page, 'sidechat.stop');
  const notice = page.getByTestId('side-chat-notice');
  await expect(notice).toContainText('A Stop in an earlier side chat: Stop was refused.');
  await expect(side(page)).toHaveValue('Keep B draft');
  await notice.getByRole('button', { name: 'Open side chat' }).click();
  await expect(page.getByRole('button', { name: 'Stop side question' })).toBeEnabled();
  await select(page, 'B');
  await expect(side(page)).toHaveValue('Keep B draft');
});

test('read-only scope and a witnessed refusal survive reload without confirming model claims', async ({ page }) => {
  const detail = 'The requested action was not performed.\n\nUnconfirmed model response retained for you to inspect:\n\nI changed the file.';
  await page.evaluate((detail) => sessionStorage.setItem('sidechat-fixture', JSON.stringify({ drafts: {}, sideTurns: [
    { id: 'side-1', status: 'refused', user: { text: 'Change it' }, sideRun: { scope: 'read-only' }, refusal: { reason: 'SIDE_CHAT_READ_ONLY', detail } },
    { id: 'side-2', status: 'done', user: { text: 'Another question' }, answer: { text: 'I changed the file.', files: [] } },
  ] })), detail);
  await page.reload();
  const turns = page.getByTestId('side-chat-tab').locator('ol > li');
  await expect(turns.nth(0)).toContainText('Read-only');
  await expect(turns.nth(0)).toContainText('Action not performed');
  await expect(turns.nth(0)).toContainText('Unconfirmed model response');
  await expect(turns.nth(0)).toContainText('I changed the file.');
  await expect(turns.nth(1)).not.toContainText('Action not performed');
  await expect(page.getByTestId('side-chat-tab')).not.toContainText('Answers do not confirm actions.');
});

test('a refusal with unreconciled Core settlement shows unknown before any refusal conclusion', async ({ page }) => {
  await page.evaluate(() => sessionStorage.setItem('sidechat-fixture', JSON.stringify({ drafts: {}, sideTurns: [{
    id: 'side-1', status: 'stopped', sideRecoveryPending: true, user: { text: 'Change it' }, sideRun: { scope: 'read-only' },
    refusal: { reason: 'SIDE_CHAT_READ_ONLY', detail: 'Action was not performed.' },
    answer: { text: 'The side run could not be recorded. Outcome unknown.\n\nUnconfirmed response: I changed the file.', files: [] },
  }] })));
  await page.reload();
  const turn = page.getByTestId('side-chat-tab').locator('ol > li').first();
  await expect(turn).toContainText('Unknown outcome. Any partial answer is unconfirmed');
  await expect(turn).toContainText('Unconfirmed response: I changed the file.');
  await expect(turn).not.toContainText('Action not performed');
});

test('a stopped reconciled turn keeps its unknown answer ahead of an earlier refusal', async ({ page }) => {
  await page.evaluate(() => sessionStorage.setItem('sidechat-fixture', JSON.stringify({ drafts: {}, sideTurns: [{
    id: 'side-1', status: 'stopped', interrupted: true, user: { text: 'Change it' }, sideRun: { scope: 'read-only' },
    refusal: { reason: 'SIDE_CHAT_READ_ONLY', detail: 'Action was not performed.' },
    answer: { text: 'The side run could not be recorded. Outcome unknown.\n\nUnconfirmed response: I changed the file.', files: [] },
  }] })));
  await page.reload();
  const turn = page.getByTestId('side-chat-tab').locator('ol > li').first();
  await expect(turn).toContainText('This side question stopped or could not finish.');
  await expect(turn).toContainText('Unconfirmed response:');
  await expect(turn).toContainText('Unconfirmed response: I changed the file.');
  await expect(turn.getByTestId('side-chat-refusal')).toHaveCount(0);
});

test('an unreconciled side turn that is still running can still be stopped by its own id', async ({ page }) => {
  await page.evaluate(() => sessionStorage.setItem('sidechat-fixture', JSON.stringify({ drafts: {}, sideTurns: [{
    id: 'side-pending', status: 'running', sideRecoveryPending: true, user: { text: 'Question' }, sideRun: { scope: 'read-only' },
  }] })));
  await page.reload();
  await expect(page.getByTestId('side-chat-tab')).toContainText('Unknown outcome');
  await page.getByRole('button', { name: 'Stop side question' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).fixture.calls)).toEqual([{ method: 'sidechat.stop', threadId: 'a', turnId: 'side-pending' }]);
});

test('unsent side drafts follow their own thread through switching and reload', async ({ page }) => {
  await side(page).fill('Draft for thread A');
  await select(page, 'B'); await expect(side(page)).toHaveValue('');
  await side(page).fill('Draft for thread B');
  await select(page, 'A'); await expect(side(page)).toHaveValue('Draft for thread A');
  await expect.poll(() => page.evaluate(() => (window as any).fixture.drafts['side-chat:a']?.text)).toBe('Draft for thread A');
  await expect.poll(() => page.evaluate(() => (window as any).fixture.drafts['side-chat:b']?.text)).toBe('Draft for thread B');
  await page.reload(); await expect(side(page)).toHaveValue('Draft for thread A');
  await select(page, 'B'); await expect(side(page)).toHaveValue('Draft for thread B');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).fixture.calls)).toEqual([expect.objectContaining({ threadId: 'b', text: 'Draft for thread B', clientKey: expect.any(String) })]);
});

test('an admitted answer clears only its submitted text, never a newer edit', async ({ page }) => {
  await page.evaluate(() => { (window as any).fixture.hold = true; });
  await side(page).fill('Earlier question'); await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).fixture.calls.length)).toBe(1);
  await expect(page.getByRole('button', { name: 'Ask', exact: true })).toBeDisabled();
  await side(page).fill('Newer question');
  await releaseFixture(page, 'sidechat.ask');
  await expect(side(page)).toHaveValue('Newer question');
  await expect(page.getByRole('button', { name: 'Ask', exact: true })).toBeEnabled();
  await expect.poll(() => page.evaluate(() => (window as any).fixture.drafts['side-chat:a']?.text)).toBe('Newer question');
});

for (const mode of ['ok', 'refused', 'lost']) test(`${mode}: late answer keeps both threads' drafts and identifies its original side chat`, async ({ page }) => {
  await page.evaluate((mode) => { const f = (window as any).fixture; f.hold = true; f.mode = mode; }, mode);
  await side(page).fill('Question for A'); await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).fixture.calls.length)).toBe(1);
  await side(page).fill('Newer A draft');
  await select(page, 'B'); await side(page).fill('Keep B draft');
  await releaseFixture(page, 'sidechat.ask');
  const notice = page.getByTestId(mode === 'ok' ? 'sent-notice' : 'side-chat-notice');
  await expect(notice).toHaveAttribute('role', mode === 'ok' ? 'status' : 'alert');
  if (mode !== 'ok') await expect(page.getByTestId('sent-notice')).toHaveCount(0);
  await expect(notice).toContainText(mode === 'ok' ? 'side question was recorded' : mode === 'refused' ? 'Thread no longer exists' : 'could not be confirmed');
  await expect(side(page)).toHaveValue('Keep B draft');
  await notice.getByRole('button', { name: 'Open side chat', exact: true }).click();
  await expect(side(page)).toHaveValue('Newer A draft');
  expect(await page.evaluate(() => (window as any).fixture.calls)).toEqual([expect.objectContaining({ threadId: 'a', text: 'Question for A', clientKey: expect.any(String) })]);
  await select(page, 'B'); await expect(side(page)).toHaveValue('Keep B draft');
});

for (const mode of ['refused', 'lost']) test(`${mode}: retain the current draft and show the actual refusal or uncertainty`, async ({ page }) => {
  await page.evaluate((mode) => { (window as any).fixture.mode = mode; }, mode);
  await side(page).fill('Keep this question'); await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(mode === 'refused' ? 'Thread no longer exists' : 'could not be confirmed');
  await expect(side(page)).toHaveValue('Keep this question');
  await page.reload(); await expect(side(page)).toHaveValue('Keep this question');
  expect(await page.evaluate(() => (window as any).fixture.calls)).toEqual([]);
});

test('an admitted but unreconciled side run keeps the original draft and identity after reload', async ({ page }) => {
  await page.evaluate(() => { (window as any).fixture.mode = 'pending'; });
  await side(page).fill('Question awaiting reconciliation');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('outcome is unknown');
  const original = await page.evaluate(() => (window as any).fixture.calls[0]);
  await expect(side(page)).toHaveValue('Question awaiting reconciliation');
  await page.reload();
  await expect(side(page)).toHaveValue('Question awaiting reconciliation');
  await page.getByRole('button', { name: 'Retry original question' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).fixture.calls.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).fixture.calls[0])).toEqual(original);
});

test('failed durable save sends no side question and retains the text', async ({ page }) => {
  await page.evaluate(() => { (window as any).fixture.failSave = true; });
  await side(page).fill('Keep unsaved question'); await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('not sent');
  await expect(side(page)).toHaveValue('Keep unsaved question');
  expect(await page.evaluate(() => (window as any).fixture.calls)).toEqual([]);
});


test('closing and reopening the side tab retains the in-flight guard', async ({ page }) => {
  await page.evaluate(() => { (window as any).fixture.hold = true; });
  await side(page).fill('One pending question'); await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).fixture.calls.length)).toBe(1);
  await page.getByRole('button', { name: 'Close Side chat', exact: true }).click();
  await expect(side(page)).toHaveCount(0);
  await page.keyboard.press('Control+Alt+S');
  await expect(side(page)).toBeEnabled();
  await expect(side(page)).toHaveValue('One pending question');
  await expect(page.getByRole('button', { name: 'Ask', exact: true })).toBeDisabled();
  await side(page).press('Enter');
  expect(await page.evaluate(() => (window as any).fixture.calls.length)).toBe(1);
  await releaseFixture(page, 'sidechat.ask');
  await expect(page.getByTestId('sent-notice')).toContainText('side question was recorded');
  await expect(page.getByRole('button', { name: 'Ask', exact: true })).toBeEnabled();
});

test('an unconfirmed side draft stays visible and reviewable after switching away and back', async ({ page }) => {
  await page.evaluate(() => { (window as any).fixture.failSave = true; });
  await side(page).fill('My unconfirmed side draft');
  await expect(page.getByRole('alert')).toContainText('could not be saved');
  await select(page, 'B'); await select(page, 'A');
  await expect(side(page)).toHaveValue('My unconfirmed side draft');
  await expect(page.getByRole('alert')).toContainText('could not be confirmed');
  await expect(page.getByRole('button', {name:'Review saved draft'})).toBeVisible();
});
