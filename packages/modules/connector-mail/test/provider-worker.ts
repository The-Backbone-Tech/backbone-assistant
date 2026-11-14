// Independent provider client for the two-process persistence regression. No database or model.
import { FakeMailbox } from '../src/index.ts';
const [stateFile, id, operationKey] = process.argv.slice(2);
const box = new FakeMailbox({ stateFile, writes: 'open' });
const message = await box.read(id);
const classified = box.classify({ op: 'modify', id, version: message.version, add: ['Label_team'], remove: [] }, await box.labels());
if (!classified.ok) throw new Error(classified.reason);
process.once('message', async () => {
  try {
    const result = await box.apply({ ...classified.value, operationKey });
    process.send?.({ result: result.outcome }); process.disconnect?.();
  } catch (error) { console.error(error); process.exit(1); }
});
process.send?.({ ready: true });
