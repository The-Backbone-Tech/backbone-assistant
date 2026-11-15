import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { ThreadJournal } from '../src/composition/thread-journal.ts';
import { withHomeLock } from '../src/composition/home-lock.ts';
import { createTerminal } from '../src/composition/terminal-stream.ts';
import type { Args, Method } from '../src/api.ts';
import { open, value, idle, settings, freshHome } from './helpers.ts';
import { IdentityRefused } from '../src/composition/identity-core.ts';
import { CoreLink } from '../src/composition/core.ts';
import { createHost, hostClosed } from '../src/composition/host.ts';
import { METHODS } from '../src/api.ts';
import { serveIdentityApi } from '../src/composition/identity-http.ts';
import { identityProviderFixture } from './identity-provider-fixture.ts';

const calls = (projectId: string, id: string) => [
  ['terminal.run', { projectId, command: 'printf authority' }],
  ['terminal.start', { projectId, command: 'printf authority', clientKey: randomUUID() }],
  ['terminal.list', { projectId }], ['terminal.clear', { projectId }], ['terminal.stop', { projectId, id }],
] as const;

test('terminal calls retain device-owner admission; viewers, editors, invalid and removed sessions cannot run, read or stop the owner command', async () => {
  const { host } = open();
  const projectId = value(await host.call('projects.create', { name: 'Terminal authority', kind: 'folder' })).id;
  const block = value(await host.call('terminal.start', { projectId, command: 'printf ready; sleep 20', clientKey: randomUUID() }));
  try {
    for (const role of ['guest', 'member', 'admin'] as const) {
      const invite = value(await host.call('identity.invite', { role }));
      const member = value(await host.acceptInvitation(invite.token, 'Terminal colleague'));
      if (role === 'guest') await assert.rejects(host.call('identity.share', { projectId, personId: member.person.id, access: 'editor' }), /guests only view/);
      for (const access of role === 'guest' ? ['viewer'] as const : ['viewer', 'editor'] as const) {
        value(await host.call('identity.share', { projectId, personId: member.person.id, access }));
        for (const [method, args] of calls(projectId, block.id)) await assert.rejects(host.callAuthenticated(member.session, method, args as Args<typeof method>), IdentityRefused, `${role}/${access}/${method}`);
      }
      value(await host.call('identity.remove', { personId: member.person.id }));
      for (const [method, args] of calls(projectId, block.id)) await assert.rejects(host.callAuthenticated(member.session, method, args as Args<typeof method>), IdentityRefused);
    }
    for (const token of ['', 'not-a-session']) for (const [method, args] of calls(projectId, block.id)) await assert.rejects(host.callAuthenticated(token, method, args as Args<typeof method>), IdentityRefused);
    const other = value(await host.call('projects.create', { name: 'Other terminal', kind: 'folder' })).id;
    assert.equal((await host.call('terminal.stop', { projectId: other, id: block.id })).ok, false);
    assert.equal(value(await host.call('terminal.list', { projectId })).commands[0].status, 'running');
    assert.equal(value(await host.call('terminal.clear', { projectId })).commands[0].id, block.id);
    assert.equal((await host.call('terminal.run', { projectId, command: 'printf second' })).ok, false);
  } finally {
    value(await host.call('terminal.stop', { projectId, id: block.id }));
    const deadline = Date.now() + 12_000;
    while (value(await host.call('terminal.list', { projectId })).commands[0].status === 'running') {
      assert.ok(Date.now() < deadline, 'the test command ends before its data folder is removed');
      await new Promise(r => setTimeout(r, 20));
    }
  }
});

test('company configuration keeps local device authority but a company sign-in session cannot use any terminal call', async () => {
  const provider = await identityProviderFixture();
  try {
    const { host } = open(undefined, { identity: { company: { issuer: provider.issuer, clientId: 'fixture', redirectUri: 'http://127.0.0.1/callback', allowLoopbackHttp: true } } });
    const projectId = value(await host.call('projects.create', { name: 'Company terminal', kind: 'folder' })).id;
    assert.equal(value(await host.call('terminal.run', { projectId, command: 'printf local-owner' })).output, 'local-owner');
    const invitation = value(await host.call('identity.invite', { role: 'member' }));
    const authorization = await host.beginCompanySignIn('terminal-test');
    const member = value(await host.completeCompanySignIn(provider.callback(authorization, 'terminal-member'), 'terminal-test', invitation.token));
    value(await host.call('identity.share', { projectId, personId: member.person.id, access: 'editor' }));
    for (const [method, args] of calls(projectId, 'command')) await assert.rejects(host.callAuthenticated(member.session, method, args as Args<typeof method>), IdentityRefused);
    assert.equal(value(await host.call('terminal.list', { projectId })).commands[0].status, 'succeeded');
  } finally { await provider.close(); }
});

test('pending rewind refuses start but permits list and Stop; withdrawal does not widen file access', async () => {
  const { host } = open();
  const projectId = value(await host.call('projects.create', { name: 'Terminal rewind', kind: 'folder' })).id;
  const original = value(await host.call('material.attach', { projectId, name: 'original.txt', mediaType: 'text/plain', base64: Buffer.from('private-original').toString('base64') }));
  value(await host.call('material.lifecycle', { id: original.id, version: 1, lifecycle: 0, state: 'withdrawn' }));
  const read = value(await host.call('terminal.run', { projectId, command: 'cat original.txt' }));
  assert.notEqual(read.code, 0); assert.doesNotMatch(read.output, /private-original/);
  const first = value(await host.call('turns.send', { projectId, text: 'Write a first brief', settings, attachments: [], clientKey: randomUUID() }));
  await idle(host, first.threadId);
  value(await host.call('turns.send', { projectId, threadId: first.threadId, text: 'Write a later brief', settings, attachments: [], clientKey: randomUUID() }));
  const thread = await idle(host, first.threadId), file = thread.turns.at(-1)!.answer!.files[0];
  const args = { threadId: first.threadId, turnId: first.turnId }, plan = value(await host.call('threads.rewindPreview', args));
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(r => { release = r; }), ready = new Promise<void>(r => { entered = r; });
  const revise = CoreLink.prototype.reviseDocument;
  CoreLink.prototype.reviseDocument = async function(id, content) { if (id === file.materialId) { entered(); await held; } return revise.call(this, id, content); };
  const action = host.call('threads.rewind', { ...args, revision: plan.revision, clientKey: randomUUID(), choices: [] });
  try {
    await Promise.race([ready, action.then(() => { throw new Error('Rewind did not reach the controlled wait'); })]);
    for (const [method, input] of calls(projectId, 'missing')) {
      const r = await host.call(method as Method, input as never) as import('../src/api.ts').Receipt<unknown>;
      if (method === 'terminal.list' || method === 'terminal.clear') assert.equal(r.ok, true, method);
      else if (method === 'terminal.stop') { assert.equal(r.ok, false); if (!r.ok) assert.match(r.detail, /no such running command/); }
      else { assert.equal(r.ok, false, method); if (!r.ok) assert.match(r.detail, /pending rewind/); }
    }
  } finally { release(); CoreLink.prototype.reviseDocument = revise; await action; }
});


test('a rewind cannot begin while a terminal command runs in its project', async () => {
  const { host } = open();
  const projectId = value(await host.call('projects.create', { name: 'Running terminal', kind: 'folder' })).id;
  const first = value(await host.call('turns.send', { projectId, text: 'First', settings, attachments: [], clientKey: randomUUID() }));
  await idle(host, first.threadId);
  value(await host.call('turns.send', { projectId, threadId: first.threadId, text: 'Later', settings, attachments: [], clientKey: randomUUID() }));
  await idle(host, first.threadId);
  const args = { threadId: first.threadId, turnId: first.turnId };
  const plan = value(await host.call('threads.rewindPreview', args));
  const command = value(await host.call('terminal.start', { projectId, command: 'sleep 30', clientKey: randomUUID() }));
  try {
    const refused = await host.call('threads.rewind', { ...args, revision: plan.revision, choices: [], clientKey: randomUUID() });
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.detail, 'A terminal command is running in this project; stop it in Terminal first.');
  } finally { value(await host.call('terminal.stop', { projectId, id: command.id })); }
});

test('terminal methods are registered and retain read-only, closing and import admission before dispatch', async () => {
  const home = freshHome(), writable = open(home).host;
  const projectId = value(await writable.call('projects.create', { name: 'Admission', kind: 'folder' })).id;
  for (const [method] of calls(projectId, 'missing')) assert.ok(METHODS.includes(method), method);
  value(await writable.call('terminal.list', { projectId }));
  writable.close(); await hostClosed(home);
  const readOnly = createHost({ home, readOnly: true });
  try {
    for (const [method, args] of calls(projectId, 'missing')) {
      const r = await readOnly.call(method, args as never);
      assert.equal(r.ok, false); if (!r.ok) assert.match(r.detail, /read.only/i);
    }
  } finally { readOnly.close(); await hostClosed(home); }
  for (const [method, args] of calls(projectId, 'missing')) await assert.rejects(writable.call(method, args as never), /closing/);
  const importer = open().host;
  const importing = importer.importExport('/does-not-exist', '').catch(() => {});
  for (const [method, args] of calls(projectId, 'missing')) await assert.rejects(importer.call(method, args as never), /import holds/);
  await importing;
});

test('the joined-workspace HTTP bridge refuses registered terminal methods for a real editor session', async () => {
  const { host } = open();
  const projectId = value(await host.call('projects.create', { name: 'HTTP terminal', kind: 'folder' })).id;
  value(await host.call('terminal.run', { projectId, command: 'printf owner' }));
  const invite = value(await host.call('identity.invite', { role: 'member' }));
  const joined = value(await host.acceptInvitation(invite.token, 'HTTP terminal editor'));
  value(await host.call('identity.share', { projectId, personId: joined.person.id, access: 'editor' }));
  const server = await serveIdentityApi({ host });
  try {
    for (const [method, args] of calls(projectId, 'missing')) {
      assert.ok(METHODS.includes(method));
      const response = await fetch(server.origin + '/api', { method: 'POST', headers: { authorization: `Bearer ${joined.session}`, 'content-type': 'application/json' }, body: JSON.stringify({ method, args }) });
      assert.equal(response.status, 403, method);
      const body = await response.json(); assert.equal(body.outcome, 'REFUSED'); assert.equal(body.accessEnded, false);
    }
    const response = await fetch(server.origin + '/api', { method: 'POST', headers: { authorization: `Bearer ${joined.session}`, 'content-type': 'application/json' }, body: JSON.stringify({ method: 'terminal.unknown', args: {} }) });
    assert.equal(response.status, 503, 'unknown methods must be distinguishable from registered refused calls');
  } finally { await server.close(); }
});


test('a recovered running command can actually be stopped while its project has a pending rewind', async () => {
  const { host: firstHost, home } = open();
  const projectId = value(await firstHost.call('projects.create', { name: 'Recovered pending terminal', kind: 'folder' })).id;
  const first = value(await firstHost.call('turns.send', { projectId, text: 'First', settings, attachments: [], clientKey: randomUUID() }));
  await idle(firstHost, first.threadId);
  value(await firstHost.call('turns.send', { projectId, threadId: first.threadId, text: 'Later', settings, attachments: [], clientKey: randomUUID() }));
  await idle(firstHost, first.threadId);
  const plan = value(await firstHost.call('threads.rewindPreview', { threadId: first.threadId, turnId: first.turnId }));
  const cwd = value(await firstHost.call('terminal.list', { projectId })).cwd;
  firstHost.close(); await hostClosed(home);
  const module = new URL('../src/composition/terminal-stream.ts', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import {createTerminal} from ${JSON.stringify(module)}; const terminal=createTerminal({home:process.argv[1],directory:()=>process.argv[2],exists:()=>true,changed(){}}); await terminal.start({projectId:process.argv[3],command:'printf recovered; sleep 60',clientKey:'pending-command'}); console.log('ready'); setInterval(()=>{},1000);`, home, cwd, projectId], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise<void>((resolve, reject) => { child.stdout!.once('data', () => resolve()); child.once('error', reject); });
  } finally { child.kill('SIGKILL'); await new Promise<void>(resolve => child.once('close', () => resolve())); }
  // An interrupted older composition can contain both records. Rebuild through the owning journal.
  await withHomeLock(home, async () => { new ThreadJournal(home).append({ kind: 'thread.rewind.started', threadId: first.threadId, record: { id: 'pending-with-terminal', turnId: first.turnId, files: plan.files, turns: plan.turns, clientKeys: [], sideTurns: [], choices: [] } }); });
  const { host } = open(home);
  try {
    const block = value(await host.call('terminal.list', { projectId })).commands[0];
    assert.equal(block.status, 'running');
    const start = await host.call('terminal.start', { projectId, command: 'echo refused', clientKey: randomUUID() });
    assert.equal(start.ok, false); if (!start.ok) assert.match(start.detail, /pending rewind/);
    value(await host.call('terminal.stop', { projectId, id: block.id }));
    const deadline = Date.now() + 12_000;
    while (value(await host.call('terminal.list', { projectId })).commands[0].status === 'running') {
      assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(value(await host.call('terminal.list', { projectId })).commands[0].detail, 'Stopped by you');
  } finally {
    host.close(); await hostClosed(home);
    const cleanup = createTerminal({ home, directory: () => cwd, exists: () => true, changed() {} });
    await cleanup.list(projectId); await cleanup.close();
  }
});
