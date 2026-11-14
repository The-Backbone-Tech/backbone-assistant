// Test-only HarnessV1 producer. It exercises the host's native route and managed import over
// real PostgreSQL, but calls no vendor client or model and supplies no entitlement evidence.
import { appendFileSync } from 'node:fs';

export function createCodexHarness() {
  const starts = process.env.BACKBONE_TEST_STARTS;
  return {
    specificationVersion: 'v1', id: 'controlled-native', label: 'Controlled native fixture (no model)',
    async listModels() { return [{ id: 'controlled', label: 'Controlled', efforts: [4], permissions: ['full'] }]; },
    start(request, { tools }) {
      appendFileSync(starts, 'start\n');
      if (request.text === 'Hold before proposing (admission fixture).') {
        let finish;
        const outcome = new Promise((resolve) => { finish = resolve; });
        const timer = setTimeout(() => finish({ status: 'failed', answer: '', error: 'Stop did not reach this producer.', usage: { input: 0, output: 0 } }), 2_000);
        return { events: (async function* () {})(), outcome, steer() {}, stop() {
          clearTimeout(timer);
          finish({ status: 'interrupted', answer: '', usage: { input: 0, output: 0 } });
        } };
      }
      const outcome = (async () => {
        if (request.resumed) return { status: 'failed', answer: '', error: 'A resumed producer was called.', usage: { input: 0, output: 0 } };
        const source = await tools.read('source.md');
        if (!source || !tools.writeIfVersion) throw new Error('Missing controlled source or conditional host.');
        if (process.env.BACKBONE_TEST_CHECKPOINT) {
          const second = process.env.BACKBONE_TEST_CHECKPOINT === 'revision' ? { name: 'source.md', body: 'A finished revision.\n', targetVersion: source.version } : { name: 'other.md', body: 'Another finished note.\n', targetVersion: null };
          await tools.checkpoint([{ name: 'note.md', body: 'A finished note.\n', targetVersion: null }, second], [{ name: source.name, version: source.version }]);
          process.kill(process.pid, 'SIGKILL');
          await new Promise(() => {});
        }
        if (process.env.BACKBONE_TEST_TWO_WRITES === '1') await tools.writeIfVersion('first.md', 'The first original result.\n',
          { targetVersion: null, sources: [{ name: source.name, version: source.version }] }, new AbortController().signal);
        const result = await tools.writeIfVersion('result.md', 'A fixed decision note from source v1.\n',
          { targetVersion: null, sources: [{ name: source.name, version: source.version }] }, new AbortController().signal);
        return { status: result.outcome === 'DONE' ? 'done' : 'failed', answer: 'The controlled result is result.md.', usage: { input: 0, output: 0 } };
      })();
      return { events: (async function* () {})(), outcome, steer() {}, stop() {} };
    },
  };
}
