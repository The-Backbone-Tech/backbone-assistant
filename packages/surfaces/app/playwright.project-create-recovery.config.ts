import { TEST_HANG_MS } from '../../../scripts/lib/test-hang.ts';
// Whole-journey hang guard; startup and recovery have no wall-clock performance promise.
import { defineConfig } from '@playwright/test';
export default defineConfig({testDir:'e2e',testMatch:/project-create-recovery[.]spec[.]ts/,timeout:TEST_HANG_MS * 4,workers:1,reporter:'list',use:{browserName:'chromium',viewport:{width:1440,height:900}}});
