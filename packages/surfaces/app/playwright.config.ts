import { defineConfig } from '@playwright/test';
import { TEST_HANG_MS } from '../../../scripts/lib/test-hang.ts';

// The journeys' homes are test homes: their keys stay in plain text (electron/main.ts takes that only
// in a development build). The installed app ignores it and keeps its keys in the Keychain.
if (process.env.BACKBONE_APP_EXECUTABLE) {
  process.env.BACKBONE_KEYS ??= 'plaintext';
} else {
  process.env.BACKBONE_SYSTEM_STORE_UNAVAILABLE = '1';
  process.env.BACKBONE_KEYS = 'plaintext';
}

// Browser journeys at 1440, 375 and 320 px in Light and Dark; the Electron journey on the built app.
const browser = (name: string, width: number, height: number, colorScheme: 'light' | 'dark') => ({
  name,
  testMatch: /browser\.spec\.ts/,
  use: { viewport: { width, height }, colorScheme, browserName: 'chromium' as const },
});

// The rebuilt screens in Light and Dark at 1440 and 375 px (e2e/design.spec.ts).
const design = (name: string, width: number, height: number, colorScheme: 'light' | 'dark') => ({
  name,
  testMatch: /design\.spec\.ts/,
  use: { viewport: { width, height }, colorScheme, browserName: 'chromium' as const },
});

export default defineConfig({
  testDir: 'e2e',
  // Whole journeys include several load-sensitive operations, each with its own hang diagnostic.
  timeout: TEST_HANG_MS * 4,
  expect: { timeout: TEST_HANG_MS },
  workers: 2,
  reporter: [['list']],
  outputDir: '../../../evidence/J-01/playwright-output',
  projects: [
    { name: 'connector-catalogue', testMatch: /connector-catalogue\.spec\.ts/, use: { viewport: { width: 1440, height: 900 }, browserName: 'chromium' } },
    { name: 'connector-approval-electron', testMatch: /connector-approval\.electron\.spec\.ts/ },
    { name: 'connectors', testMatch: /connectors\.spec\.ts/, use: { viewport: { width: 1440, height: 900 }, browserName: 'chromium' } },
    { name: 'signed-tools-electron', testMatch: /signed-tools\.electron\.spec\.ts/ },
    { name: 'signed-tools', testMatch: /signed-tools\.spec\.ts/, use: { viewport: { width: 375, height: 812 }, browserName: 'chromium' } },
    { name: 'connector-read-decisions', testMatch: /connector-read-decisions\.spec\.ts/, use: { viewport: { width: 375, height: 812 }, browserName: 'chromium' } },
    { name: 'sidechat-host', testMatch: /sidechat-host\.spec\.ts/, use: { viewport: { width: 1440, height: 900 }, browserName: 'chromium' } },
    { name: 'sidechat-custody', testMatch: /sidechat-custody\.spec\.ts/, use: { viewport: { width: 1440, height: 900 }, browserName: 'chromium' } },
    { name: 'changes-identity', testMatch: /changes-identity\.spec\.ts/, use: { viewport: { width: 1440, height: 900 }, browserName: 'chromium' } },
    { name: 'task-selection-integration', testMatch: /task-selection\.integration\.spec\.ts/, use: { viewport: { width: 1440, height: 900 }, browserName: 'chromium' } },
    { name: 'task-selection', testMatch: /task-selection\.spec\.ts/, use: { viewport: { width: 1440, height: 900 }, browserName: 'chromium' } },
    { name: 'streaming', testMatch: /streaming\.spec\.ts/, use: { viewport: { width: 1440, height: 900 }, browserName: 'chromium' } },
    { name: 'work-evidence-integration', testMatch: /work-evidence\.integration\.spec\.ts/, use: { viewport: { width: 1440, height: 900 }, colorScheme: 'light', browserName: 'chromium' } },
    { name: 'held', testMatch: /held\.spec\.ts/, use: { viewport: { width: 1440, height: 900 }, colorScheme: 'light', browserName: 'chromium' } },
    { name: 'goals', testMatch: /(goals|restart)\.spec\.ts/, use: { viewport: { width: 1440, height: 900 }, colorScheme: 'light', browserName: 'chromium' } },
    { name: 'backup', testMatch: /backup\.spec\.ts/, use: { viewport: { width: 1440, height: 900 }, colorScheme: 'light', browserName: 'chromium' } },
    { name: 'restore', testMatch: /restore\.spec\.ts/, timeout: TEST_HANG_MS * 6, use: { viewport: { width: 1440, height: 900 }, colorScheme: 'light', browserName: 'chromium' } },
    ...(['light', 'dark'] as const).map((scheme) => ({ name: `restore-views-${scheme}-1440`, testMatch: /restore-views\.spec\.ts/, timeout: TEST_HANG_MS * 6, use: { viewport: { width: 1440, height: 900 }, colorScheme: scheme, browserName: 'chromium' as const } })),
    { name: 'restore-views-light-375', testMatch: /restore-views\.spec\.ts/, timeout: TEST_HANG_MS * 6, use: { viewport: { width: 375, height: 812 }, colorScheme: 'light' as const, browserName: 'chromium' as const } },
    { name: 'memory', testMatch: /(memory|plugins)\.spec\.ts/, use: { viewport: { width: 1440, height: 900 }, colorScheme: 'light', browserName: 'chromium' } },
    { name: 'first-run', testMatch: /first-run\.spec\.ts/, use: { viewport: { width: 1440, height: 900 }, colorScheme: 'light', browserName: 'chromium' } },
    { name: 'first-send', testMatch: /first-send\.spec\.ts/, use: { viewport: { width: 1440, height: 900 }, colorScheme: 'light', browserName: 'chromium' } },
    { name: 'project-create', testMatch: /project-create\.spec\.ts/, use: { viewport: { width: 1440, height: 900 }, colorScheme: 'light', browserName: 'chromium' } },
    { name: 'draft-conflict', testMatch: /draft-conflict\.spec\.ts/, use: { viewport: { width: 1440, height: 900 }, colorScheme: 'light', browserName: 'chromium' } },
    { name: 'project-create-recovery', testMatch: /project-create-recovery\.spec\.ts/, timeout: TEST_HANG_MS * 4, use: { viewport: { width: 1440, height: 900 }, colorScheme: 'light', browserName: 'chromium' } },
    { name: 'scheduled', testMatch: /(scheduled|proactive)\.spec\.ts/, use: { viewport: { width: 1440, height: 900 }, colorScheme: 'light', browserName: 'chromium' } },
    { name: 'clean-ui', testMatch: /clean-ui\.spec\.ts/, use: { viewport: { width: 1440, height: 900 }, colorScheme: 'light', browserName: 'chromium' } },
    { name: 'work-evidence', testMatch: /work-evidence\.spec\.ts/, use: { viewport: { width: 1440, height: 900 }, browserName: 'chromium' } },
    browser('browser-light-1440', 1440, 900, 'light'),
    browser('browser-dark-1440', 1440, 900, 'dark'),
    browser('browser-light-375', 375, 812, 'light'),
    browser('browser-dark-375', 375, 812, 'dark'),
    browser('browser-light-320', 320, 640, 'light'),
    browser('browser-dark-320', 320, 640, 'dark'),
    design('design-light-1440', 1440, 900, 'light'),
    design('design-dark-1440', 1440, 900, 'dark'),
    design('design-light-375', 375, 812, 'light'),
    design('design-dark-375', 375, 812, 'dark'),
    { name: 'continuity-light-1440', testMatch: /continuity\.workspace\.spec\.ts/, use: { viewport: { width: 1440, height: 900 }, colorScheme: 'light', browserName: 'chromium' } },
    { name: 'workspace-light-1440', testMatch: /(?<!continuity\.)workspace\.spec\.ts/, use: { viewport: { width: 1440, height: 900 }, colorScheme: 'light', browserName: 'chromium' } },
    { name: 'workspace-dark-1440', testMatch: /(?<!continuity\.)workspace\.spec\.ts/, use: { viewport: { width: 1440, height: 900 }, colorScheme: 'dark', browserName: 'chromium' } },
    { name: 'side-pane-light-1440', testMatch: /side-pane\.spec\.ts/, use: { viewport: { width: 1440, height: 900 }, colorScheme: 'light', browserName: 'chromium' } },
    { name: 'side-pane-dark-1440', testMatch: /side-pane\.spec\.ts/, use: { viewport: { width: 1440, height: 900 }, colorScheme: 'dark', browserName: 'chromium' } },
    // Both tab strips with many tabs (e2e/tab-strips.spec.ts), in Light and Dark at 1440 and in a narrow window.
    ...([['light', 1440, 900], ['dark', 1440, 900], ['light', 375, 812]] as const).map(([scheme, width, height]) => ({ name: `tab-strips-${scheme}-${width}`, testMatch: /tab-strips\.spec\.ts/, use: { viewport: { width, height }, colorScheme: scheme, browserName: 'chromium' as const } })),
    { name: 'primitives', testMatch: /primitives\.spec\.ts/, use: { viewport: { width: 1440, height: 900 }, colorScheme: 'light', browserName: 'chromium' } },
    { name: 'flows', testMatch: /flows\.spec\.ts/, use: { viewport: { width: 1440, height: 900 }, colorScheme: 'light', browserName: 'chromium' } },
    { name: 'parallel', testMatch: /parallel\.spec\.ts/, use: { viewport: { width: 1440, height: 900 }, colorScheme: 'light', browserName: 'chromium' } },
    { name: 'electron', testMatch: /electron\.spec\.ts|long-conversations\.spec\.ts/, testIgnore: /browser-pane\.electron\.spec\.ts/ },
    // The browser pane's journeys hand keyboard focus to a native child view and back, which only the
    // window the operating system has focused can do. Another Electron app starting at that moment takes
    // the focus for good, so these run one at a time, after every other Electron journey has finished.
    // Run them alone with --project=electron-keyboard-focus --no-deps.
    { name: 'electron-keyboard-focus', testMatch: /browser-pane\.electron\.spec\.ts/, workers: 1, dependencies: ['connector-approval-electron', 'signed-tools-electron', 'electron'] },
  ],
});
