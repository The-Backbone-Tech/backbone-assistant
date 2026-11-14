import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {ApiLineProjectBudget,serveApiLine} from '../src/composition/api-line.ts';
import {attachApi} from '../src/doors/api-line.ts';

const input = {name:'Bounded project',kind:'folder',clientKey:'create'} as const;

test('project creation is bounded across connections and never queued after the limit', async t => {
  const home = mkdtempSync(join(tmpdir(), 'line-project-limit-'));
  let calls = 0, now = Date.now();
  const projectCreationBudget = new ApiLineProjectBudget();
  t.mock.method(Date, 'now', () => now);
  const server = await serveApiLine({home,projectCreation:true,projectCreationBudget,call:async () => {calls++; return {ok:true,value:{id:'project'}} as never;}});
  try {
    for (let window = 0; window < 10; window++) {
      for (let i = 0; i < 10; i++) {
        const client = await attachApi(home); assert.ok(client);
        try { assert.ok((await client.call('projects.create',{...input,clientKey:`${window}-${i}`})).ok); }
        finally {client.close();}
      }
      const client = await attachApi(home); assert.ok(client);
      try {
        const denied = await client.call('projects.create',{...input,clientKey:'over-limit'});
        assert.ok(!denied.ok); assert.equal(denied.outcome,'REFUSED');
        assert.match(denied.detail,/creation limit.*nothing was queued/i);
        assert.equal(calls,(window+1)*10);
      } finally {client.close();}
      now += 60_001;
    }
    const secondHome = mkdtempSync(join(tmpdir(), 'line-project-second-'));
    const second = await serveApiLine({home:secondHome,projectCreation:true,projectCreationBudget,call:async () => {calls++; return {ok:true} as never;}});
    const client = await attachApi(secondHome); assert.ok(client);
    try {
      const denied = await client.call('projects.create',input);
      assert.ok(!denied.ok); assert.match(denied.detail,/creation limit/i);
      assert.equal(calls,100,'the owner lifetime bound survives a fresh minute, connection and server');
    } finally {client.close(); await second.close(); rmSync(secondHome,{recursive:true,force:true});}
  } finally {await server.close(); rmSync(home,{recursive:true,force:true});}
});

test('a new line owner in the same process has its own creation budget', async () => {
  const home = mkdtempSync(join(tmpdir(), 'line-project-new-owner-'));
  const otherHome = mkdtempSync(join(tmpdir(), 'line-project-other-owner-'));
  let calls = 0;
  const server = await serveApiLine({home,projectCreation:true,projectCreationBudget:new ApiLineProjectBudget(),call:async () => {calls++; return {ok:true} as never;}});
  const other = await serveApiLine({home:otherHome,projectCreation:true,projectCreationBudget:new ApiLineProjectBudget(),call:async () => {calls++; return {ok:true} as never;}});
  const client = await attachApi(home); assert.ok(client);
  const otherClient = await attachApi(otherHome); assert.ok(otherClient);
  try {
    for (let i = 0; i < 10; i++) assert.ok((await client.call('projects.create',input)).ok);
    assert.ok(!(await client.call('projects.create',input)).ok);
    const created = await otherClient.call('projects.create',input);
    assert.ok(created.ok, 'another owner must not inherit an exhausted budget');
    assert.equal(calls,11);
  } finally {client.close(); otherClient.close(); await server.close(); await other.close(); rmSync(home,{recursive:true,force:true}); rmSync(otherHome,{recursive:true,force:true});}
});

test('one owner shares its minute budget across concurrent lines and replacement servers', async () => {
  const home = mkdtempSync(join(tmpdir(), 'line-project-owner-'));
  const otherHome = mkdtempSync(join(tmpdir(), 'line-project-owner-other-'));
  const projectCreationBudget = new ApiLineProjectBudget();
  let calls = 0;
  const call = async () => {calls++; return {ok:true} as never;};
  const server = await serveApiLine({home,projectCreation:true,projectCreationBudget,call});
  let other = await serveApiLine({home:otherHome,projectCreation:true,projectCreationBudget,call});
  const client = await attachApi(home); assert.ok(client);
  let otherClient = await attachApi(otherHome); assert.ok(otherClient);
  try {
    // Wire fields cannot replace the trusted owner's budget, including on a fresh connection.
    const replies = await Promise.all(Array.from({length:12}, (_, i) => (i % 2 ? client : otherClient!).call('projects.create', {...input, projectCreationBudget:{}} as typeof input)));
    assert.equal(replies.filter(reply => reply.ok).length,10);
    assert.equal(replies.filter(reply => !reply.ok && reply.outcome === 'REFUSED').length,2);
    assert.equal(calls,10);
    otherClient.close(); await other.close();
    other = await serveApiLine({home:otherHome,projectCreation:true,projectCreationBudget,call});
    otherClient = await attachApi(otherHome); assert.ok(otherClient);
    assert.ok(!(await otherClient.call('projects.create',input)).ok);
    assert.equal(calls,10,'replacing a server does not replenish its owner’s budget');
  } finally {client.close(); otherClient?.close(); await server.close(); await other.close(); rmSync(home,{recursive:true,force:true}); rmSync(otherHome,{recursive:true,force:true});}
});


test('a line enabling creation without its owner budget refuses to serve before writing', async t => {
  const home = mkdtempSync(join(tmpdir(), 'line-project-no-budget-'));
  t.after(() => rmSync(home, {recursive:true, force:true}));
  let server: Awaited<ReturnType<typeof serveApiLine>> | undefined;
  try {
    await assert.rejects(async () => { server = await serveApiLine({home, projectCreation:true, call:async () => assert.fail('host call')}); }, /project creation.*budget/i);
    const {readdirSync} = await import('node:fs');
    assert.deepEqual(readdirSync(home), []);
  } finally { await server?.close(); }
});
