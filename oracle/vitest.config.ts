import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The cases read ORACLE_TARGET (their own default is the old repository's `legacy`); here it is the successor.
const target = process.env.ORACLE_TARGET ?? 'successor';
const setups: Record<string, string[]> = {
  successor: ['./adapters/successor/setup.ts'],
};

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    include: ['core/**/*.test.ts', 'lessons/**/*.test.ts', 'behaviour/**/*.test.ts'],
    env: { ORACLE_TARGET: target },
    globalSetup: setups[target] ?? [],
    testTimeout: 300_000,
    hookTimeout: 180_000,
    // Each file has its own installation, but the embedded server is one process: keep the load modest.
    fileParallelism: true,
    maxWorkers: 4,
    reporters: ['default', ['json', { outputFile: `results/raw/${target}.json` }]],
  },
});
