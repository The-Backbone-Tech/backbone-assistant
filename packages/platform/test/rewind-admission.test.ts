import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createParallelWork, type ParallelDeps } from '../src/composition/parallel-work.ts';
import { rewindAdmission, rewindWriteHold } from '../src/composition/rewind-admission.ts';
import { ThreadJournal, type StoredThread } from '../src/composition/thread-journal.ts';
import { freshHome, settings } from './helpers.ts';

function fixture(files: boolean) {
  const home = freshHome();
  const pending = { summary: { id: 'pending', projectId: 'project', title: 'Pending rewind' }, turns: [],
    rewindPending: { id: 'rewind', turnId: 'target', files: files ? [{ materialId: 'file' }] : [] } } as unknown as StoredThread;
  const parent = { summary: { id: 'parent', projectId: 'project' }, turns: [{ user: { settings } }] } as unknown as StoredThread;
  const threads = new Map([['pending', pending], ['parent', parent]]);
  let crossings = 0;
  const parallel = createParallelWork({ home, threads, running: new Map(), journal: new ThreadJournal(home),
    link: async () => { crossings++; throw new Error('Admission must refuse before Core or reservation'); },
  } as unknown as ParallelDeps);
  return { threads, parallel, crossings: () => crossings };
}

for (const files of [false, true]) {
  test(`pending rewind holds child and board worker admission before reservation (files=${files})`, async () => {
    const f = fixture(files);
    for (const parentThreadId of ['pending', 'parent']) {
      const child = await f.parallel.handlers['children.start']({ parentThreadId, text: 'Work', role: 'worker', clientKey: 'child' });
      const worker = await f.parallel.startWorker({ parentThreadId, text: 'Work', title: 'Card', key: 'board' });
      for (const result of [child, worker]) {
        assert.equal(result.ok, false);
        assert.match(!result.ok ? result.detail : '', /pending rewind/i);
      }
    }
    assert.equal(f.crossings(), 0);
    assert.deepEqual([...f.threads.keys()], ['pending', 'parent']);
  });
  test(`rewind boundary recognises parentThreadId and holds same-project admissions (files=${files})`, () => {
    const { threads } = fixture(files);
    assert.match(rewindWriteHold(threads.values(), 'children.start', { parentThreadId: 'pending' }) ?? '', /pending rewind/i);
    assert.match(rewindAdmission(threads.values(), 'project', 'parent') ?? '', /pending rewind/i);
    assert.equal(rewindAdmission(threads.values(), 'elsewhere', 'other'), undefined);
  });
}
