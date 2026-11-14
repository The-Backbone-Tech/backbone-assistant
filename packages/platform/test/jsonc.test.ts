// The careful JSON-with-comments edit Cursor's settings get (jsonc-parser's modify and applyEdits): only our member and the comma it needs
// change; every comment and whitespace span around it stays.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseJsonc, removeMember, setMember } from '../src/tools/jsonc.ts';

const ours = { command: '/data/bin/backbone-mcp', args: ['serve'], env: { BACKBONE_HOME: '/data' } };
const servers = (text: string) => (parseJsonc(text) as { mcpServers: Record<string, unknown> }).mcpServers;

test('removing the last member keeps the comments before and after it', () => {
  const text = '{\n  "mcpServers": {\n    "linear": { "url": "x" }, // remote\n    // about the next one\n    "backbone": {"command": "b"} // trailing\n    /* after it */\n  }\n}\n';
  const out = removeMember(text, ['mcpServers'], 'backbone');
  for (const c of ['// remote', '// about the next one', '// trailing', '/* after it */']) assert.ok(out.includes(c), `${c} kept in:\n${out}`);
  assert.deepEqual(servers(out), { linear: { url: 'x' } });
});

test('removing a middle or only member keeps the comments around it', () => {
  const middle = '{\n  "mcpServers": {\n    // first\n    "a": 1,\n    // ours\n    "backbone": 2, // same line\n    // last\n    "z": 3\n  }\n}\n';
  const out = removeMember(middle, ['mcpServers'], 'backbone');
  for (const c of ['// first', '// ours', '// last']) assert.ok(out.includes(c), c);
  assert.deepEqual(servers(out), { a: 1, z: 3 });
  const only = '{\n  "mcpServers": {\n    /* inside, before */\n    "backbone": 2\n    // inside, after\n  }\n}\n';
  const alone = removeMember(only, ['mcpServers'], 'backbone');
  assert.ok(alone.includes('/* inside, before */') && alone.includes('// inside, after'), alone);
  assert.deepEqual(servers(alone), {});
});

test('adding to an empty object keeps the comments inside it', () => {
  for (const text of ['{\n  "mcpServers": { /* none yet */ }\n}\n', '{\n  "mcpServers": {\n    // none yet\n  }\n}\n', '{ // nothing here\n}\n']) {
    const out = setMember(text, ['mcpServers'], 'backbone', ours);
    assert.ok(out.includes('none yet') || out.includes('nothing here'), out);
    assert.deepEqual(servers(out).backbone, ours);
  }
});

test('adding after a member with a line comment leaves that comment on its line, and removing restores the bytes', () => {
  for (const text of [
    '{\n  "mcpServers": {\n    "linear": { "url": "x" } // remote\n  }\n}\n',
    '{\n  "mcpServers": {\n    "linear": { "url": "x" }, // remote\n  },\n  /* keep me */\n  "theme": "dark"\n}\n',
    '{\n\t"mcpServers": {\n\t\t"a": 1\n\t}\n}',
  ]) {
    const added = setMember(text, ['mcpServers'], 'backbone', ours);
    assert.match(added, /"url": "x" \},? \/\/ remote\n|"a": 1,\n/);
    assert.deepEqual(servers(added).backbone, ours);
    assert.equal(removeMember(added, ['mcpServers'], 'backbone'), text);
  }
});

test('jsonc-parser’s own modify drops a comment between members, so only its parser and applyEdits are used', async () => {
  const { applyEdits, modify } = await import('jsonc-parser');
  const text = '{\n  "mcpServers": {\n    "linear": 1,\n    // about the next one\n    "backbone": 2\n  }\n}\n';
  assert.ok(!applyEdits(text, modify(text, ['mcpServers', 'backbone'], undefined, {})).includes('about the next one'), 'upstream keeps it now: use modify');
  assert.ok(removeMember(text, ['mcpServers'], 'backbone').includes('about the next one'));
});

test('a comment between our value and its comma stays; only the comma goes with the member', () => {
  for (const text of [
    '{\n  "mcpServers": {\n    "backbone-door":{} /* KEEP */,\n    "a": 1\n  }\n}\n',
    '{"mcpServers":{"backbone-door":{} /* KEEP */,"a":1}}',
    '{\n  "mcpServers": {\n    "a": 1,\n    "backbone-door": {} // KEEP\n  }\n}\n',
  ]) {
    const out = removeMember(text, ['mcpServers'], 'backbone-door');
    assert.ok(out.includes('KEEP'), out);
    assert.deepEqual(servers(out), { a: 1 });
  }
});
