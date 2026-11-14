// "Last turn" changes belong to one project: a thread from another project, or a file that is not
// this project's, is never shown under it (reported by a consumer thread, 5 November).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { idle, open, settings, value } from './helpers.ts';

test('last-turn changes refuse a thread from another project, and still show the project\'s own', async () => {
  const { host } = open();
  const a = value(await host.call('projects.create', { name: 'Project A', kind: 'folder' }));
  const b = value(await host.call('projects.create', { name: 'Project B', kind: 'folder' }));
  const sent = value(await host.call('turns.send', { projectId: b.id, text: 'Write an editable brief', attachments: [], settings, clientKey: 'private-b' }));
  const done = await idle(host, sent.threadId);
  assert.equal(done.turns.at(-1)?.effects[0]?.outcome, 'DONE');
  const own = value(await host.call('changes.get', { projectId: b.id, threadId: sent.threadId, scope: 'last-turn' }));
  assert.ok(own.files.length, 'the control: the thread\'s own project sees its change');
  const crossed = await host.call('changes.get', { projectId: a.id, threadId: sent.threadId, scope: 'last-turn' });
  assert.equal(crossed.ok, false, 'a thread of project B is not read as project A');
  assert.doesNotMatch(JSON.stringify(crossed), /brief/i, 'and the refusal shows nothing of it');
  const unknown = await host.call('changes.get', { projectId: a.id, threadId: 'no-such-thread', scope: 'last-turn' });
  assert.equal(unknown.ok, false, 'a thread that does not exist is refused, not answered as empty');
});

test('a thread moved into another project shows none of its old project\'s documents', async () => {
  const { host } = open();
  const a = value(await host.call('projects.create', { name: 'Project A', kind: 'folder' }));
  const b = value(await host.call('projects.create', { name: 'Project B', kind: 'folder' }));
  const sent = value(await host.call('turns.send', { projectId: b.id, text: 'Write an editable brief', attachments: [], settings, clientKey: 'moved' }));
  await idle(host, sent.threadId);
  assert.ok(value(await host.call('changes.get', { projectId: b.id, threadId: sent.threadId, scope: 'last-turn' })).files.length, 'the control, before the move');
  value(await host.call('threads.update', { id: sent.threadId, patch: { projectId: a.id } }));
  const moved = value(await host.call('changes.get', { projectId: a.id, threadId: sent.threadId, scope: 'last-turn' }));
  assert.deepEqual(moved.files, [], 'B\'s brief is not shown under A');
});

test('an untracked link in a repository shows where it points, never what it points to', async () => {
  const { host } = open();
  const other = value(await host.call('projects.create', { name: 'Other', kind: 'git' }));
  value(await host.call('terminal.run', { projectId: other.id, command: 'printf "private words\\n" > private.md' }));
  const target = value(await host.call('terminal.run', { projectId: other.id, command: 'pwd' })).output.trim();
  const repo = value(await host.call('projects.create', { name: 'Repo', kind: 'git' }));
  value(await host.call('terminal.run', { projectId: repo.id, command: `ln -s '${target}/private.md' leak.md` }));
  for (const scope of ['uncommitted', 'unstaged', 'branch'] as const) {
    const changes = value(await host.call('changes.get', { projectId: repo.id, scope }));
    assert.deepEqual(changes.files.map((f) => f.path), ['leak.md'], scope);
    assert.doesNotMatch(changes.files[0]!.patch, /private words/, scope);
    assert.match(changes.files[0]!.patch, /private\.md/, `${scope}: the link's target name, as git shows it`);
  }
});

test('an untracked hard link, binary, large file or pipe shows a line saying so, never foreign or raw bytes, and never blocks', async () => {
  const { host } = open();
  const other = value(await host.call('projects.create', { name: 'Other', kind: 'git' }));
  value(await host.call('terminal.run', { projectId: other.id, command: 'printf "private words\\n" > private.md' }));
  const target = value(await host.call('terminal.run', { projectId: other.id, command: 'pwd' })).output.trim();
  const repo = value(await host.call('projects.create', { name: 'Repo', kind: 'git' }));
  value(await host.call('terminal.run', { projectId: repo.id, command: `ln '${target}/private.md' hard.md && printf 'a\\000b\\n' > bin.dat && head -c 2000000 /dev/zero | tr '\\000' a > big.txt && mkfifo pipe && printf 'plain\\n' > plain.md` }));
  const changes = value(await host.call('changes.get', { projectId: repo.id, scope: 'uncommitted' }));
  const by = Object.fromEntries(changes.files.map((f) => [f.path, f.patch]));
  assert.deepEqual(Object.keys(by).sort(), ['big.txt', 'bin.dat', 'hard.md', 'plain.md'], 'the pipe is not read');
  assert.doesNotMatch(by['hard.md']!, /private words/);
  assert.match(by['hard.md']!, /other names/);
  assert.match(by['bin.dat']!, /binary/);
  assert.doesNotMatch(by['bin.dat']!, /\u0000/);
  assert.match(by['big.txt']!, /large file/);
  assert.ok(by['big.txt']!.length < 1000);
  assert.match(by['plain.md']!, /\+plain/, 'the control: an ordinary file shows its text');
});
