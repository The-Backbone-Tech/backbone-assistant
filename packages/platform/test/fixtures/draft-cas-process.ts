import { join } from 'node:path';
import { withHomeLock } from '../../src/composition/home-lock.ts';
import { decodeDraft, transitionDraft } from '../../src/composition/draft-cas.ts';
import { readJson, writeJson } from '../../src/stub/fsx.ts';
const [home, clientKey] = process.argv.slice(2);
await withHomeLock(home, async (lost) => {
  const path = join(home,'draft.json');
  const previous = decodeDraft(readJson<unknown>(path,null),'k');
  const result = transitionDraft(previous,{key:'k', text:clientKey, clientKey, baseRevision:0},'now');
  if (result.state === 'accepted' && !result.replay) { if (lost.aborted) throw new Error('lock lost'); writeJson(path,result.record); }
  process.stdout.write(result.state);
});
