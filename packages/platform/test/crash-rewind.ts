// Child for real process-kill tests: the material store stops at a precise durable boundary.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MaterialStore, type CrashPoint } from '../src/stub/material.ts';
import { createThreadRewind } from '../src/composition/thread-rewind.ts';
import { ThreadJournal, type StoredThread } from '../src/composition/thread-journal.ts';
import { writeJson } from '../src/stub/fsx.ts';
const [home, root, crashAt] = process.argv.slice(2);
const thread: StoredThread = JSON.parse(readFileSync(join(home, 'crash-thread.json'), 'utf8'));
const threads = new Map([[thread.summary.id, thread]]);
const material = new MaterialStore(home, { crashAt: crashAt as CrashPoint }, (entry, bytes) => writeFileSync(join(root, entry.name), bytes), entry => join(root, entry.name));
const rewind = createThreadRewind({ home, material, threads, journal: new ThreadJournal(home), projectDir: () => root, busy: () => false, save: async t => writeJson(join(home, 'crash-thread.json'), t), changed: () => {} });
const args = { threadId: thread.summary.id, turnId: thread.turns[0].id };
const plan = await rewind.preview(args);
if (!plan.ok) throw new Error(plan.detail);
await rewind.apply({ ...args, revision: plan.value.revision, clientKey: 'crash', choices: [] });
throw new Error('The rewind returned without reaching its crash point.');
