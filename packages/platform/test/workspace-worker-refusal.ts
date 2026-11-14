// Owned controller process: an unavailable executable must not crash it through IPC errors.
import assert from 'node:assert/strict';
import { WorkspaceStore } from '../src/workspace/store.ts';
const [folder, unavailable] = process.argv.slice(2);
Object.defineProperty(process, 'execPath', { value: unavailable });
await assert.rejects(new WorkspaceStore('owned-controller').execute({ folder: folder!, createdAt: Date.now(), expiresAt: Date.now() + 30_000, sources: [] }, { command: 'echo must-not-run', inputs: [] }), Error);
// Give queued IPC errors a turn: a second unhandled error must fail this helper.
await new Promise(resolve => setTimeout(resolve, 30));
process.stdout.write('controller survived an unconfirmed launch\n');
