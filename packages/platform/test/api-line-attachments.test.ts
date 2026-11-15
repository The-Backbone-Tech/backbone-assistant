import assert from 'node:assert/strict';
import {mkdtempSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import type {PathLike} from 'node:fs';
import type {Args, Receipt, MaterialEntry} from '../src/api.ts';
import {ApiLineAttachmentBudget,serveApiLine} from '../src/composition/api-line.ts';
import {attachApi,API_LINE_ATTACHMENTS} from '../src/doors/api-line.ts';

const budget = () => new ApiLineAttachmentBudget();
const input = {projectId:'project',name:'launch.md',base64:Buffer.from('# Launch\n').toString('base64'),mediaType:'text/markdown'};
const options = (home:string, call:Parameters<typeof serveApiLine>[0]['call'], extra:object = {}) => ({home,readOnly:true,attachment:true,attachmentBudget:budget(),call,...extra});

test('attachment is an explicit local opt-in and rebuilds only the attachment fields', async () => {
  assert.deepEqual(API_LINE_ATTACHMENTS,['material.attach']);
  for (const attachment of [false,true,'signed-in-app'] as const) {
    const home = mkdtempSync(join(tmpdir(),'line-attach-'));
    const calls:unknown[] = [];
    const server = await serveApiLine(options(home,async (method,args) => {calls.push({method,args});return {ok:true,value:{id:'material'}} as never;},{attachment}));
    const client = await attachApi(home); assert.ok(client);
    try {
      const result = await client.call('material.attach',{...input,relativePath:'elsewhere.md',attachment:true} as Args<'material.attach'>);
      assert.equal(result.ok,attachment === true);
      assert.deepEqual(calls,attachment === true ? [{method:'material.attach',args:input}] : []);
      if (attachment === 'signed-in-app') {assert.ok(!result.ok);assert.match(result.detail,/attach.*signed-in app/i);}
      const denied = await client.call('material.save',{} as never); assert.ok(!denied.ok);
    } finally {client.close();await server.close();rmSync(home,{recursive:true,force:true});}
  }
});

test('attachment validates names, ids, media types and canonical bounded bytes before calling the host', async () => {
  const home = mkdtempSync(join(tmpdir(),'line-attach-input-'));let calls = 0;
  const server = await serveApiLine(options(home,async () => {calls++;return {ok:true} as never;}));
  const client = await attachApi(home);assert.ok(client);
  try {
    for (const changed of [{projectId:''},{name:''},{name:'.private'},{name:'launch.tmp'},{mediaType:''},{base64:'!!!'},{base64:'YQ='},{base64:'YR=='},{base64:Buffer.alloc(25*1024*1024+1).toString('base64')}]) {
      const result:Receipt<MaterialEntry> = await client.call('material.attach',{...input,...changed});
      assert.ok(!result.ok);assert.equal(result.outcome,'REFUSED');assert.equal(result.reason,'INVALID');
      if ('name' in changed) assert.equal(result.detail,'That file name cannot be attached.');
      if (typeof changed.base64 === 'string' && changed.base64.length > 1000) assert.equal(result.detail,'An attachment must be at most 25 MiB. Nothing was attached.');
    }
    assert.equal(calls,0);
    // A full-size original must pass the transport's former 1 MiB request ceiling.
    const result = await client.call('material.attach',{...input,base64:Buffer.alloc(25*1024*1024,255).toString('base64')});
    assert.ok(result.ok);assert.equal(calls,1);
  } finally {client.close();await server.close();rmSync(home,{recursive:true,force:true});}
});

test('attachment budget counts failed and repeated requests across connections, minutes and replacement lines', async t => {
  const home = mkdtempSync(join(tmpdir(),'line-attach-budget-'));const attachmentBudget = budget();let now = Date.now(), calls = 0;
  t.mock.method(Date,'now',() => now);
  const call = async () => {calls++;return {ok:false,outcome:'REFUSED',reason:'NOT_FOUND',detail:'No project.'} as never;};
  let server = await serveApiLine(options(home,call,{attachmentBudget}));
  try {
    for (let minute = 0;minute < 10;minute++) {
      const client = await attachApi(home);assert.ok(client);
      try {
        await Promise.all(Array.from({length:10},() => client.call('material.attach',input)));
        const denied = await client.call('material.attach',input);assert.ok(!denied.ok);assert.match(denied.detail,/attachment limit.*nothing was queued/i);
        assert.equal(calls,(minute+1)*10);
      } finally {client.close();}
      now += 60_001;
    }
    await server.close();server = await serveApiLine(options(home,call,{attachmentBudget}));
    const client = await attachApi(home);assert.ok(client);
    try {const denied = await client.call('material.attach',input);assert.ok(!denied.ok);assert.match(denied.detail,/attachment limit/i);assert.equal(calls,100);} finally {client.close();}
  } finally {await server.close();rmSync(home,{recursive:true,force:true});}
});

test('enabling attachment without an owner budget refuses startup before writing', async () => {
  const home = mkdtempSync(join(tmpdir(),'line-attach-start-'));let server:Awaited<ReturnType<typeof serveApiLine>>|undefined;
  try {
    await assert.rejects(async () => {server = await serveApiLine({home,attachment:true,call:async () => assert.fail('host call')} as Parameters<typeof serveApiLine>[0]);},/attachment.*budget/i);
    assert.deepEqual(readdirSync(home),[]);
  } finally {await server?.close();rmSync(home,{recursive:true,force:true});}
});

test('the line uses the Host original-byte and naming operation; lost admission writes nothing', async t => {
  const {open,value} = await import('./helpers.ts');
  const {default:fs} = await import('node:fs');
  const {host,home} = open();
  const project = value(await host.call('projects.create',{name:'Attachments',kind:'folder'}));
  let loseAnswer = false;
  const server = await serveApiLine(options(home,async (method,args) => {
    const result = await host.call(method,args);
    if (method === 'material.attach' && loseAnswer) throw Error('simulated lost answer after attachment');
    return result;
  }));
  const client = await attachApi(home);assert.ok(client);
  try {
    const args = {...input,name:'launch.bin',projectId:project.id,mediaType:'application/octet-stream',base64:Buffer.from([0,255,10,13,128]).toString('base64')};
    const first = value(await client.call('material.attach',args));
    const second = value(await client.call('material.attach',args));
    assert.equal(first.class,'original');assert.equal(first.current,1);assert.equal(first.versions[0]!.by,'person');
    assert.notEqual(first.id,second.id);assert.notEqual(first.name,second.name,'ordinary attach keeps both originals');
    assert.equal(value(await host.call('material.read',{id:first.id})).base64,args.base64);
    loseAnswer = true;
    await assert.rejects(client.call('material.attach',{...args,name:'lost.bin'}),/not known/);
    loseAnswer = false;
    const before = await host.call('material.list',{projectId:project.id});
    assert.equal(before.filter(entry => entry.name === 'lost.bin').length,1,'a lost answer after the write is never resent');
    const beforeFiles = fs.readdirSync(join(home,'material'),{recursive:true});
    const {MaterialStore} = await import('../src/stub/material.ts');
    const statfs = fs.statfsSync, freeName = MaterialStore.prototype.freeName;
    let admitted = true;
    t.mock.method(fs,'statfsSync',((path:PathLike) => ({...statfs(path),...(!admitted ? {type:0x6969} : {})})) as typeof fs.statfsSync);
    // Lose admission after taking the lock and allocating the name, immediately before attachment.
    t.mock.method(MaterialStore.prototype,'freeName',function (this:InstanceType<typeof MaterialStore>,projectId:string,label:string) {
      const name = freeName.call(this,projectId,label);admitted = false;return name;
    });
    const refused = await client.call('material.attach',{...args,name:'refused.md'});
    assert.ok(!refused.ok);assert.equal(refused.outcome,'REFUSED');assert.match(refused.detail,/nothing was attached/i);
    const folderRefused = await host.call('material.attach',{...args,relativePath:'source.md'});
    assert.ok(!folderRefused.ok);assert.equal(folderRefused.outcome,'REFUSED');assert.match(folderRefused.detail,/nothing was attached/i);
    t.mock.restoreAll();
    assert.deepEqual(await host.call('material.list',{projectId:project.id}),before);
    assert.deepEqual(fs.readdirSync(join(home,'material'),{recursive:true}),beforeFiles);
  } finally {client.close();await server.close();}
});

test('an attachment-enabled line keeps the ordinary frame ceiling for other requests', async () => {
  const {createConnection} = await import('node:net');
  const {apiSocket} = await import('../src/doors/api-line.ts');
  const {MAX_LINE} = await import('../src/doors/protocol.ts');
  const home = mkdtempSync(join(tmpdir(),'line-attach-frame-'));let calls = 0;
  const server = await serveApiLine(options(home,async () => {calls++;return [] as never;}));
  const socket = createConnection(apiSocket(home));
  try {
    await new Promise<void>((resolve,reject) => {
      const timer = setTimeout(() => reject(Error('oversized request retained')),1000);
      socket.setEncoding('utf8');socket.on('error',()=>{});
      socket.once('close',() => {clearTimeout(timer);resolve();});
      socket.once('data',() => socket.write(`${' '.repeat(MAX_LINE)}${JSON.stringify({id:1,method:'projects.list',args:{}})}\n`));
      socket.once('connect',() => socket.write('{"api":1}\n'));
    });
    assert.equal(calls,0);
  } finally {socket.destroy();await server.close();rmSync(home,{recursive:true,force:true});}
});


test('line attachment names and refusal reasons match the direct attachment rules', async () => {
  const {attachmentName} = await import('../src/material-attachment.ts');
  const home = mkdtempSync(join(tmpdir(),'line-attach-names-'));const names:string[] = [];
  const server = await serveApiLine(options(home,async (_method,args) => {names.push((args as typeof input).name);return {ok:true} as never;}));
  const client = await attachApi(home);assert.ok(client);
  try {
    for (const name of ['👩‍💻.md','left\u200emark.md','line\nname.md','folder/launch.md','a'.repeat(255),'界'.repeat(85)]) {
      assert.ok(attachmentName(name));
      assert.ok((await client.call('material.attach',{...input,name})).ok,name);
      assert.equal(names.at(-1),attachmentName(name));
    }
    // No file on disk has a longer name or a NUL in it, so neither path accepts one.
    for (const name of ['', '.env', 'launch.tmp', 'a'.repeat(256), '界'.repeat(86), 'nul\0name.md', 'x/'.repeat(3000)+'launch.md']) {
      const result:Receipt<MaterialEntry> = await client.call('material.attach',{...input,name});
      assert.ok(!result.ok);assert.equal(result.detail,'That file name cannot be attached.');
    }
    const result = await client.call('material.attach',{...input,base64:Buffer.alloc(25*1024*1024+1).toString('base64')});
    assert.ok(!result.ok);assert.equal(result.detail,'An attachment must be at most 25 MiB. Nothing was attached.');
  } finally {client.close();await server.close();rmSync(home,{recursive:true,force:true});}
});

test('an exhausted attachment budget gives service-neutral recovery wording', async () => {
  const home = mkdtempSync(join(tmpdir(),'line-attach-words-'));
  const attachmentBudget = budget();for(let i=0;i<10;i++)attachmentBudget.take();
  const server = await serveApiLine(options(home,async () => assert.fail('no dispatch'),{attachmentBudget}));
  const client = await attachApi(home);assert.ok(client);
  try {
    const result = await client.call('material.attach',input);
    assert.ok(!result.ok);assert.doesNotMatch(result.detail,/in the app/);assert.match(result.detail,/try later/i);
  } finally {client.close();await server.close();rmSync(home,{recursive:true,force:true});}
});
