import { unexpectedMaterialRead } from './fixtures/synthetic-material-reader.ts';
// Child of sidechat-core.integration.test.ts; killed only after the local model received a request.
import {randomUUID} from 'node:crypto';
import { CoreLink } from '../src/composition/core.ts';
import { loadPiece, PIECES, pieceOnDisk } from '../src/composition/pieces.ts';
import { createSideCore } from '../src/composition/sidechat-core.ts';
import { createSideChat } from '../src/composition/sidechat.ts';
import { saveThreadProjection } from '../src/composition/thread-custody.ts';
import type { StoredThread } from '../src/composition/thread-journal.ts';
import { MaterialStore } from '../src/stub/material.ts';
import { createPiHarness } from '../../modules/harness-pi/src/index.ts';

const home = process.argv[2];
const endpoint = process.env.SIDECHAT_TEST_ENDPOINT!;
const model = process.env.SIDECHAT_TEST_MODEL!;
const link = await CoreLink.open({ home });
const pi = PIECES['harness-pi'];
const { registration } = await loadPiece(link, pieceOnDisk(pi.dir, pi.id), { firstUse: true });
await link.grantPiece(registration.id);
const projectId=randomUUID();await link.call(link.person(),'SELECT gov.identity_project_create($1)',[projectId]);
const now = new Date().toISOString();
const thread: StoredThread = { summary: { id: 'side-thread', projectId, title: 'Work', pinned: false, unread: false, archived: false, running: false, updatedAt: now }, turns: [], sideTurns: [], clientKeys: [] };
const route = { kind: 'endpoint' as const, provider: 'openai-compatible' as const, model, baseUrl: endpoint, label: 'local test', credential: null };
const core = createSideCore({ link: async () => link, piece: () => registration.id, ownsHome: () => true, closing: () => false,
  save: () => saveThreadProjection(home, thread), gateway: () => ({ read: unexpectedMaterialRead, write: async () => undefined }),
});
const service = createSideChat({ home, material: new MaterialStore(home, {}, () => {}), thread: () => thread,
  plan: () => ({ ok: true, value: { engine: createPiHarness(), route } }), credential: async () => '', closing: () => false,
  save: () => saveThreadProjection(home, thread), begin: core.begin, recoverRun: core.recoverRun,
});
await service.ask({ threadId: thread.summary.id, text: 'Crash test side question', clientKey: 'crash-key' });
throw new Error('The parent was expected to kill this child during inference.');
