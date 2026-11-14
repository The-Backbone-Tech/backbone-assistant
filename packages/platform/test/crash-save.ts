// Child process for the kill-during-Save tests: the stub kills itself at BACKBONE_STUB_CRASH_AT.
import { createHost } from '../src/composition/host.ts';

const [home, id] = process.argv.slice(2);
const crashAt = process.env.BACKBONE_STUB_CRASH_AT as 'after-intent' | 'after-version' | 'after-meta';
const host = createHost({ home, faults: { crashAt } });
await host.call('material.save', { id, text: '# Edited by me\n', baseVersion: 1 });
console.error('save returned without crashing');
