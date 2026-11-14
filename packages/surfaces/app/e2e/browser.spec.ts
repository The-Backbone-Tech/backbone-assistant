// J-01 in the browser, through the HTTP bridge, at 1440, 375 and 320 px in Light and Dark.
// Cites R-UX-HOME-01, R-UX-SIDEBAR-01, R-UX-COMPOSER-01, R-FILES-ORIG-01, R-UX-THREAD-01, R-BASE-01,
// R-UX-PANES-01, R-UX-KEYS-01, R-BASE-02, R-FILES-REFRESH-01, R-UX-SIDECHAT-01, R-BASE-03, R-MEM-TIER-01.
import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { removeDataHome } from '@backbone-next/platform/composition';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { startBridge, stopBridge } from './bridge';
import {
  evidenceDir, phase1Home, phase2ProjectAndAttach, phase3Brief, phase4Panes, phase5EditSave, phase6SideChat,
  phase7Restored, phase8FollowUp, phase10Classes, prepareColdStart, Recorder,
} from './journey';

test('J-01 phases 1–8 and 10 in the browser', async ({ page }, info) => {
  const home = freshDataHome('j01-browser');
  let bridge = await startBridge(home);
  const pageErrors: string[] = [];
  let bridgeRestarting = false;
  page.on('pageerror', (e) => {
    if (!bridgeRestarting || e.message !== 'Failed to fetch') pageErrors.push(e.message);
  });
  const rec = new Recorder(join(evidenceDir, 'browser', info.project.name), () => page);
  try {
    await page.goto(bridge.url);
    await rec.phase('01-home', () => phase1Home(page));
    let projectId = '';
    await rec.phase('02-project-attach', async () => void (projectId = await phase2ProjectAndAttach(page)));
    await rec.phase('03-brief', () => phase3Brief(page));
    await rec.phase('04-panes', () => phase4Panes(page));
    await rec.phase('05-edit-save', () => phase5EditSave(page));
    await rec.phase('06-side-chat', () => phase6SideChat(page, projectId));
    await prepareColdStart(page);
    await rec.shot('07a-before-quit');
    await rec.phase('07-cold-start', async () => {
      bridgeRestarting = true;
      try {
        await stopBridge(bridge.proc);
        bridge = await startBridge(home);
        await page.goto(bridge.url);
      } finally {
        bridgeRestarting = false;
      }
      await phase7Restored(page);
    });
    await rec.phase('08-follow-up', () => phase8FollowUp(page));
    await rec.phase('10-classes', () => phase10Classes(page, projectId));
    expect(pageErrors, 'unexpected browser page errors').toEqual([]);
  } finally {
    writeFileSync(join(rec.dir, 'phases.json'), JSON.stringify(rec.phases, null, 2));
    await stopBridge(bridge.proc);
    await removeDataHome(home);
  }
});
