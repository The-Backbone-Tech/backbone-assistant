import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { promisify } from 'node:util';
import { serveIdentityApi } from '../src/composition/identity-http.ts';
import { open,value } from './helpers.ts';

// Dedicated qualification, never part of the ordinary account-free platform suite.
// Caller chooses DOCKER_CONTEXT; this fixture never changes the global context.
const IMAGE = 'quay.io/keycloak/keycloak:26.8.2@sha256:723b1d6e254c0fc96d5cffec860c7e0744d6a3277822b865bb538cf891575e41';
const execute = promisify(execFile);
const docker = async (...args: string[]) => (await execute('docker', args, { timeout: 180_000, maxBuffer: 1024 * 1024 })).stdout.trim();

test('a disposable Keycloak verifies a company authorization-code sign-in with PKCE and prevents callback reuse', { timeout: 180_000 }, async t => {
  const name = `identity-${randomUUID()}`, scratch = await mkdtemp(join(tmpdir(), 'identity-keycloak-'));
  const subject=randomUUID(),bearer=randomBytes(32).toString('base64url');
  const password = randomBytes(24).toString('base64url');
  const redirectUri = 'https://app.example.invalid/identity/callback';
  let created = false;
  t.after(async () => {
    try { if (created) await docker('rm', '--force', name); }
    finally { await rm(scratch, { recursive: true, force: true }); }
  });
  await mkdir(join(scratch, 'import'));
  await writeFile(join(scratch, 'import', 'realm.json'), JSON.stringify({
    realm: 'identity-test', enabled: true, sslRequired: 'none', registrationAllowed: false,
    clients: [{ clientId: 'identity-app', enabled: true, protocol: 'openid-connect', publicClient: true,
      standardFlowEnabled: true, directAccessGrantsEnabled: false, redirectUris: [redirectUri],
      attributes: { 'pkce.code.challenge.method': 'S256' } }],
    users: [{ id:subject, username: 'test-person', enabled: true, email: 'person@example.invalid', emailVerified: true, firstName: 'Test', lastName: 'Person', requiredActions: [],
      credentials: [{ type: 'password', value: password, temporary: false }] }],
  // The disposable credentials are fake. Keycloak's unprivileged container user
  // must be able to read the copied file; the enclosing scratch folder is private.
  }), { mode: 0o644 });
  await docker('create', '--name', name, '--publish', '127.0.0.1::8080', IMAGE,
    'start-dev', '--import-realm', '--hostname-strict=false');
  created = true;
  await docker('cp', join(scratch, 'import'), `${name}:/opt/keycloak/data/`);
  await docker('start', name);
  const mapping = await docker('port', name, '8080/tcp');
  const port = /^127\.0\.0\.1:(\d+)$/.exec(mapping)?.[1];
  assert.ok(port, 'Keycloak listens only on a disposable loopback port');
  const issuer = `http://127.0.0.1:${port}/realms/identity-test`;
  const deadline = Date.now() + 120_000;
  while (true) {
    try { if ((await fetch(`${issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(2_000) })).ok) break; } catch {}
    if (await docker('inspect', '--format', '{{.State.Running}}', name) !== 'true') throw new Error('Disposable Keycloak exited before readiness.');
    if (Date.now() > deadline) throw new Error('Disposable Keycloak did not become ready.');
    await setTimeout(250);
  }
  const {host}=open(undefined,{identity:{company:{issuer,clientId:'identity-app',redirectUri,allowLoopbackHttp:true},directory:{bearer,issuer}}});
  const server=await serveIdentityApi({host}); t.after(()=>server.close());
  const post=async(path:string,body:unknown,session?:string)=>fetch(server.origin+path,{method:'POST',headers:{'content-type':'application/json',...(session?{authorization:`Bearer ${session}`}:{})},body:JSON.stringify(body)});
  const scim=async(method:string,path:string,body:unknown)=>fetch(server.origin+'/scim/v2/'+path,{method,headers:{'content-type':'application/scim+json',authorization:`Bearer ${bearer}`},body:JSON.stringify(body)});
  const provisioned=await scim('POST','Users',{userName:'test-person',externalId:subject,displayName:'Test Person'});
  assert.equal(provisioned.status,201);const person=await provisioned.json();
  const begin=await (await post('/identity/company/begin',{})).json();
  assert.ok(begin.attempt);const authorization=new URL(begin.authorization);
  const login = await fetch(authorization, { redirect: 'manual' });
  assert.equal(login.status, 200);
  const html = await login.text();
  const action = /<form\b[^>]*\baction="([^"]+)"/.exec(html)?.[1].replaceAll('&amp;', '&');
  assert.ok(action, 'Keycloak offers its password sign-in form');
  const cookies = login.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ');
  const result = await fetch(action, { method: 'POST', redirect: 'manual', headers: {
    'content-type': 'application/x-www-form-urlencoded', cookie: cookies,
  }, body: new URLSearchParams({ username: 'test-person', password, credentialId: '' }) });
  assert.equal(result.status, 302, 'Keycloak accepts the disposable person');
  const callback = new URL(result.headers.get('location')!);
  assert.equal(callback.origin + callback.pathname, redirectUri);
  const completion=await post('/identity/company/complete',{attempt:begin.attempt,callback:callback.href});
  assert.equal(completion.status,200);const signed=await completion.json();
  assert.equal(signed.ok,true);assert.equal(signed.value.person.id,person.id);
  assert.equal(signed.value.person.role,'member');
  const project=value(await host.call('projects.create',{name:'Company shared project',kind:'folder',clientKey:randomUUID()}));
  value(await host.call('identity.share',{projectId:project.id,personId:person.id,access:'viewer'}));
  const projects=await (await post('/api',{method:'projects.list',args:{}},signed.value.session)).json();
  assert.deepEqual(projects.map((row:{id:string})=>row.id),[project.id]);
  assert.notEqual((await post('/identity/company/complete',{attempt:begin.attempt,callback:callback.href})).status,200);
  const removed=await scim('PATCH',`Users/${person.id}`,{schemas:['urn:ietf:params:scim:api:messages:2.0:PatchOp'],Operations:[{op:'replace',path:'active',value:false}]});
  assert.equal(removed.status,200);assert.equal((await removed.json()).active,false);
  assert.equal((await post('/api',{method:'projects.list',args:{}},signed.value.session)).status,403,'directory removal ends the live company session before acknowledgement');
  assert.equal((await scim('PUT',`Users/${person.id}`,{userName:'test-person',externalId:subject,active:true})).status,409);
});
