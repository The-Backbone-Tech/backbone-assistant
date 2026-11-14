import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FileLink, ProjectFile } from '@backbone-next/platform';
import { fileUrlsAsPaths, linkKey, resolveLink, workspaceLinks, type LinkContext } from '../src/lib/workspace-links.ts';

const files: ProjectFile[] = [
  { path: 'brief.md', class: 'working', materialId: 'brief' },
  { path: 'notes/plan v2.md', class: 'accepted', materialId: 'plan' },
  { path: 'tracked.txt', class: 'working' },
];
const touched: FileLink[] = [{ materialId: 'brief', name: 'brief.md', version: 3 }];
// A home-relative path, spelled so no home literal sits in the source.
const HOME = ['~', ''].join('/');
const context: LinkContext = { projectId: 'q4', workspace: { projectId: 'q4', files }, touched };
const resolve = (href: string) => resolveLink(href, context);

test('a relative link to a workspace document opens it, at the version the turn touched', () => {
  assert.deepEqual(resolve('brief.md'), { kind: 'workspace', materialId: 'brief', version: 3, path: 'brief.md' });
  assert.deepEqual(resolve('./brief.md#L4'), { kind: 'workspace', materialId: 'brief', version: 3, path: 'brief.md' });
  assert.deepEqual(resolve('notes/plan%20v2.md'), { kind: 'workspace', materialId: 'plan', path: 'notes/plan v2.md' });
  assert.deepEqual(resolve('notes/../brief.md'), { kind: 'workspace', materialId: 'brief', version: 3, path: 'brief.md' });
});

test('an absolute path opens only what the platform resolved for this project; the app holds no folder of its own', () => {
  const abs = '/srv/someone/Backbone/projects/q4/brief.md';
  // Not yet resolved, or never: text.
  for (const href of [abs, '/srv/projects/other-project/brief.md', '/etc/passwd']) assert.deepEqual(resolve(href), { kind: 'blocked' }, href);
  const resolved: LinkContext['resolved'] = { projectId: 'q4', links: { [abs]: { materialId: 'brief', path: 'brief.md' } } };
  assert.deepEqual(resolveLink(abs, { ...context, resolved }), { kind: 'workspace', materialId: 'brief', version: 3, path: 'brief.md' });
  assert.deepEqual(resolveLink('/srv/projects/other-project/brief.md', { ...context, resolved }), { kind: 'blocked' });
  // A resolution is only as good as the current list: a document withdrawn or removed since, or a list not (yet) read, opens nothing.
  assert.deepEqual(resolveLink(abs, { ...context, workspace: { projectId: 'q4', files: files.slice(1) }, resolved }), { kind: 'blocked' });
  assert.deepEqual(resolveLink(abs, { ...context, workspace: undefined, resolved }), { kind: 'blocked' });
  // An answer that was resolved for another project opens nothing here.
  assert.deepEqual(resolveLink(abs, { ...context, projectId: 'b', workspace: { projectId: 'b', files }, resolved }), { kind: 'blocked' });
  // A home path is never asked about.
  assert.deepEqual(resolveLink(`${HOME}brief.md`, { ...context, resolved: { projectId: 'q4', links: { [`${HOME}brief.md`]: { materialId: 'brief', path: 'brief.md' } } } }), { kind: 'blocked' });
});

test('the rehype steps carry a local file: link as its path and report each absolute address to ask about', () => {
  const tree = { type: 'root', children: [a('file:///srv/x/projects/q4/brief.md', 'brief'), a('file://elsewhere/projects/q4/brief.md', 'remote'), a('/etc/passwd', 'passwd'), a('https://example.com', 'site')] };
  fileUrlsAsPaths()(tree as never);
  const [local, remote] = tree.children as El[];
  assert.equal(local.properties.href, '/srv/x/projects/q4/brief.md');
  assert.equal(remote.properties.href, undefined);
  const asked: string[] = [];
  workspaceLinks({ key: 'test', resolve, found: (href) => asked.push(href) })(tree as never);
  assert.deepEqual(asked, ['/srv/x/projects/q4/brief.md', '/etc/passwd']);
  assert.deepEqual((tree.children as El[]).map((n) => n.tagName), ['blocked-link', 'blocked-link', 'blocked-link', 'a']);
});

test('a file list from another project opens nothing in this answer', () => {
  const stale: LinkContext = { projectId: 'b', workspace: { projectId: 'q4', files }, touched: [] };
  assert.deepEqual(resolveLink('brief.md', stale), { kind: 'blocked' });
  assert.deepEqual(resolveLink('notes/plan v2.md', stale), { kind: 'blocked' });
  // Before this project's list arrives, nothing opens: a recorded name alone names no project.
  assert.deepEqual(resolveLink('brief.md', { projectId: 'q4', touched }), { kind: 'blocked' });
});

test('the resolver key changes whenever what a link can open changes', () => {
  const keys = new Set([
    linkKey(context),
    linkKey({ ...context, projectId: 'b', workspace: { projectId: 'b', files } }),
    linkKey({ ...context, workspace: undefined }),
    linkKey({ ...context, workspace: { projectId: 'q4', files: files.slice(1) } }),
    linkKey({ ...context, workspace: { projectId: 'q4', files: [{ ...files[0], materialId: 'other' }, ...files.slice(1)] } }),
    linkKey({ ...context, touched: [{ ...touched[0], version: 4 }] }),
    linkKey({ ...context, resolved: { projectId: 'q4', links: { '/x/brief.md': { materialId: 'brief', path: 'brief.md' } } } }),
  ]);
  assert.equal(keys.size, 7);
  assert.equal(linkKey({ ...context, workspace: { projectId: 'q4', files: [...files] } }), linkKey(context), 'a refetch of the same list keeps the rendering');
});

test('nothing outside the workspace becomes openable', () => {
  for (const href of [
    '/etc/passwd', 'file:///etc/passwd', '/etc/brief.md', 'file:///etc/brief.md', `${HOME}brief.md`, `${HOME}.ssh/id_ed25519`,
    '../brief.md', '../../etc/passwd', 'notes/../../brief.md', '/srv/x/projects/q4/../../secret/brief.md',
    'file://elsewhere/projects/q4/brief.md', 'C:\\Documents\\projects\\q4\\brief.md', 'C:/Documents/x/brief.md',
    'missing.md', 'tracked.txt', '%2e%2e/brief.md', 'brief.md%00', '',
  ]) assert.deepEqual(resolve(href), { kind: 'blocked' }, href);
});

test('external and in-page links keep their own handling', () => {
  for (const href of ['https://example.com/brief.md', 'http://example.com', 'mailto:a@example.com', '//example.com/x', '#section', 'javascript:alert(1)', 'data:text/html,x'])
    assert.deepEqual(resolve(href), { kind: 'external' }, href);
});

type El = { type: 'element'; tagName: string; properties: Record<string, unknown>; children: Node[] };
type Node = El | { type: 'text'; value: string };
const a = (href: string, text: string): El => ({ type: 'element', tagName: 'a', properties: { href }, children: [{ type: 'text', value: text }] });

test('the rehype step turns workspace links into openers and other local links into plain text', () => {
  const tree = { type: 'root', children: [{ type: 'element', tagName: 'p', properties: {}, children: [a('brief.md', 'the brief'), a('/etc/passwd', 'passwd'), a('https://example.com', 'site')] }] };
  workspaceLinks({ key: 'test', resolve })(tree as never);
  const [opener, blocked, external] = (tree.children[0] as El).children as El[];
  assert.equal(opener.tagName, 'workspace-link');
  assert.deepEqual(opener.properties, { dataMaterial: 'brief', dataVersion: '3', dataPath: 'brief.md' });
  assert.deepEqual(opener.children, [{ type: 'text', value: 'the brief' }]);
  assert.equal(blocked.tagName, 'blocked-link');
  assert.deepEqual(blocked.properties, {}, 'no address survives to be followed');
  assert.deepEqual(blocked.children, [{ type: 'text', value: 'passwd' }]);
  assert.deepEqual(external, a('https://example.com', 'site'));
});

test('an anchor with no address is plain text', () => {
  const tree = { type: 'root', children: [{ type: 'element', tagName: 'a', properties: {}, children: [{ type: 'text', value: 'stripped' }] }] };
  workspaceLinks({ key: 'test', resolve })(tree as never);
  assert.equal((tree.children[0] as El).tagName, 'blocked-link');
});

test('deferred local anchors carry inert text for current React resolution, leaving web handling intact', () => {
  const tree = { type: 'root', children: [a('brief.md', 'brief'), a('/etc/passwd', 'passwd'), a('https://example.com', 'site')] };
  workspaceLinks({ key: 'live', resolve, defer: true })(tree as never);
  const [relative, absolute, external] = tree.children as El[];
  assert.equal(relative.tagName, 'workspace-link');
  assert.deepEqual(relative.properties, { dataHref: 'brief.md' });
  assert.equal(absolute.tagName, 'workspace-link');
  assert.deepEqual(absolute.properties, { dataHref: '/etc/passwd' });
  assert.equal(external.tagName, 'a');
  assert.equal(external.properties.href, 'https://example.com');
});
