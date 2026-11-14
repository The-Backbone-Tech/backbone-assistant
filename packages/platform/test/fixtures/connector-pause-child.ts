import assert from 'node:assert/strict';
import { CoreLink } from '../../src/composition/core.ts';
import { ConnectorService, type ConnectorCore } from '../../src/connectors/service.ts';
import { defaultToolEnv } from '../../src/tools/places.ts';
const [home, person] = process.argv.slice(2);
const link = await CoreLink.open({ home });
const service = new ConnectorService({ home, env: () => defaultToolEnv({ HOME: person, PATH: process.env.PATH }), link: async () => link });
try {
  const tool = service.offered().find(t => t.serverId === 'claude-code:notes' && t.tool === 'draft_note')!;
  const result = await service.call(tool, { text: 'second process' }, {} as ConnectorCore, { threadId: 'child', turnId: 'child', seq: 1 }, new AbortController().signal);
  assert.equal(result.outcome, 'HELD'); console.log('HELD');
} finally { await service.close(); await link.release(); }
