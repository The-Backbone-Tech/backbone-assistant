import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Ajv } from 'ajv';
import type { Thread, Turn } from '@backbone-next/platform';
import { EXIT, parse, runCommand, type Api, type Io } from '../src/commands.ts';
import { runExec } from '../src/exec.ts';

const validate = new Ajv().compile(JSON.parse(readFileSync(new URL('../src/exec-events.schema.json', import.meta.url), 'utf8')));
const turn = (over: Partial<Turn> = {}): Turn => ({
  id: 'turn', side: false, user: { text: 'hello', attachments: [], at: '2026-11-11T00:00:00Z' },
  work: { startedAt: '2026-11-11T00:00:00Z', harness: 'fake', steps: [{ kind: 'read', label: 'Read source' }], usage: { input: 12, output: 7 } },
  effects: [], status: 'done', answer: { text: '{"total":42}', files: [] }, ...over,
});
function fixture(snapshots: Turn[] = [turn()], sendError?: 'lost' | 'refused', readErrorAfter?: number) {
  const out: string[] = [], err: string[] = [], calls: { method: string; args: any }[] = [];
  const outputAtRead: string[][] = [];
  let interrupt = () => {}, stopped = false;
  const io: Io = { out: s => { out.push(s); }, err: s => { err.push(s); }, onInterrupt: fn => { interrupt = fn; }, holding: () => {}, pollMs: 1, stopWaitMs: 1 };
  const api = { async call(method: string, args: unknown) {
    calls.push({ method, args });
    if (method === 'projects.list') return [{ id: 'project', name: 'P' }];
    if (method === 'models.list') return [{ id: 'fake' }];
    if (method === 'turns.send') {
      if (sendError === 'lost') throw new Error('lost response');
      if (sendError === 'refused') return { ok: false, outcome: 'REFUSED', reason: 'NOT_AVAILABLE', detail: 'unavailable' };
      return { ok: true, value: { threadId: 'thread', turnId: 'turn' } };
    }
    if (method === 'turns.stop') { stopped = true; return { ok: true, value: { stopped: true } }; }
    if (method === 'threads.get') {
      outputAtRead.push([...out]);
      if (readErrorAfter !== undefined && outputAtRead.length > readErrorAfter) throw new Error('lost observation');
      const next = stopped ? turn({ status: 'stopped' }) : snapshots.length > 1 ? snapshots.shift()! : snapshots[0];
      return { ok: true, value: { summary: { id: 'thread' }, turns: [next] } as Thread };
    }
    throw new Error(`unexpected method ${method}`);
  } } as Api;
  const run = (args: string[] = []) => runExec(parse(['exec', 'Calculate', '--home', '/unused', '--json', ...args]), io, (parsed, observed) => runCommand(parsed, api, observed));
  const events = () => out.map(line => {
    assert.ok(!line.includes('\n'), 'each write contains one JSON event');
    const event = JSON.parse(line); assert.equal(validate(event), true, JSON.stringify(validate.errors)); return event;
  });
  return { run, events, out, err, calls, outputAtRead, interrupt: () => interrupt() };
}
function schemaFile(t: TestContext, value: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'exec-schema-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'answer.json'); writeFileSync(file, JSON.stringify(value)); return file;
}
const schema = { type: 'object', properties: { total: { type: 'integer' } }, required: ['total'], additionalProperties: false };

test('exec streams schema-valid JSON events and a final answer validated against the supplied schema', async t => {
  const file = schemaFile(t, schema);
  const f = fixture([turn({ status: 'running', answer: undefined }), turn()]);
  assert.equal(await f.run(['--output-schema', file]), EXIT.OK);
  const events = f.events();
  assert.deepEqual(events.slice(0, 2).map(e => e.type), ['thread.started', 'turn.started']);
  assert.ok(events.some(e => e.type === 'item.started'));
  const message = events.find(e => e.type === 'item.completed' && e.item.type === 'agent_message');
  assert.deepEqual(JSON.parse(message.item.text), { total: 42 });
  assert.deepEqual(events.at(-1).usage, { input_tokens: 12, cached_input_tokens: null, output_tokens: 7 });
  assert.deepEqual(events.at(-1).structured_output, { total: 42 });
  assert.equal(events.at(-1).type, 'turn.completed');
  const sent = f.calls.find(c => c.method === 'turns.send')!.args;
  assert.match(sent.text, /"total"/); assert.equal(sent.settings.permission, 'ask');
  assert.equal(f.calls.filter(c => c.method === 'turns.send').length, 1);
});

test('exec emits progress before the turn settles and does not duplicate unchanged items', async () => {
  const f = fixture([turn({ status: 'running', answer: undefined }), turn({ status: 'running', answer: undefined }), turn()]);
  assert.equal(await f.run(), EXIT.OK);
  const events = f.events();
  const reads = events.filter(e => e.type === 'item.completed' && e.item.type === 'backbone_step');
  assert.equal(reads.length, 1);
  const beforeSettling = f.outputAtRead[1].map(s => JSON.parse(s));
  assert.ok(beforeSettling.some(e => e.type === 'item.started'));
  assert.ok(!beforeSettling.some(e => e.type === 'turn.completed'));
});

for (const answer of ['not JSON', '{"total":"42"}', '{}']) test(`exec fails closed for a schema-invalid final answer: ${answer}`, async t => {
  const f = fixture([turn({ answer: { text: answer, files: [] } })]);
  assert.equal(await f.run(['--output-schema', schemaFile(t, schema)]), EXIT.FAILED);
  assert.equal(f.events().at(-1).type, 'turn.failed');
  assert.ok(!f.events().some(e => e.type === 'turn.completed'));
  assert.equal(f.calls.filter(c => c.method === 'turns.send').length, 1);
});

for (const invalid of [null, { type: 'unknown' }, { $ref: 'https://invalid.example/schema' }]) test(`exec rejects an invalid schema before opening a home: ${JSON.stringify(invalid)}`, async t => {
  const f = fixture();
  assert.equal(await f.run(['--output-schema', schemaFile(t, invalid)]), EXIT.USAGE);
  assert.equal(f.calls.length, 0);
  assert.equal(f.events().at(-1).type, 'turn.failed');
});

test('exec reports a missing schema before opening a home', async t => {
  const file = schemaFile(t, schema); rmSync(file);
  const f = fixture(); assert.equal(await f.run(['--output-schema', file]), EXIT.USAGE);
  assert.equal(f.calls.length, 0); assert.equal(f.events().at(-1).exit_code, EXIT.USAGE);
});

for (const [snapshot, code] of [
  [turn({ effects: [{ key: 'e', kind: 'write-working-copy', target: 'doc', outcome: 'UNKNOWN' }] }), EXIT.UNKNOWN],
  [turn({ status: 'refused', refusal: { reason: 'NOT_AVAILABLE', detail: 'unavailable' } }), EXIT.REFUSED],
  [turn({ status: 'stopped' }), EXIT.STOPPED],
  [turn({ status: 'stopped', failure: { detail: 'provider failed' } }), EXIT.FAILED],
  [turn({ status: 'stopped', work: { ...turn().work, finishReason: 'length' }, failure: { detail: 'cut off' } }), EXIT.UNFINISHED],
] as const) test(`exec preserves send outcome ${code}`, async () => {
  const f = fixture([snapshot]); assert.equal(await f.run(), code);
  assert.equal(f.events().at(-1).type, 'turn.failed'); assert.equal(f.events().at(-1).exit_code, code);
});

for (const [error, code] of [['lost', EXIT.UNKNOWN], ['refused', EXIT.REFUSED]] as const) test(`exec never retries a ${error} send`, async () => {
  const f = fixture(undefined, error); assert.equal(await f.run(), code);
  assert.equal(f.calls.filter(c => c.method === 'turns.send').length, 1);
  assert.equal(f.events().at(-1).exit_code, code);
});

test('exec passes Ctrl-C to the same single stop path', async () => {
  const f = fixture([turn({ status: 'running', answer: undefined })]);
  const running = f.run();
  while (!f.calls.some(c => c.method === 'threads.get')) await new Promise(r => setTimeout(r, 1));
  f.interrupt(); assert.equal(await running, EXIT.STOPPED);
  assert.equal(f.calls.filter(c => c.method === 'turns.stop').length, 1);
});

test('exec flags do not change send JSON or redirect a prompt into goal execution', async () => {
  assert.ok(parse(['send', 'hello', '--home', '/unused', '--output-schema', 'schema.json']).usage);
  assert.ok(parse(['exec', '/goal something', '--home', '/unused']).usage);
  const f = fixture(); assert.equal(await f.run(), EXIT.OK);
});


test('exec updates an item in place and reports unavailable usage honestly', async () => {
  const f = fixture([
    turn({ status: 'running', answer: undefined, work: { ...turn().work, steps: [{ kind: 'note', label: 'Thinking' }] } }),
    turn({ work: { ...turn().work, steps: [{ kind: 'note', label: 'Finished thinking' }], usage: undefined } }),
  ]);
  assert.equal(await f.run(), EXIT.OK);
  const events = f.events();
  const update = events.find(e => e.type === 'item.updated');
  assert.equal(update.item.id, events.find(e => e.type === 'item.started').item.id);
  assert.equal(events.at(-1).usage, null);
});

test('a withheld answer is not streamed or treated as a successful final result', async () => {
  const f = fixture([turn({ withheld: true })]);
  assert.equal(await f.run(), EXIT.FAILED);
  assert.ok(!f.events().some(e => e.item?.type === 'agent_message'));
});


test('lost observation leaves steps in progress and reports UNKNOWN without resending', async () => {
  const f = fixture([turn({ status: 'running', answer: undefined })], undefined, 1);
  assert.equal(await f.run(), EXIT.UNKNOWN);
  const events = f.events();
  assert.ok(events.some(e => e.type === 'item.started'));
  assert.ok(!events.some(e => e.type === 'item.completed'));
  assert.equal(events.at(-1).exit_code, EXIT.UNKNOWN);
  assert.equal(f.calls.filter(c => c.method === 'turns.send').length, 1);
});

test('an empty output schema filename is refused before work starts', async () => {
  const f = fixture(); assert.equal(await f.run(['--output-schema', '']), EXIT.USAGE);
  assert.equal(f.calls.length, 0);
});

test('schema parse errors never echo the supplied file contents', async t => {
  const file = schemaFile(t, schema);
  const privateText = 'fake-private-key'; writeFileSync(file, privateText);
  const f = fixture(); assert.equal(await f.run(['--output-schema', file]), EXIT.USAGE);
  assert.equal(f.calls.length, 0);
  assert.ok(!f.out.join('\n').includes(privateText));
  assert.ok(!f.err.join('\n').includes(privateText));
});
