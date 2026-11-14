import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { createScimHandler, type DirectoryPerson, type IdentityDirectory } from '../src/composition/identity-scim.ts';

test('SCIM deactivation awaits access revocation, refuses role escalation and keeps directory credentials scoped', async () => {
  const people = new Map<string, DirectoryPerson>();
  let revocations = 0, release!: () => void;
  const revoked = new Promise<void>(resolve => { release = resolve; });
  const directory: IdentityDirectory = {
    async remove(id){return people.delete(id);},
    async list() { return [...people.values()]; },
    async get(id) { return people.get(id) ?? null; },
    async create(person) { const added = { ...person, id: 'person-id' }; people.set(added.id, added); return added; },
    async update(id, change) {
      const person = people.get(id);
      if (!person) return null;
      const updated = await change({ ...person });
      if (!updated.active && person.active) { revocations++; await revoked; }
      people.set(id, updated);
      return updated;
    },
  };
  const bearer = randomBytes(32).toString('base64url');
  const handle = createScimHandler({ bearer, directory });
  const call = (method: string, path: string, body?: unknown, token = bearer) => handle(new Request(`https://app.example.invalid/scim/v2/${path}`, {
    method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/scim+json' }, body: body === undefined ? undefined : JSON.stringify(body),
  }));
  assert.equal((await call('POST', 'Users', { userName: 'ada', active: true }, 'wrong')).status, 401);
  assert.equal(people.size, 0);
  const otherDirectory = createScimHandler({ bearer: randomBytes(32).toString('base64url'), directory });
  assert.equal((await otherDirectory(new Request('https://app.example.invalid/scim/v2/Users', { headers: { authorization: `Bearer ${bearer}` } }))).status, 401);
  assert.equal((await call('POST', 'Users', { userName: 'ada', roles: [{ value: 'owner' }] })).status, 400);
  assert.equal((await call('POST', 'Users', { userName: 'ada', externalId: 'directory-subject', active: true })).status, 201);
  assert.equal((await call('GET', 'Users?filter=userName%20eq%20%22ada%22').then(r => r.json())).totalResults, 1);
  assert.equal((await call('GET', 'Users/person-id', undefined, 'wrong')).status, 401);
  assert.equal((await call('PATCH', 'Users/person-id', { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'replace', path: 'roles', value: [{ value: 'owner' }] }] })).status, 400);
  let settled = false;
  const disabling = call('PATCH', 'Users/person-id', { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'replace', path: 'active', value: false }] }).then(response => { settled = true; return response; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'directory removal cannot acknowledge before revocation commits');
  release();
  assert.equal((await disabling).status, 200);
  assert.equal(people.get('person-id')?.active, false);
  assert.equal(revocations, 1);
  assert.equal((await call('PUT', 'Users/person-id', { userName: 'ada', externalId: 'directory-subject', active: true })).status, 409, 'removed access is never resurrected by a stale sync');
  assert.equal((await call('DELETE', 'Users/person-id')).status, 204);
  assert.equal((await call('GET', 'Users?workspace=other')).status, 400);
  assert.equal((await call('POST', 'Users', { userName: 'x'.repeat(70_000) })).status, 413);
  const broken = createScimHandler({ bearer, directory: { ...directory, async remove() { throw new Error('private database details'); } } });
  const failure = await broken(new Request('https://app.example.invalid/scim/v2/Users/person-id', { method: 'DELETE', headers: { authorization: `Bearer ${bearer}` } }));
  assert.equal(failure.status, 503);
  assert.doesNotMatch(await failure.text(), /private database details/);
});
