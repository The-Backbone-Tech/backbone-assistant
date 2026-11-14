import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { open, value, idle, settings } from './helpers.ts';
import { CoreLink } from '../src/composition/core.ts';
import { hostClosed } from '../src/composition/host.ts';
import { ThreadJournal } from '../src/composition/thread-journal.ts';
import { assertHomeWriteAdmission, withHomeLock } from '../src/composition/home-lock.ts';

async function fixture(t: TestContext) {
  let link!: CoreLink;
  const read = CoreLink.prototype.read;
  const tap = t.mock.method(CoreLink.prototype, 'read', function(this: CoreLink, ...args: Parameters<typeof read>) { link = this; return read.apply(this, args); });
  const f = open();
  const project = value(await f.host.call('projects.create', { name: 'Checked team', kind: 'folder' }));
  await f.host.call('identity.get', {});
  tap.mock.restore();
  const member = value(await f.host.acceptInvitation(value(await f.host.call('identity.invite', { role: 'member' })).token, 'Member'));
  const viewer = value(await f.host.acceptInvitation(value(await f.host.call('identity.invite', { role: 'guest' })).token, 'Viewer'));
  for (const [personId, access] of [[member.person.id, 'editor'], [viewer.person.id, 'viewer']] as const) value(await f.host.call('identity.share', { projectId: project.id, personId, access }));
  const own = value(await f.host.call('turns.send', { projectId: project.id, text: 'Own work', attachments: [], settings, clientKey: 'own' }));
  await idle(f.host, own.threadId);
  const other = value(await f.host.callAuthenticated(member.session, 'turns.send', { projectId: project.id, text: 'Member work', attachments: [], settings, clientKey: 'other' }));
  await idle(f.host, other.threadId);
  const automation = value(await f.host.call('identity.automation.create', { projectId: project.id, personId: value(await f.host.call('identity.get', {})).person.id, name: 'Own automation' }));
  const automated = value(await f.host.call('identity.automation.run', { id: automation.id, text: 'Automated work' }));
  await idle(f.host, automated.threadId);
  f.host.close(); await hostClosed(f.home);
  await withHomeLock(f.home, async () => {
    assertHomeWriteAdmission(f.home);
    const journal = new ThreadJournal(f.home);
    for (const sent of [own, other, automated]) journal.append({ kind: 'turn.closed', threadId: sent.threadId, turnId: sent.turnId, state: { status: 'stopped', effects: [], unknownOutcome: true, unknownEvidence: { connectorEffects: [], other: true } } });
  });
  const host = open(f.home).host;
  const tap2 = t.mock.method(CoreLink.prototype, 'read', function(this: CoreLink, ...args: Parameters<typeof read>) { link = this; return read.apply(this, args); });
  await host.call('identity.get', {}); tap2.mock.restore();
  return { ...f, host, link, project, member, viewer, own, other, automated };
}

test('shared unknown checks belong only to the conversation owner on the device', async t => {
  const f = await fixture(t);
  assert.ok(value(await f.host.call('threads.get', { id: f.own.threadId })).turns[0].unknownCheck);
  for (const sent of [f.other, f.automated]) {
    assert.equal(value(await f.host.call('threads.get', { id: sent.threadId })).turns[0].unknownCheck, undefined);
    assert.equal((await f.host.unknownChecks.question(sent)).ok, false);
    assert.equal((await f.host.unknownChecks.check({ ...sent, revision: 'forged' })).ok, false);
  }
  for (const person of [f.member, f.viewer]) {
    assert.equal(value(await f.host.callAuthenticated(person.session, 'threads.get', { id: f.own.threadId })).turns[0].unknownCheck, undefined);
    await assert.rejects(f.host.callAuthenticated(person.session, 'threads.checked' as never, f.own as never));
    const result = await f.link.identities.asPerson(person.person.id, () => f.host.unknownChecks.question(f.own));
    assert.equal(result.ok, false);
  }
  const automation = value(await f.host.call('identity.automations', {}))[0];
  assert.equal((await f.link.identities.asAutomation(automation, () => f.host.unknownChecks.question(f.own))).ok, false);
  const q = value(await f.host.unknownChecks.question(f.own));
  const withdrawn = new AbortController(); withdrawn.abort();
  assert.equal((await f.host.unknownChecks.check({ ...f.own, revision: q.revision }, withdrawn.signal)).ok, false);
  const mark = value(await f.host.unknownChecks.check({ ...f.own, revision: q.revision }));
  assert.equal(mark.by, value(await f.host.call('identity.get', {})).person.id);
  assert.equal(value(await f.host.call('threads.get', { id: f.own.threadId })).turns[0].status, 'stopped');
});


test('the Full access card audience follows live project sharing and revocation', async () => {
  const { host } = open();
  const project = value(await host.call('projects.create', { name: 'Card audience', kind: 'folder' }));
  assert.equal(value(await host.call('identity.sharing', { projectId: project.id })).nativeAccountTools, true);
  const colleague = value(await host.acceptInvitation(value(await host.call('identity.invite', { role: 'member' })).token, 'Colleague'));
  value(await host.call('identity.share', { projectId: project.id, personId: colleague.person.id, access: 'viewer' }));
  assert.equal(value(await host.call('identity.sharing', { projectId: project.id })).nativeAccountTools, false);
  assert.equal(value(await host.callAuthenticated(colleague.session, 'identity.get', {})).deviceOwner, false);
  value(await host.call('identity.share', { projectId: project.id, personId: colleague.person.id, access: null }));
  assert.equal(value(await host.call('identity.sharing', { projectId: project.id })).nativeAccountTools, true);
});
