import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { childHangTimer } from '../../../../scripts/lib/test-child.ts';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHost, hostClosed, removeDataHome } from '@backbone-next/platform/composition';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { startScriptedModel } from '@backbone-next/platform/testing';
import { plaintextKeys } from '@backbone-next/platform/keys';
import { serveIdentityApi } from '@backbone-next/platform/composition/identity-http';
import { sharedCertificate } from '@backbone-next/platform/composition/shared-certificate';
import { serveApiLine } from '@backbone-next/platform/composition/api-line';
import { assertHomeWriteAdmission, withHomeLock } from '@backbone-next/platform/composition/home-lock';
import { remoteWorkspace } from '@backbone-next/platform/remote/workspace';
import { parse, type Io } from '../src/commands.ts';
import { remoteCommand, teamCommand } from '../src/remote.ts';

function cli(home: string, args: string[]) {
  return new Promise<{code:number|null;out:string;err:string}>(resolve=>{
    const child=spawn(process.execPath,[new URL('../src/main.ts',import.meta.url).pathname,...args],{env:{...process.env,BACKBONE_HOME:home,BACKBONE_KEYS:'plaintext',BACKBONE_HARNESS:undefined,BACKBONE_MODEL_ENDPOINT:undefined,BACKBONE_CODEX_MODEL:undefined},stdio:['ignore','pipe','pipe']});
    const timer=childHangTimer(child,'shared model CLI command');let out='',err='';
    child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
    child.on('close',code=>{clearTimeout(timer);resolve({code,out,err});});
  });
}

// A real Host and pinned TLS service; no installed client is launched and the only model is this local fake.
test('the running service refuses shared configuration, then stop/configure/restart ends with a colleague answer', { timeout: 120_000 }, async () => {
  const home = freshDataHome('cli-shared-model'), clientHome = freshDataHome('cli-colleague-model');
  const server = await startScriptedModel('team-model', () => ({ text: 'The shared route answered.' }));
  let host = createHost({ home, harness: 'harness-codex', keys: plaintextKeys() });
  const lines: string[] = [];
  const io: Io = { out: line => lines.push(line), err: line => lines.push(line), onInterrupt() {}, holding() {}, pollMs: 10, stopWaitMs: 100 };
  let service: Awaited<ReturnType<typeof serveIdentityApi>> | undefined, socket: Awaited<ReturnType<typeof serveApiLine>> | undefined;
  const prior = process.env.BACKBONE_KEYS; process.env.BACKBONE_KEYS = 'plaintext';
  try {
    const project = await host.call('projects.create', { name: 'Team project', kind: 'folder' }); assert.ok(project.ok);
    assert.ok((await host.call('settings.engine.put', { engine: 'codex' })).ok);

    assert.match((await host.call('settings.model.get', {})).harness, /Codex/);
    const tls = await sharedCertificate(home, plaintextKeys());
    service = await serveIdentityApi({ host, tls, address: '127.0.0.1', port: 0 });
    socket = await serveApiLine({ home, holder: 'background-service', readOnly: true, teamManagement: true, call: (method, args) => host.call(method, args) });
    await withHomeLock(home, async () => {
      assertHomeWriteAdmission(home);
      writeFileSync(join(home, 'daemon.json'), JSON.stringify({ pid: process.pid, shared: { origin: service!.origin, fingerprint: tls.fingerprint } }));
    });
    const args=['model','shared','local','--runtime','ollama','--endpoint',new URL(server.url).origin,'--model',server.model];
    const refused=await cli(home,args);
    assert.equal(refused.code,1,refused.out+refused.err);
    assert.match(refused.err,/background service holds this data folder.*Stop the background service.*start it again/s);
    assert.doesNotMatch(refused.err,/Use the app for it/);
    await socket.close();socket=undefined;await service.close();service=undefined;host.close();await hostClosed(home);
    const saved=await cli(home,args);assert.equal(saved.code,0,saved.err);assert.match(saved.out,/the \/v1 path was added/);assert.match(saved.out,/is listed/);
    host=createHost({home,harness:'harness-codex',keys:plaintextKeys()});
    await host.call('settings.model.get',{});
    service=await serveIdentityApi({host,tls,address:'127.0.0.1',port:0});
    socket=await serveApiLine({home,holder:'background-service',readOnly:true,teamManagement:true,call:(method,args)=>host.call(method,args)});
    await withHomeLock(home,async()=>{assertHomeWriteAdmission(home);writeFileSync(join(home,'daemon.json'),JSON.stringify({pid:process.pid,shared:{origin:service!.origin,fingerprint:tls.fingerprint}}));});
    lines.length = 0;
    assert.equal(await teamCommand(parse(['team', 'invite'], { BACKBONE_HOME: home }), io), 0);
    assert.doesNotMatch(lines.join('\n'), /messages are refused/);
    const invitation = { link: lines.join('\n').match(/https:\/\/[^\s]+/)![0] };
    lines.length = 0;
    assert.equal(await remoteCommand(parse(['join', invitation.link, '--name', 'Colleague'], { BACKBONE_HOME: clientHome }), io), 0, lines.join('\n'));
    const workspace = await remoteWorkspace(clientHome, plaintextKeys()), client = await workspace.client();
    const identity = await client.call('identity.get', {}); assert.ok(identity.ok);
    assert.equal(await teamCommand(parse(['team', 'share', project.value.id, '--person', identity.value.person.id, '--access', 'editor'], { BACKBONE_HOME: home }), io), 0);
    lines.length = 0;
    assert.equal(await remoteCommand(parse(['remote', 'send', 'Hello shared model', '--project', project.value.id], { BACKBONE_HOME: clientHome }), io), 0, lines.join('\n'));
    assert.match(lines.join('\n'), /The shared route answered/);
    const [thread] = await client.call('threads.list', {});
    lines.length = 0;
    assert.equal(await remoteCommand(parse(['remote', 'read', thread.id], { BACKBONE_HOME: clientHome }), io), 0);
    assert.match(lines.join('\n'), /engine.*Pi.*team-model/i);
    assert.match(lines.join('\n'), /The shared route answered/);
    assert.ok(server.requests.some(request => request.body.includes('Hello shared model')));
    assert.match((await host.call('settings.model.get', {})).harness, /Codex/);
  } finally {
    if (prior === undefined) delete process.env.BACKBONE_KEYS; else process.env.BACKBONE_KEYS = prior;
    await socket?.close(); await service?.close(); host.close(); await hostClosed(home);
    await server.close(); await removeDataHome(home); await removeDataHome(clientHome);
  }
});
