import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NativeSubAgents, NativeTurnEvents } from '../src/events.ts';

const frame = { threadId: 'thread', turnId: 'turn' };
const item = (id: string, text: string, phase: string | null = null) => ({ ...frame, item: { id, type: 'agentMessage', text, phase } });
const delta = (id: string, text: string) => ({ ...frame, itemId: id, delta: text });

test('interleaved message items retain identity and a final answer independent of later commentary', () => {
  const p = new NativeTurnEvents('thread');
  p.receive('item/started', item('progress', '', 'commentary'));
  p.receive('item/started', item('final', '', 'final_answer'));
  p.receive('item/agentMessage/delta', delta('progress', 'Working.'));
  p.receive('item/agentMessage/delta', delta('final', 'First'));
  p.receive('item/agentMessage/delta', delta('progress', ' Still working.'));
  p.receive('item/completed', item('final', 'First result.', 'final_answer'));
  p.receive('item/completed', item('progress', 'Working. Still working.', 'commentary'));
  assert.equal(p.answer(), 'First result.');
  assert.deepEqual(p.receive('item/completed', item('final', 'First result.', 'final_answer')), []);
});
test('completed text is authoritative, even without any delta or when it corrects streaming text', () => {
  const p = new NativeTurnEvents('thread');
  p.receive('item/agentMessage/delta', delta('a', 'provisional'));
  const [event] = p.receive('item/completed', item('a', 'Actual result.', 'final_answer'));
  assert.equal(event.type, 'text');
  if (event.type === 'text') assert.equal(event.message?.text, 'Actual result.');
  assert.equal(p.answer(), 'Actual result.');
});
test('unphased legacy messages use last item while commentary and partial answers are not terminal answers', () => {
  const p = new NativeTurnEvents('thread');
  p.receive('item/completed', item('note', 'working', 'commentary'));
  p.receive('item/completed', item('partial', 'draft', 'partial_answer'));
  assert.equal(p.answer(), '');
  p.receive('item/completed', item('legacy1', 'one'));
  p.receive('item/completed', item('legacy2', 'two'));
  assert.equal(p.answer(), 'two');
});
test('turn completion can supply the final item missing from individual notifications', () => {
  const p = new NativeTurnEvents('thread');
  p.receive('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'completed', items: [item('final', 'result', 'final_answer').item] } });
  assert.equal(p.answer(), 'result');
  assert.throws(() => p.receive('item/agentMessage/delta', delta('final', 'late')), /after completion/);
});
test('a delayed reply must bind the same provisional turn identity', () => {
  const p = new NativeTurnEvents('thread');
  p.receive('item/agentMessage/delta', delta('a', 'result'));
  assert.throws(() => p.bindTurn('other'), /another turn/);
});
for (const [method, params] of [
  ['item/agentMessage/delta', { ...delta('a', 'x'), threadId: 'other' }],
  ['item/agentMessage/delta', { ...frame, delta: 'x' }],
  ['item/completed', { ...item('a', 'x'), turnId: 'other' }],
  ['thread/tokenUsage/updated', { ...frame, turnId: 'other', tokenUsage: { total: { inputTokens: 1, outputTokens: 1 } } }],
] as const) {
  test(`rejects invalid scoped ${method}: ${JSON.stringify(params)}`, () => {
    const p = new NativeTurnEvents('thread'); p.bindTurn('turn');
    assert.throws(() => p.receive(method, params), /Native/);
  });
}
test('completed messages cannot be appended, changed, retyped or given an invented phase', () => {
  const p = new NativeTurnEvents('thread');
  p.receive('item/completed', item('a', 'done', 'final_answer'));
  assert.throws(() => p.receive('item/agentMessage/delta', delta('a', 'late')), /completed/);
  assert.throws(() => p.receive('item/completed', item('a', 'changed', 'final_answer')), /completed/);
  assert.throws(() => p.receive('item/completed', { ...frame, item: { id: 'a', type: 'fileChange', status: 'completed' } }), /type/);
  assert.throws(() => p.receive('item/completed', item('b', 'x', 'invented')), /phase/);
});
test('usage repeats produce zero deltas; invalid and regressing totals are refused', () => {
  const p = new NativeTurnEvents('thread');
  const usage = (input: number, output: number) => p.receive('thread/tokenUsage/updated', { ...frame, tokenUsage: { total: { inputTokens: input, outputTokens: output } } });
  assert.deepEqual(usage(5, 2), [{ type: 'usage', input: 5, output: 2 }]);
  assert.deepEqual(usage(5, 2), [{ type: 'usage', input: 0, output: 0 }]);
  assert.throws(() => usage(4, 2), /usage/);
  assert.throws(() => usage(5, NaN), /usage/);
  assert.throws(() => usage(5, Number.MAX_SAFE_INTEGER + 1), /usage/);
  assert.deepEqual(p.usage, { input: 5, output: 2 });
});
test('aggregate UTF-8 bytes and item count are bounded, not just individual message size', () => {
  const p = new NativeTurnEvents('thread');
  p.receive('item/completed', item('a', 'é'.repeat(250_000)));
  assert.throws(() => p.receive('item/completed', item('b', 'é'.repeat(250_001))), /limit/);
  const many = new NativeTurnEvents('thread');
  for (let i = 0; i < 1_000; i++) many.receive('item/completed', item(String(i), ''));
  assert.throws(() => many.receive('item/completed', item('overflow', '')), /count/);
});
test('staged tool observations are keyed and idempotent and never fabricate effect receipts', () => {
  const p = new NativeTurnEvents('thread');
  const started = { ...frame, item: { id: 'cmd', type: 'commandExecution', status: 'inProgress' } };
  p.receive('item/started', started);
  const completed = { ...started, item: { ...started.item, status: 'completed' } };
  assert.deepEqual(p.receive('item/completed', completed), [{ type: 'tool', id: 'cmd', tool: 'native_staged', phase: 'done', label: 'Work in temporary drafts' }]);
  assert.deepEqual(p.receive('item/completed', completed), []);
  assert.throws(() => p.receive('item/completed', { ...completed, item: { ...completed.item, status: 'invented' } }), /status/);
});

for (const messagePhase of [null, 'final_answer'] as const) {
  for (const observed of ['all', 'none', 'later-only'] as const) {
    test(`v2 full terminal order wins over ${observed} notifications (${messagePhase})`, () => {
      const p = new NativeTurnEvents('thread');
      const earlier = item('earlier', 'Earlier.', messagePhase).item;
      const later = item('later', 'Actual last answer.', messagePhase).item;
      if (observed === 'all') p.receive('item/completed', { ...frame, item: earlier });
      if (observed !== 'none') p.receive('item/completed', { ...frame, item: later });
      p.receive('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'completed', items: [earlier, later], itemsView: 'full' } });
      assert.equal(p.answer(), 'Actual last answer.');
    });
  }
}
const command = { type: 'commandExecution', id: 'command', command: 'printf first', cwd: '/staging', source: 'agent',
  status: 'completed', aggregatedOutput: 'first', exitCode: 0, processId: null, pluginId: null, scriptPath: null, durationMs: 1, commandActions: [] };
for (const difference of [{ command: 'printf other' }, { aggregatedOutput: 'other' }, { cwd: '/other' }, { exitCode: 1 }, { source: 'user' }]) {
  test(`v2 completed command semantic change refuses: ${JSON.stringify(difference)}`, () => {
    const p = new NativeTurnEvents('thread');
    p.receive('item/completed', { ...frame, item: command });
    assert.throws(() => p.receive('item/completed', { ...frame, item: { ...command, ...difference } }), /completed tool changed/);
  });
}
test('v2 identical command semantics tolerate key order, absent nulls and timing/parser metadata changes', () => {
  const p = new NativeTurnEvents('thread');
  p.receive('item/completed', { ...frame, item: command });
  const { processId: _process, pluginId: _plugin, scriptPath: _script, ...same } = command;
  assert.deepEqual(p.receive('item/completed', { ...frame, item: { ...same, durationMs: 99, commandActions: [{ type: 'unknown', command: 'printf first' }] } }), []);
});
for (const difference of [{ path: 'other.md' }, { diff: '+changed' }, { kind: { type: 'delete' } }]) {
  test(`v2 file-change semantic change refuses: ${JSON.stringify(difference)}`, () => {
    const p = new NativeTurnEvents('thread');
    const change = { path: 'draft.md', kind: { type: 'add' }, diff: '+draft' };
    const first = { type: 'fileChange', id: 'patch', status: 'completed', changes: [change] };
    p.receive('item/completed', { ...frame, item: first });
    assert.throws(() => p.receive('item/completed', { ...frame, item: { ...first, changes: [{ ...change, ...difference }] } }), /completed tool changed/);
  });
}

test('v2 summary/notLoaded views do not replace messages absent from a partial payload', () => {
  for (const view of ['summary', 'notLoaded', undefined]) {
    const p = new NativeTurnEvents('thread');
    p.receive('item/completed', item('final', 'Retained answer.', 'final_answer'));
    const events = p.receive('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'completed', items: [item('progress', 'Working.', 'commentary').item], itemsView: view } });
    assert.equal(p.answer(), 'Retained answer.');
    assert.equal(events.some((event) => event.type === 'messages'), false);
  }
});
test('v2 full views replace provisional membership, including an explicitly empty full set', () => {
  const p = new NativeTurnEvents('thread');
  p.receive('item/completed', item('provisional', 'Not in the full turn.', 'final_answer'));
  const events = p.receive('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'completed', items: [], itemsView: 'full' } });
  assert.equal(p.answer(), '');
  assert.deepEqual(events, [{ type: 'messages', messages: [] }]);
});
test('v2 full view preserves order in one authoritative event, including duplicate notifications', () => {
  const p = new NativeTurnEvents('thread');
  p.receive('item/completed', item('last', 'Last.', 'final_answer'));
  const events = p.receive('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'completed', items: [item('first', 'First.', 'final_answer').item, item('last', 'Last.', 'final_answer').item], itemsView: 'full' } });
  assert.equal(events.length, 1, 'do not transiently publish the wrong appended text before correcting order');
  assert.equal(events[0].type, 'messages');
  if (events[0].type === 'messages') assert.deepEqual(events[0].messages.map((m) => m.id), ['first', 'last']);
});
test('v2 malformed or repeated full-view identities refuse rather than invent order', () => {
  for (const turn of [
    { id: 'turn', status: 'completed', itemsView: 'full' },
    { id: 'turn', status: 'completed', itemsView: 'invented', items: [] },
    { id: 'turn', status: 'completed', itemsView: 'full', items: [item('same', 'x').item, item('same', 'x').item] },
  ]) assert.throws(() => new NativeTurnEvents('thread').receive('turn/completed', { threadId: 'thread', turn }), /Native/);
});
test('v2 file-change semantics tolerate JSON key order and omitted optional move targets', () => {
  const p = new NativeTurnEvents('thread');
  p.receive('item/completed', { ...frame, item: { type: 'fileChange', id: 'patch', status: 'completed', changes: [{ path: 'draft.md', diff: '+draft', kind: { type: 'update', move_path: null } }] } });
  assert.deepEqual(p.receive('item/completed', { ...frame, item: { status: 'completed', id: 'patch', type: 'fileChange', changes: [{ kind: { type: 'update' }, diff: '+draft', path: 'draft.md' }] } }), []);
});
test('v2 terminal semantic data has a byte limit and validates outcome fields', () => {
  assert.throws(() => new NativeTurnEvents('thread').receive('item/completed', { ...frame, item: { ...command, aggregatedOutput: 'x'.repeat(2_000_000) } }), /limit/);
  assert.throws(() => new NativeTurnEvents('thread').receive('item/completed', { ...frame, item: { ...command, exitCode: 0.5 } }), /exit code/);
});

// Sub-agents: a tracker for the parent thread 'root', whose turn is 'parent'.
const spawn = (thread: string, path = '/root/helper') => ({ threadId: 'root', turnId: 'parent', item: { type: 'subAgentActivity', kind: 'started', id: `spawn-${thread}`, agentThreadId: thread, agentPath: path } });
const tracker = () => { const a = new NativeSubAgents('root'); a.bindRootTurn('parent'); return a; };
const childTurn = (thread: string, turn: ObjectLike = {}) => ({ threadId: thread, turn: { id: 'child-turn', rootTurnId: 'parent', status: 'inProgress', items: [], ...turn } });
type ObjectLike = Record<string, unknown>;
const childCommand = (thread: string, extra: ObjectLike = {}) => ({ threadId: thread, turnId: 'child-turn', item: { type: 'commandExecution', id: 'cmd', command: 'echo first', cwd: '/w', status: 'completed', aggregatedOutput: 'first', exitCode: 0, ...extra } });

test('a sub-agent turn must name this turn as its root, at receipt and when held notifications are replayed', () => {
  const missing = tracker(); missing.fromRoot('item/completed', spawn('child'));
  assert.throws(() => missing.receive('turn/started', { threadId: 'child', turn: { id: 'child-turn' } }), /another turn/);
  const other = tracker(); other.fromRoot('item/completed', spawn('child'));
  assert.throws(() => other.receive('turn/started', childTurn('child', { rootTurnId: 'stale' })), /another turn/);
  // Held first, then claimed: a completion with no root is refused on replay, not accepted.
  const stale = { threadId: 'stranger', turn: { id: 'stale-turn', status: 'completed' } };
  assert.throws(() => tracker().receive('turn/completed', stale), /another turn/);
  const held = new NativeSubAgents('root');
  held.receive('turn/completed', stale);
  assert.throws(() => held.fromRoot('item/completed', spawn('stranger')), /another turn/);
  // A held notification already naming another root is refused at receipt.
  assert.throws(() => tracker().receive('turn/started', childTurn('stranger', { rootTurnId: 'stale' })), /another turn/);
});

test('a sub-agent item counts only inside a validated sub-agent turn, so it cannot register descendants first', () => {
  const a = tracker(); a.fromRoot('item/completed', spawn('child'));
  assert.throws(() => a.receive('item/completed', { threadId: 'child', turnId: 'unvalidated', item: { type: 'subAgentActivity', kind: 'started', id: 's', agentThreadId: 'grandchild' } }), /another turn/);
  assert.equal(a.knows('grandchild'), false);
});

test('the sub-agent turn count is bounded on every insertion path', () => {
  const a = tracker(); a.fromRoot('item/completed', spawn('child'));
  assert.throws(() => { for (let i = 0; i <= 1_000; i++) a.receive('turn/started', childTurn('child', { id: `t${i}` })); }, /limit/);
  const b = tracker(); b.fromRoot('item/completed', spawn('child'));
  assert.throws(() => { for (let i = 0; i <= 1_000; i++) b.receive('item/completed', { threadId: 'child', turnId: `t${i}`, item: { type: 'reasoning', id: `r${i}` } }); });
});

test('spawns in a terminal snapshot are tracked, the parent\'s and a sub-agent\'s', () => {
  const a = tracker();
  a.fromRoot('turn/completed', { threadId: 'root', turn: { id: 'parent', status: 'completed', items: [spawn('child').item] } });
  assert.deepEqual(a.running().map((r) => r.thread), ['child']);
  a.receive('turn/started', childTurn('child'));
  a.receive('turn/completed', childTurn('child', { status: 'completed', items: [spawn('grandchild', '/root/helper/deeper').item] }));
  assert.deepEqual(a.running().map((r) => r.thread), ['grandchild']);
});

test('a conflicting sub-agent tool completion makes the turn UNKNOWN; an identical repeat is idempotent', () => {
  const a = tracker(); a.fromRoot('item/completed', spawn('child')); a.receive('turn/started', childTurn('child'));
  assert.equal(a.receive('item/completed', childCommand('child')).length, 1);
  assert.deepEqual(a.receive('item/completed', childCommand('child', { durationMs: 9 })), []);
  assert.equal(a.unknown, undefined);
  const events = a.receive('item/completed', childCommand('child', { command: 'echo other' }));
  assert.equal(events[0]?.type === 'tool' && events[0].phase, 'unknown');
  assert.match(a.unknown ?? '', /\/root\/helper/);
});

test('a sub-agent turn that ends other than completed makes the turn UNKNOWN', () => {
  for (const status of ['interrupted', 'failed']) {
    const a = tracker(); a.fromRoot('item/completed', spawn('child')); a.receive('turn/started', childTurn('child'));
    a.receive('turn/completed', childTurn('child', { status }));
    assert.deepEqual(a.running(), []);
    assert.match(a.unknown ?? '', new RegExp(`/root/helper.*${status}`));
  }
});

test('held notifications have an aggregate byte budget', () => {
  const a = tracker(), big = 'x'.repeat(1_000_000);
  assert.throws(() => { for (let i = 0; i < 20; i++) a.receive('item/completed', { threadId: 'stranger', turnId: 't', item: { type: 'agentMessage', id: `m${i}`, text: big } }); }, /another thread/);
});

test('a sub-agent\'s terminal snapshot is checked against its streamed tool reports', () => {
  const same = tracker(); same.fromRoot('item/completed', spawn('child')); same.receive('turn/started', childTurn('child'));
  same.receive('item/completed', childCommand('child', { aggregatedOutput: 'safe' }));
  same.receive('turn/completed', childTurn('child', { status: 'completed', items: [childCommand('child', { aggregatedOutput: 'safe' }).item] }));
  assert.equal(same.unknown, undefined, 'an identical snapshot is idempotent');
  const changed = tracker(); changed.fromRoot('item/completed', spawn('child')); changed.receive('turn/started', childTurn('child'));
  changed.receive('item/completed', childCommand('child', { aggregatedOutput: 'safe' }));
  changed.receive('turn/completed', childTurn('child', { status: 'completed', items: [childCommand('child', { aggregatedOutput: 'CHANGED' }).item] }));
  assert.match(changed.unknown ?? '', /\/root\/helper/);
});

test('a repeated sub-agent completion is validated before it is dismissed', () => {
  const same = tracker(); same.fromRoot('item/completed', spawn('child')); same.receive('turn/started', childTurn('child'));
  same.receive('turn/completed', childTurn('child', { status: 'completed' }));
  assert.deepEqual(same.receive('turn/completed', childTurn('child', { status: 'completed' })), [], 'only an identical repeat is ignored');
  assert.equal(same.unknown, undefined);
  const changed = tracker(); changed.fromRoot('item/completed', spawn('child')); changed.receive('turn/started', childTurn('child'));
  changed.receive('turn/completed', childTurn('child', { status: 'completed' }));
  changed.receive('turn/completed', childTurn('child', { status: 'interrupted', items: [spawn('grandchild', '/root/helper/deeper').item] }));
  assert.match(changed.unknown ?? '', /\/root\/helper.*interrupted/);
  assert.deepEqual(changed.running().map((r) => r.thread), ['grandchild'], 'spawns in the repeat are registered');
  const conflict = tracker(); conflict.fromRoot('item/completed', spawn('child')); conflict.receive('turn/started', childTurn('child'));
  conflict.receive('turn/completed', childTurn('child', { status: 'completed', items: [childCommand('child').item] }));
  conflict.receive('turn/completed', childTurn('child', { status: 'completed', items: [childCommand('child', { exitCode: 1 }).item] }));
  assert.match(conflict.unknown ?? '', /\/root\/helper/);
});

test('after a sub-agent turn ends, only its descendants\' later lifecycle reports are accepted', () => {
  const a = tracker(); a.fromRoot('item/completed', spawn('child')); a.receive('turn/started', childTurn('child'));
  a.receive('item/completed', { threadId: 'child', turnId: 'child-turn', item: { type: 'subAgentActivity', kind: 'started', id: 's', agentThreadId: 'grandchild', agentPath: '/root/helper/deeper' } });
  a.receive('turn/completed', childTurn('child', { status: 'completed' }));
  assert.deepEqual(a.receive('item/completed', { threadId: 'child', turnId: 'child-turn', item: { type: 'subAgentActivity', kind: 'completed', id: 'done-g', agentThreadId: 'grandchild' } }), []);
  assert.equal(a.unknown, undefined);
  assert.throws(() => a.receive('item/completed', { threadId: 'child', turnId: 'child-turn', item: { type: 'subAgentActivity', kind: 'started', id: 's2', agentThreadId: 'other' } }), /after completion/);
  assert.throws(() => a.receive('item/completed', childCommand('child', { id: 'late' })), /after completion/);
});

test('the work record includes a staged command and its refusal evidence', () => {
  const p = new NativeTurnEvents('thread');
  const events = p.receive('item/completed', { ...frame, item: { id: 'failed-command', type: 'commandExecution', status: 'failed', command: 'python3 totals.py', exitCode: 2 } });
  const event = events[0]; assert.equal(event.type, 'tool');
  if (event.type === 'tool') assert.match(event.detail!, /python3 totals.py.*failed.*exit 2/);
});

test('native command reports a protected-folder denial without exposing its output', () => {
  const p = new NativeTurnEvents('thread');
  const frame = { threadId: 'thread', turnId: 'turn' };
  p.receive('item/started', { ...frame, item: { id: 'privacy', type: 'commandExecution', command: 'ls ' + '~' + '/Downloads', status: 'inProgress' } });
  const events = p.receive('item/completed', { ...frame, item: { id: 'privacy', type: 'commandExecution', command: 'ls ' + '~' + '/Downloads', status: 'failed', exitCode: 1, aggregatedOutput: 'ls: ' + '~' + '/Downloads: Operation not permitted private-data' } });
  assert.match(JSON.stringify(events), /macOS denied access to a protected folder/);
  assert.doesNotMatch(JSON.stringify(events), /private-data/);
});

test('a running command can report a protected-folder denial without waiting for completion', () => {
  const p = new NativeTurnEvents('thread');
  const frame = { threadId: 'thread', turnId: 'turn' };
  p.receive('item/started', { ...frame, item: { id: 'privacy', type: 'commandExecution', command: 'ls ' + '~' + '/Downloads', status: 'inProgress' } });
  const events = p.receive('item/commandExecution/outputDelta', { ...frame, itemId: 'privacy', delta: 'Operation not permitted private-data' });
  assert.match(JSON.stringify(events), /macOS denied access to a protected folder/);
  assert.doesNotMatch(JSON.stringify(events), /private-data/);
  const end = p.receive('item/completed', { ...frame, item: { id: 'privacy', type: 'commandExecution', command: 'ls ' + '~' + '/Downloads', status: 'failed', exitCode: 1 } });
  assert.match(JSON.stringify(end), /macOS denied access to a protected folder/);
});

test('protected folder signal names only a folder in the command and withholds output', () => {
  const p = new NativeTurnEvents('thread');
  const item = (id: string, command: string) => ({ id, type: 'commandExecution', command, status: 'failed', exitCode: 1, aggregatedOutput: 'Operation not permitted private-data /' + 'Users/x/Downloads' });
  const named = p.receive('item/completed', { ...frame, item: item('named', 'ls ' + '~' + '/Downloads') });
  assert.deepEqual((named[0] as any).denied, { kind: 'macos-protected-folder', folder: 'Downloads' });
  const other = p.receive('item/completed', { ...frame, item: item('other', 'ls ' + '~' + '/Pictures') });
  assert.equal((other[0] as any).denied, undefined);
  assert.doesNotMatch(JSON.stringify(named), /private-data/);
});

test('late command output after turn completion is ignored', () => {
  const p = new NativeTurnEvents('thread');
  p.receive('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'completed' } });
  assert.deepEqual(p.receive('item/commandExecution/outputDelta', { ...frame, itemId: 'x', delta: 'late' }), []);
});
