import { randomUUID } from 'node:crypto';
import type { JourneyFlaw } from './cases.ts';
import { sha256 } from './fixtures.ts';
import type {
  AgentPlan,
  Author,
  CrashPoint,
  DocumentState,
  Journey,
  JourneyPort,
  SaveState,
  SaveTicket,
  Seen,
  ThreadView,
  WriteStatus,
} from './port.ts';

interface Doc {
  id: string;
  title: string;
  versions: { version: number; by: Author; content: string }[];
  original?: { filename: string; sha256: string; byteLength: number; bytes: Uint8Array };
}
interface Write {
  id: string;
  status: WriteStatus;
  document: string;
  version: number | undefined;
  content: string;
  title: string;
}
interface Thread {
  id: string;
  project: string | null;
  answers: string[];
  writes: Write[];
  stopped: boolean;
  work: Promise<void>;
}

/**
 * An in-memory journey target, correct unless one lesson's flaw is switched on. Its document store
 * is an outside target that does not check versions itself (as a mail server or a file share does
 * not): only the gateway's own rules stand between a resent or copied write and a second change.
 */
export function openJourneyStub(flaw?: JourneyFlaw): JourneyPort {
  return {
    async open() {
      const docs = new Map<string, Doc>();
      const threads = new Map<string, Thread>();
      const seen: Seen[] = [];
      const saves = new Map<SaveTicket, { title: string; expectedVersion: number; accepted?: number }>();
      let up = true;
      let armed: CrashPoint | undefined;
      let died = false;
      let revive: () => void = () => {};
      let revived = Promise.resolve();
      const down = () => {
        up = false;
        died = true;
        armed = undefined;
        revived = new Promise<void>((resolve) => (revive = resolve));
      };
      const need = () => {
        if (!up) throw new Error('the service is down');
      };
      const current = (d: Doc) => d.versions.at(-1) ?? { version: 0, by: 'agent' as Author, content: '' };
      const apply = (w: Write, by: Author) => {
        const d = docs.get(w.document);
        if (d === undefined) {
          docs.set(w.document, {
            id: w.document,
            title: w.title,
            versions: [{ version: 1, by, content: w.content }],
          });
        } else {
          d.versions.push({ version: current(d).version + 1, by, content: w.content });
          d.title = w.title;
        }
      };
      const sameMeaning = (a: Write, b: Write) =>
        a.document === b.document &&
        a.version === b.version &&
        a.content === b.content &&
        a.title === b.title;

      async function work(t: Thread, plan: AgentPlan) {
        const read = (plan.read ?? []).flatMap((title) =>
          [...docs.values()].filter((d) => d.title === title),
        );
        seen.push({
          text: [...read.map((d) => current(d).content)].join('\n'),
          documents: read.map((d) => ({
            id: d.id,
            version: current(d).version,
            content: current(d).content,
          })),
        });
        if (plan.write) {
          if (plan.hold) await plan.hold.wait();
          const w: Write = {
            id: randomUUID(),
            status: 'pending',
            document: plan.write.document ?? randomUUID(),
            version: plan.write.version,
            content: plan.write.content,
            title: plan.write.title,
          };
          if (t.stopped && flaw !== 'L8-no-recheck-before-send') return;
          t.writes.push(w);
          const copyOf = [...threads.values()]
            .flatMap((x) => x.writes)
            .find(
              (o) => o !== w && sameMeaning(o, w) && (o.status === 'unknown' || o.status === 'succeeded'),
            );
          if (copyOf && flaw !== 'L7-key-only-dedupe') {
            w.status = 'denied';
          } else {
            if (armed === 'write.proposed' || armed === 'write.claimed') {
              down();
              await revived;
            }
            if (armed === 'write.begun') {
              apply(w, 'agent');
              w.status = 'unknown';
              down();
              await revived;
              // Recovery sorts the unknown and sends nothing; the flaw sends it again.
              if (flaw === 'L6-recovery-resends') {
                apply(w, 'agent');
                w.status = 'succeeded';
              }
            } else {
              apply(w, 'agent');
              w.status = 'succeeded';
              if (armed === 'write.recorded') {
                down();
                await revived;
              }
            }
          }
        }
        if (!t.stopped) t.answers.push(plan.answer);
      }
      const view = (t: Thread): ThreadView => ({
        id: t.id,
        project: t.project,
        idle: true,
        answers: [...t.answers],
        writes: t.writes.map((w) => ({ id: w.id, status: w.status, document: w.document })),
        questions: 0,
      });
      let settling: Promise<void> = Promise.resolve();

      const journey: Journey = {
        person: randomUUID(),
        async createProject() {
          return randomUUID();
        },
        async ask({ message: _message, project, material, agent }) {
          need();
          const attachments: string[] = [];
          if (material?.note) {
            const id = randomUUID();
            docs.set(id, {
              id,
              title: material.note.title,
              versions: [{ version: 1, by: 'person', content: material.note.text }],
            });
            attachments.push(id);
          }
          if (material?.spreadsheet) {
            const id = randomUUID();
            const bytes = material.spreadsheet.bytes;
            docs.set(id, {
              id,
              title: material.spreadsheet.name,
              versions: [{ version: 1, by: 'person', content: '' }],
              original: {
                filename: material.spreadsheet.name,
                sha256: sha256(bytes),
                byteLength: bytes.byteLength,
                bytes,
              },
            });
            attachments.push(id);
          }
          const t: Thread = {
            id: randomUUID(),
            project: project ?? null,
            answers: [],
            writes: [],
            stopped: false,
            work: Promise.resolve(),
          };
          threads.set(t.id, t);
          t.work = work(t, agent);
          settling = t.work;
          return { thread: t.id, attachments };
        },
        async followUp(id, _message, agent) {
          need();
          const t = threads.get(id);
          if (!t) throw new Error('no thread');
          t.stopped = false;
          t.work = t.work.then(() => work(t, agent));
          settling = t.work;
        },
        async settled(id, answers) {
          const t = threads.get(id);
          if (!t) throw new Error('no thread');
          await t.work;
          if (t.answers.length < answers && !t.stopped) throw new Error('the thread did not settle');
          return view(t);
        },
        async thread(id) {
          need();
          const t = threads.get(id);
          if (!t) throw new Error('no thread');
          return view(t);
        },
        async stop(id) {
          need();
          const t = threads.get(id);
          if (!t) return false;
          t.stopped = true;
          return true;
        },
        async documents() {
          need();
          return [...docs.values()].map((d) => ({ id: d.id, title: d.title, version: current(d).version }));
        },
        async document(id) {
          need();
          const d = docs.get(id);
          if (!d) throw new Error('no document');
          const now = current(d);
          const state: DocumentState = {
            id: d.id,
            title: d.title,
            version: now.version,
            content: now.content,
            by: now.by,
            versions: d.versions.map((v) => ({ ...v })),
            ...(d.original
              ? {
                  original: {
                    filename: d.original.filename,
                    sha256: d.original.sha256,
                    byteLength: d.original.byteLength,
                  },
                }
              : {}),
          };
          return state;
        },
        async original(id) {
          need();
          const bytes = docs.get(id)?.original?.bytes;
          if (!bytes) throw new Error('no original');
          return bytes;
        },
        async prepareSave(id, edit) {
          need();
          const ticket: SaveTicket = { document: id, content: edit.content };
          saves.set(ticket, { title: edit.title, expectedVersion: edit.expectedVersion });
          return ticket;
        },
        async save(ticket) {
          need();
          const s = saves.get(ticket);
          const d = docs.get(ticket.document);
          if (!s || !d) throw new Error('no save');
          if (s.accepted !== undefined) return { status: 'accepted', version: s.accepted };
          if (current(d).version !== s.expectedVersion) return { status: 'refused', reason: 'changed' };
          d.versions.push({ version: current(d).version + 1, by: 'person', content: ticket.content });
          s.accepted = current(d).version;
          return { status: 'accepted', version: s.accepted };
        },
        async saveState(ticket): Promise<SaveState> {
          need();
          const s = saves.get(ticket);
          if (!s) return { status: 'unavailable' };
          return s.accepted === undefined
            ? { status: 'prepared' }
            : { status: 'accepted', version: s.accepted };
        },
        async saveThenKill(ticket, afterMs) {
          need();
          if (afterMs > 0) {
            await journey.save(ticket);
            // The flaw: the Save's answer is kept only in memory, and the kill loses it.
            const s = saves.get(ticket);
            if (flaw === 'L14-reported-not-stored' && s) delete s.accepted;
          }
          down();
        },
        seen: () => seen,
        async restart() {
          up = true;
        },
        async kill() {
          down();
        },
        async start(options = {}) {
          up = true;
          died = false;
          armed = options.crashAt;
          revive();
          await Promise.resolve();
        },
        async crashed() {
          for (let i = 0; i < 50 && !died; i += 1) await new Promise((resolve) => setTimeout(resolve, 1));
          return died;
        },
        async close() {
          up = false;
          revive();
          await settling.catch(() => {});
        },
      };
      return journey;
    },
  };
}
