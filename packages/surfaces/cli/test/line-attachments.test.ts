import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {ApiLineAttachmentBudget,serveApiLine} from '@backbone-next/platform/composition/api-line';
import {spawn} from 'node:child_process';
import {childHangTimer} from '../../../../scripts/lib/test-child.ts';

function run(home:string, args:string[]) {
  return new Promise<{code:number|null;out:string;err:string}>(resolve => {
    const child = spawn(process.execPath, [new URL('../src/main.ts', import.meta.url).pathname, ...args], {env:{...process.env,BACKBONE_HOME:home},stdio:['ignore','pipe','pipe']});
    const timer = childHangTimer(child, 'attachment CLI completion');
    let out = '', err = '';
    child.stdout.on('data', b => out += b); child.stderr.on('data', b => err += b);
    child.once('close', code => {clearTimeout(timer); resolve({code,out,err});});
  });
}

test('files attach reads local bytes through a running line host with the direct result text', async () => {
  const home = mkdtempSync(join(tmpdir(),'cli-attach-line-'));
  const path = join(home,'launch.md');writeFileSync(path,'# Launch\n');let calls = 0;
  const server = await serveApiLine({home,readOnly:true,attachment:true,attachmentBudget:new ApiLineAttachmentBudget(),call:async (method,args) => {
    if (method === 'projects.list') return [{id:'project',name:'Launch',kind:'folder'}] as never;
    assert.equal(method,'material.attach');assert.deepEqual(args,{projectId:'project',name:'launch.md',base64:Buffer.from('# Launch\n').toString('base64'),mediaType:'text/markdown'});calls++;
    return {ok:true,value:{id:'material',name:'launch.md',current:1}} as never;
  }});
  try {
    const attached = await run(home,['files','attach',path,'--project','project']);
    assert.equal(attached.code,0,attached.err);assert.equal(attached.out,"Attached launch.md v1 (material). Original bytes kept; available to this project's turns.\n");assert.equal(calls,1);
  } finally {await server.close();rmSync(home,{recursive:true,force:true});}
});

test('refused and lost attachment answers never print Attached or resend', async () => {
  for (const lost of [false,true]) {
    const home = mkdtempSync(join(tmpdir(),'cli-attach-lost-'));const path = join(home,'launch.md');writeFileSync(path,'plan');let calls = 0;
    const server = await serveApiLine({home,attachment:true,attachmentBudget:new ApiLineAttachmentBudget(),call:async (method) => {
      if (method === 'projects.list') return [{id:'project',name:'Launch',kind:'folder'}] as never;
      assert.equal(method,'material.attach');calls++;if(lost) throw Error('lost answer');
      return {ok:false,outcome:'REFUSED',reason:'NOT_AVAILABLE',detail:'Attach in the signed-in app.'} as never;
    }});
    try {
      const result = await run(home,['files','attach',path,'--project','project']);
      assert.equal(result.code,lost ? 4 : 1,result.err);assert.doesNotMatch(result.out,/Attached/);assert.match(result.err,lost ? /unknown outcome/i : /REFUSED/);assert.equal(calls,1);
    } finally {await server.close();rmSync(home,{recursive:true,force:true});}
  }
});

test('a send with attachments is refused before uploading anything on the local line', async () => {
  const home = mkdtempSync(join(tmpdir(),'cli-send-attach-'));const path = join(home,'launch.md');writeFileSync(path,'plan');let calls = 0;
  const server = await serveApiLine({home,attachment:true,attachmentBudget:new ApiLineAttachmentBudget(),call:async (method) => {
    calls++;
    if (method === 'projects.list') return [{id:'project',name:'Launch',kind:'folder'}] as never;
    if (method === 'models.list') return [] as never;
    return {ok:true,value:{id:'material'}} as never;
  }});
  try {
    for (const command of ['send','exec']) {
      const result = await run(home,[command,'Read this','--attach',path,'--project','project']);
      assert.equal(result.code,1,result.err);assert.match(result.err,/app, or.*standalone data folder/i);assert.equal(calls,0,'no original is uploaded for a send the line cannot carry');
    }
  } finally {await server.close();rmSync(home,{recursive:true,force:true});}
});
