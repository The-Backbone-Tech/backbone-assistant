#!/usr/bin/env node
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  console.error(`backbone needs Node.js 22.18 or newer; found ${process.versions.node}. Install a newer Node.js and try again.`);
  process.exitCode = 1;
} else {
  import('./loader.mjs').then(() => import('../packages/surfaces/cli/src/main.ts')).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
