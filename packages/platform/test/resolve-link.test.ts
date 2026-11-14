// An answer's absolute or file: link resolves on the platform, which knows each project's folder:
// to a document of that project, or refused. The renderer never learns the folder.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { b64, freshDir, idle, open, settings, value } from './helpers.ts';

async function twoProjects() {
  const { host, home } = open();
  const made = [];
  for (const name of ['Q4 review', 'Other']) {
    const p = value(await host.call('projects.create', { name, kind: 'folder' }));
    const sent = value(await host.call('turns.send', { projectId: p.id, text: 'Write an editable brief', attachments: [], settings, clientKey: `brief-${name}` }));
    await idle(host, sent.threadId);
    made.push(p);
  }
  const stored = JSON.parse(readFileSync(join(home, 'projects.json'), 'utf8')) as { id: string; dir: string }[];
  const root = (id: string) => join(home, 'projects', stored.find((p) => p.id === id)!.dir);
  const brief = async (projectId: string) => (await host.call('material.list', { projectId })).find((m) => m.name === 'brief.md')!;
  return { host, home, a: made[0], b: made[1], root, brief };
}

test('an absolute or local file: path inside the project folder resolves to that project\'s document', async () => {
  const { host, a, root, brief } = await twoProjects();
  const want = await brief(a.id);
  const path = join(root(a.id), 'brief.md');
  for (const href of [path, pathToFileURL(path).href, `file://localhost${pathToFileURL(path).pathname}`, `${path}#L3`, `${root(a.id)}/./brief.md`]) {
    const r = value(await host.call('files.resolveLink', { projectId: a.id, href }));
    assert.deepEqual(r, { materialId: want.id, path: 'brief.md' }, href);
  }
  mkdirSync(join(root(a.id), 'notes'));
  assert.equal(value(await host.call('files.resolveLink', { projectId: a.id, href: `${root(a.id)}/notes/../brief.md` })).materialId, want.id);
});

test('nothing outside this project\'s folder resolves: another project, escapes, symlinks, other places', async () => {
  const { host, home, a, b, root } = await twoProjects();
  const inside = root(a.id);
  const outside = freshDir('resolve-outside-');
  writeFileSync(join(outside, 'secret.md'), '# secret');
  // A link inside the project to a file outside it, and to the other project's brief.
  symlinkSync(join(outside, 'secret.md'), join(inside, 'secret.md'));
  symlinkSync(join(root(b.id), 'brief.md'), join(inside, 'theirs.md'));
  // A link outside the project to this project's brief: its address is not in this project.
  symlinkSync(join(inside, 'brief.md'), join(outside, 'mine.md'));
  for (const href of [
    join(root(b.id), 'brief.md'), pathToFileURL(join(root(b.id), 'brief.md')).href,
    `${inside}/../${root(b.id).split('/').at(-1)!}/brief.md`, `${inside}/../../projects.json`,
    join(inside, 'secret.md'), join(inside, 'theirs.md'), join(outside, 'mine.md'), join(outside, 'secret.md'),
    join(inside, 'missing.md'), inside, join(home, 'projects.json'), '/etc/passwd', 'file:///etc/passwd',
    `file://elsewhere${pathToFileURL(join(inside, 'brief.md')).pathname}`, 'brief.md', './brief.md', ['~', 'brief.md'].join('/'),
    'https://example.com/brief.md', `${join(inside, 'brief.md')}\u0000`, join(inside, 'brief.md').replaceAll('/', '\\'), '',
  ]) {
    const r = await host.call('files.resolveLink', { projectId: a.id, href });
    assert.equal(r.ok, false, href);
  }
  const unknown = await host.call('files.resolveLink', { projectId: 'nope', href: join(inside, 'brief.md') });
  assert.equal(!unknown.ok && unknown.reason, 'NOT_FOUND');
});
