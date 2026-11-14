// Disposable Host stand-in; the parent test kills only this owned process.
import { WorkspaceStore } from '../src/workspace/store.ts';
const store = new WorkspaceStore('crash-owner', { root: process.argv[2] });
await store.run('thread', { command: 'echo durable > result', inputs: [] });
process.send!('ready');
await store.run('thread', { command: "echo running; sleep 100", inputs: [] });
