import { TEST_HANG_MS } from '../../../scripts/lib/test-hang.ts';
// Controlled crash during recovery: the host resumes the interrupted turn up to BACKBONE_CRASH_AT.
import { createHost } from '../src/composition/host.ts';

const [home, piece] = process.argv.slice(2);
void createHost({ home, harness: 'harness-codex', pieceDirs: { 'harness-codex': piece } }).resumeInterrupted();
setTimeout(() => { console.error('Recovery did not reach its crash cut.'); process.exit(1); }, TEST_HANG_MS);
